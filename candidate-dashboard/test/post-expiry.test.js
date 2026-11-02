"use strict";
// Expiry (src/scheduling/post-expiry.js, post-presses.js, service.expirePassed,
// slack.markExpired): an open post whose first session has passed is closed,
// once, saying whether anything was pressed on it; nothing else is touched.
// The service, store and press log are real; Slack is a stand-in.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPostExpiry } = require("../src/scheduling/post-expiry");
const { createPressLog, pressesSentence } = require("../src/scheduling/post-presses");
const { createService } = require("../src/scheduling/service");
const { createStore, blocksRepost } = require("../src/scheduling/store");
const { createSlack, blockProblems } = require("../src/scheduling/slack");

const NOW = Date.parse("2026-11-02T17:00:00Z");
const when = ms => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(ms);
const plan = (name, start) => ({ candidateId: `c-${name}`, applicationId: `a-${name}`, candidateName: name, jobTitle: "Recruiting Coordinator", timezone: "America/Los_Angeles", format: "calendar_checked", notes: "n",
  sessions: [{ title: "Initial Chat", start, end: start.replace(":00.000Z", ":30.000Z"), interviewers: "Mary Petrino", location: "Zoom", people: [{ name: "Mary Petrino" }] }] });
const shared = (id, name, start, postedAt, extra = {}) => ({ id, clientId: "luminai", revision: 2, state: "shared", plan: plan(name, start), digest: "g", slack: { channel: "C0CONFIG", ts: String(Date.parse(postedAt) / 1000) },
  audit: [{ action: "drafted", by: "auto", at: postedAt }], ...extra });

