"use strict";
// Interview counts per interviewer per week, from Ashby's public API
// (interviewSchedule.list). Shared by the dashboard's Interviewer Weekly
// Limits and the calendar-checked proposal's interviewer load
// (scheduling-rules interviewerLoad).
//
// Weeks run Monday to Sunday in a named time zone (Luminai: Pacific), keyed by
// the Monday's date ("2026-11-02"). An event belongs to the week its start
// falls in, in that zone.
//
// Every schedule is read, not just those created in the last
// SCHEDULE_LOOKBACK_DAYS: an interview booked months ago for this week still
// counts. The first read is the whole history; later reads pass Ashby's
// syncToken and get only schedules changed since (createScheduleSync).

const DAY = 24 * 60 * 60 * 1000;

// The Monday (YYYY-MM-DD) of the week containing `ms`, in `timeZone`.
function weekKey(ms, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(ms).map(x => [x.type, x.value]));
  const back = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday);
  if (back < 0) throw new Error(`Unreadable weekday for ${new Date(ms).toISOString()} in ${timeZone}.`);
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - back * DAY).toISOString().slice(0, 10);
}

// userId → { userId, name, email, weeks: Map(weekKey → count) }, over events
// of schedules that aren't cancelled. `counts(event, interviewer)` decides
// whether one interviewer's place on one event counts (default: every one).
function countInterviewLoad(schedules, { timeZone, counts = () => true, excludeScheduleIds = [] }) {
  const skip = new Set(excludeScheduleIds.filter(Boolean));
  const byId = new Map();
  for (const schedule of schedules) {
    if (schedule.status === "Cancelled" || skip.has(schedule.id)) continue;
    for (const event of schedule.interviewEvents || []) {
      const start = Date.parse(event.startTime);
      if (!Number.isFinite(start)) continue;
      const week = weekKey(start, timeZone);
      for (const interviewer of event.interviewers || []) {
        if (!interviewer.id || !counts(event, interviewer)) continue;
        const row = byId.get(interviewer.id) || { userId: interviewer.id, name: `${interviewer.firstName || ""} ${interviewer.lastName || ""}`.trim() || interviewer.email, email: interviewer.email, weeks: new Map() };
        row.weeks.set(week, (row.weeks.get(week) || 0) + 1);
        byId.set(interviewer.id, row);
      }
    }
  }
  return byId;
}

