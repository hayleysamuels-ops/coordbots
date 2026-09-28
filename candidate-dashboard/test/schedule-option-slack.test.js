"use strict";
// Posting one Full schedule option to Slack for discussion: the service path
// (draft -> share, channel from config only) and the booking route that
// rebuilds the option server-side before posting.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { createService } = require("../src/scheduling/service");
const { createStore } = require("../src/scheduling/store");
const { bookingRoutes } = require("../src/scheduling/booking-routes");

const user = { id: "coordinator", canApprove: true };
const candidate = { applicationId: "app", candidateId: "candidate", candidateName: "Fictional Candidate", jobTitle: "Test Role", status: "Active" };
const option = { start: "2099-01-01T10:00:00.000Z", end: "2099-01-01T11:00:00.000Z", events: [
  { sessionId: "s", interviewId: "i", title: "Welcome", durationMinutes: 60, start: "2099-01-01T10:00:00.000Z", end: "2099-01-01T11:00:00.000Z",
    interviewer: { name: "Plan Interviewer" }, eligibleInterviewers: [{ name: "Plan Interviewer" }] }] };
const post = (extra = {}) => ({ applicationId: "app", candidateId: "candidate", timezone: "UTC", option, optionNumber: 1, sourceRef: "full-schedule:request:abc", availabilitySource: "ashby", ...extra });

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-option-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir), sent = [];
  const service = createService({ store, candidates: async () => [candidate], clientId: "luminai", routing: "client", channelId: "C0CONFIG", channelName: "luminai-scheduling",
    slack: async (plan, meta) => { sent.push({ plan, meta }); return { ts: "1.2", channel: meta.channelId }; }, ...options });
  return { service, store, sent };
}

test("an option is posted once, to the configured channel, as an unbooked discussion draft", async t => {
  const { service, store, sent } = setup(t);
  const result = await service.postScheduleOption(post(), user);
  assert.equal(result.state, "shared");
  assert.equal(result.channelName, "luminai-scheduling");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].meta.channelId, "C0CONFIG");
  assert.equal(sent[0].plan.source, "full_schedule_option");
  assert.match(sent[0].plan.notes, /Not calendar-checked/);
  assert.match(sent[0].plan.sessions[0].interviewers, /suggested, not calendar-checked/);
  const [row] = await store.list();
  assert.equal(row.bookingApproval, null);
});

test("a missing or malformed channel refuses, never falls back, and leaves no draft behind", async t => {
  for (const channelId of [undefined, "not-a-channel"]) {
    const { service, store, sent } = setup(t, { channelId });
    await assert.rejects(service.postScheduleOption(post(), user), { status: 503 });
    assert.equal(sent.length, 0);
    assert.deepEqual(await store.list(), []);
  }
  const { service, sent } = setup(t, { slack: null });
  await assert.rejects(service.postScheduleOption(post(), user), { status: 503 });
  assert.equal(sent.length, 0);
});

