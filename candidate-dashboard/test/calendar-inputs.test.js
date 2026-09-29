"use strict";
// Calendar-constrained schedule options: the inputs assembled from Ashby,
// scheduling rules and Google free/busy (calendar-inputs.js, meeting-hours.js),
// the solver's handling of assumed hours, and the booking route that uses them.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { hoursIntervals } = require("../src/scheduling/meeting-hours");
const { buildCalendarInputs } = require("../src/scheduling/calendar-inputs");
const { proposeCalendarSchedule } = require("../src/scheduling/full-calendar-schedule");
const { parseRules } = require("../src/scheduling/rules");
const { bookingRoutes } = require("../src/scheduling/booking-routes");

const PACIFIC = { timezone: "America/Los_Angeles", days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" };
const rulesDoc = change => { const d = JSON.parse(JSON.stringify(require("../scheduling-rules/luminai.json"))); if (change) change(d); return parseRules(d, "luminai"); };

// ---- meeting hours ---------------------------------------------------------

test("meeting hours become one interval per listed weekday, across daylight saving", () => {
  const rows = hoursIntervals(PACIFIC, Date.parse("2026-10-30T00:00Z"), Date.parse("2026-11-04T00:00Z"));
  assert.deepEqual(rows, [
    { start: "2026-10-30T16:00:00.000Z", end: "2026-10-31T00:00:00.000Z" }, // Friday, PDT
    { start: "2026-11-02T17:00:00.000Z", end: "2026-11-03T01:00:00.000Z" }, // Monday, PST
    { start: "2026-11-03T17:00:00.000Z", end: "2026-11-04T01:00:00.000Z" },
  ]);
});

test("an override's own time zone is used", () => {
  const [row] = hoursIntervals({ ...PACIFIC, timezone: "America/New_York" }, Date.parse("2099-01-05T00:00Z"), Date.parse("2099-01-05T23:00Z"));
  assert.equal(row.start, "2099-01-05T14:00:00.000Z");
});

// ---- assembling inputs ---------------------------------------------------------

const ANA = { userId: "11111111-1111-1111-1111-111111111111", name: "Ana Silva", email: "ana@luminai.com" };
const TOM = { userId: "22222222-2222-2222-2222-222222222222", name: "Tom Reyes", email: "tom@luminai.com" };
const plan = { sessions: [
  { sessionId: "s1", interviewId: "i1", title: "Flexible", durationMinutes: 60, assignmentVerified: true, requiredCount: 1, eligibleInterviewers: [{ name: "Ana Silva" }, { name: "Tom Reyes" }] },
  { sessionId: "s2", interviewId: "i2", title: "Fixed", durationMinutes: 30, assignmentVerified: true, requiredCount: 1, eligibleInterviewers: [{ name: "Tom Reyes" }] },
] };
const windows = [{ start: "2099-01-05T09:00", end: "2099-01-05T17:00" }], timezone = "America/Los_Angeles";

function sources({ limits = {}, busy = {} } = {}) {
  const calls = { limits: 0, freeBusy: [] };
  const people = { "Ana Silva": ANA, "Tom Reyes": TOM };
  const facts = {
    resolveInterviewers: async sessions => ({ sessions: sessions.map(s => ({ ...s, eligibleInterviewers: s.eligibleInterviewers.map(p => people[p.name]) })), interviewers: [ANA, TOM] }),
    interviewerLimits: async ids => { calls.limits++; return new Map(ids.map(id => [id, limits[id] || { dailyLimit: null, weeklyLimit: 5 }])); },
  };
  const freeBusy = { read: async ({ calendarIds, timeMin, timeMax }) => { calls.freeBusy.push({ calendarIds, timeMin, timeMax });
    return calendarIds.map(id => ({ calendarId: id, busy: busy[id] || [], coverage: [{ start: timeMin, end: timeMax }], coverageVerified: true, checkedAt: Date.now() })); } };
  return { facts, freeBusy, calls };
}

test("interviewers are joined to free/busy by Ashby email, with assumed hours and no counts", async () => {
  const { facts, freeBusy, calls } = sources();
  const inputs = await buildCalendarInputs({ plan, windows, timezone, rules: rulesDoc(), facts, freeBusy });
  assert.deepEqual(calls.freeBusy[0].calendarIds, ["ana@luminai.com", "tom@luminai.com"]);
  assert.equal(calls.freeBusy[0].timeMin, "2099-01-05T17:00:00.000Z");
  assert.equal(inputs.calendars.length, 2);
  for (const c of inputs.calendars) { assert.equal(c.workingHoursSource, "assumed"); assert.deepEqual(c.limits, { dailyLimit: null, weeklyLimit: null }); }
  assert.deepEqual(Object.keys(inputs.calendars.find(c => c.userId === TOM.userId).sessionWorkingWindows), ["s1", "s2"]);
  assert.equal(inputs.meetingHours[0].source, "default");
  assert.deepEqual(inputs.excluded, []);
});

test("zero_only excludes a zero limit and ignores every other limit", async () => {
  const { facts, freeBusy, calls } = sources({ limits: { [ANA.userId]: { dailyLimit: 0, weeklyLimit: null } } });
  const inputs = await buildCalendarInputs({ plan, windows, timezone, rules: rulesDoc(), facts, freeBusy });
  assert.equal(calls.limits, 1);
  assert.deepEqual(inputs.excluded, [{ name: "Ana Silva", email: "ana@luminai.com", reason: "Ashby daily interview limit is 0" }]);
  assert.deepEqual(inputs.sessions[0].eligibleInterviewers.map(p => p.name), ["Tom Reyes"]);
  assert.deepEqual(calls.freeBusy[0].calendarIds, ["tom@luminai.com"]);
});

test("ignore doesn't read limits; enforce and other busy sources refuse; gaps pass through", async () => {
  const { facts, freeBusy, calls } = sources();
  await buildCalendarInputs({ plan, windows, timezone, rules: rulesDoc(d => { d.limits.ashbyInterviewerLimits = "ignore"; }), facts, freeBusy });
  assert.equal(calls.limits, 0);
  const gapped = await buildCalendarInputs({ plan, windows, timezone, rules: rulesDoc(d => { d.agenda.minBreakMinutes = 10; d.agenda.maxGapMinutes = 30; d.agenda.maxGapCount = 1; }), facts, freeBusy });
  assert.deepEqual(gapped.agenda, { minBreakMinutes: 10, maxGapMinutes: 30, maxGapCount: 1 });
  const legacy = await buildCalendarInputs({ plan, windows, timezone, rules: rulesDoc(d => { delete d.agenda.maxGapCount; }), facts, freeBusy });
  assert.equal(legacy.agenda.maxGapCount, 0);
  assert.equal(gapped.calendars[0].hoursSource, "default");
  assert.equal(gapped.calendars[0].hoursLabel, "09:00–17:00 America/Los_Angeles, client default");
  for (const change of [d => { d.limits.ashbyInterviewerLimits = "enforce"; }, d => { d.busy.source = "none"; }, d => { d.busy.calendars = ["primary", "holds"]; }])
    await assert.rejects(buildCalendarInputs({ plan, windows, timezone, rules: rulesDoc(change), facts, freeBusy }), { status: 503 });
});

test("an interviewer without meeting hours is excluded, and a session with nobody left is blocked before any calendar read", async () => {
  const { facts, freeBusy, calls } = sources();
  const inputs = await buildCalendarInputs({ plan, windows, timezone, rules: rulesDoc(d => { d.meetingHours.default = null; d.meetingHours.overrides["ana@luminai.com"] = PACIFIC; }), facts, freeBusy });
  assert.deepEqual(inputs.excluded.map(x => x.name), ["Tom Reyes"]);
  assert.match(inputs.blocked, /Fixed/);
  assert.equal(calls.freeBusy.length, 0);
});

// ---- solver with assumed hours -------------------------------------------------

test("busy time on a primary calendar is a constraint, and the result says hours are assumed", async () => {
  const { facts, freeBusy } = sources({ busy: { "tom@luminai.com": [{ start: "2099-01-05T17:00:00.000Z", end: "2099-01-05T18:30:00.000Z" }] } });
  const inputs = await buildCalendarInputs({ plan, windows, timezone, rules: rulesDoc(), facts, freeBusy });
  const result = proposeCalendarSchedule({ sessions: inputs.sessions, windows, timezone, calendars: inputs.calendars });
  assert.equal(result.status, "calendar_checked");
  assert.equal(result.availabilityVerified, false);
  assert.equal(result.meetingHoursAssumed, true);
  assert.match(result.reason, /assumed/);
  const [first] = result.proposals;
  // Tom is busy until 10:30 Pacific and is the only one who can take "Fixed".
  assert.equal(first.events[0].interviewer.name, "Ana Silva");
  assert.ok(Date.parse(first.events[1].start) >= Date.parse("2099-01-05T18:30:00.000Z"));
});

test("hours that are neither verified nor marked assumed still refuse", () => {
  const calendars = [ANA, TOM].map(p => ({ userId: p.userId, verified: true, coverageVerified: true, checkedAt: Date.now(), coverage: [{ start: "2099-01-05T17:00:00Z", end: "2099-01-06T01:00:00Z" }], busy: [], sessionWorkingWindows: { s1: [{ start: "2099-01-05T17:00:00Z", end: "2099-01-06T01:00:00Z" }], s2: [{ start: "2099-01-05T17:00:00Z", end: "2099-01-06T01:00:00Z" }] }, limits: { dailyLimit: null, weeklyLimit: null } }));
  const sessions = plan.sessions.map(s => ({ ...s, eligibleInterviewers: s.eligibleInterviewers.map(p => p.name === "Ana Silva" ? ANA : TOM) }));
  assert.throws(() => proposeCalendarSchedule({ sessions, windows, timezone, calendars }));
});

// ---- the booking route ----------------------------------------------------------

async function route(t, { busy } = {}) {
  const planSessions = plan.sessions.map(s => ({ ...s }));
  const posted = [], state = { busy: busy || {} };
  const { facts: base } = sources();
  const facts = { ...base, application: async () => ({ applicationId: "app", candidateId: "cand", stageId: "stage", templateRevision: "v1", activities: [{ sessions: planSessions }] }),
    interviewerLimits: async ids => new Map(ids.map(id => [id, { dailyLimit: null, weeklyLimit: null }])) };
  const freeBusy = { read: async ({ calendarIds, timeMin, timeMax }) => calendarIds.map(id => ({ calendarId: id, busy: state.busy[id] || [], coverage: [{ start: timeMin, end: timeMax }], coverageVerified: true, checkedAt: Date.now() })) };
  const app = express(); app.use(express.json()); app.use((req, res, next) => { req.schedulingUser = { id: "coordinator", canApprove: true }; next(); });
  app.use("/b", bookingRoutes({
    facts, googleFreeBusy: freeBusy, googleCalendar: { status: () => ({ connected: true }) }, rules: { get: () => rulesDoc() },
    availability: { requests: async () => ({ stageId: "stage", requests: [{ scheduleId: "req", updatedAt: "v" }] }), load: async () => ({ stageId: "stage", timezone, localWindows: windows }) },
    inspectPlan: async input => ({ ...input, sessions: planSessions.map(s => ({ ...s })) }),
    discussion: { postScheduleOption: async input => { posted.push(input); return { state: "shared", channelName: "#test" }; } },
  }));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/b`, headers = { "Content-Type": "application/json", "X-Scheduling-Request": "1" };
  const call = (path, body) => fetch(url + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { call, posted, state };
}
const request = { applicationId: "app", scheduleId: "req", availabilitySource: "ashby", calendarCheck: true };

test("the calendar-checked preview reports its sources, and posting rebuilds the same option", async t => {
  const { call, posted } = await route(t);
  const result = await (await call("/suggest-full-schedule", request)).json();
  assert.equal(result.status, "calendar_checked");
  assert.equal(result.calendarCheck.busySource, "Google free/busy, primary calendars");
  assert.equal(result.calendarCheck.meetingHours[0].timezone, "America/Los_Angeles");
  const r = await call("/post-full-schedule-option", { ...request, optionIndex: 0, optionDigest: result.proposals[0].optionDigest });
  assert.equal(r.status, 200);
  assert.equal(posted[0].calendarCheck.meetingHoursAssumed, true);
  assert.ok(Number.isFinite(posted[0].calendarCheck.checkedAt));
  assert.deepEqual(posted[0].attendance, ["in_person", "in_person"]);
});

test("a calendar change between preview and post refuses instead of posting a stale option", async t => {
  const { call, posted, state } = await route(t);
  const result = await (await call("/suggest-full-schedule", request)).json();
  state.busy["tom@luminai.com"] = [{ start: "2099-01-05T17:00:00.000Z", end: "2099-01-05T19:00:00.000Z" }];
  const r = await call("/post-full-schedule-option", { ...request, optionIndex: 0, optionDigest: result.proposals[0].optionDigest });
  assert.equal(r.status, 409);
  assert.equal(posted.length, 0);
});

test("without the calendar flag the preview is today's unconstrained one", async t => {
  const { call } = await route(t);
  const { calendarCheck, ...plain } = request;
  const result = await (await call("/suggest-full-schedule", plain)).json();
  assert.equal(result.availabilityVerified, false);
  assert.equal(result.calendarCheck, undefined);
});

test("start windows from the rules attach to sessions by Ashby interview name, case-insensitively", async () => {
  const lunchPlan = { sessions: [...plan.sessions, { sessionId: "s3", interviewId: "i3", title: "  team LUNCH ", durationMinutes: 45, assignmentVerified: true, requiredCount: 1, eligibleInterviewers: [{ name: "Ana Silva" }] }] };
  const { facts, freeBusy } = sources();
  const inputs = await buildCalendarInputs({ plan: lunchPlan, windows, timezone, rules: rulesDoc(), facts, freeBusy });
  assert.deepEqual(inputs.sessions.map(s => (s.placementWindows || []).map(w => `${w.earliestStart}-${w.latestStart} ${w.timezone}`)), [[], [], ["12:00-13:30 America/Los_Angeles"]]);
  const exact = rulesDoc(d => { d.sessions.placementWindows = [{ match: "exact", value: "lunch", timezone: "UTC", earliestStart: "12:00", latestStart: "13:00" }]; });
  assert.equal(exact.placementFor("Lunch").length, 1);
  assert.equal(exact.placementFor("Team lunch").length, 0);
  assert.throws(() => rulesDoc(d => { d.sessions.placementWindows[0].latestStart = "11:00"; }), { status: 503 });
});
