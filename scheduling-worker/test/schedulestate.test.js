"use strict";
/**
 * The third panel state: scheduled, unscheduled, unknown.
 *
 * effective() used to ask only whether the panel HAD a date. So "Ashby says
 * this trial is not scheduled" and "Ashby has never been asked" both fell
 * through to the same silent fallback, and a cancelled trial kept rendering on
 * the dates it had before it was cancelled.
 *
 * Brandon Wagoner, 14 Sep 2026, application 16796541: three Cancelled
 * schedules and two NeedsScheduling, every one with interviewEvents: [], while
 * the tracker showed 13 to 15 Sep on the board. Fifth instance this week of a
 * failed lookup rendering as an answer.
 */
const { test } = require("node:test");
const assert = require("node:assert");

const EFFECTIVE = require("../lib/effective");

/** A tracker row with stored dates, linked to Ashby. */
const card = (over) => ({
  id: "c1", name: "Brandon Wagoner",
  values: Object.assign({ ashbyCandidateId: "a1", startDate: "2026-09-13",
                          endDate: "2026-09-15" }, over || {}),
});

/** A panel entry in the shape effective() reads. */
const entry = (panel) => ({ state: "live", panel: Object.assign({ fields: {} }, panel) });

const dates = (c, e) => [
  EFFECTIVE.resolve(c, "startDate", e, c.values.startDate),
  EFFECTIVE.resolve(c, "endDate", e, c.values.endDate),
];

test("a cancelled or unscheduled trial has no effective dates, stored or not", () => {
  const e = entry({ trialStart: null, trialEnd: null, scheduleState: "unscheduled" });
  assert.deepEqual(dates(card(), e), ["", ""],
    "Ashby actively says there is no trial, so the stored dates do not stand");
  assert.equal(EFFECTIVE.covers(e, "startDate", card()), true, "the panel covers it");
  assert.equal(EFFECTIVE.covers(e, "endDate", card()), true);
});

test("no work trial schedule at all leaves the stored dates alone", () => {
  const e = entry({ trialStart: null, trialEnd: null, scheduleState: "unknown" });
  assert.deepEqual(dates(card(), e), ["2026-09-13", "2026-09-15"],
    "Ashby has nothing to say, so what a person typed stands, exactly as before");
  assert.equal(EFFECTIVE.covers(e, "startDate", card()), false);
});

test("a scheduled trial behaves exactly as it does today", () => {
  const e = entry({ trialStart: "2026-09-20T17:00:00.000Z",
                    trialEnd: "2026-09-21T01:00:00.000Z", scheduleState: "scheduled" });
  const [s, x] = dates(card(), e);
  assert.equal(s, "2026-09-20", "the panel's date, in the office's day");
  assert.equal(x, "2026-09-20");
  assert.equal(EFFECTIVE.covers(e, "startDate", card()), true);
});

test("a start with no end still falls back for the end alone", () => {
  // Unchanged behaviour: scheduleState is "scheduled", so only the missing end
  // falls through, which is what it did before.
  const e = entry({ trialStart: "2026-09-20T17:00:00.000Z", trialEnd: null,
                    scheduleState: "scheduled" });
  const [s, x] = dates(card(), e);
  assert.equal(s, "2026-09-20");
  assert.equal(x, "2026-09-15", "the stored end, as today");
});

test("an unlinked row is never covered, whatever the panel says", () => {
  const e = entry({ trialStart: null, trialEnd: null, scheduleState: "unscheduled" });
  const unlinked = { id: "c2", name: "X", values: { startDate: "2026-09-13" } };
  assert.equal(EFFECTIVE.covers(e, "startDate", unlinked), false);
  assert.equal(EFFECTIVE.resolve(unlinked, "startDate", e, "2026-09-13"), "2026-09-13");
});

test("a panel that is not live or stale never covers", () => {
  for (const state of ["loading", "notlinked", "notfound", "error"]) {
    const e = { state, panel: { fields: {}, scheduleState: "unscheduled" } };
    assert.equal(EFFECTIVE.covers(e, "startDate", card()), false, state);
    assert.deepEqual(dates(card(), e), ["2026-09-13", "2026-09-15"],
      "unlinking or a failed read must not make dates disappear: " + state);
  }
});

/* ---------------- the state is derived where the facts are ---------------- */

const fs = require("fs");
const path = require("path");
const panelSrc = fs.readFileSync(path.join(__dirname, "..", "bots", "ashby-panel.js"), "utf8");

test("cancelled schedules count toward unscheduled", () => {
  // onStage() runs liveSchedules first, which drops cancelled, so the state
  // cannot be derived from it: a candidate whose only schedules were cancelled
  // would look identical to one Ashby has never heard of.
  assert.match(panelSrc, /const wtAnyStatus = \(schedules \|\| \[\]\)\.filter/);
  assert.match(panelSrc, /const scheduleState = start \? "scheduled"\s*\n\s*: wtAnyStatus\.length \? "unscheduled"\s*\n\s*: "unknown";/);
  assert.match(panelSrc, /const liveSchedules = \(schedules\) => schedules\.filter\(\(s\) => s\.status !== "Cancelled"\)/,
    "which is exactly why wtSchedules could not be used for this");
});

test("the card says NOT SCHEDULED rather than a dash", () => {
  // A dash reads as "nothing here", which is the thing that has to stop.
  assert.match(panelSrc, /: scheduleState === "unscheduled" \? "NOT SCHEDULED" : "—",/);
});

test("the state reaches effective through the panel, not through a second path", () => {
  assert.match(panelSrc, /^\s*scheduleState,$/m, "put on the panel object");
  const effSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "effective.js"), "utf8");
  assert.match(effSrc, /p\.scheduleState === "unscheduled"/);
  assert.match(effSrc, /return p\.trialStart \? isoToDay\(p\.trialStart\) : "";/,
    "empty, not undefined: undefined falls back to the stored value");
});

/* ---------------- the readiness sweep reads the same chain ---------------- */

const { _internal } = require("../bots/readiness-sweep");
const { trialStartAt } = _internal;

test("the sweep does not chase a trial Ashby says is not scheduled", () => {
  // The same defect one layer along: covers() is true, panel.trialStart is
  // null, and the old code fell through to the stored date and posted T-72
  // reminders about a cancelled trial.
  const e = entry({ trialStart: null, trialEnd: null, scheduleState: "unscheduled" });
  assert.equal(trialStartAt(card(), e), null,
    "no trial start, so no milestone and no post");
});

test("the sweep still uses a stored date when Ashby has no schedule", () => {
  const e = entry({ trialStart: null, trialEnd: null, scheduleState: "unknown" });
  const at = trialStartAt(card(), e);
  assert.ok(at, "unchanged: Ashby has nothing to say");
  assert.equal(at.precise, false, "a date with no clock time");
  assert.equal(at.key, "2026-09-13");
});

test("the sweep still prefers Ashby's clock time when there is one", () => {
  const e = entry({ trialStart: "2026-09-20T17:00:00.000Z", trialEnd: null,
                    scheduleState: "scheduled" });
  const at = trialStartAt(card(), e);
  assert.equal(at.precise, true);
  assert.equal(at.key, "2026-09-20T17:00:00.000Z");
});

test("an unlinked row keeps its stored date in the sweep too", () => {
  const unlinked = { id: "c2", name: "X", values: { startDate: "2026-09-13" } };
  const e = entry({ trialStart: null, scheduleState: "unscheduled" });
  const at = trialStartAt(unlinked, e);
  assert.ok(at, "covers() is false without a link, so nothing changes");
  assert.equal(at.key, "2026-09-13");
});
