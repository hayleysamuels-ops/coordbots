"use strict";
/**
 * Spec section 4. The map is human-reviewed and committed as written; these
 * tests pin it rather than re-deriving it.
 *
 * Counting the raw strings would show Sam Henderson as three people carrying
 * one trial each, which inverts the exact signal the Day view exists to give.
 */
const { test } = require("node:test");
const assert = require("node:assert");

const { resolveDri, suggestFor, DRI_ALIASES, UNASSIGNED_VALUES } = require("../lib/dri-aliases");
const SHEET = require("../bots/sheet-sync.config");

/* All 18 raw strings, and who each must resolve to. */
const EXPECTED = {
  "sam h": "Sam Henderson",
  "fde-sam h": "Sam Henderson",
  "sam henderson": "Sam Henderson",
  "shantam": "Shantam Jain",
  "fds-shantam j": "Shantam Jain",
  "shashank": "Shashank Pancharpula",
  "sales-shashank": "Shashank Pancharpula",
  "fde-ria s": "Ria Sharma",
  "mz": "Michael Zuccarino",
  "fde-mz": "Michael Zuccarino",
  "dillon": "Dillon Bogart",
  "fds-dillon": "Dillon Bogart",
  "neel": "Neel",
  "dan k": "Dan K",
  "alex morgan": "Alex Morgan",
  "advait": "Advait Shroff",
  "fde-erik": "Erik Zhang",
  "fde-liam": "Liam",
};

test("all 18 known raw strings resolve to the expected canonical names", () => {
  const raws = Object.keys(EXPECTED);
  assert.equal(raws.length, 18, "18 distinct raw strings, not 19");
  for (const raw of raws) {
    const r = resolveDri(raw);
    assert.equal(r.canonical, EXPECTED[raw], raw + " should be " + EXPECTED[raw]);
    assert.equal(r.matched, true, raw + " should be matched");
    assert.equal(r.unassigned, false);
  }
});

test("the map holds exactly those 18 and invents no nineteenth", () => {
  const inMap = [];
  for (const canonical of Object.keys(DRI_ALIASES)) inMap.push(...DRI_ALIASES[canonical]);
  assert.equal(inMap.length, 18);
  assert.deepEqual(inMap.slice().sort(), Object.keys(EXPECTED).sort());
  assert.equal(new Set(inMap).size, 18, "no spelling listed under two people");
});

test("three Sam Henderson spellings collapse to one person", () => {
  const names = ["sam h", "fde-sam h", "sam henderson"].map((r) => resolveDri(r).canonical);
  assert.deepEqual(names, ["Sam Henderson", "Sam Henderson", "Sam Henderson"]);
  assert.equal(new Set(names).size, 1,
    "counting raw strings would show three people with one trial each");
});

test("the three surnames supplied from pool-health are the canonical form", () => {
  assert.equal(resolveDri("dillon").canonical, "Dillon Bogart");
  assert.equal(resolveDri("advait").canonical, "Advait Shroff");
  assert.equal(resolveDri("fde-erik").canonical, "Erik Zhang");
  // display only: the raw spellings they match are unchanged
  assert.deepEqual(DRI_ALIASES["Dillon Bogart"], ["dillon", "fds-dillon"]);
  assert.deepEqual(DRI_ALIASES["Advait Shroff"], ["advait"]);
  assert.deepEqual(DRI_ALIASES["Erik Zhang"], ["fde-erik"]);
});

test("an unknown string resolves to itself and is flagged", () => {
  const r = resolveDri("fde-jordan p");
  assert.equal(r.matched, false);
  assert.equal(r.unassigned, false, "a new spelling is a person, just not a known one");
  assert.equal(r.canonical, "fde-jordan p", "the name still works");
  assert.equal(r.raw, "fde-jordan p");
});

test("resolution is case and whitespace insensitive", () => {
  for (const v of ["  SAM H  ", "Sam H", "sAm H", "\tsam h\n"]) {
    assert.equal(resolveDri(v).canonical, "Sam Henderson", JSON.stringify(v));
    assert.equal(resolveDri(v).matched, true);
  }
  assert.equal(resolveDri("FDE-MZ").canonical, "Michael Zuccarino");
});

test("every blank marker resolves to unassigned, never to a person", () => {
  const markers = ["", "   ", null, undefined, "NOT YET", "not yet", "TBD", "n/a", "-", "—",
                   "None", "pending", "unassigned", "?"];
  for (const m of markers) {
    const r = resolveDri(m);
    assert.equal(r.unassigned, true, JSON.stringify(m) + " must be unassigned");
    assert.equal(r.canonical, null, JSON.stringify(m) + " must not become a person");
    assert.equal(r.matched, false);
  }
});

test("the unassigned vocabulary covers bot 10's, since it cannot import it", () => {
  // lib/ is served to the browser and cannot require a bots/ config, so this
  // list is a copy. The copy is pinned here rather than left to drift.
  for (const v of SHEET.BLANK_EQUIVALENTS) {
    assert.equal(resolveDri(v).unassigned, true,
      "BLANK_EQUIVALENTS member not covered: " + JSON.stringify(v));
  }
  for (const v of SHEET.NOT_YET_MARKERS) {
    assert.equal(resolveDri(v).unassigned, true,
      "NOT_YET_MARKERS member not covered: " + JSON.stringify(v));
  }
  const missing = SHEET.BLANK_EQUIVALENTS.concat(SHEET.NOT_YET_MARKERS)
    .filter((v) => UNASSIGNED_VALUES.indexOf(String(v).toLowerCase()) < 0);
  assert.deepEqual(missing, [], "add these to UNASSIGNED_VALUES");
});

test("matching is exact, not fuzzy", () => {
  // A wrong merge is invisible; a missing one is not. That asymmetry is why.
  assert.equal(resolveDri("sam").matched, false, "a prefix must not merge");
  assert.equal(resolveDri("sam hendersonn").matched, false, "nor a typo");
  assert.equal(resolveDri("s h").matched, false);
  assert.equal(resolveDri("dillon b").matched, false, "nor a closer-looking spelling");
});

test("the suggestion is text only and never performs the merge", () => {
  assert.equal(suggestFor("sam"), "Sam Henderson", "offered as a question");
  assert.equal(resolveDri("sam").matched, false, "and still not merged");
  assert.equal(resolveDri("sam").canonical, "sam");
  assert.equal(suggestFor("qqqq"), null, "no guess where there is nothing close");
});

test("resolveDri does not mutate what it is given", () => {
  const before = JSON.stringify(DRI_ALIASES);
  resolveDri("sam h"); resolveDri("nobody"); resolveDri("");
  assert.equal(JSON.stringify(DRI_ALIASES), before);
});
