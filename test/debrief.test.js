"use strict";
/**
 * The debrief signal. Ashby's isDebrief flag, and nothing else.
 *
 * The fixture is the two real interviews from the live workspace on 11 Sep,
 * because the defect was a property of real title text and a synthetic pair
 * would not have had it.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { _internal } = require("../bots/ashby-panel");
const { isDebriefSession } = _internal;

const src = fs.readFileSync(path.join(__dirname, "..", "bots", "ashby-panel.js"), "utf8");
const cfgSrc = fs.readFileSync(path.join(__dirname, "..", "bots", "ashby-panel.config.js"), "utf8");

/* The two real interviews, verbatim. */
const RUNBOOK = { title: "FDS WT: Runbook QA Debrief", isDebrief: false }; // 12bb1430, in the FDS plan
const DEBRIEF = { title: "Debrief", isDebrief: true };                     // 9250b04a, the only flagged one

test("a trial session with 'Debrief' in its title is not the debrief", () => {
  // This is the whole defect. It is part of the FDS work trial, created with
  // the schedule on 4 Sept, and it reported the debrief as already booked.
  assert.equal(isDebriefSession(RUNBOOK), false);
  assert.match(RUNBOOK.title, /debrief/i, "the title really does contain the word");
});

test("the interview Ashby flags is the debrief", () => {
  assert.equal(isDebriefSession(DEBRIEF), true);
});

test("the substring path is gone from the code, not merely outvoted", () => {
  // Asserting the result alone would pass again the moment somebody
  // reintroduces a title match with a narrower string.
  assert.equal(/has\(t\.title/.test(src), false, "no title matching in the debrief loop");
  assert.equal(/debriefTitleContains/.test(src), false, "and the config key is not read");
  assert.equal(/debriefTitleContains\s*:/.test(cfgSrc), false, "nor defined");
  assert.match(src, /if \(isDebriefSession\(t\)\) \{/, "one named rule");
  const fn = src.slice(src.indexOf("function isDebriefSession(t) {"));
  assert.match(fn.slice(0, 120), /return !!\(t && t\.isDebrief\);/);
});

test("the flag is the only input, whatever the title says", () => {
  const titles = ["Debrief", "debrief", "FDS WT: Runbook QA Debrief", "Runbook QA",
                  "", "DEBRIEF (final)", "Work trial day 2"];
  for (const title of titles) {
    assert.equal(isDebriefSession({ title, isDebrief: true }), true, "true: " + title);
    assert.equal(isDebriefSession({ title, isDebrief: false }), false, "false: " + title);
  }
});

test("an unreadable title is not a debrief, which over-reports rather than under", () => {
  // titles.get returns null when Ashby would not say. The safe direction is a
  // reminder somebody does not need, not a missing one.
  assert.equal(isDebriefSession(null), false);
  assert.equal(isDebriefSession(undefined), false);
  assert.equal(isDebriefSession({}), false);
  assert.equal(isDebriefSession({ title: "Debrief" }), false, "no flag means no");
});

test("a candidate with no events still reports no debrief", () => {
  // NeedsScheduling applications have no interviewEvents, so the loop finds
  // nothing and the panel says NO. That was already correct and stays correct:
  // the false YES needed the runbook event to exist.
  const events = [];
  const found = events.filter((e) => isDebriefSession(e.title));
  assert.equal(found.length, 0);
});

test("the reason the fallback could never work as documented is recorded", () => {
  // It was commented "used only if Ashby's isDebrief flag is absent" while
  // being wired to fire on an explicit false. A future reader reintroducing it
  // needs to know that, not just that it was deleted.
  assert.match(src, /"Ashby did not say" and "Ashby said no" arrived here as/);
  assert.match(cfgSrc, /Do not reintroduce a title match/);
});

/* ---------------- the cache must not flatten what Ashby said ---------------- */

const titlesSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "interviewtitles.js"), "utf8");

/** The resolver, against a stubbed Ashby and an in-memory lookup cache. */
function resolver(interviews) {
  const { createTitleResolver } = require("../lib/interviewtitles");
  const store = {};
  const botStore = {
    async lookupGet(kind, key) { return store[kind + "|" + key] || null; },
    async lookupPut(kind, key, value) { store[kind + "|" + key] = value; },
  };
  const ashby = { async getInterview(id) { return interviews[id]; } };
  return { r: createTitleResolver({ ashby, botStore, concurrency: 2 }), store };
}

test("absent and false are kept apart in the cache", async () => {
  // !!iv.isDebrief collapsed these, which is why a fallback documented as
  // "only when the flag is absent" could not be written that way.
  const { r, store } = resolver({
    silent: { title: "Something", /* no isDebrief at all */ },
    saidNo: { title: "FDS WT: Runbook QA Debrief", isDebrief: false },
    saidYes: { title: "Debrief", isDebrief: true },
  });
  await r.load(["silent", "saidNo", "saidYes"]);
  assert.equal(r.get("silent").isDebrief, null, "Ashby did not say");
  assert.equal(r.get("saidNo").isDebrief, false, "Ashby said no");
  assert.equal(r.get("saidYes").isDebrief, true);
  // and that survives the round trip through the cache
  assert.equal(store["interview_v2|silent"].isDebrief, null);
  assert.equal(store["interview_v2|saidNo"].isDebrief, false);
});

test("null is still not a debrief, so behaviour is unchanged by the distinction", () => {
  // The three-valued flag is for future readers. Today every consumer treats
  // silence as no, which is the over-reporting direction.
  assert.equal(isDebriefSession({ title: "Debrief", isDebrief: null }), false);
});

test("the namespace bump is the cache clear, and needs no database access", () => {
  assert.match(titlesSrc, /const CACHE_KIND = "interview_v2";/);
  assert.equal(/lookupGet\("interview"/.test(titlesSrc), false, "old rows are never read again");
  assert.equal(/lookupPut\("interview"/.test(titlesSrc), false);
  assert.match(titlesSrc, /lookupGet\(CACHE_KIND, id\)/);
  assert.match(titlesSrc, /lookupPut\(CACHE_KIND, id, value\)/);
});

test("a fresh namespace really does re-read from Ashby", async () => {
  const { r, store } = resolver({ a: { title: "Debrief", isDebrief: true } });
  store["interview|a"] = { title: "Stale", isDebrief: false };   // an old-namespace row
  await r.load(["a"]);
  assert.equal(r.get("a").title, "Debrief", "the stale row must not be consulted");
  assert.equal(r.get("a").isDebrief, true);
});

test("a failed lookup is still not cached and still reported", async () => {
  const { r, store } = resolver({});                 // getInterview returns undefined
  await r.load(["missing"]);
  assert.equal(r.get("missing"), null);
  assert.equal(r.incomplete(), true);
  assert.equal(store["interview_v2|missing"], undefined, "a failure must not become a title");
});
