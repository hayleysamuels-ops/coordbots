"use strict";
// Watching Ashby for open posts (src/scheduling/post-watch.js,
// service.closeFromAshby, slack.markClosedInAshby): an open post whose
// request Ashby shows booked, cancelled or left behind is closed once, saying
// what Ashby showed; anything else is left open. The service and store are
// real; Ashby and Slack are stand-ins. Fictional people.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPostWatch, closedReason } = require("../src/scheduling/post-watch");
const { createService } = require("../src/scheduling/service");
const { createStore, blocksRepost } = require("../src/scheduling/store");
const { createSlack, blockProblems } = require("../src/scheduling/slack");

const NOW = Date.parse("2026-11-12T18:20:00Z");
const STAGE = "stage-hm", LATER = "stage-onsite";
const plan = (name, start) => ({ candidateId: `c-${name}`, applicationId: `a-${name}`, candidateName: name, jobTitle: "Forward Deployed Engineer", timezone: "America/New_York", timezoneSource: "candidate_submitted",
  format: "calendar_checked", notes: "Posted automatically. Nothing has been booked and no invitations have been sent.",
  bookingPlan: { applicationId: `a-${name}`, interviewScheduleId: `s-${name}` },
  sessions: [{ title: "Hiring Manager Interview", start, end: start.replace(":00.000Z", ":30.000Z"), interviewers: "Dana Example", location: "Zoom", people: [{ name: "Dana Example" }] }] });
const shared = (id, name, start = "2026-11-17T15:00:00.000Z", extra = {}) => ({ id, clientId: "luminai", revision: 2, state: "shared", plan: plan(name, start), digest: "g",
  slack: { channel: "C0CONFIG", ts: "1794500000.000100" }, audit: [{ action: "drafted", by: "auto", at: "2026-11-12T17:07:00Z" }], ...extra });
const booked = { applicationStatus: "Active", stageId: STAGE, schedule: { status: "Scheduled", stageId: STAGE, scheduledBy: "Pat Coordinator",
  events: [{ start: "2026-11-17T17:00:00.000Z", end: "2026-11-17T17:30:00.000Z", interviewers: ["Dana Example"] }] } };
const pending = { applicationStatus: "Active", stageId: STAGE, schedule: { status: "CandidateAvailabilitySubmitted", stageId: STAGE, scheduledBy: null, events: [] } };

async function fixture(t, ashby) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-watch-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir);
  const service = createService({ store, candidates: async () => [], clientId: "luminai", routing: "client", channelId: "C0CONFIG", channelName: "luminai-rc-team", slack: async () => ({}) });
  const marked = [], logs = [], reads = [];
  const availability = { scheduleState: async (applicationId, scheduleId) => { reads.push(applicationId); const v = ashby[applicationId]; if (v instanceof Error) throw v; return v; } };
  const watch = createPostWatch({ service, store, slackApi: { markClosedInAshby: async x => marked.push(x) }, availability, clientId: "luminai", now: () => NOW, log: { warn: m => logs.push(m) } });
  return { store, service, watch, marked, logs, reads };
}

test("what closes a post, in order: booked, cancelled, no longer active, moved stage; anything else leaves it open", () => {
  assert.deepEqual(closedReason(booked), { kind: "booked", status: "Scheduled", by: "Pat Coordinator", events: booked.schedule.events });
  for (const status of ["WaitingOnFeedback", "Complete"]) assert.equal(closedReason({ ...booked, schedule: { ...booked.schedule, status } }).kind, "booked");
  assert.equal(closedReason({ ...booked, applicationStatus: "Archived", stageId: LATER }).kind, "booked", "booked wins over everything after it");
  assert.deepEqual(closedReason({ ...pending, schedule: { ...pending.schedule, status: "Cancelled" } }), { kind: "cancelled" });
  assert.deepEqual(closedReason({ ...pending, applicationStatus: "Archived" }), { kind: "inactive", status: "Archived" });
  assert.deepEqual(closedReason({ ...pending, stageId: LATER }), { kind: "stage" });
  assert.equal(closedReason(pending), null);
  assert.equal(closedReason({ ...pending, schedule: { ...pending.schedule, status: "WaitingOnCandidateAvailability" } }), null, "a status we don't close on");
  assert.equal(closedReason({ ...pending, schedule: null }), null, "a request missing from the list isn't proof of anything");
});

