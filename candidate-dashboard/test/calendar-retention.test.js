"use strict";
// Retention for Google Calendar data in scheduling.json drafts: busy flags and
// the free/clash label go 90 days after the later of the last session's end
// and the draft's last update. The draft, and rules-based "hours" flags, stay.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createService, digest } = require("../src/scheduling/service");
const { createStore } = require("../src/scheduling/store");
const { sweep, dueAt } = require("../src/scheduling/calendar-retention");

const DAY = 24 * 60 * 60 * 1000;
const user = { id: "coord@example.test", canApprove: true };
const candidate = { applicationId: "app", candidateId: "candidate", candidateName: "Fictional Candidate", jobTitle: "Test Role", status: "Active" };
const sessions = [
  { title: "Welcome", start: "2030-01-02T17:00:00Z", end: "2030-01-02T17:30:00Z", interviewers: "Fictional Host (free on primary calendar)", location: "Room / location to confirm" },
  { title: "System Design", start: "2030-01-02T17:30:00Z", end: "2030-01-02T18:30:00Z", interviewers: "Fictional Interviewer (calendar clash flagged)", location: "Video link required" },
];
const busy = { kind: "busy", name: "Fictional Interviewer", start: "2030-01-02T17:45:00Z", end: "2030-01-02T18:15:00Z", minutes: 30 };
const hours = { kind: "hours", name: "Fictional Interviewer", start: "2030-01-02T17:30:00Z", end: "2030-01-02T18:00:00Z", minutes: 30, hoursSource: "assumed", hoursLabel: "09:00–17:00 PT" };
const lastSessionEnd = Date.parse("2030-01-02T18:30:00Z");

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-retention-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir);
  const service = createService({ store, candidates: async () => [candidate], clientId: "test" });
  const row = await service.draft({ applicationId: "app", timezone: "America/Los_Angeles", sessions }, user,
    { source: "full_schedule_option", sourceRef: "ref", format: "calendar_checked",
      people: [[{ name: "Fictional Host" }], [{ name: "Fictional Interviewer" }]], flags: [[], [busy, hours]] });
  const logs = [];
  return { store, service, row, logs, log: line => logs.push(line) };
}

test("due date is 90 days after the later of the last session end and the last update", () => {
  const row = { plan: { sessions }, audit: [{ at: "2029-12-01T00:00:00Z" }] };
  assert.equal(dueAt(row), lastSessionEnd + 90 * DAY);
  const laterUpdate = { ...row, audit: [...row.audit, { at: "2030-03-01T00:00:00Z" }] };
  assert.equal(dueAt(laterUpdate), Date.parse("2030-03-01T00:00:00Z") + 90 * DAY);
  assert.equal(dueAt({ plan: { sessions: [] }, audit: [] }), null);
});

test("nothing is removed before the due date", async t => {
  const { store, row, log, logs } = await setup(t);
  const result = await sweep({ store, now: lastSessionEnd + 90 * DAY - 1, log });
  assert.equal(result.drafts, 0);
  assert.deepEqual(await store.get(row.id), row);
  assert.match(logs.at(-1), /sweep done: 0 draft\(s\) updated/);
});

test("on the due date, busy intervals and Google labels go; the draft and hours flags stay", async t => {
  const { store, row, log, logs } = await setup(t);
  const now = lastSessionEnd + 90 * DAY;
  const result = await sweep({ store, now, log });
  assert.deepEqual({ drafts: result.drafts, busyFlags: result.busyFlags, labels: result.labels }, { drafts: 1, busyFlags: 1, labels: 2 });
  const after = await store.get(row.id);
  assert.equal(after.state, row.state);
  assert.equal(after.plan.sessions.length, 2);
  const storedHours = row.plan.sessions[1].flags.find(f => f.kind === "hours");
  assert.deepEqual(after.plan.sessions.map(s => s.flags), [undefined, [storedHours]]);
  assert.deepEqual(after.plan.sessions.map(s => s.interviewers), [
    "Fictional Host (calendar check details removed after 90 days)",
    "Fictional Interviewer (calendar check details removed after 90 days)",
  ]);
  assert.equal(JSON.stringify(after).includes("free on primary calendar"), false);
  assert.equal(JSON.stringify(after).includes(busy.start), false);
  // Everything else in the plan is untouched.
  const { sessions: _a, ...restBefore } = row.plan, { sessions: _b, ...restAfter } = after.plan;
  assert.deepEqual(restAfter, restBefore);
  // Revision-checked, digest kept consistent, and recorded in the audit trail.
  assert.equal(after.revision, row.revision + 1);
  assert.equal(after.digest, digest(after.plan));
  assert.notEqual(after.digest, row.digest);
  assert.deepEqual(after.audit.at(-1), { action: "calendar_data_removed", by: "retention", at: new Date(now).toISOString(), busyFlags: 1, labels: 2 });
  // Logged by draft id and counts, never interviewer names.
  assert.ok(logs.some(l => l.includes(row.id) && /removed 1 busy interval\(s\) and 2 calendar label\(s\)/.test(l)));
  assert.equal(logs.some(l => l.includes("Fictional")), false);
});

test("a later update pushes the due date back", async t => {
  const { store, row, log } = await setup(t);
  const updated = { ...row, revision: row.revision + 1, audit: [...row.audit, { action: "rejected", by: user.id, at: new Date(lastSessionEnd + 30 * DAY).toISOString() }] };
  assert.equal(await store.replace(row.id, row.revision, updated), true);
  assert.equal((await sweep({ store, now: lastSessionEnd + 90 * DAY, log })).drafts, 0);
  assert.equal((await sweep({ store, now: lastSessionEnd + 120 * DAY, log })).drafts, 1);
});

test("a second sweep finds nothing left to remove", async t => {
  const { store, row, log } = await setup(t);
  const now = lastSessionEnd + 100 * DAY;
  await sweep({ store, now, log });
  const once = await store.get(row.id);
  assert.equal((await sweep({ store, now: now + 365 * DAY, log })).drafts, 0);
  assert.deepEqual(await store.get(row.id), once);
});

test("a draft with no calendar data is never touched", async t => {
  const { store, service, row, log } = await setup(t);
  // One open draft per candidate, so close the calendar-checked one first.
  await service.reject(row.id, { revision: row.revision, digest: row.digest }, user);
  const plain = await service.draft({ applicationId: "app", timezone: "America/Los_Angeles",
    sessions: [{ ...sessions[0], interviewers: "Fictional Host (suggested, not calendar-checked)" }] }, user);
  await sweep({ store, now: lastSessionEnd + 400 * DAY, log });
  assert.deepEqual(await store.get(plain.id), plain);
});

test("a busy store is logged and retried next sweep, not fatal", async t => {
  const { store, row, log, logs } = await setup(t);
  const busyStore = { list: store.list, replace: async () => { throw Object.assign(new Error("Scheduling is busy or requires recovery."), { status: 409 }); } };
  const result = await sweep({ store: busyStore, now: lastSessionEnd + 90 * DAY, log });
  assert.equal(result.failed, 1);
  assert.match(logs.at(-1), /1 failed \(retried next sweep\)/);
  assert.deepEqual(await store.get(row.id), row);
});
