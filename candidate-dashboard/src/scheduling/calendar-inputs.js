"use strict";
// Assembles full-calendar-schedule.js input from live sources:
//   1. interviewer identity: facts.resolveInterviewers (Ashby user id + email)
//   2. limits: facts.interviewerLimits, applied per scheduling-rules limits
//   3. meeting hours: scheduling-rules meetingHours, always assumed
//   4. busy time: Google free/busy for each interviewer's primary calendar
// Anyone who can't be scheduled (zero limit, no meeting hours) is removed from
// every session's eligible list and reported in `excluded`, never counted as
// free. Busy time is read last so it's as fresh as possible when the solver
// checks its age.
const { windowsToInstants } = require("./booking-planner");
const { hoursIntervals } = require("./meeting-hours");

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

async function buildCalendarInputs({ plan, windows, timezone, rules, facts, freeBusy, now = Date.now() }) {
  if (rules.busy.source !== "google_freebusy" || rules.busy.calendars.length !== 1 || rules.busy.calendars[0] !== "primary") fail(503, "Calendar checks need busy.source google_freebusy with the primary calendar only.");
  if (rules.limitsPolicy === "enforce") fail(503, "Enforced interview limits need interview counts, which aren't built. Use zero_only.");
  if (!facts?.resolveInterviewers || !freeBusy) fail(503, "Calendar checks aren't connected.");
  const candidate = windowsToInstants(windows, timezone, now);
  const rangeStart = Math.min(...candidate.map(w => w.start)), rangeEnd = Math.max(...candidate.map(w => w.end));

  const resolved = await facts.resolveInterviewers(plan.sessions);
  const people = resolved.interviewers;
  const limits = rules.limitsPolicy === "zero_only" ? await facts.interviewerLimits(people.map(p => p.userId)) : new Map();

  const excluded = [], usable = new Map(), hoursUsed = [];
  for (const person of people) {
    const limit = limits.get(person.userId);
    if (limit && (limit.dailyLimit === 0 || limit.weeklyLimit === 0)) { excluded.push({ name: person.name, email: person.email, reason: `Ashby ${limit.dailyLimit === 0 ? "daily" : "weekly"} interview limit is 0` }); continue; }
    const { hours, source } = rules.meetingHoursFor(person.email);
    if (!hours) { excluded.push({ name: person.name, email: person.email, reason: "No meeting hours in the client rules" }); continue; }
    usable.set(person.userId, { person, hours, source, intervals: hoursIntervals(hours, rangeStart, rangeEnd) });
    hoursUsed.push({ name: person.name, email: person.email, source, timezone: hours.timezone, days: hours.days, start: hours.start, end: hours.end });
  }
  const sessions = resolved.sessions.map(s => {
    const placementWindows = rules.placementFor(s.title);
    return { ...s, eligibleInterviewers: s.eligibleInterviewers.filter(p => usable.has(p.userId)), ...(placementWindows.length ? { placementWindows } : {}) };
  });
  const context = { excluded, meetingHours: hoursUsed, limitsPolicy: rules.limitsPolicy, rulesRevision: rules.rulesRevision, busySource: "Google free/busy, primary calendars" };
  const empty = sessions.find(s => !s.eligibleInterviewers.length);
  if (empty) return { ...context, blocked: `No eligible interviewer can take ${empty.title}: every one is excluded (see below).` };

  const rows = await freeBusy.read({ calendarIds: [...usable.values()].map(u => u.person.email), timeMin: new Date(rangeStart).toISOString(), timeMax: new Date(rangeEnd).toISOString() });
  const byEmail = new Map(rows.map(r => [String(r.calendarId).toLowerCase(), r]));
  const calendars = [...usable.values()].map(({ person, hours, source, intervals }) => {
    const row = byEmail.get(person.email);
    if (!row) fail(409, `Google returned no calendar for ${person.name}.`);
    return {
      userId: person.userId, verified: true, coverageVerified: row.coverageVerified === true,
      // "default" is the client's placeholder hours, "override" hours set for
      // this person; the solver's no-fit report keeps the two apart.
      workingHoursSource: "assumed", hoursSource: source, hoursLabel: `${hours.start}–${hours.end} ${hours.timezone}, ${source === "default" ? "client default" : "set for this person"}`,
      checkedAt: row.checkedAt, coverage: row.coverage, busy: row.busy,
      sessionWorkingWindows: Object.fromEntries(sessions.filter(s => s.eligibleInterviewers.some(p => p.userId === person.userId)).map(s => [s.sessionId, intervals])),
      // zero_only: zero limits were excluded above; every other limit is ignored.
      limits: { dailyLimit: null, weeklyLimit: null },
    };
  });
  return { ...context, sessions, calendars, agenda: { minBreakMinutes: rules.agenda.minBreakMinutes, maxGapMinutes: rules.agenda.maxGapMinutes } };
}

module.exports = { buildCalendarInputs };
