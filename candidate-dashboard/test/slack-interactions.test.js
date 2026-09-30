"use strict";
// Stage 1 of the Slack "Schedule" button: the public interactivity endpoint,
// its signature checks, approver mapping, and the approval it records (never a
// booking).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { verifySlackRequest, createSlackInteractions } = require("../src/scheduling/slack-interactions");
const { createService } = require("../src/scheduling/service");
const { createStore } = require("../src/scheduling/store");
const { createSlack } = require("../src/scheduling/slack");

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const sign = (body, ts = Math.floor(Date.now() / 1000), secret = SECRET) => ({ "x-slack-request-timestamp": String(ts), "x-slack-signature": "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex") });

// ---- signature verification --------------------------------------------------

test("a correctly signed, fresh request verifies; anything else doesn't", () => {
  const body = Buffer.from("payload=%7B%7D"), now = Date.now(), ts = Math.floor(now / 1000);
  assert.equal(verifySlackRequest({ rawBody: body, headers: sign(body, ts), secret: SECRET, now }), null);
  assert.equal(verifySlackRequest({ rawBody: body, headers: sign(body, ts, "a-different-secret-entirely-000"), secret: SECRET, now }), "bad signature");
  assert.equal(verifySlackRequest({ rawBody: Buffer.from("payload=%7B%22x%22%7D"), headers: sign(body, ts), secret: SECRET, now }), "bad signature");
  assert.equal(verifySlackRequest({ rawBody: body, headers: sign(body, ts - 301), secret: SECRET, now }), "stale timestamp");
  assert.equal(verifySlackRequest({ rawBody: body, headers: {}, secret: SECRET, now }), "missing or malformed signature");
  assert.equal(verifySlackRequest({ rawBody: body, headers: sign(body, ts), secret: "", now }), "missing or malformed signature");
});

test("the same signed request can't be replayed inside the window", () => {
  const body = Buffer.from("payload=%7B%7D"), now = Date.now(), headers = sign(body, Math.floor(now / 1000)), seen = new Map();
  assert.equal(verifySlackRequest({ rawBody: body, headers, secret: SECRET, now, seen }), null);
  assert.equal(verifySlackRequest({ rawBody: body, headers, secret: SECRET, now: now + 1000, seen }), "replayed request");
});

// ---- the endpoint ------------------------------------------------------------

const click = (extra = {}) => ({ type: "block_actions", team: { id: "T0CARRARA" }, api_app_id: "A0SCHED", user: { id: "U0ANNA" }, channel: { id: "C0CONFIG" },
  container: { message_ts: "1.2" }, actions: [{ action_id: "schedule_option", value: JSON.stringify({ d: "draft-1", g: "digest-1" }) }], ...extra });
