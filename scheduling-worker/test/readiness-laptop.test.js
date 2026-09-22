"use strict";
/**
 * The laptop and desk item reads the values, not the status.
 *
 * laptopDesk was a hand-maintained select standing in for a fact the tracker
 * now holds directly in computer and desk, synced from sheet columns E and G.
 * A coordinator who assigns a desk and forgets to flip the select was getting
 * chased for a thing they had done; one who flips the select without assigning
 * anything was not being chased at all.
 */
const { test } = require("node:test");
const assert = require("node:assert");

const CONFIG = require("../bots/readiness-sweep.config");
const SHEET = require("../bots/sheet-sync.config");
const { _internal } = require("../bots/readiness-sweep");
const { evaluate, isDone, isDoneAll } = _internal;

const check = CONFIG.checks.filter((c) => c.key === "laptopAssignment")[0];

/** A candidate with a position and whatever values are given. */
const cand = (values) => ({ id: "c1", name: "Ada Lovelace", values: Object.assign({}, values) });
const redsFor = (values) =>
  evaluate({ candidate: cand(values), entry: null, position: "FDE" });
const laptopRed = (values) => redsFor(values).filter((r) => r.key === "laptopAssignment")[0];

test("the check reads computer and desk, not laptopDesk", () => {
  assert.deepEqual(check.keys, ["computer", "desk"]);
  assert.equal(CONFIG.checks.some((c) => c.key === "laptopDesk"), false);
});

test("both filled satisfies the item", () => {
  assert.equal(laptopRed({ computer: "SF-Poetic 7", desk: "SF-Desk 1" }), undefined);
});

test("either one missing keeps it red, and says which", () => {
  assert.equal(laptopRed({ computer: "SF-Poetic 7" }).detail, "no desk");
  assert.equal(laptopRed({ desk: "SF-Desk 1" }).detail, "no laptop");
  assert.equal(laptopRed({}).detail, "no laptop and no desk");
});

test("a placeholder is absence, not an assignment", () => {
  // The failure this guards: "NOT YET" is what column G actually holds for most
  // rows, and counting it as a desk would turn the whole item green for nobody.
  for (const marker of SHEET.NOT_YET_MARKERS) {
    const red = laptopRed({ computer: "SF-Poetic 7", desk: marker });
    assert.ok(red, "desk of " + JSON.stringify(marker) + " must not count");
    assert.equal(red.detail, "no desk");
  }
  // and the wider blank vocabulary bot 10 already uses
  for (const marker of SHEET.BLANK_EQUIVALENTS) {
    assert.ok(laptopRed({ computer: marker, desk: "SF-Desk 1" }),
      "computer of " + JSON.stringify(marker) + " must not count");
  }
});

test("the blank vocabulary is bot 10's own, not a second copy", () => {
  assert.equal(check.blankAlso, SHEET.NOT_YET_MARKERS, "the same array, by reference");
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "bots", "readiness-sweep.config.js"), "utf8");
  assert.equal(/not yet["']\s*,/.test(src), false, "no restated marker list");
});

test("laptopDesk is untouched: still a field, still in the progress bar", () => {
  // Deleting a field out from under this sweep is what left it chasing two
  // ghosts for a week. The status is no longer swept; it is not gone.
  const FIELDS = require("../lib/fields");
  const f = FIELDS.field("laptopDesk");
  assert.ok(f, "still defined");
  assert.deepEqual(f.opts, ["NOT YET", "REQUESTED", "ASSIGNED"]);
  assert.deepEqual(f.done, ["ASSIGNED"], "still counts toward progress on its own terms");
});

test("flipping laptopDesk to ASSIGNED no longer greens the item on its own", () => {
  const red = laptopRed({ laptopDesk: "ASSIGNED" });
  assert.ok(red, "a status with nothing behind it is not an assignment");
  assert.equal(red.detail, "no laptop and no desk");
});

test("a real assignment is green even with laptopDesk left at NOT YET", () => {
  // The common case, and the one that was being chased wrongly.
  assert.equal(laptopRed({ laptopDesk: "NOT YET", computer: "SF-Poetic 4", desk: "SF-Desk 2" }),
    undefined);
});

