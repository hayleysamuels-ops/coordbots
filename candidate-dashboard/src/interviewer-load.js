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
function interviewerLoadSnapshot(schedules, { users = null, timeZone, now = Date.now(), rosterDays = 90, exclude = [] }) {
  const excluded = new Set(exclude.map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  const keys = { day: dayKey(now, timeZone), week: weekKey(now, timeZone), month: dayKey(now, timeZone).slice(0, 7) };
  const rosterFrom = now - rosterDays * DAY;
  const enabled = users ? new Map(users.map((u) => [u.id, u])) : null;
  const rows = new Map();
  const blank = () => ({ done: 0, booked: 0 });
  for (const schedule of schedules) {
    if (schedule.status === "Cancelled") continue;
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
          row = { userId: interviewer.id, name, day: blank(), week: blank(), month: blank() };
          rows.set(interviewer.id, row);
        }
        for (const period of ["day", "week", "month"]) if (at[period] === keys[period]) row[period][state]++;
      }
    }
  }
  return {
    periods: keys,
    timeZone,
    rosterDays,
    rows: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

module.exports = { weekKey, dayKey, countInterviewLoad, interviewerLoadSnapshot, createScheduleSync };
