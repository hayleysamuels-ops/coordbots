"use strict";
// The Remind button's server side (reminder-route.js, reminder-history.js):
// who may send, who it goes to, what's remembered. Fictional people and ids;
// the reminder bot is a stand-in.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createReminderRoute } = require("../src/reminder-route");
const { createReminderHistory } = require("../src/reminder-history");

const EVENT = "11111111-1111-4111-8111-111111111111";
const entry = {
  interviewEventId: EVENT, applicationId: "22222222-2222-4222-8222-222222222222", candidateId: "c-1",
  candidateName: "Cara Moss", jobTitle: "Engineer", ashbyProfileUrl: "https://app.ashbyhq.com/candidates/c-1",
  interviewers: [{ id: "u-ana", name: "Ana Diaz", email: "ana@example-client.com" }, { id: "u-ben", name: "Ben Ito", email: "ben@example-client.com" }],
};
const kit = { method: "google", email: "kit@example-client.com", name: "Kit Quinn" };
const quiet = { log() {}, warn() {} };

function setup({ reply = { sent: [{ name: "Ana Diaz" }], skipped: [{ name: "Ben Ito", reason: "already submitted" }] }, status = 200, fail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reminders-"));
  let t = Date.UTC(2026, 10, 18, 18, 42);
  const history = createReminderHistory({ dataDir: dir, now: () => t, log: quiet });
  const calls = [];
  const route = createReminderRoute({
    botUrl: "http://scorecard-bot.internal:3000", botSecret: "fictional-secret", history, log: quiet,
    findEntry: (id) => (id === EVENT ? entry : null),
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts, body: JSON.parse(opts.body) });
      if (fail) throw new Error("connect ECONNREFUSED");
      return { ok: status === 200, status, json: async () => reply };
    },
  });
  return { dir, history, route, calls, advance: (d) => { t += d; } };
}

test("only a Google sign-in can send one", async () => {
  const s = setup();
  for (const viewer of [null, { method: "password", email: null }]) {
    const out = await s.route.send(EVENT, viewer);
    assert.equal(out.status, 403);
  }
  assert.equal(s.calls.length, 0);
});

test("who it goes to comes from the dashboard's row, and the bot is told who asked", async () => {
  const s = setup();
  const out = await s.route.send(EVENT, kit);
  assert.equal(out.status, 200);
  assert.equal(s.calls.length, 1);
  const { url, opts, body } = s.calls[0];
  assert.equal(url, "http://scorecard-bot.internal:3000/remind");
  assert.equal(opts.headers.Authorization, "Bearer fictional-secret");
  assert.deepEqual(body.interviewers.map((i) => i.email), ["ana@example-client.com", "ben@example-client.com"]);
  assert.deepEqual(body.requestedBy, { name: "Kit Quinn", email: "kit@example-client.com" });
  assert.equal(body.candidateName, "Cara Moss");
  assert.equal(body.candidateUrl, "https://app.ashbyhq.com/candidates/c-1");
  assert.deepEqual(out.body.skipped, [{ name: "Ben Ito", reason: "already submitted" }]);
});

test("an interview that isn't overdue any more sends nothing", async () => {
  const s = setup();
  const out = await s.route.send("33333333-3333-4333-8333-333333333333", kit);
  assert.equal(out.status, 404);
  assert.equal(s.calls.length, 0);
});

test("the row then shows who reminded and when; the email stays off the page", async () => {
  const s = setup();
  await s.route.send(EVENT, kit);
  const snap = s.history.apply({ feedbackOverdue: [entry, { ...entry, interviewEventId: "other" }] });
  assert.deepEqual(snap.feedbackOverdue[0].reminder, { at: Date.UTC(2026, 10, 18, 18, 42), byName: "Kit Quinn", sent: ["Ana Diaz"] });
  assert.equal(snap.feedbackOverdue[1].reminder, undefined);
  assert.ok(!JSON.stringify(snap).includes("kit@example-client.com"));
  // Survives a restart, and goes after 14 days.
  const again = createReminderHistory({ dataDir: s.dir, now: () => Date.UTC(2026, 10, 19), log: quiet });
  assert.equal(again.get(EVENT).byName, "Kit Quinn");
  const later = createReminderHistory({ dataDir: s.dir, now: () => Date.UTC(2026, 11, 3), log: quiet });
  assert.equal(later.get(EVENT), null);
});

test("nothing sent (all skipped) leaves no 'Reminded' line", async () => {
  const s = setup({ reply: { sent: [], skipped: [{ name: "Ana Diaz", reason: "reminded too recently", lastAt: 1 }] } });
  const out = await s.route.send(EVENT, kit);
  assert.equal(out.status, 200);
  assert.equal(s.history.get(EVENT), null);
});

test("a bot that's down or refuses is reported, and nothing is recorded", async () => {
  for (const opts of [{ fail: true }, { status: 500, reply: { error: "x" } }]) {
    const s = setup(opts);
    const out = await s.route.send(EVENT, kit);
    assert.equal(out.status, 502);
    assert.match(out.body.error, /Nothing was sent/);
    assert.equal(s.history.get(EVENT), null);
  }
});