// Every schedule, kept current with Ashby's syncToken. `fetchPage(body)`
// returns one page of interviewSchedule.list ({results, moreDataAvailable,
// nextCursor, syncToken}). Schedules whose events all ended more than `keepDays`
// ago are dropped from memory after each read (a later change to one comes
// back through the sync). What each interviewer last had as isFeedbackRequired
// on each interview is kept from the whole history (feedbackHistory), for
// sessions not yet booked.
//
// With a `store` (syncStateFile.js; ashby.js passes
// <DATA_DIR>/schedule-sync.json), the kept schedules, feedbackHistory and
// sync token are saved on the volume and a restart carries on from the token
// instead of re-reading every schedule ever (Forus: ~350 pages, the bulk of
// a 9-minute first refresh that held up the Dashboard tab). Used only if it
// was kept for at least as many days as now (raising
// FEEDBACK_LEADERBOARD_DAYS forces one full read); an expired token falls
// back to a full read as before. Saved after a full read, then at most every
// `saveEveryMs`.
const SCHEDULE_STATE_VERSION = 1;
function createScheduleSync({ fetchPage, now = () => Date.now(), keepDays = 8, log = console, store = null, saveEveryMs = 10 * 60 * 1000 }) {
  const byId = new Map(), feedback = new Map();
  let token = null, inFlight = null, lastSaved = 0;
  function restore() {
    const state = store && store.load();
    if (!state) return;
    if (state.version !== SCHEDULE_STATE_VERSION || !state.token || !Array.isArray(state.schedules) || !Array.isArray(state.feedback) || !(state.keepDays >= keepDays)) {
      log.warn("[interviewer-load] saved schedules don't cover the current window; reading every schedule again.");
      return;
    }
    for (const s of state.schedules) byId.set(s.id, s);
    for (const [interviewId, people] of state.feedback) feedback.set(interviewId, new Map(people.map(([userId, at, required]) => [userId, { at, required }])));
    token = state.token;
    lastSaved = now();
    log.log(`[interviewer-load] restored ${byId.size} schedules saved ${Math.round((Date.now() - Date.parse(state.savedAt)) / 60000)}m ago; continuing from the sync token.`);
  }
  function save(force) {
    if (!store || !token || (!force && now() - lastSaved < saveEveryMs)) return;
    store.save({
      version: SCHEDULE_STATE_VERSION, savedAt: new Date().toISOString(), keepDays, token,
      schedules: [...byId.values()],
      feedback: [...feedback].map(([interviewId, people]) => [interviewId, [...people].map(([userId, x]) => [userId, x.at, x.required])]),
    });
    lastSaved = now();
  }
  async function readAll(body) {
    const results = [];
    let cursor = null, last = null;
    for (;;) {
      last = await fetchPage(cursor ? { ...body, cursor } : body);
      results.push(...(last.results || []));
      if (!last.moreDataAvailable || !last.nextCursor) break;
      cursor = last.nextCursor;
    }
    return { results, syncToken: last.syncToken || null };
  }
  function remember(schedule) {
    for (const event of schedule.interviewEvents || []) {
      const at = Date.parse(event.startTime);
      for (const i of event.interviewers || []) {
        if (!event.interviewId || !i.id || typeof i.isFeedbackRequired !== "boolean") continue;
        const people = feedback.get(event.interviewId) || new Map(), seen = people.get(i.id);
        if (!seen || at >= seen.at) people.set(i.id, { at, required: i.isFeedbackRequired });
        feedback.set(event.interviewId, people);
      }
    }
  }
  async function sync() {
    let read;
    if (token) {
      try { read = await readAll({ limit: 100, syncToken: token }); }
      catch (err) {
        if (!/sync.?token/i.test(String(err.message))) throw err;
        log.warn("[interviewer-load] Ashby's sync token expired; reading every schedule again.");
        byId.clear(); token = null;
      }
    }
    const full = !read;
    if (full) read = await readAll({ limit: 100 });
    for (const s of read.results) { byId.set(s.id, s); remember(s); }
    if (read.syncToken) token = read.syncToken;
    const cutoff = now() - keepDays * DAY;
    for (const [id, s] of byId) if (!(s.interviewEvents || []).some(e => Date.parse(e.endTime) > cutoff)) byId.delete(id);
    save(full);
    return [...byId.values()];
  }
  restore();
  return {
    // Current schedules; concurrent callers share one read.
    schedules() { if (!inFlight) inFlight = sync().finally(() => { inFlight = null; }); return inFlight; },
    // Whether this person gives feedback on this interview, from the most
    // recent booking of it that shows: theirs, else anyone's (true if any of
    // the latest says so); null when it has never been booked.
    feedbackHistory(interviewId, userId) {
      const people = feedback.get(interviewId);
      if (!people || !people.size) return null;
      if (people.has(userId)) return people.get(userId).required;
      return [...people.values()].some(x => x.required);
    },
  };
}

// Minutes covered by [start, end] spans, overlaps counted once.
function mergedMinutes(spans) {
  let total = 0, curStart = null, curEnd = null;
  for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
    if (curEnd === null || a > curEnd) {
      if (curEnd !== null) total += curEnd - curStart;
      curStart = a; curEnd = b;
    } else if (b > curEnd) curEnd = b;
  }
  if (curEnd !== null) total += curEnd - curStart;
  return Math.round(total / 60000);
}