async function endpoint(t, { users = { U0ANNA: { email: "anna@carrara.is", name: "Anna Jones" } }, approve } = {}) {
  const calls = { approve: [], marked: [], replies: [] };
  const service = { approveInSlack: async input => { calls.approve.push(input); if (approve) return approve(input); return { id: input.draftId, slackApproval: { name: "Anna Jones" } }; } };
  const slackApi = { userInfo: async id => users[id] || null, markApproved: async x => calls.marked.push(x), threadReply: async x => calls.replies.push(x) };
  const handler = createSlackInteractions({ service, slackApi, signingSecret: SECRET, teamId: "T0CARRARA", appId: "A0SCHED", channelId: "C0CONFIG", approvers: ["anna@carrara.is"], log: { warn() {} } });
  const app = express();
  app.post("/api/slack/interactions", express.raw({ type: "application/x-www-form-urlencoded" }), handler);
  app.use((req, res) => res.status(401).end()); // stands in for Basic Auth on every other route
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/slack/interactions`;
  const send = async (payload, { headers, raw } = {}) => {
    const body = raw ?? "payload=" + encodeURIComponent(JSON.stringify(payload));
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...(headers || sign(body)) }, body });
    await new Promise(r => setTimeout(r, 30)); // the work runs after the 200
    return res.status;
  };
  return { send, calls };
}

test("an approver's click records the approval and updates the message", async t => {
  const { send, calls } = await endpoint(t);
  assert.equal(await send(click()), 200);
  assert.deepEqual(calls.approve, [{ draftId: "draft-1", digest: "digest-1", channelId: "C0CONFIG", messageTs: "1.2", approver: { email: "anna@carrara.is", slackUserId: "U0ANNA", name: "Anna Jones" } }]);
  assert.equal(calls.marked.length, 1);
  assert.equal(calls.replies.length, 0);
});

test("the approver's identity comes from Slack, never from the payload", async t => {
  const { send, calls } = await endpoint(t, { users: { U0MALLORY: { email: "mallory@carrara.is", name: "Mallory" } } });
  await send(click({ user: { id: "U0MALLORY", email: "anna@carrara.is", name: "Anna Jones" } }));
  assert.equal(calls.approve.length, 0);
  assert.match(calls.replies[0].text, /^Mallory isn't an approver for this client's interview schedules, so nothing was recorded/);
  assert.equal(calls.replies[0].threadTs, "1.2");
});

test("a Slack user whose email can't be read is refused", async t => {
  const { send, calls } = await endpoint(t, { users: {} });
  await send(click());
  assert.equal(calls.approve.length, 0);
  assert.match(calls.replies[0].text, /isn't an approver/);
});

test("forged, replayed or misdirected requests record nothing", async t => {
  const { send, calls } = await endpoint(t);
  assert.equal(await send(click(), { headers: sign("payload=%7B%7D") }), 401);                     // signature over a different body
  assert.equal(await send(click(), { headers: sign("x", Math.floor(Date.now() / 1000) - 600) }), 401); // stale
  const body = "payload=" + encodeURIComponent(JSON.stringify(click()));
  const once = sign(body);
  assert.equal(await send(null, { raw: body, headers: once }), 200);
  assert.equal(await send(null, { raw: body, headers: once }), 401);                             // replayed
  assert.equal(await send(click({ team: { id: "T0OTHER" } })), 403);
  assert.equal(await send(click({ api_app_id: "A0OTHER" })), 403);
  assert.equal(await send(click({ channel: { id: "C0ELSEWHERE" } })), 200);                     // acknowledged, ignored
  assert.equal(await send(click({ actions: [{ action_id: "something_else", value: "{}" }] })), 200);
  assert.equal(calls.approve.length, 1); // only the one genuine click
});

test("a refused approval explains itself in the thread", async t => {
  const { send, calls } = await endpoint(t, { approve: () => { throw Object.assign(new Error("Already approved by Anna Jones at 2026-09-29 18:00 UTC."), { status: 409 }); } });
  await send(click());
  assert.equal(calls.marked.length, 0);
  assert.equal(calls.replies[0].text, "Already approved by Anna Jones at 2026-09-29 18:00 UTC. Nothing was recorded.");
});

// ---- the approval itself -----------------------------------------------------

const user = { id: "Luminai Scheduler", canApprove: true };
const candidate = { applicationId: "app", candidateId: "candidate", candidateName: "Fictional Candidate", jobTitle: "Test Role", status: "Active" };
const option = start => ({ start, end: start, events: [{ sessionId: "s", interviewId: "i", title: "Welcome", durationMinutes: 60, start, end: new Date(Date.parse(start) + 3600000).toISOString(), interviewer: { userId: "u", name: "Pat Doe", email: "pat@luminai.com" }, eligibleInterviewers: [] }] });
async function posted(t, start = "2099-01-01T10:00:00.000Z") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-slack-approve-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir);
  const service = createService({ store, candidates: async () => [candidate], clientId: "luminai", routing: "client", channelId: "C0CONFIG", channelName: "#test", slack: async () => ({ ts: "1.2", channel: "C0CONFIG" }) });
  const result = await service.postScheduleOption({ applicationId: "app", candidateId: "candidate", timezone: "UTC", option: option(start), optionNumber: 1, sourceRef: "full-schedule:r:" + start, availabilitySource: "ashby", attendance: ["in_person"], rulesRevision: 5, calendarCheck: { checkedAt: Date.now(), meetingHoursAssumed: true } }, user);
  const row = await store.get(result.id);
  const approver = { email: "anna@carrara.is", slackUserId: "U0ANNA", name: "Anna Jones" };
  const approve = extra => service.approveInSlack({ draftId: row.id, digest: row.digest, channelId: "C0CONFIG", messageTs: "1.2", approver, ...extra });
  return { service, store, row, approve };
}

test("approving records who approved this exact option, and is never booking approval", async t => {
  const { service, row, approve } = await posted(t);
  const approved = await approve();
  assert.equal(approved.state, "discussion_approved");
  assert.equal(approved.slackApproval.email, "anna@carrara.is");
  assert.equal(approved.slackApproval.digest, row.digest);
  assert.equal(approved.bookingApproval, null);
  assert.equal(approved.audit.at(-1).action, "approved_in_slack");
  await assert.rejects(service.approveBooking(row.id, { revision: approved.revision, digest: approved.digest }, user), { status: 503 });
});

test("a second click says who already approved", async t => {
  const { approve } = await posted(t);
  await approve();
  await assert.rejects(approve({ approver: { email: "grace@carrara.is", slackUserId: "U0GRACE", name: "Grace" } }), /^Error: Already approved by Anna Jones at /);
});

test("every binding is checked against the stored draft", async t => {
  const { approve } = await posted(t);
  await assert.rejects(approve({ digest: "0".repeat(64) }), /changed after it was posted/);
  await assert.rejects(approve({ messageTs: "9.9" }), /isn't the message the draft was posted as/);
  await assert.rejects(approve({ channelId: "C0ELSEWHERE" }), /isn't the message the draft was posted as/);
  await assert.rejects(approve({ draftId: "no-such-draft" }), { status: 404 });
});

test("a schedule whose start has passed can't be approved", async t => {
  const { approve } = await posted(t, "2020-01-01T10:00:00.000Z");
  await assert.rejects(approve(), /start time has already passed/);
});

// ---- the button and the approved message ---------------------------------------

function slackCapture() {
  const calls = [];
  const request = async (url, init) => { calls.push({ method: url.split("/").pop(), body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ ok: true, ts: "1.2", channel: "C1" }) }; };
  return { request, calls };
}
const checkedPlan = { format: "calendar_checked", candidateId: "c", candidateName: "TEST petrino", jobTitle: "Engineer", timezone: "America/Los_Angeles", notes: "Nothing has been booked.", sessions: [{ title: "Welcome", start: "2099-01-01T18:00:00Z", end: "2099-01-01T18:15:00Z", location: "Room / location to confirm", people: [{ name: "Pat Doe" }] }] };

test("the Schedule button appears only when interactive, with a confirmation that says nothing is booked", async () => {
  const on = slackCapture();
  await createSlack("x", on.request, { displayTimeZone: "America/Los_Angeles", interactive: true })(checkedPlan, { channelId: "C1", proposalId: "d1", approver: "a", digest: "g1" });
  const actions = on.calls[0].body.blocks.find(b => b.type === "actions");
  const [button] = actions.elements;
  assert.equal(button.text.text, "Schedule");
  assert.deepEqual(JSON.parse(button.value), { d: "d1", g: "g1" });
  assert.equal(button.confirm.confirm.text, "Approve");
  assert.match(button.confirm.text.text, /Nothing will be booked:\* booking in Ashby is blocked on IT permissions/);
  const off = slackCapture();
  await createSlack("x", off.request, { displayTimeZone: "America/Los_Angeles", interactive: false })(checkedPlan, { channelId: "C1", proposalId: "d1", approver: "a", digest: "g1" });
  assert.equal(off.calls[0].body.blocks.find(b => b.type === "actions"), undefined);
});

test("after approval the button is gone and the message says who approved, when, and that nothing is booked", async () => {
  const cap = slackCapture();
  const slack = createSlack("x", cap.request, { displayTimeZone: "America/Los_Angeles", interactive: true });
  await slack.markApproved({ channel: "C1", ts: "1.2", row: { id: "d1", plan: checkedPlan, discussionApproval: { by: "Luminai Scheduler" }, slackApproval: { email: "anna@carrara.is", name: "Anna Jones", at: "2099-01-01T17:00:00Z" } } });
  const [update] = cap.calls;
  assert.equal(update.method, "chat.update");
  assert.equal(update.body.ts, "1.2");
  assert.equal(update.body.blocks.find(b => b.type === "actions"), undefined);
  const text = update.body.blocks.map(b => b.text?.text || "").join("\n");
  assert.match(text, /\*Approved\* by Anna Jones \(anna@carrara\.is\) at Jan 1, 2099, 9:00\S* AM PST/);
  assert.match(text, /\*Not booked\.\* Booking in Ashby is blocked on IT permissions: no interviews are scheduled and no invitations or candidate email have been sent/);
  // It never claims a booking happened.
  assert.doesNotMatch(text + update.body.text, /\b(has been|was|is now) booked\b|\bbooking (is )?confirmed\b|\binvitations? (have been|were) sent\b/i);
});
