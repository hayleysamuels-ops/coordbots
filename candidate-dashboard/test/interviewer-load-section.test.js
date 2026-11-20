"use strict";
// The Interviewer load section's counting (interviewerLoadSnapshot): what
// counts, which periods, done vs booked, and who appears. Fictional people.
const test = require("node:test");
const assert = require("node:assert/strict");
const { interviewerLoadSnapshot, dayKey } = require("../src/interviewer-load");

const TZ = "America/Los_Angeles";
// Thursday 19 November 2026, 10:00 Pacific.
const NOW = Date.parse("2026-11-19T18:00:00Z");
const ana = { id: "u-ana", firstName: "Ana", lastName: "Diaz", email: "ana@example-client.com" };
const ben = { id: "u-ben", firstName: "Ben", lastName: "Ito", email: "ben@example-client.com" };
const cy = { id: "u-cy", firstName: "Cy", lastName: "Long", email: "cy@example-client.com" };
const users = [ana, ben, cy].map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`, email: u.email }));

let n = 0;
const ev = (startIso, people, { minutes = 60, required = true } = {}) => ({
  id: `e${++n}`, startTime: startIso, endTime: new Date(Date.parse(startIso) + minutes * 60000).toISOString(),
  interviewers: people.map((p) => ({ ...p, isFeedbackRequired: required })),
});
const sched = (events, status = "Scheduled") => ({ id: `s${++n}`, status, interviewEvents: events });
const row = (snap, id) => snap.rows.find((r) => r.userId === id);
const db = (p) => ({ done: p.done, booked: p.booked });

test("periods are the calendar day, Monday-to-Sunday week and month in the display zone", () => {
  const snap = interviewerLoadSnapshot([], { users, timeZone: TZ, now: NOW });
  assert.deepEqual(snap.periods, { day: "2026-11-19", week: "2026-11-16", month: "2026-11" });
  // 23:30 Pacific on the 18th is the 19th in UTC, but the 18th here.
  assert.equal(dayKey(Date.parse("2026-11-19T07:30:00Z"), TZ), "2026-11-18");
});

test("done vs booked, and each interview lands in its day, week and month", () => {
  const snap = interviewerLoadSnapshot([
    sched([ev("2026-11-19T16:00:00Z", [ana])]),            // today 8am, ended: done
    sched([ev("2026-11-19T21:00:00Z", [ana])]),            // today 1pm: booked
    sched([ev("2026-11-17T18:00:00Z", [ana])]),            // Tuesday: week + month, not day
    sched([ev("2026-11-23T18:00:00Z", [ana])]),            // next Monday: month only
    sched([ev("2026-11-03T18:00:00Z", [ana])]),            // earlier this month
    sched([ev("2026-10-30T18:00:00Z", [ana])]),            // last month: roster only
  ], { users, timeZone: TZ, now: NOW });
  const a = row(snap, "u-ana");
  assert.deepEqual(db(a.day), { done: 1, booked: 1 });
  assert.deepEqual(db(a.week), { done: 2, booked: 1 });
  assert.deepEqual(db(a.month), { done: 3, booked: 2 });
});

test("an interview still running counts as booked until it ends", () => {
  const snap = interviewerLoadSnapshot([sched([ev("2026-11-19T17:30:00Z", [ana], { minutes: 60 })])], { users, timeZone: TZ, now: NOW });
  assert.deepEqual(db(row(snap, "u-ana").day), { done: 0, booked: 1 });
});

test("everything on the calendar counts, not just feedback-owed; cancelled doesn't", () => {
  const snap = interviewerLoadSnapshot([
    sched([ev("2026-11-17T18:00:00Z", [ana, ben], { required: false })]), // a Welcome
    sched([ev("2026-11-18T18:00:00Z", [ana])], "Cancelled"),
  ], { users, timeZone: TZ, now: NOW });
  assert.equal(row(snap, "u-ana").week.done, 1);
  assert.equal(row(snap, "u-ben").week.done, 1);
});

test("who appears: interviewed in the last 90 days or booked ahead, zeros kept, leavers out", () => {
  const snap = interviewerLoadSnapshot([
    sched([ev("2026-09-01T18:00:00Z", [ben])]),            // 79 days ago: on the list, zero now
    sched([ev("2026-08-01T18:00:00Z", [cy])]),             // over 90 days: not on it
    sched([ev("2026-12-15T18:00:00Z", [cy])]),             // ...unless booked ahead
    sched([ev("2026-11-17T18:00:00Z", [{ id: "u-gone", firstName: "Lee", lastName: "Gone" }])]),
  ], { users, timeZone: TZ, now: NOW });
  assert.deepEqual(snap.rows.map((r) => r.name), ["Ben Ito", "Cy Long"]);
  assert.deepEqual(db(row(snap, "u-ben").week), { done: 0, booked: 0 });
  assert.deepEqual(db(row(snap, "u-cy").month), { done: 0, booked: 0 });
});

test("without a user list nobody is dropped, and names come from the interview", () => {
  const snap = interviewerLoadSnapshot([sched([ev("2026-11-17T18:00:00Z", [{ id: "u-gone", firstName: "Lee", lastName: "Gone" }])])], { users: null, timeZone: TZ, now: NOW });
  assert.deepEqual(snap.rows.map((r) => r.name), ["Lee Gone"]);
});

test("the Weekly Limits count and this agree on the week", () => {
  const { countInterviewLoad, weekKey } = require("../src/interviewer-load");
  const schedules = [
    sched([ev("2026-11-17T18:00:00Z", [ana, ben], { required: false })]),
    sched([ev("2026-11-21T18:00:00Z", [ana])]),
    sched([ev("2026-11-18T18:00:00Z", [ana])], "Cancelled"),
  ];
  const limits = countInterviewLoad(schedules, { timeZone: TZ });
  const load = interviewerLoadSnapshot(schedules, { users, timeZone: TZ, now: NOW });
  for (const id of ["u-ana", "u-ben"]) {
    const w = row(load, id).week;
    assert.equal(w.done + w.booked, limits.get(id).weeks.get(weekKey(NOW, TZ)));
  }
});

test("named shared calendar accounts are left out, whatever the case; nobody else is", () => {
  const shared = { id: "u-shared", firstName: "Recruiting", lastName: "", email: "Recruiting@Example-Client.com" };
  const lookalike = { id: "u-real", firstName: "Rec", lastName: "Ruiter", email: "recruiting.lead@example-client.com" };
  const all = [...users, { id: "u-shared", name: "Recruiting", email: shared.email }, { id: "u-real", name: "Rec Ruiter", email: lookalike.email }];
  const snap = interviewerLoadSnapshot([
    sched([ev("2026-11-17T16:00:00Z", [shared], { minutes: 540 })]),
    sched([ev("2026-11-17T17:00:00Z", [ana, shared])]),
    sched([ev("2026-11-18T17:00:00Z", [lookalike])]),
  ], { users: all, timeZone: TZ, now: NOW, exclude: ["recruiting@example-client.com"] });
  assert.equal(row(snap, "u-shared"), undefined);
  assert.equal(row(snap, "u-ana").week.done, 1);
  assert.equal(row(snap, "u-real").week.done, 1);
});

test("hours: time on the calendar, an overlap counted once, per period", () => {
  const snap = interviewerLoadSnapshot([
    sched([ev("2026-11-17T17:00:00Z", [ana], { minutes: 60 })]),
    // Two candidates' lunches at once with one host: 90 minutes, not 120.
    sched([ev("2026-11-18T19:00:00Z", [ana], { minutes: 60 })]),
    sched([ev("2026-11-18T19:30:00Z", [ana], { minutes: 60 })]),
    sched([ev("2026-11-25T17:00:00Z", [ana], { minutes: 45 })]), // next week: month only
  ], { users, timeZone: TZ, now: NOW });
  const a = row(snap, "u-ana");
  assert.equal(a.week.minutes, 150);
  assert.equal(a.month.minutes, 195);
  assert.equal(a.day.minutes, 0);
  assert.equal(a.week.done + a.week.booked, 3, "the count is unchanged by the overlap");
});

test("untimed interviews count toward the number, not the hours, and are counted as such", () => {
  const BUILD = "i-build";
  const buildEv = (iso, people) => ({ ...ev(iso, people, { minutes: 270 }), interviewId: BUILD });
  const snap = interviewerLoadSnapshot([
    sched([buildEv("2026-11-17T17:00:00Z", [ana])]),
    sched([buildEv("2026-11-18T17:00:00Z", [ana])]),
    sched([ev("2026-11-18T23:00:00Z", [ana], { minutes: 60 })]),
  ], { users, timeZone: TZ, now: NOW, untimed: (id) => id === BUILD });
  const w = row(snap, "u-ana").week;
  assert.equal(w.done + w.booked, 3);
  assert.equal(w.minutes, 60);
  assert.equal(w.untimed, 2);
});

test("every row carries hours fields even with nothing timed", () => {
  const snap = interviewerLoadSnapshot([sched([ev("2026-09-01T18:00:00Z", [ben])])], { users, timeZone: TZ, now: NOW });
  assert.deepEqual(row(snap, "u-ben").week, { done: 0, booked: 0, minutes: 0, untimed: 0, byRole: [] });
  assert.equal(JSON.stringify(snap).includes("spans"), false, "working fields don't reach the page");
  assert.equal(JSON.stringify(snap).includes("roleSet"), false);
});

test("roles: each interview is split by its candidate's role; unknown ones stay in the totals only", () => {
  const eng = { departmentId: "d-eng", jobId: "j-swe", jobTitle: "Software Engineer", recruiterId: "r-1", recruiterName: "Rae Ruiz", coordinatorId: null, coordinatorName: null };
  const sales = { departmentId: "d-sales", jobId: "j-ae", jobTitle: "Account Executive", recruiterId: "r-1", recruiterName: "Rae Ruiz", coordinatorId: null, coordinatorName: null };
  const roleOf = (id) => ({ "app-eng": eng, "app-sales": sales }[id] || null);
  const s = (app, events) => ({ ...sched(events), applicationId: app });
  const snap = interviewerLoadSnapshot([
    s("app-eng", [ev("2026-11-17T17:00:00Z", [ana], { minutes: 60 })]),
    s("app-eng", [ev("2026-11-18T17:00:00Z", [ana], { minutes: 30 })]),
    s("app-sales", [ev("2026-11-18T19:00:00Z", [ana], { minutes: 45 })]),
    s("app-unknown", [ev("2026-11-18T21:00:00Z", [ana], { minutes: 15 })]),
    s("app-sales", [ev("2026-09-10T17:00:00Z", [ben])]), // ben: sales only, months ago
  ], { users, timeZone: TZ, now: NOW, roleOf });
  assert.equal(snap.roles.length, 2);
  const iEng = snap.roles.findIndex((r) => r.jobId === "j-swe");
  const iSales = snap.roles.findIndex((r) => r.jobId === "j-ae");
  const a = row(snap, "u-ana");
  assert.equal(a.week.done + a.week.booked, 4, "the total includes the unknown one");
  assert.equal(a.week.minutes, 150);
  const byRole = Object.fromEntries(a.week.byRole.map(([i, done, booked, minutes, untimed]) => [i, { n: done + booked, minutes, untimed }]));
  assert.deepEqual(byRole[iEng], { n: 2, minutes: 90, untimed: 0 });
  assert.deepEqual(byRole[iSales], { n: 1, minutes: 45, untimed: 0 });
  assert.equal(snap.unmatched.week, 1);
  assert.deepEqual(a.roles.sort(), [iEng, iSales].sort());
  assert.deepEqual(row(snap, "u-ben").roles, [iSales], "who appears when filtered to Sales");
});

test("saved role details never expire by age, and drop out when no schedule needs them", () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { createApplicationRoles } = require("../src/applicationRoles");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "roles-")), "application-roles.json");
  const a = createApplicationRoles({ file, log: { warn() {} } });
  a.set("app-1", { jobId: "j-1" }); a.set("app-2", { jobId: "j-2" }); a.flush();
  const b = createApplicationRoles({ file, log: { warn() {} } });
  assert.equal(b.get("app-1").jobId, "j-1");
  b.prune(new Set(["app-2"])); b.flush();
  assert.equal(createApplicationRoles({ file, log: { warn() {} } }).has("app-1"), false);
});

// Split by stage (stages / stageOf): each period's byStage, and byRole's
// sixth element, minutes per segment then Other.
const { chooseStageSegments, minutesByStageGroup } = require("../src/interviewer-load");
const staged = (stageId, events, status = "Scheduled") => ({ ...sched(events, status), interviewStageId: stageId });

test("byStage: minutes per stage segment, then Other; none without stages", () => {
  const schedules = [
    staged("st-intro", [ev("2026-11-17T16:00:00Z", [ana], { minutes: 30 })]),
    staged("st-onsite", [ev("2026-11-18T16:00:00Z", [ana], { minutes: 120 })]),
    staged("st-review", [ev("2026-11-18T20:00:00Z", [ana], { minutes: 15 })]), // not a segment: Other
    staged(undefined, [ev("2026-11-16T20:00:00Z", [ana], { minutes: 45 })]),    // no stage: Other
  ];
  const stageOf = (id) => ({ "st-intro": 0, "st-onsite": 1 }[id] ?? -1);
  const snap = interviewerLoadSnapshot(schedules, { users, timeZone: TZ, now: NOW, stages: ["Intro", "Onsite"], stageOf });
  assert.deepEqual(snap.stages, ["Intro", "Onsite"]);
  const a = row(snap, "u-ana");
  assert.deepEqual(a.week.byStage, [30, 120, 60]);
  assert.equal(a.week.minutes, 210);
  const plain = interviewerLoadSnapshot(schedules, { users, timeZone: TZ, now: NOW });
  assert.equal(plain.stages, null);
  assert.equal(row(plain, "u-ana").week.byStage, undefined);
});

test("byStage counts overlap once within a stage, and untimed interviews not at all", () => {
  const snap = interviewerLoadSnapshot([
    staged("st-a", [ev("2026-11-17T16:00:00Z", [ana], { minutes: 60 })]),
    staged("st-a", [ev("2026-11-17T16:30:00Z", [ana], { minutes: 60 })]), // 30 min overlap
    staged("st-a", [{ ...ev("2026-11-17T20:00:00Z", [ana]), interviewId: "build" }]),
  ], { users, timeZone: TZ, now: NOW, stages: ["A"], stageOf: () => 0, untimed: (id) => id === "build" });
  assert.deepEqual(row(snap, "u-ana").week.byStage, [90, 0]);
});

test("byRole carries the same split, for the filtered view", () => {
  const roleOf = (id) => ({ "app-1": { jobId: "j1" }, "app-2": { jobId: "j2" } }[id]);
  const snap = interviewerLoadSnapshot([
    { ...staged("st-intro", [ev("2026-11-17T16:00:00Z", [ana], { minutes: 30 })]), applicationId: "app-1" },
    { ...staged("st-onsite", [ev("2026-11-18T16:00:00Z", [ana], { minutes: 60 })]), applicationId: "app-2" },
  ], { users, timeZone: TZ, now: NOW, roleOf, stages: ["Intro", "Onsite"], stageOf: (id) => (id === "st-intro" ? 0 : 1) });
  const byJob = Object.fromEntries(row(snap, "u-ana").week.byRole.map((e) => [snap.roles[e[0]].jobId, e[5]]));
  assert.deepEqual(byJob, { j1: [30, 0, 0], j2: [0, 60, 0] });
});

const G = (id, title, order, stageType = "Active") => ({ id, title, order, stageType });
const poeticGroups = [G("ar", "Application Review", 0, "PreInterviewScreen"), G("is", "Initial Screen", 1), G("as", "Additional Screen", 2), G("sk", "Skills Assessment", 3), G("cs", "Case Study", 4), G("bg", "Background Screen", 5), G("wt", "Work Trial", 6), G("of", "Offer", 7, "Offer")];
// Poetic's 90-day minutes by group (hours ×60), rounded.
const poeticMinutes = new Map([["is", 330 * 60], ["as", 6 * 60], ["sk", 299 * 60], ["cs", 266 * 60], ["bg", 83 * 60], ["wt", 1260 * 60], ["of", 600]]);

test("unset: the five interview groups with the most hours, in plan order", () => {
  const { segments } = chooseStageSegments(poeticGroups, poeticMinutes);
  // Plan order alone would have kept Additional Screen (6h) and dropped Work Trial (1,260h).
  assert.deepEqual(segments.map((g) => g.title), ["Initial Screen", "Skills Assessment", "Case Study", "Background Screen", "Work Trial"]);
});

test("unset: only Active groups with hours count; none at all means no split", () => {
  assert.deepEqual(chooseStageSegments([G("a", "Intro", 1), G("b", "Onsite", 2), G("o", "Offer", 3, "Offer")], new Map([["a", 60], ["o", 600]])).segments.map((g) => g.title), ["Intro"]);
  // Runlayer and LiteLLM: no interview stage groups.
  const runlayer = [G("ar", "Application Review", 0, "PreInterviewScreen"), G("of", "Offer", 1, "Offer"), G("x", "Archived", 2, "Archived"), G("h", "Hired", 3, "Hired")];
  assert.equal(chooseStageSegments(runlayer, new Map([["of", 500]])).segments, null);
  assert.equal(chooseStageSegments(null, new Map()).segments, null);
});

test("configured: those groups in the order given, case-insensitive; unknown names reported; past five dropped", () => {
  const r = chooseStageSegments(poeticGroups, poeticMinutes, ["work trial", "Initial  Screen", "Nope"]);
  assert.deepEqual(r.segments.map((g) => g.title), ["Work Trial", "Initial Screen"]);
  assert.deepEqual(r.unknown, ["Nope"]);
  const six = chooseStageSegments(poeticGroups, poeticMinutes, ["Initial Screen", "Additional Screen", "Skills Assessment", "Case Study", "Background Screen", "Work Trial"]);
  assert.equal(six.segments.length, 5);
  assert.deepEqual(six.dropped, ["Work Trial"]);
  // Nothing found: no split, never a silent fallback to the automatic choice.
  assert.equal(chooseStageSegments(poeticGroups, poeticMinutes, ["Nope"]).segments, null);
});

test("minutesByStageGroup: per interviewer, from the window start, cancelled and ungrouped skipped", () => {
  const from = Date.parse("2026-11-01T00:00:00Z");
  const m = minutesByStageGroup([
    staged("st-1", [ev("2026-11-10T16:00:00Z", [ana, ben], { minutes: 60 })]),
    staged("st-1", [ev("2026-10-10T16:00:00Z", [ana], { minutes: 60 })]),          // before the window
    staged("st-1", [ev("2026-11-11T16:00:00Z", [ana], { minutes: 60 })], "Cancelled"),
    staged("st-x", [ev("2026-11-12T16:00:00Z", [ana], { minutes: 60 })]),          // no group
  ], { from, groupOf: (id) => (id === "st-1" ? "g1" : null) });
  assert.deepEqual([...m], [["g1", 120]]);
});