async function fixture(t, { startedAt = "2026-11-02T10:00:00Z" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-expiry-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { t: Date.parse(startedAt) };
  const presses = createPressLog(dir, { now: () => clock.t });
  clock.t = NOW;
  const store = createStore(dir);
  const service = createService({ store, candidates: async () => [], clientId: "luminai", routing: "client", channelId: "C0CONFIG", channelName: "luminai-rc-team", slack: async () => ({}) });
  const marked = [], logs = [];
  const slackApi = { markExpired: async x => marked.push(x) };
  const expiry = createPostExpiry({ service, store, slackApi, presses, clientId: "luminai", now: () => clock.t, log: { warn: m => logs.push(m) } });
  return { store, service, presses, expiry, marked, logs, clock };
}

test("the press sentence: not recorded, nothing pressed, or what was pressed and what came of it", () => {
  const since = Date.parse("2026-11-02T10:00:00Z");
  assert.equal(pressesSentence([], { postedAt: Date.parse("2026-10-05T10:00:00Z"), since, when }),
    "Presses on this post weren't recorded (it was posted before recording began), so whether anyone pressed anything isn't known.");
  assert.equal(pressesSentence([], { postedAt: since + 1000, since, when }), "Nobody pressed Schedule or Suggest on it.");
  assert.equal(pressesSentence([{ action: "schedule", by: "Anna Jones", at: "2026-11-02T16:31:00Z", outcome: "refused: This schedule's start time has already passed." },
    { action: "suggest_time", by: "Mary Petrino", at: "2026-11-02T12:00:00Z", outcome: "no other option fit" }], { postedAt: since + 1000, since, when }),
    "Pressed, without changing it: Schedule by Anna Jones, Nov 2, 8:31 AM PST (refused: This schedule's start time has already passed); Suggest another time by Mary Petrino, Nov 2, 4:00 AM PST (no other option fit).");
});

test("a passed open post is closed once, saying what was pressed; a future one, another client's and an approved one are left alone", async t => {
  const f = await fixture(t);
  await f.store.insert(shared("old", "Samuel Zhao", "2026-10-05T16:15:00.000Z", "2026-09-29T18:00:00Z"));
  await f.store.insert(shared("pressed", "Amara Jordan", "2026-11-02T16:30:00.000Z", "2026-11-02T11:00:00Z"));
  await f.store.insert(shared("quiet", "Pat Doe", "2026-11-02T16:00:00.000Z", "2026-11-02T12:00:00Z"));
  await f.store.insert(shared("future", "Rachel Lo", "2026-11-04T00:00:00.000Z", "2026-11-02T12:00:00Z"));
  await f.store.insert({ ...shared("theirs", "Other", "2026-10-05T16:15:00.000Z", "2026-09-29T18:00:00Z"), clientId: "someone-else" });
  await f.store.insert(shared("approved", "Lee Park", "2026-10-05T16:15:00.000Z", "2026-09-29T18:00:00Z", { state: "discussion_approved" }));
  f.presses.record({ draftId: "pressed", action: "schedule", by: "Anna Jones", outcome: "refused: This schedule's start time has already passed." });
  assert.equal(await f.expiry.sweep(), 3);
  const get = id => f.store.get(id);
  for (const id of ["old", "pressed", "quiet"]) {
    const row = await get(id);
    assert.equal(row.state, "rejected");assert.equal(row.expired.at, new Date(NOW).toISOString());assert.equal(row.audit.at(-1).action, "expired");
    assert.equal(blocksRepost(row), false, "an expired post never blocks a new one");
  }
  assert.match((await get("old")).expired.presses, /^Presses on this post weren't recorded/);
  assert.match((await get("pressed")).expired.presses, /^Pressed, without changing it: Schedule by Anna Jones, Nov 2, 9:00 AM PST \(refused: This schedule's start time has already passed\)\.$/);
  assert.equal((await get("quiet")).expired.presses, "Nobody pressed Schedule or Suggest on it.");
  for (const id of ["future", "theirs", "approved"]) assert.notEqual((await get(id)).state, "rejected");
  assert.deepEqual(f.marked.map(m => [m.row.id, m.channel, m.ts]).sort(), [["old", "2026-09-29T18:00:00Z"], ["pressed", "2026-11-02T11:00:00Z"], ["quiet", "2026-11-02T12:00:00Z"]].map(([id, at]) => [id, "C0CONFIG", String(Date.parse(at) / 1000)]));
  assert.equal(await f.expiry.sweep(), 0);
  assert.equal(f.marked.length, 3);
  assert.deepEqual(f.logs, ["[expiry] Expired 3 posts whose first session had passed."]);
});

test("a post approved while it was being expired is left as approved", async t => {
  const f = await fixture(t);
  await f.store.insert(shared("raced", "Amara Jordan", "2026-11-02T16:30:00.000Z", "2026-11-02T11:00:00Z"));
  const stale = await f.store.get("raced");
  await f.store.replace("raced", stale.revision, { ...stale, state: "discussion_approved", revision: stale.revision + 1 });
  assert.equal(await f.service.expirePassed(stale, { at: new Date(NOW).toISOString() }), null);
  assert.equal((await f.store.get("raced")).state, "discussion_approved");
});

test("the expired message: buttons gone, nothing booked by the bot, what was pressed, and no guess about Ashby", async () => {
  const calls = [];
  const slack = createSlack("x", async (url, o) => { calls.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ ok: true }) }; }, { displayTimeZone: "America/Los_Angeles", interactive: true });
  const row = { id: "pressed", plan: plan("Amara Jordan", "2026-11-02T16:30:00.000Z"),
    expired: { at: "2026-11-02T17:00:00.000Z", firstStart: "2026-11-02T16:30:00.000Z", presses: "Nobody pressed Schedule or Suggest on it." } };
  await slack.markExpired({ channel: "C0CONFIG", ts: "1.2", row });
  const update = calls[0];
  assert.equal(update.ts, "1.2");
  assert.equal(update.blocks.some(b => b.type === "actions"), false);
  assert.equal(update.blocks.at(-1).text.text, "Expired at Nov 2, 9:00 AM PST: the first session (Nov 2, 8:30 AM PST) passed without approval, so this option can no longer be scheduled or replaced from here. Nothing from this message was booked or sent by the bot. Nobody pressed Schedule or Suggest on it. Whether it was booked in Ashby some other way isn't known to the bot.");
  assert.equal(update.text, "Interview schedule for Amara Jordan · Recruiting Coordinator: expired; the first session passed without approval, nothing booked by the bot.");
  assert.doesNotMatch(update.blocks[0].text.text, /press Schedule/);
  assert.deepEqual(blockProblems(update), []);
});

test("the press log is started once, so a restart doesn't move when recording began", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-presses-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  createPressLog(dir, { now: () => Date.parse("2026-11-02T10:00:00Z") });
  const again = createPressLog(dir, { now: () => Date.parse("2026-11-05T10:00:00Z") });
  assert.equal(again.since(), Date.parse("2026-11-02T10:00:00Z"));
});
