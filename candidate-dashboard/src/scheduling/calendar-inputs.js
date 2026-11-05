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
const { unreadableError } = require("./google-freebusy");

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// excludeInterviewers ([{ session, userId, name }], from Slack's "Suggest
// different interviewer"): that person is left out of that session only
// (session is its 0-based place in the plan). A session left with no one says
// so by name, before any calendar is read.
// requireInterviewers ([{ session, userId, name }], from a Slack amend): that
// session is narrowed to that one person. Someone Ashby no longer lists for
// it, or who can't be scheduled (zero limit, no meeting hours), blocks by
// name; nobody else is put in their place.
// A panel session (plan-reader.js `slots`) is filtered slot by slot: an
// excluded person leaves every slot of that session, and a required person
// must take one of its slots (requiredUserIds, which the solver holds), with
// the other slots filled as usual. A slot left with no one blocks by number.
async function buildCalendarInputs({ plan, windows, timezone, rules, facts, freeBusy, now = Date.now(), excludeInterviewers = [], requireInterviewers = [] }) {
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
  const steered = (i, userId) => excludeInterviewers.some(x => x.session === i && x.userId === userId);
  const required = i => requireInterviewers.find(r => r.session === i);
  // A panel can have one required person per slot (a Slack amend keeps the rest of it).
  const requiredAll = i => requireInterviewers.filter(r => r.session === i);
  // A required session is checked below instead: the requirement wins.
  const noOneElse = resolved.sessions.map((s, i) => ({ s, i, left: s.eligibleInterviewers.filter(p => usable.has(p.userId)) }))
    .find(({ i, left }) => !required(i) && left.length && left.every(p => steered(i, p.userId)));
  if (noOneElse) {
    const names = excludeInterviewers.filter(x => x.session === noOneElse.i).map(x => x.name || "the interviewer asked about").join(" or ");
    return { excluded, meetingHours: hoursUsed, limitsPolicy: rules.limitsPolicy, rulesRevision: rules.rulesRevision, busySource: "Google free/busy, primary calendars",
      blocked: `No one other than ${names} is eligible for session ${noOneElse.i + 1} ("${noOneElse.s.title}").`, noOtherInterviewer: true };
  }
  const exclusionOf = userId => excluded.find(x => x.email === people.find(p => p.userId === userId)?.email)?.reason || "excluded";
  for (const r of requireInterviewers) {
    const s = resolved.sessions[r.session];
    const code = !s ? "session_gone" : !s.eligibleInterviewers.some(p => p.userId === r.userId) ? "not_eligible" : !usable.has(r.userId) ? exclusionOf(r.userId) : null;
    const why = code === "session_gone" ? "isn't on the plan" : code === "not_eligible" ? "isn't eligible for it in Ashby any more" : `can't be scheduled (${code})`;
    // `requirement` lets the caller word a standing request (requests.js).
    if (code) return { excluded, meetingHours: hoursUsed, limitsPolicy: rules.limitsPolicy, rulesRevision: rules.rulesRevision, busySource: "Google free/busy, primary calendars",
      blocked: `${r.name} can't take session ${r.session + 1}${s ? ` ("${s.title}")` : ""}: ${r.name} ${why}.`, noOtherInterviewer: true, requirement: { session: r.session, userId: r.userId, why: code } };
  }
  const sessions = resolved.sessions.map((s, i) => {
    const placementWindows = rules.placementFor(s.title);
    let eligibleInterviewers, panel = {};
    if (s.slots) {
      const slots = s.slots.map(x => ({ eligibleInterviewers: x.eligibleInterviewers.filter(p => usable.has(p.userId) && !steered(i, p.userId)) }));
      const seen = new Map(); for (const x of slots) for (const p of x.eligibleInterviewers) if (!seen.has(p.userId)) seen.set(p.userId, p);
      eligibleInterviewers = [...seen.values()];
      panel = { slots, ...(required(i) ? { requiredUserIds: [...new Set(requiredAll(i).map(r => r.userId))] } : {}) };
    } else eligibleInterviewers = s.eligibleInterviewers.filter(p => usable.has(p.userId) && (required(i) ? p.userId === required(i).userId : !steered(i, p.userId)));
    // Preferred interviewers by email, in order, and last resorts, for this
    // job's session; kept only if eligible and usable.
    const preference = rules.preferenceFor ? rules.preferenceFor(s.title, plan.jobId) : { first: [], last: [] };
    const ids = emails => emails.map(email => eligibleInterviewers.find(p => p.email === email)?.userId).filter(Boolean);
    const preferredUserIds = ids(preference.first), lastResortUserIds = ids(preference.last);
    return { ...s, eligibleInterviewers, ...panel, ...(placementWindows.length ? { placementWindows } : {}), ...(preferredUserIds.length ? { preferredUserIds } : {}), ...(lastResortUserIds.length ? { lastResortUserIds } : {}) };
  });
  const context = { excluded, meetingHours: hoursUsed, limitsPolicy: rules.limitsPolicy, rulesRevision: rules.rulesRevision, busySource: "Google free/busy, primary calendars" };
  const empty = sessions.find(s => !s.eligibleInterviewers.length);
  if (empty) return { ...context, blocked: `No eligible interviewer can take ${empty.title}: every one is excluded (see below).` };
  for (const [i, s] of sessions.entries()) {
    const k = (s.slots || []).findIndex(x => !x.eligibleInterviewers.length);
    if (k < 0) continue;
    const asked = excludeInterviewers.some(x => x.session === i);
    return { ...context, blocked: `No eligible interviewer can take slot ${k + 1} of ${s.title} (a panel of ${s.slots.length}): ${asked ? "everyone left for it was asked to be left out, or is excluded (see below)" : "every one is excluded (see below)"}.`, ...(asked ? { noOtherInterviewer: true } : {}) };
  }

  // An unreadable calendar refuses the whole check. It's never counted as free
  // or busy, and its interviewer isn't dropped. The refusal names every one,
  // here by interviewer name, with what the coordinator can do about it.
  let rows;
  try {
    rows = await freeBusy.read({ calendarIds: [...usable.values()].map(u => u.person.email), timeMin: new Date(rangeStart).toISOString(), timeMax: new Date(rangeEnd).toISOString() });
  } catch (e) {
    if (!e.unreadable) throw e;
    const names = new Map([...usable.values()].map(u => [u.person.email.toLowerCase(), u.person.name]));
    throw unreadableError(e.unreadable, { total: e.total, account: e.account, nameFor: id => names.get(String(id).toLowerCase()) });
  }
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
  return { ...context, sessions, calendars, agenda: { minBreakMinutes: rules.agenda.minBreakMinutes, maxGapMinutes: rules.agenda.maxGapMinutes, maxGapCount: rules.agenda.maxGapCount, excludedWeekdays: rules.agenda.excludedWeekdays || null } };
}

module.exports = { buildCalendarInputs };
