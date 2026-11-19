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
  assert.deepEqual(a.day, { done: 1, booked: 1 });
  assert.deepEqual(a.week, { done: 2, booked: 1 });
  assert.deepEqual(a.month, { done: 3, booked: 2 });
});

test("an interview still running counts as booked until it ends", () => {
  const snap = interviewerLoadSnapshot([sched([ev("2026-11-19T17:30:00Z", [ana], { minutes: 60 })])], { users, timeZone: TZ, now: NOW });
  assert.deepEqual(row(snap, "u-ana").day, { done: 0, booked: 1 });
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
  assert.deepEqual(row(snap, "u-ben").week, { done: 0, booked: 0 });
  assert.deepEqual(row(snap, "u-cy").month, { done: 0, booked: 0 });
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