test("a partner named NOT YET is not a named partner", () => {
  // Column M's vocabulary reaching the read side. sheet-sync.config.js already
  // stops this value being written; nothing was stopping it being counted.
  const dri = CONFIG.checks.filter((c) => c.key === "driName")[0];
  assert.equal(dri.blankAlso, SHEET.NOT_YET_MARKERS);
  assert.equal(isDone(dri, "NOT YET"), false);
  assert.equal(isDone(dri, "not yet"), false, "case folded");
  assert.equal(isDone(dri, "  TBD  "), false, "trimmed");
  assert.equal(isDone(dri, ""), false);
  assert.equal(isDone(dri, "Sam Henderson"), true);
  assert.equal(isDone(dri, "Dillon Bogart"), true);
});

test("blankAlso changes nothing for the checks that did not opt in", () => {
  const opted = CONFIG.checks.filter((c) => c.blankAlso).map((c) => c.key).sort();
  assert.deepEqual(opted, ["driName", "laptopAssignment"],
    "exactly the two sheet-authoritative items, nothing else");
  const nda = CONFIG.checks.filter((c) => c.key === "nda")[0];
  assert.equal(nda.blankAlso, undefined);
  assert.equal(isDone(nda, "COMPLETED"), true);
  assert.equal(isDone(nda, "NOT STARTED"), false);
});

test("single-key checks still go through the same evaluator", () => {
  const nda = CONFIG.checks.filter((c) => c.key === "nda")[0];
  assert.equal(isDoneAll(nda, { nda: "COMPLETED" }), true);
  assert.equal(isDoneAll(nda, { nda: "NOT STARTED" }), false);
  const reds = redsFor({ nda: "COMPLETED" });
  assert.equal(reds.some((r) => r.key === "nda"), false);
  assert.equal(reds.some((r) => r.key === "rampLinear"), true, "the rest still evaluate");
});

/* ============ a suggestion is not an assignment (11 Sep) ============
   The same failure shape as the Runbook QA Debrief bug: something that merely
   LOOKED like the thing silenced a reminder for a week. A proposal that
   silenced this sweep would be that bug rebuilt in a new place, so it is
   tested rather than trusted to a comment. */

test("a candidate with only a suggestion is still chased for the desk", () => {
  const withSuggestion = cand({ computer: "SF-Poetic 7" });
  // every shape a suggestion could plausibly arrive in, none of them a value
  withSuggestion.suggestions = { desk: { ok: true, value: "SF-Desk 4", reason: "Not used since Sep 3." } };
  withSuggestion.sugg = { desk: { ok: true, value: "SF-Desk 4" } };
  withSuggestion.suggested = { desk: "SF-Desk 4" };

  const reds = evaluate({ candidate: withSuggestion, entry: null, position: "FDE" });
  const red = reds.filter((r) => r.key === "laptopAssignment")[0];
  assert.ok(red, "the desk is still missing, so it is still outstanding");
  assert.equal(red.detail, "no desk");
});

test("a suggested partner does not count as a named partner", () => {
  const c = cand({});
  c.suggestions = { driName: { ok: true, value: "FDE-Sam H", display: "Sam Henderson" } };
  const reds = evaluate({ candidate: c, entry: null, position: "FDE" });
  assert.ok(reds.some((r) => r.key === "driName"), "still unnamed until accepted");
});

test("the sweep reads values only, so a suggestion cannot reach it at all", () => {
  // The structural guarantee behind the two tests above: evaluate() resolves
  // through candidate.values and the Ashby panel, and knows no other source.
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "bots", "readiness-sweep.js"), "utf8");
  const fn = src.slice(src.indexOf("function evaluate({ candidate, entry, position })"),
                       src.indexOf("/**\n * Sessions inside the trial"));
  assert.match(fn, /const stored = candidate\.values \|\| \{\};/);
  assert.match(fn, /EFFECTIVE\.resolve\(candidate, k, entry, stored\[k\]\)/);
  for (const w of ["suggest", "sugg", "proposed"]) {
    assert.equal(new RegExp(w, "i").test(fn), false,
      "the sweep must not learn about " + w + ": a proposal is not an assignment");
  }
});

test("an ACCEPTED value does count, because it is an assignment", () => {
  // The distinction that makes the rule meaningful. Accepting writes into
  // values, and from then on it is a real value everywhere.
  const accepted = cand({ computer: "SF-Poetic 7", desk: "SF-Desk 4" });
  accepted.acceptedSource = {
    desk: { value: "SF-Desk 4", by: "hayley", at: "2026-09-11T10:00:00.000Z" },
  };
  const reds = evaluate({ candidate: accepted, entry: null, position: "FDE" });
  assert.equal(reds.some((r) => r.key === "laptopAssignment"), false,
    "accepted is assigned, so the item is done");
});
