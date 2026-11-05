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
function createScheduleSync({ fetchPage, now = () => Date.now(), keepDays = 8, log = console }) {
  const byId = new Map(), feedback = new Map();
  let token = null, inFlight = null;
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
    if (!read) read = await readAll({ limit: 100 });
    for (const s of read.results) { byId.set(s.id, s); remember(s); }
    if (read.syncToken) token = read.syncToken;
    const cutoff = now() - keepDays * DAY;
    for (const [id, s] of byId) if (!(s.interviewEvents || []).some(e => Date.parse(e.endTime) > cutoff)) byId.delete(id);
    return [...byId.values()];
  }
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

module.exports = { weekKey, countInterviewLoad, createScheduleSync };