test("the same option can't be posted twice, even by overlapping requests", async t => {
  const { service, sent } = setup(t);
  const results = await Promise.allSettled([service.postScheduleOption(post(), user), service.postScheduleOption(post(), user)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(sent.length, 1);
  await assert.rejects(service.postScheduleOption(post(), user), { status: 409 });
  assert.equal(sent.length, 1);
});

test("a different option for the same candidate can be posted after the first", async t => {
  const { service, sent } = setup(t);
  await service.postScheduleOption(post(), user);
  await service.postScheduleOption(post({ sourceRef: "full-schedule:request:other", optionNumber: 2 }), user);
  assert.equal(sent.length, 2);
});

test("a refusal before the claim rejects the unposted draft so a retry can post", async t => {
  let changed = true;
  const { service, store, sent } = setup(t, { templateReader: async () => ({ candidateId: changed ? "someone-else" : "candidate" }) });
  await assert.rejects(service.postScheduleOption(post(), user), { status: 409 });
  assert.equal(sent.length, 0);
  assert.deepEqual((await store.list()).map(r => r.state), ["rejected"]);
  changed = false;
  assert.equal((await service.postScheduleOption(post(), user)).state, "shared");
  assert.equal(sent.length, 1);
});

test("an unverified Slack response is recorded as uncertain and blocks a second post", async t => {
  let calls = 0;
  const { service } = setup(t, { slack: async () => { calls++; throw new Error("timeout"); } });
  assert.equal((await service.postScheduleOption(post(), user)).state, "discussion_uncertain");
  await assert.rejects(service.postScheduleOption(post(), user), { status: 409 });
  assert.equal(calls, 1);
});

test("shared-login users and a changed candidate can't post", async t => {
  const { service, sent } = setup(t);
  await assert.rejects(service.postScheduleOption(post(), {}), { status: 403 });
  await assert.rejects(service.postScheduleOption(post({ candidateId: "spoof" }), user), { status: 409 });
  assert.equal(sent.length, 0);
});

// ---- the booking route ------------------------------------------------------

async function routeFixture(t) {
  const sessions = [{ sessionId: "s", interviewId: "i", title: "Welcome", durationMinutes: 15 }];
  const plan = { applicationId: "app", candidateId: "candidate", stageId: "stage", templateRevision: "v1", activities: [{ sessions }] };
  const posted = [];
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.get("X-Test-User") === "coordinator") req.schedulingUser = user; next(); });
  app.use("/booking", bookingRoutes({
    facts: { application: async () => plan },
    availability: { requests: async () => ({ stageId: "stage", requests: [{ scheduleId: "request", updatedAt: "version" }] }),
      load: async () => ({ stageId: "stage", timezone: "UTC", localWindows: [{ start: "2099-01-01T10:00", end: "2099-01-01T11:00" }] }) },
    inspectPlan: async input => ({ ...input, sessions: sessions.map(s => ({ ...s, assignmentVerified: true, requiredCount: 1, eligibleInterviewers: [{ name: "Plan Interviewer" }] })) }),
    discussion: { postScheduleOption: async (input, u) => { posted.push({ input, u }); return { state: "shared", channelName: "luminai-scheduling" }; } },
  }));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/booking`;
  return { base, posted };
}
const headers = { "X-Test-User": "coordinator", "X-Scheduling-Request": "1", "Content-Type": "application/json" };
const request = { applicationId: "app", scheduleId: "request", availabilitySource: "ashby" };

test("posting rebuilds the option server-side and ignores a browser-supplied channel", async t => {
  const { base, posted } = await routeFixture(t);
  const suggested = await (await fetch(base + "/suggest-full-schedule", { method: "POST", headers, body: JSON.stringify(request) })).json();
  const digest = suggested.proposals[0].optionDigest;
  assert.match(digest, /^[0-9a-f]{64}$/);
  const r = await fetch(base + "/post-full-schedule-option", { method: "POST", headers,
    body: JSON.stringify({ ...request, optionIndex: 0, optionDigest: digest, channelId: "C0ATTACKER", events: [{ title: "spoof" }] }) });
  assert.equal(r.status, 200);
  assert.equal(posted.length, 1);
  const { input } = posted[0];
  assert.equal(input.sourceRef, "full-schedule:request:" + digest);
  assert.equal(input.option.events[0].interviewer.name, "Plan Interviewer");
  assert.equal(input.option.optionDigest, undefined);
  assert.ok(!JSON.stringify(input).includes("C0ATTACKER"));
});

test("a stale or unknown option, or no coordinator login, posts nothing", async t => {
  const { base, posted } = await routeFixture(t);
  const send = (body, h = headers) => fetch(base + "/post-full-schedule-option", { method: "POST", headers: h, body: JSON.stringify({ ...request, ...body }) });
  assert.equal((await send({ optionIndex: 0, optionDigest: "0".repeat(64) })).status, 409);
  assert.equal((await send({ optionIndex: 7, optionDigest: "0".repeat(64) })).status, 409);
  assert.equal((await send({ optionIndex: "0", optionDigest: "x" })).status, 422);
  assert.equal((await send({ optionIndex: 0, optionDigest: "x" }, { "X-Scheduling-Request": "1", "Content-Type": "application/json" })).status, 403);
  assert.equal(posted.length, 0);
});

test("without the discussion service the route refuses", async t => {
  const app = express(); app.use(express.json()); app.use((req, res, next) => { req.schedulingUser = user; next(); });
  app.use("/booking", bookingRoutes({}));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const r = await fetch(`http://127.0.0.1:${server.address().port}/booking/post-full-schedule-option`, { method: "POST", headers, body: "{}" });
  assert.equal(r.status, 503);
});