test("a sweep closes what Ashby shows booked, cancelled or left behind, once; leaves pending, unreadable, passed, approved and other clients' posts alone", async t => {
  const f = await fixture(t, {
    "a-Booked": booked,
    "a-Cancelled": { ...pending, schedule: { ...pending.schedule, status: "Cancelled" } },
    "a-Moved": { ...pending, stageId: LATER },
    "a-Archived": { ...pending, applicationStatus: "Archived" },
    "a-Pending": pending,
    "a-Unreadable": new Error("Could not refresh submitted availability from Ashby."),
  });
  for (const name of ["Booked", "Cancelled", "Moved", "Archived", "Pending", "Unreadable"]) await f.store.insert(shared(name, name));
  await f.store.insert(shared("Passed", "Passed", "2026-11-12T17:00:00.000Z"));
  await f.store.insert(shared("Approved", "Approved", undefined, { state: "discussion_approved" }));
  await f.store.insert({ ...shared("Theirs", "Theirs"), clientId: "someone-else" });
  assert.equal(await f.watch.sweep(), 4);
  assert.deepEqual(f.reads.sort(), ["a-Archived", "a-Booked", "a-Cancelled", "a-Moved", "a-Pending", "a-Unreadable"], "only open, future, own posts are read");
  const row = await f.store.get("Booked");
  assert.equal(row.state, "rejected");
  assert.deepEqual(row.closedInAshby, { at: new Date(NOW).toISOString(), kind: "booked", status: "Scheduled", by: "Pat Coordinator", events: booked.schedule.events });
  assert.equal(row.audit.at(-1).action, "closed_in_ashby");
  assert.equal(blocksRepost(row), false);
  assert.deepEqual((await f.store.get("Cancelled")).closedInAshby, { at: new Date(NOW).toISOString(), kind: "cancelled" });
  assert.equal((await f.store.get("Moved")).closedInAshby.kind, "stage");
  assert.deepEqual((await f.store.get("Archived")).closedInAshby, { at: new Date(NOW).toISOString(), kind: "inactive", status: "Archived" });
  for (const id of ["Pending", "Unreadable", "Passed"]) assert.equal((await f.store.get(id)).state, "shared", id);
  assert.equal((await f.store.get("Approved")).state, "discussion_approved");
  assert.deepEqual(f.marked.map(m => [m.row.id, m.channel, m.ts]).sort(), ["Archived", "Booked", "Cancelled", "Moved"].map(id => [id, "C0CONFIG", "1794500000.000100"]));
  assert.ok(f.logs.some(l => /Unreadable: Ashby couldn't be read .*tried again next sweep/.test(l)));
  f.marked.length = 0;
  assert.equal(await f.watch.sweep(), 0, "closed once");
  assert.equal(f.marked.length, 0);
});

test("a post approved while it was being closed stays approved, and a press on a closed post says why", async t => {
  const f = await fixture(t, {});
  await f.store.insert(shared("raced", "Raced"));
  const stale = await f.store.get("raced");
  await f.store.replace("raced", stale.revision, { ...stale, state: "discussion_approved", revision: stale.revision + 1 });
  assert.equal(await f.service.closeFromAshby(stale, { kind: "booked", events: [] }), null);
  assert.equal((await f.store.get("raced")).state, "discussion_approved");

  await f.store.insert(shared("closed", "Closed"));
  await f.service.closeFromAshby(await f.store.get("closed"), { kind: "booked", by: "Pat Coordinator", events: [] });
  const press = { draftId: "closed", digest: "g", channelId: "C0CONFIG", messageTs: "1794500000.000100", approver: { email: "pat@example-agency.com", slackUserId: "U1", name: "Pat" } };
  await assert.rejects(() => f.service.approveInSlack(press), e => e.status === 409 && /^This interview has already been booked in Ashby, so this option is closed/.test(e.message));
  await assert.rejects(() => f.service.suggestionSource(press), e => e.status === 409 && /already been booked in Ashby/.test(e.message));
});

test("the closed message: buttons gone, who booked it and when as Ashby has it, and never \"Nothing has been booked\"", async () => {
  const calls = [];
  const slack = createSlack("x", async (url, o) => { calls.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ ok: true }) }; }, { displayTimeZone: "America/Los_Angeles", interactive: true });
  const at = new Date(NOW).toISOString();
  const render = async closedInAshby => { calls.length = 0; await slack.markClosedInAshby({ channel: "C0CONFIG", ts: "1.2", row: { id: "d1", plan: plan("Sam Example", "2026-11-17T15:00:00.000Z"), closedInAshby } }); return calls[0]; };

  const update = await render({ at, kind: "booked", status: "Scheduled", by: "Pat Coordinator", events: booked.schedule.events });
  assert.equal(update.ts, "1.2");
  assert.equal(update.blocks.some(b => b.type === "actions"), false);
  assert.equal(update.blocks.at(-1).text.text, "*Booked in Ashby by Pat Coordinator* (seen Nov 12, 10:20 AM PST): Tue, Nov 17, 9:00 AM – 9:30 AM (PST) with Dana Example. This option wasn't used, so it can no longer be scheduled or replaced from here. Nothing from this message was booked or sent by the bot.");
  assert.equal(update.text, "Interview schedule for Sam Example · Forward Deployed Engineer: booked in Ashby; this option wasn't used.");
  assert.doesNotMatch(JSON.stringify(update.blocks), /Nothing has been booked/);
  assert.doesNotMatch(update.blocks[0].text.text, /press Schedule/);
  assert.deepEqual(blockProblems(update), []);

  assert.match((await render({ at, kind: "cancelled" })).blocks.at(-1).text.text, /^\*Cancelled in Ashby\* \(seen .*\): .* send them a new availability request in Ashby\.$/);
  assert.match((await render({ at, kind: "inactive", status: "Archived" })).blocks.at(-1).text.text, /^\*No longer active in Ashby\* .*application is archived/);
  const moved = await render({ at, kind: "stage" });
  assert.match(moved.blocks.at(-1).text.text, /^\*Moved on in Ashby\* .*another stage/);
  assert.match(JSON.stringify(moved.blocks), /Nothing has been booked/, "only a booked post drops that line: the others weren't booked");
  assert.equal((await render({ at, kind: "booked", events: [] })).blocks.at(-1).text.text.startsWith("*Booked in Ashby* (seen"), true, "no booker named when Ashby has none");
});
