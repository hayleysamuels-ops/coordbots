"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// db.js opens its file at require time, so the temp location has to be set
// before anything pulls it in.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "coordmetrics-buckets-"));
process.env.CLIENTS = "";

const { localBuckets, isExcludedTitle } = require("../src/metrics");

test("buckets an instant into the client's local day, not UTC", () => {
  // 01:30 UTC on 2 March is still 20:30 on 1 March in New York. Bucketing
  // on the UTC date would file a Monday-evening interview under Tuesday.
  const buckets = localBuckets("2026-03-02T01:30:00.000Z", "America/New_York");
  assert.strictEqual(buckets.day, "2026-03-01");
  assert.strictEqual(buckets.hour, 20);
});

test("honours daylight saving rather than a fixed offset", () => {
  // Same wall-clock hour either side of the US DST switch: 16:00 UTC is
  // 11:00 EST in January and 12:00 EDT in July. A fixed -5 offset would
  // report 11 for both.
  assert.strictEqual(localBuckets("2026-01-15T16:00:00.000Z", "America/New_York").hour, 11);
  assert.strictEqual(localBuckets("2026-07-15T16:00:00.000Z", "America/New_York").hour, 12);
});

test("week keys are the Monday of the local week", () => {
  // 2026-10-14 is a Wednesday; its week starts Monday the 12th.
  assert.strictEqual(localBuckets("2026-10-14T15:00:00.000Z", "America/New_York").week, "2026-10-12");
  // A Sunday belongs to the week that started the previous Monday, not the
  // one about to start.
  assert.strictEqual(localBuckets("2026-10-18T15:00:00.000Z", "America/New_York").week, "2026-10-12");
  assert.strictEqual(localBuckets("2026-10-19T15:00:00.000Z", "America/New_York").week, "2026-10-19");
});

test("a Sunday-evening US interview does not leak into the next week", () => {
  // 2026-10-19T01:00Z is Sunday 18:00 in Los Angeles — still the week of
  // the 12th locally, even though it is Monday the 19th in UTC.
  const buckets = localBuckets("2026-10-19T01:00:00.000Z", "America/Los_Angeles");
  assert.strictEqual(buckets.day, "2026-10-18");
  assert.strictEqual(buckets.week, "2026-10-12");
});

test("rejects an unparseable timestamp rather than bucketing it as epoch", () => {
  assert.strictEqual(localBuckets("not a date", "America/New_York"), null);
});

test("excluded-title matching is case-insensitive and whole-word", () => {
  const keywords = ["hold", "work time", "dinner"];
  assert.ok(isExcludedTitle("External Hold ", keywords));
  assert.ok(isExcludedTitle("[Forus] Account Strategy Work Time", keywords));
  assert.ok(isExcludedTitle("Dinner with Forus", keywords));
  assert.ok(!isExcludedTitle("[Forus] Coding Interview", keywords));
  assert.ok(!isExcludedTitle("Debrief", keywords));
});

test("a keyword buried inside a longer word is NOT a hold", () => {
  // This shipped as a substring match and silently excluded 297 real
  // interviews across three clients before anyone looked at the titles.
  const keywords = ["hold", "lunch", "break", "set up", "arrival"];
  assert.ok(!isExcludedTitle("[Forus] Stakeholder Conversation", keywords), "stakeholder is not a hold");
  assert.ok(!isExcludedTitle("[Forus] Onsite Stakeholder Convo", keywords));
  assert.ok(!isExcludedTitle("Lunchtime Chat", keywords), "a lunchtime chat is a conversation, not a meal break");
  assert.ok(!isExcludedTitle("Breakfast with Kesava", keywords), "breakfast is not 'break'");
  assert.ok(!isExcludedTitle("Household Survey", keywords));

  // The genuine logistics blocks must still be caught.
  assert.ok(isExcludedTitle("External Hold", keywords));
  assert.ok(isExcludedTitle("[Forus] Team Lunch", keywords));
  assert.ok(isExcludedTitle("[Forus] Arrival + Set Up", keywords));
});

test("whitespace inside a keyword matches any run of whitespace", () => {
  assert.ok(isExcludedTitle("Project Work  Time", ["work time"]));
});

test("an empty keyword list excludes nothing", () => {
  assert.ok(!isExcludedTitle("External Hold", []));
});
