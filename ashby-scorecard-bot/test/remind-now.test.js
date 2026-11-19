"use strict";
// The dashboard's "remind now" path: who gets a DM, the cooldown, and the
// route's auth. Fictional people and ids; no Slack or Ashby calls.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "xoxb-fictional";
const { createRemindNow, parseRequest } = require("../src/remind-now");
const { createServer } = require("../src/server");
const { buildManualMessage } = require("../src/slack");

const EVENT = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const ana = { userId: "u-ana", email: "ana@example-client.com", name: "Ana Diaz" };
const ben = { userId: "u-ben", email: "ben@example-client.com", name: "Ben Ito" };
const links = (id) => ({ scorecardUrl: `https://ashby.example/${id}/feedback`, briefingUrl: `https://ashby.example/${id}` });

function harness({ submitted = [], verified = true, slackUsers = ["ana@example-client.com", "ben@example-client.com"], cooldownHours = 4 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-now-"));
  const sent = [];
  let t = Date.UTC(2026, 10, 18, 17, 0);
  const make = () => createRemindNow({
    filterAlreadySubmitted: async (r) => ({ recipients: r.interviewers.filter((i) => !submitted.includes(i.email)), verified }),
    sendManualReminder: async (i, ctx) => {
      if (!slackUsers.includes(i.email)) return { sent: false, reason: "no Slack account with their Ashby email" };
      sent.push({ to: i.email, ctx });
      return { sent: true };
    },
    interviewLinks: links, dataDir: dir, cooldownHours, now: () => t, log: { log() {}, warn() {} },
  });
  return { dir, sent, make, advance: (h) => { t += h * 3600000; } };
}
const request = (over = {}) => ({
  interviewEventId: EVENT, applicationId: APP, interviewers: [ana, ben],
  candidateName: "Cara Moss", jobTitle: "Engineer", candidateUrl: "https://app.ashbyhq.com/candidates/c-1", requestedByName: "Kit Quinn", requestedByEmail: "kit@example-client.com", ...over,
});

test("only people still missing get a DM", async () => {
  const h = harness({ submitted: ["ben@example-client.com"] });
  const out = await h.make().remind(request());
  assert.deepEqual(out.sent, [{ name: "Ana Diaz" }]);
  assert.deepEqual(out.skipped, [{ name: "Ben Ito", reason: "already submitted" }]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].ctx.requestedByName, "Kit Quinn");
  assert.equal(h.sent[0].ctx.candidateUrl, "https://app.ashbyhq.com/candidates/c-1");
  // No candidate page: the name links to the scorecard instead.
  const h2 = harness();
  await h2.make().remind(request({ candidateUrl: null }));
  assert.equal(h2.sent[0].ctx.candidateUrl, `https://ashby.example/${EVENT}/feedback`);
});

test("a second request inside the cooldown sends nothing, and survives a restart", async () => {
  const h = harness();
  await h.make().remind(request());
  h.advance(1);
  const again = await h.make().remind(request()); // a fresh instance reads the saved file
  assert.equal(h.sent.length, 2);
  assert.deepEqual(again.sent, []);
  assert.deepEqual(again.skipped.map((s) => s.reason), ["reminded too recently", "reminded too recently"]);
  assert.equal(again.skipped[0].lastBy, "kit@example-client.com");
  h.advance(3.5);
  const later = await h.make().remind(request());
  assert.equal(later.sent.length, 2);
});

test("five clicks at once send one DM per person", async () => {
  const h = harness();
  const r = h.make();
  await Promise.all([1, 2, 3, 4, 5].map(() => r.remind(request())));
  assert.equal(h.sent.length, 2);
});

test("someone with no Slack account is reported, not counted as reminded", async () => {
  const h = harness({ slackUsers: ["ana@example-client.com"] });
  const out = await h.make().remind(request());
  assert.deepEqual(out.skipped, [{ name: "Ben Ito", reason: "no Slack account with their Ashby email" }]);
  const again = await h.make().remind(request({ interviewers: [ben] }));
  assert.equal(again.skipped[0].reason, "no Slack account with their Ashby email");
});

test("the request is checked", () => {
  assert.ok(parseRequest({ ...request(), interviewEventId: "x" }).error);
  assert.ok(parseRequest({ ...request(), interviewers: [] }).error);
  assert.ok(parseRequest({ ...request(), interviewers: [{ name: "No Email" }] }).error);
  assert.ok(parseRequest({ interviewEventId: EVENT, applicationId: APP, interviewers: [ana] }).error, "requestedBy.email required");
  const ok = parseRequest({ interviewEventId: EVENT, applicationId: APP, interviewers: [ana], requestedBy: { name: "Kit Quinn", email: "kit@example-client.com" } });
  assert.equal(ok.request.requestedByName, "Kit Quinn");
});

test("message wording: greeting and the one-sentence ask, the name linked, nobody named as asking", () => {
  const m = buildManualMessage({ interviewerName: "Ana Diaz", candidateName: "Cara Moss", candidateUrl: "https://app.ashbyhq.com/candidates/c-1", requestedByName: "Kit Quinn" });
  assert.equal(m, "Hi Ana -- Please submit your feedback for <https://app.ashbyhq.com/candidates/c-1|Cara Moss>!");
  const odd = buildManualMessage({ interviewerName: "Ana Diaz", candidateName: "A <b> & C|D", candidateUrl: "javascript:x" });
  assert.equal(odd, "Hi Ana -- Please submit your feedback for A &lt;b&gt; &amp; C|D!");
});

async function serve(settings, remindNow) {
  const server = createServer({ remindNow, settings }).listen(0, "127.0.0.1");
  await new Promise((r) => server.on("listening", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
const body = JSON.stringify({ interviewEventId: EVENT, applicationId: APP, interviewers: [ana], requestedBy: { name: "Kit Quinn", email: "kit@example-client.com" } });

test("route: manual-only has no webhook route; /remind needs the secret", async () => {
  const calls = [];
  const s = await serve({ automaticReminders: false, remindSecret: "fictional-remind-secret" }, { remind: async (r) => { calls.push(r); return { sent: [{ name: r.interviewers[0].name }], skipped: [] }; } });
  try {
    assert.equal((await fetch(s.base + "/webhooks/ashby", { method: "POST", body: "{}" })).status, 404);
    const post = (auth) => fetch(s.base + "/remind", { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) }, body });
    assert.equal((await post(null)).status, 401);
    assert.equal((await post("Bearer wrong")).status, 401);
    const ok = await post("Bearer fictional-remind-secret");
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).sent, [{ name: "Ana Diaz" }]);
    assert.equal(calls.length, 1);
    const health = await (await fetch(s.base + "/health")).json();
    assert.deepEqual(health, { ok: true, automaticReminders: false, remind: true });
  } finally { s.close(); }
});

test("route: without REMIND_SECRET there is no /remind", async () => {
  const s = await serve({ automaticReminders: false, remindSecret: "" }, { remind: async () => ({}) });
  try {
    assert.equal((await fetch(s.base + "/remind", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " }, body })).status, 404);
  } finally { s.close(); }
});