// The calendar day (YYYY-MM-DD) containing `ms`, in `timeZone`.
function dayKey(ms, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

// The Interviewer Info tab's Interviewer load section: for everyone who has
// interviewed recently, how many interviews they have today, this week
// (Monday to Sunday) and this month, calendar periods in `timeZone`, each
// split into done (ended) and booked (not ended yet, so the rest of the
// period's calendar counts too).
//
// Load is everything on someone's calendar, unlike who owes feedback: a
// Welcome, lunch or debrief costs the time whether or not a scorecard is
// due. Cancelled schedules don't count (Ashby marks the schedule, and an
// event removed from a schedule is simply gone). No-shows count: Ashby
// records no attendance. Same rule as Interviewer Weekly Limits
// (countInterviewsThisWeek), so the two sections agree on the week.
//
// Who appears: anyone listed on a non-cancelled interview that started in
// the last `rosterDays` or is booked ahead, who is still an enabled Ashby
// user (`users`, from listUsers; leavers drop out). People at zero for a
// period are kept: who did nothing this week is half the point. Without a
// user list (that read failed), nobody is dropped.
//
// `exclude`: emails of shared calendar accounts that aren't people
// (INTERVIEWER_LOAD_EXCLUDE), left out entirely.
//
// Hours: `minutes` per period is the time on someone's calendar with any
// overlap counted once (Poetic's work-trial lunches put one host on two
// candidates' meals at once). `untimed(interviewId)` true means the event
// counts toward the number but not the hours (INTERVIEWER_LOAD_UNTIMED_
// INTERVIEWS, e.g. Poetic's "Build Time"); `untimed` per period counts those.
//
// Roles, for the page's department/job/recruiter/coordinator filter:
// `roleOf(applicationId)` gives the candidate's application's
// { departmentId, jobId, jobTitle, recruiterId, recruiterName, coordinatorId,
// coordinatorName }, or null while it isn't known yet. Each distinct one goes
// in `roles` once; each period carries `byRole`: [roleIndex, done, booked,
// minutes, untimed] (minutes with overlap counted once within that role), and
// each row `roles`: every role they interviewed for in the roster window, for
// who appears when filtered. An interview with no known role still counts in
// the totals, never in a filtered view; `unmatched` says how many of this
// period's are like that.
//
// Stages, for the bar's split by stage: `stages` is the segment names (from
// chooseStageSegments) or null for no split (the client has no interview
// stage groups, or the stage lookups aren't complete yet). `stageOf(
// interviewStageId)` gives a segment index, or anything else for "Other".
// With a split, each period carries `byStage`: minutes per segment then
// Other (overlap counted once within each), and each byRole entry gains the
// same array as a sixth element. Segments are drawn as shares of the
// person's total, so overlap across two stages can't make a bar too long.
function interviewerLoadSnapshot(schedules, { users = null, timeZone, now = Date.now(), rosterDays = 90, exclude = [], untimed = () => false, roleOf = () => null, stages = null, stageOf = () => -1 }) {
  const split = Array.isArray(stages) && stages.length > 0;
  const buckets = split ? stages.length + 1 : 0;
  const bucketOf = (stageId) => { const i = stageOf(stageId); return Number.isInteger(i) && i >= 0 && i < buckets - 1 ? i : buckets - 1; };
  const stageSpans = () => Array.from({ length: buckets }, () => []);
  const excluded = new Set(exclude.map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  const keys = { day: dayKey(now, timeZone), week: weekKey(now, timeZone), month: dayKey(now, timeZone).slice(0, 7) };
  const rosterFrom = now - rosterDays * DAY;
  const enabled = users ? new Map(users.map((u) => [u.id, u])) : null;
  const rows = new Map();
  const blank = () => ({ done: 0, booked: 0, minutes: 0, untimed: 0 });
  const PERIODS = ["day", "week", "month"];
  const roles = [];
  const roleIndex = new Map();
  const ROLE_FIELDS = ["departmentId", "jobId", "jobTitle", "recruiterId", "recruiterName", "coordinatorId", "coordinatorName"];
  const roleFor = (applicationId) => {
    const r = applicationId ? roleOf(applicationId) : null;
    if (!r) return -1;
    const clean = Object.fromEntries(ROLE_FIELDS.map((f) => [f, r[f] || null]));
    const key = JSON.stringify(ROLE_FIELDS.map((f) => clean[f]));
    if (!roleIndex.has(key)) { roleIndex.set(key, roles.length); roles.push(clean); }
    return roleIndex.get(key);
  };
  const unmatched = { day: 0, week: 0, month: 0 };
  for (const schedule of schedules) {
    if (schedule.status === "Cancelled") continue;
    const role = roleFor(schedule.applicationId);
    const bucket = split ? bucketOf(schedule.interviewStageId) : -1;
    for (const event of schedule.interviewEvents || []) {
      const start = Date.parse(event.startTime);
      if (!Number.isFinite(start) || start < rosterFrom) continue;
      const end = Date.parse(event.endTime);
      const state = (Number.isFinite(end) ? end : start) <= now ? "done" : "booked";
      const day = dayKey(start, timeZone);
      const at = { day, week: weekKey(start, timeZone), month: day.slice(0, 7) };
      for (const interviewer of event.interviewers || []) {
        if (!interviewer.id || (enabled && !enabled.has(interviewer.id))) continue;
        if (excluded.size && excluded.has(String(interviewer.email || (enabled && enabled.get(interviewer.id)?.email) || "").toLowerCase())) continue;
        let row = rows.get(interviewer.id);
        if (!row) {
          const user = enabled && enabled.get(interviewer.id);
          const name = (user && user.name) || `${interviewer.firstName || ""} ${interviewer.lastName || ""}`.trim() || interviewer.email || "Unknown";
          row = { userId: interviewer.id, name, day: blank(), week: blank(), month: blank(), roleSet: new Set(), spans: { day: [], week: [], month: [] }, stageSpans: { day: stageSpans(), week: stageSpans(), month: stageSpans() }, byRole: { day: new Map(), week: new Map(), month: new Map() } };
          rows.set(interviewer.id, row);
        }
        if (role >= 0) row.roleSet.add(role);
        const timed = Number.isFinite(end) && end > start && !untimed(event.interviewId);
        const isUntimed = !timed && untimed(event.interviewId);
        for (const period of PERIODS) {
          if (at[period] !== keys[period]) continue;
          row[period][state]++;
          if (timed) row.spans[period].push([start, end]);
          else if (isUntimed) row[period].untimed++;
          if (timed && split) row.stageSpans[period][bucket].push([start, end]);
          if (role < 0) continue;
          const g = row.byRole[period].get(role) || { done: 0, booked: 0, spans: [], untimed: 0, stageSpans: split ? stageSpans() : null };
          g[state]++;
          if (timed) g.spans.push([start, end]);
          if (timed && split) g.stageSpans[bucket].push([start, end]);
          else if (isUntimed) g.untimed++;
          row.byRole[period].set(role, g);
        }
      }
    }
  }
  for (const row of rows.values()) {
    for (const period of PERIODS) {
      row[period].minutes = mergedMinutes(row.spans[period]);
      if (split) row[period].byStage = row.stageSpans[period].map(mergedMinutes);
      row[period].byRole = [...row.byRole[period]].map(([i, g]) => {
        const entry = [i, g.done, g.booked, mergedMinutes(g.spans), g.untimed];
        if (split) entry.push(g.stageSpans.map(mergedMinutes));
        return entry;
      });
    }
    row.roles = [...row.roleSet];
    delete row.spans; delete row.byRole; delete row.roleSet; delete row.stageSpans;
  }
  // Interviews in each period whose role isn't known yet (counted in totals,
  // left out of filtered views), across the people listed.
  for (const row of rows.values()) for (const period of PERIODS) {
    const matched = row[period].byRole.reduce((n, g) => n + g[1] + g[2], 0);
    unmatched[period] += row[period].done + row[period].booked - matched;
  }
  return {
    periods: keys,
    timeZone,
    rosterDays,
    roles,
    unmatched,
    stages: split ? stages.slice() : null,
    rows: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// Which of a client's Ashby stage groups get their own segment of the bar
// (at most five; everything else is Other).
// `groups`: interviewStageGroup.list ({ id, title, order, stageType }).
// `minutesByGroup`: Map(groupId → interview minutes in the roster window).
// `configured`: INTERVIEWER_LOAD_STAGE_GROUPS, group titles in the order to
// draw them. Set, it decides, so a group's shade never changes on its own
// (January has seven interview groups, Poetic six; picking the first five
// in plan order dropped Poetic's Work Trial, 56% of its hours). Unset: the
// five Active groups with the most minutes, in plan order. No Active group
// with minutes (Runlayer, LiteLLM: no interview stage groups at all): null,
// no split. Returns { segments: [{ id, title }] | null, unknown: [titles
// configured but not found], dropped: [configured past the fifth] }.
const MAX_STAGE_SEGMENTS = 5;
function chooseStageSegments(groups, minutesByGroup, configured = []) {
  const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const list = Array.isArray(groups) ? groups : [];
  if (configured.length) {
    const byTitle = new Map();
    for (const g of list) if (!byTitle.has(norm(g.title))) byTitle.set(norm(g.title), g);
    const found = [], unknown = [];
    for (const name of configured) {
      const g = byTitle.get(norm(name));
      if (!g) unknown.push(name);
      else if (!found.includes(g)) found.push(g);
    }
    const kept = found.slice(0, MAX_STAGE_SEGMENTS);
    const dropped = found.slice(MAX_STAGE_SEGMENTS).map((g) => g.title);
    return { segments: kept.length ? kept.map((g) => ({ id: g.id, title: g.title })) : null, unknown, dropped };
  }
  const minutes = (g) => minutesByGroup.get(g.id) || 0;
  const top = list.filter((g) => g.stageType === "Active" && minutes(g) > 0)
    .sort((a, b) => minutes(b) - minutes(a) || a.order - b.order)
    .slice(0, MAX_STAGE_SEGMENTS)
    .sort((a, b) => a.order - b.order);
  return { segments: top.length ? top.map((g) => ({ id: g.id, title: g.title })) : null, unknown: [], dropped: [] };
}

// Interview minutes per stage group over events starting from `from`, every
// interviewer counted (the share of work, not calendar time), cancelled
// schedules skipped. `groupOf(interviewStageId)` → groupId or null.
function minutesByStageGroup(schedules, { from, groupOf }) {
  const out = new Map();
  for (const s of schedules) {
    if (s.status === "Cancelled") continue;
    const groupId = groupOf(s.interviewStageId);
    if (!groupId) continue;
    for (const e of s.interviewEvents || []) {
      const start = Date.parse(e.startTime), end = Date.parse(e.endTime);
      if (!(start >= from) || !(end > start)) continue;
      const people = (e.interviewers || []).length;
      out.set(groupId, (out.get(groupId) || 0) + ((end - start) / 60000) * people);
    }
  }
  return out;
}

module.exports = { weekKey, dayKey, countInterviewLoad, interviewerLoadSnapshot, chooseStageSegments, minutesByStageGroup, MAX_STAGE_SEGMENTS, createScheduleSync };