test("the store refuses a second row for a posted option even when the first is no longer active", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-option-store-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir), row = (id, candidateId, state) => ({ id, clientId: "luminai", state, revision: 1, plan: { candidateId, sourceRef: "full-schedule:request:abc" } });
  assert.equal(await store.insert(row("1", "candidate", "shared")), true);
  assert.equal(await store.insert(row("2", "candidate", "draft")), false);
  assert.equal(await store.insert({ ...row("3", "other", "draft"), clientId: "another-client" }), true);
});

// ---- message text -----------------------------------------------------------

const { createSlack } = require("../src/scheduling/slack");
async function render(plan) {
  let text;
  const slack = createSlack("fictional-token", async (url, init) => { text = JSON.parse(init.body).text; return { ok: true, json: async () => ({ ok: true, ts: "1", channel: "C1" }) }; }, { displayTimeZone: "America/Los_Angeles" });
  await slack({ candidateName: "Fictional", jobTitle: "Role", notes: "", ...plan }, { channelId: "C1", proposalId: "ref", approver: "coordinator" });
  // Intl puts narrow no-break and thin spaces around AM/PM and the dash.
  return text.replace(/[\u202f\u2009]/g, " ");
}
const session = { title: "Welcome", start: "2026-10-01T17:00:00.000Z", end: "2026-10-01T17:15:00.000Z", interviewers: "Someone", location: "Room" };

test("posts use a neutral header and never say the schedule was approved", async () => {
  const text = await render({ timezone: "America/Los_Angeles", sessions: [session] });
  assert.match(text, /^INTERVIEW SCHEDULE DRAFT — FOR DISCUSSION/);
  assert.doesNotMatch(text, /ONSITE|Approved/);
  assert.match(text, /Posted for discussion by coordinator\./);
});

test("coordinator time comes first, then the candidate's submitted time, each labelled", async () => {
  const text = await render({ timezone: "America/New_York", timezoneSource: "candidate_submitted", sessions: [session] });
  const coordinator = text.indexOf("Coordinator time (America/Los_Angeles): Oct 1, 2026, 10:00 – 10:15 AM");
  const candidateLine = text.indexOf("Candidate time (America/New_York, as submitted): Oct 1, 2026, 1:00 – 1:15 PM");
  assert.ok(coordinator > 0 && candidateLine > coordinator, text);
});

test("coordinator-entered times are never labelled as the candidate's", async () => {
  const text = await render({ timezone: "Europe/London", sessions: [session] });
  assert.match(text, /Entered time \(Europe\/London\): Oct 1, 2026, 6:00 – 6:15 PM/);
  assert.doesNotMatch(text, /Candidate time/);
});

test("one line when both timezones match", async () => {
  const text = await render({ timezone: "America/Los_Angeles", timezoneSource: "candidate_submitted", sessions: [session] });
  assert.match(text, /Coordinator time \(America\/Los_Angeles\), same as the candidate's submitted timezone: Oct 1, 2026, 10:00 – 10:15 AM/);
  assert.equal((text.match(/10:00/g) || []).length, 1);
});
