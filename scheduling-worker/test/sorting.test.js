"use strict";
/**
 * List ordering: trial date, soonest first.
 *
 * The comparator is pulled out of public/index.html by source slice — the same
 * arrangement as test/panels.test.js, and it fails loudly if the code moves.
 *
 * effective() here is the REAL lib/effective.js and lib/fields.js, not a stub,
 * because the precedence being tested (panel date beats stored date) is that
 * module's behaviour and stubbing it would test nothing.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const EFFECTIVE = require("../lib/effective");
const FIELDS = require("../lib/fields");
const DATEDAY = require("../lib/dateday");   // the real one: parseDay now lives there

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function slice(startMark, endMark) {
  const a = html.indexOf(startMark), b = html.indexOf(endMark);
  assert.ok(a >= 0, "start marker not found — list ordering moved: " + startMark);
  assert.ok(b > a, "end marker not found — list ordering moved: " + endMark);
  return html.slice(a, b);
}

function sorter() {
  const src = slice("  function trialDay(c){", "  function needsAttention(c){");
  return new Function("EFFECTIVE", "FIELDS", "DATEDAY", `
    var panels = {};
    function linkOf(c){ return (c.values && c.values.ashbyCandidateId) || ""; }
    function panelEntry(c){ var aid = linkOf(c); return aid ? panels[aid] : null; }
    function get(c,k){
      return c.values[k] === undefined ? FIELDS.defVal(FIELDS.field(k)) : c.values[k];
    }
    function effective(c,key){ return EFFECTIVE.resolve(c, key, panelEntry(c), get(c,key)); }
    ${src}
    /* The list split, lifted from render() so the DONE rule is testable without
       a DOM. Kept identical to the source. */
    function splitActive(arr, today){
      var stillRunning=function(c){
        var d=trialEndDay(c), t=(today===undefined?todayDay():today);
        return d!==null && t!==null && d>=t;
      };
      var isDone=function(c){ return get(c,"status")==="DONE"; };
      return {
        active: arr.filter(function(c){ return !isDone(c) || stillRunning(c); }),
        done:   arr.filter(function(c){ return isDone(c) && !stillRunning(c); }),
      };
    }
    return { trialDay, trialEndDay, todayDay, parseDay, nameSortKey, byTrialDate,
             byTrialEnd, byName, dateGroups, splitActive, panels, effective };
  `)(EFFECTIVE, FIELDS, DATEDAY);
}

/** A tracker row with a stored start date. */
const card = (id, name, startDate, over) => ({
  id, name,
  values: Object.assign(startDate === undefined ? {} : { startDate }, over || {}),
});

/** A row linked to Ashby, with a panel whose derived trial start is `iso`. */
function linkedTo(M, cardObj, iso) {
  cardObj.values.ashbyCandidateId = "ash-" + cardObj.id;
  M.panels["ash-" + cardObj.id] = {
    state: "live",
    panel: { trialStart: iso, trialEnd: null, fields: { trialDates: { value: "x" } } },
  };
  return cardObj;
}

const order = (M, list) => list.slice().sort(M.byTrialDate).map((c) => c.id);

/* ------------------------------------------------------------------ order */

test("dated candidates sort ascending, soonest first", () => {
  const M = sorter();
  const list = [
    card("c-late", "Zoe Adams", "2026-10-01"),
    card("c-soon", "Andrew Mi", "2026-09-10"),
    card("c-mid", "Jannik Wiedenhaupt", "2026-09-20"),
  ];
  assert.deepEqual(order(M, list), ["c-soon", "c-mid", "c-late"]);
});

test("a past trial date sorts above a future one, deliberately", () => {
  const M = sorter();
  const list = [
    card("c-future", "Aakash Japi", "2026-12-01"),
    card("c-past", "Andrew Mi", "2026-08-01"),
    card("c-today", "Jannik Wiedenhaupt", "2026-09-09"),
  ];
  // An active candidate whose trial already happened is the one to chase.
  assert.deepEqual(order(M, list), ["c-past", "c-today", "c-future"]);
});

test("undated candidates sort beneath every dated one", () => {
  const M = sorter();
  const list = [
    card("c-none", "Aaaa Aaaa", undefined),
    card("c-dated", "Zzzz Zzzz", "2026-12-31"),
    card("c-blank", "Bbbb Bbbb", ""),
  ];
  const got = order(M, list);
  assert.equal(got[0], "c-dated", "the dated row leads even with a late date and a Z name");
  assert.deepEqual(got.slice(1), ["c-none", "c-blank"], "undated follow, in name order");
});

/* --------------------------------------------------------- date parsing */

test("an unparseable value is undated, never zero or NaN", () => {
  const M = sorter();
  ["TBD", "tbc", "n/a", "—", "next week", "9/14/2026", "2026-9-4", "2026-13-01",
   "2026-02-31", "0000-00-00", " ", "{}"].forEach((v) => {
    assert.equal(M.parseDay(v), null, JSON.stringify(v) + " must be undated");
  });
  assert.equal(M.parseDay(null), null);
  assert.equal(M.parseDay(undefined), null);
  assert.equal(M.parseDay("2026-09-14"), 20260914, "a real date parses");

  // The failure this guards: a typo sorting above tomorrow's trial.
  const list = [card("c-typo", "Aaa Aaa", "TBD"), card("c-real", "Zzz Zzz", "2026-09-10")];
  assert.deepEqual(order(M, list), ["c-real", "c-typo"]);
});

test("a time component cannot reorder two candidates on the same day", () => {
  const M = sorter();
  // 09:00 and 22:00 Pacific on the same day. Compared as calendar integers, so
  // the fourteen hours between them cannot decide the order — the name does.
  const x = linkedTo(M, card("c-x", "Bravo Bravo"), "2026-09-14T16:00:00Z");
  const y = linkedTo(M, card("c-y", "Alpha Alpha"), "2026-09-15T05:00:00Z");
  assert.equal(M.trialDay(x), 20260914);
  assert.equal(M.trialDay(y), 20260914, "still the 14th in Pacific time");
  assert.deepEqual(order(M, [x, y]), ["c-y", "c-x"], "name decides, not the clock");
});

test("the calendar day is the Pacific day, as the card shows it", () => {
  // Inherited from effective() -> isoToDay, which formats in
  // America/Los_Angeles. A trial at 00:01Z on the 14th is the 13th in the
  // office, and the list has to agree with the date printed on the card.
  const M = sorter();
  const early = linkedTo(M, card("c-early", "Andrew Mi"), "2026-09-14T00:01:00Z");
  assert.equal(M.effective(early, "startDate"), "2026-09-13");
  assert.equal(M.trialDay(early), 20260913, "not the UTC day");
});

/* ------------------------------------------------------------ precedence */

test("the Ashby derived date wins over a conflicting stored date", () => {
  const M = sorter();
  // Stored says December; Ashby's derived trial start says tomorrow. The card
  // shows Ashby's, so the list must sort on Ashby's.
  const conflicted = linkedTo(M, card("c-ashby", "Andrew Mi", "2026-12-25"), "2026-09-10T17:00:00Z");
  const other = card("c-plain", "Jannik Wiedenhaupt", "2026-09-20");

  assert.equal(M.effective(conflicted, "startDate"), "2026-09-10", "effective() prefers the panel");
  assert.equal(M.trialDay(conflicted), 20260910);
  assert.deepEqual(order(M, [other, conflicted]), ["c-ashby", "c-plain"]);
});

test("the stored date is used when Ashby has no trial date", () => {
  const M = sorter();
  // Linked, panel present, but no derived trial start: covers() returns false
  // and the resolver falls through to the stored value.
  const c = card("c1", "Andrew Mi", "2026-09-12");
  c.values.ashbyCandidateId = "ash-1";
  M.panels["ash-1"] = { state: "live", panel: { trialStart: null, fields: {} } };
  assert.equal(M.effective(c, "startDate"), "2026-09-12");
  assert.equal(M.trialDay(c), 20260912);
});

test("an unlinked row falls back to its stored date", () => {
  const M = sorter();
  assert.equal(M.trialDay(card("c1", "Andrew Mi", "2026-09-12")), 20260912);
  assert.equal(M.trialDay(card("c2", "Andrew Mi", undefined)), null);
});

/* ------------------------------------------------------------- stability */

test("a tie holds a stable order: last name, then first, then id", () => {
  const M = sorter();
  const day = "2026-09-14";
  const list = [
    card("c3", "Zoe Adams", day),
    card("c1", "Andrew Mi", day),
    card("c2", "Bob Adams", day),
  ];
  // Adams before Mi; within Adams, Bob before Zoe.
  assert.deepEqual(order(M, list), ["c2", "c3", "c1"]);

  // Re-sorting an already-sorted list, and a shuffled one, give the same answer.
  const once = list.slice().sort(M.byTrialDate);
  const twice = once.slice().sort(M.byTrialDate);
  assert.deepEqual(twice.map((c) => c.id), once.map((c) => c.id));
  const shuffled = [list[2], list[0], list[1]].sort(M.byTrialDate);
  assert.deepEqual(shuffled.map((c) => c.id), once.map((c) => c.id));
});

test("two identical names on the same day still hold a fixed order", () => {
  const M = sorter();
  const list = [card("cB", "Andrew Mi", "2026-09-14"), card("cA", "Andrew Mi", "2026-09-14")];
  assert.deepEqual(order(M, list), ["cA", "cB"], "id is the last resort");
  assert.deepEqual(order(M, [list[1], list[0]]), ["cA", "cB"], "and it does not depend on input order");
});

test("one name, or none, does not throw", () => {
  const M = sorter();
  assert.deepEqual(M.nameSortKey({ name: "Cher" }), ["cher", "cher"]);
  assert.deepEqual(M.nameSortKey({ name: "  " }), ["", ""]);
  assert.deepEqual(M.nameSortKey({}), ["", ""]);
  const list = [card("c1", "", "2026-09-14"), card("c2", "Andrew Mi", "2026-09-14")];
  assert.equal(order(M, list).length, 2);
});

/* ----------------------------------------------------------- no mutation */

test("sorting does not mutate the array it is given", () => {
  const M = sorter();
  const list = [
    card("c-late", "Zoe Adams", "2026-10-01"),
    card("c-soon", "Andrew Mi", "2026-09-10"),
  ];
  const before = list.map((c) => c.id);
  const sorted = list.slice().sort(M.byTrialDate);
  assert.deepEqual(list.map((c) => c.id), before, "the caller's array is untouched");
  assert.notDeepEqual(sorted.map((c) => c.id), before, "the copy is reordered");
});


/* =============================================== three date groups (9 Sep) */

/** A card with explicit start and end dates. */
const span = (id, name, start, end) => ({
  id, name,
  values: Object.assign({}, start === undefined ? {} : { startDate: start },
                            end === undefined ? {} : { endDate: end }),
});

const TODAY = 20260909; // fixed, so these do not drift with the wall clock
const groupOf = (M, list, id) => {
  const g = M.dateGroups(list, TODAY).find((x) => x.rows.some((r) => r.id === id));
  return g ? g.label : null;
};

test("the end date decides the group, not the start", () => {
  const M = sorter();
  // Began yesterday, ends today: running right now, so it is Upcoming.
  const running = span("c-running", "Andrew Mi", "2026-09-08", "2026-09-09");
  // Began and ended yesterday: finished, so it needs closing out.
  const finished = span("c-finished", "Jannik Wiedenhaupt", "2026-09-08", "2026-09-08");
  const list = [running, finished];

  assert.equal(groupOf(M, list, "c-running"), "Upcoming");
  assert.equal(groupOf(M, list, "c-finished"), "Needs closing out");
  // Both started yesterday — grouping on the start date would have put them together.
  assert.equal(M.trialDay(running), M.trialDay(finished));
});

test("the boundary is today itself, inclusive", () => {
  const M = sorter();
  const list = [
    span("c-today", "A A", "2026-09-01", "2026-09-09"),
    span("c-yesterday", "B B", "2026-09-01", "2026-09-08"),
    span("c-tomorrow", "C C", "2026-09-10", "2026-09-11"),
  ];
  assert.equal(groupOf(M, list, "c-today"), "Upcoming", "ending today is not past");
  assert.equal(groupOf(M, list, "c-yesterday"), "Needs closing out");
  assert.equal(groupOf(M, list, "c-tomorrow"), "Upcoming");
});

test("Upcoming ascends and Needs closing out descends", () => {
  const M = sorter();
  const list = [
    span("u-far", "A A", "2026-09-20", "2026-09-24"),
    span("u-near", "B B", "2026-09-10", "2026-09-11"),
    span("p-old", "C C", "2026-07-01", "2026-07-05"),
    span("p-recent", "D D", "2026-09-01", "2026-09-05"),
  ];
  const g = M.dateGroups(list, TODAY);
  assert.deepEqual(g[0].rows.map((c) => c.id), ["u-near", "u-far"], "soonest first");
  assert.deepEqual(g[1].rows.map((c) => c.id), ["p-recent", "p-old"], "freshest first");
});

test("the three groups come back in display order, always", () => {
  const M = sorter();
  const g = M.dateGroups([], TODAY);
  assert.deepEqual(g.map((x) => x.label), ["Upcoming", "Needs closing out", "Awaiting a date"]);
  assert.deepEqual(g.map((x) => x.rows.length), [0, 0, 0], "empty groups are still returned; render drops them");
});

test("a start date with no end date falls back to the start", () => {
  const M = sorter();
  const future = span("c-future", "A A", "2026-09-20", undefined);
  const pastOnly = span("c-past", "B B", "2026-09-01", undefined);
  const list = [future, pastOnly];
  assert.equal(M.trialEndDay(future), 20260920, "the start stands in for the end");
  assert.equal(groupOf(M, list, "c-future"), "Upcoming");
  assert.equal(groupOf(M, list, "c-past"), "Needs closing out");
});

test("an end date with no start date still groups", () => {
  const M = sorter();
  const c = span("c1", "A A", undefined, "2026-09-20");
  assert.equal(M.trialEndDay(c), 20260920);
  assert.equal(groupOf(M, [c], "c1"), "Upcoming");
});

test("no usable date at all lands in Awaiting a date", () => {
  const M = sorter();
  const list = [
    span("c-tbd", "A A", "TBD", "TBD"),
    span("c-none", "B B", undefined, undefined),
    span("c-dated", "Z Z", "2026-09-20", "2026-09-21"),
  ];
  const g = M.dateGroups(list, TODAY);
  // "A A" before "B B" — the undated group is ordered by name, nothing else.
  assert.deepEqual(g[2].rows.map((c) => c.id), ["c-tbd", "c-none"], "unparseable is undated, in name order");
  assert.deepEqual(g[0].rows.map((c) => c.id), ["c-dated"]);
});

test("the Ashby end date wins over a stored one, and decides the group", () => {
  const M = sorter();
  // Stored end says last month; Ashby's derived trial end says next week.
  const c = span("c1", "Andrew Mi", "2026-08-01", "2026-08-05");
  c.values.ashbyCandidateId = "ash-1";
  M.panels["ash-1"] = {
    state: "live",
    panel: { trialStart: "2026-09-14T16:00:00Z", trialEnd: "2026-09-18T16:00:00Z",
             fields: { trialDates: { value: "x" } } },
  };
  assert.equal(M.effective(c, "endDate"), "2026-09-18");
  assert.equal(M.trialEndDay(c), 20260918);
  assert.equal(groupOf(M, [c], "c1"), "Upcoming", "the stored dates would have said past");
});

test("today comes from the Pacific day, not UTC", () => {
  const M = sorter();
  const t = M.todayDay();
  assert.ok(typeof t === "number" && String(t).length === 8, "a calendar integer: " + t);
  // Independently derived the same way the card does.
  const EFF = require("../lib/effective");
  assert.equal(t, M.parseDay(EFF.isoToDay(new Date())));
});

test("grouping does not mutate the list it is given", () => {
  const M = sorter();
  const list = [
    span("c-far", "A A", "2026-09-20", "2026-09-24"),
    span("c-near", "B B", "2026-09-10", "2026-09-11"),
    span("c-past", "C C", "2026-07-01", "2026-07-05"),
  ];
  const before = list.map((c) => c.id);
  M.dateGroups(list, TODAY);
  assert.deepEqual(list.map((c) => c.id), before, "the caller's array is untouched");
});

/* ============ a running trial is not hidden by its status (10 Sep) */

const statusCard = (id, name, status, start, end, over) => ({
  id, name,
  values: Object.assign({ status }, start === undefined ? {} : { startDate: start },
                                   end === undefined ? {} : { endDate: end }, over || {}),
});

const T = 20260910; // fixed, so these do not drift with the wall clock

test("DONE with an end date of today appears in Upcoming", () => {
  const M = sorter();
  // Mykhailo Skrobach: 9 to 10 Sept, DONE, and invisible on the 10th while his
  // trial was still running.
  const c = statusCard("mykhailo", "Mykhailo Skrobach", "DONE", "2026-09-09", "2026-09-10");
  const split = M.splitActive([c], T);
  assert.deepEqual(split.active.map((x) => x.id), ["mykhailo"], "not filed away");
  assert.deepEqual(split.done.map((x) => x.id), []);
  assert.deepEqual(M.dateGroups(split.active, T)[0].rows.map((x) => x.id), ["mykhailo"]);
});

test("DONE with an end date of yesterday does not", () => {
  const M = sorter();
  const c = statusCard("finished", "A Person", "DONE", "2026-09-07", "2026-09-09");
  const split = M.splitActive([c], T);
  assert.deepEqual(split.active.map((x) => x.id), [], "a finished trial stays out of the way");
  assert.deepEqual(split.done.map((x) => x.id), ["finished"]);
});

test("DONE with no stored dates but an Ashby-derived future date appears", () => {
  // Three DONE candidates carry no stored dates. Reading the stored field would
  // miss them, so the rule goes through effective().
  const M = sorter();
  const c = statusCard("derived", "Derived Person", "DONE", undefined, undefined,
                       { ashbyCandidateId: "ash-d" });
  M.panels["ash-d"] = {
    state: "live",
    panel: { trialStart: "2026-09-14T16:00:00Z", trialEnd: "2026-09-18T16:00:00Z",
             fields: { trialDates: { value: "x" } } },
  };
  assert.equal(c.values.endDate, undefined, "nothing stored");
  assert.equal(M.effective(c, "endDate"), "2026-09-18", "but Ashby knows");
  const split = M.splitActive([c], T);
  assert.deepEqual(split.active.map((x) => x.id), ["derived"]);
  assert.deepEqual(M.dateGroups(split.active, T)[0].rows.map((x) => x.id), ["derived"]);
});

test("DONE with no date at all stays filed away", () => {
  const M = sorter();
  const c = statusCard("nodate", "No Date", "DONE", undefined, undefined);
  const split = M.splitActive([c], T);
  assert.deepEqual(split.active.map((x) => x.id), [], "no date is not a live trial");
  assert.deepEqual(split.done.map((x) => x.id), ["nodate"]);
});

test("CANCELED with a future date does not appear in Upcoming", () => {
  const M = sorter();
  const c = statusCard("cancelled", "Cancelled Person", "CANCELED", "2026-09-20", "2026-09-24");
  const g = M.dateGroups([c], T);
  assert.deepEqual(g[0].rows.map((x) => x.id), [], "a cancelled trial is not upcoming");
  // It stays visible rather than vanishing: Needs closing out.
  assert.deepEqual(g[1].rows.map((x) => x.id), ["cancelled"]);
});

test("a candidate drops out of Upcoming on its own the day after its end date", () => {
  const M = sorter();
  const c = statusCard("rolling", "Rolling Person", "DONE", "2026-09-09", "2026-09-10");

  let split = M.splitActive([c], 20260910);
  assert.deepEqual(split.active.map((x) => x.id), ["rolling"], "on the 10th it is running");
  assert.deepEqual(M.dateGroups(split.active, 20260910)[0].rows.map((x) => x.id), ["rolling"]);

  split = M.splitActive([c], 20260911);
  assert.deepEqual(split.active.map((x) => x.id), [], "on the 11th nothing changed but the date");
  assert.deepEqual(split.done.map((x) => x.id), ["rolling"]);
});

test("a candidate that is not DONE is unaffected by the rule", () => {
  const M = sorter();
  const live = statusCard("live", "Live Person", "IN PROGRESS", "2026-09-20", "2026-09-24");
  const past = statusCard("past", "Past Person", "IN PROGRESS", "2026-08-01", "2026-08-05");
  const split = M.splitActive([live, past], T);
  assert.deepEqual(split.active.map((x) => x.id).sort(), ["live", "past"]);
  assert.deepEqual(split.done.map((x) => x.id), []);
  const g = M.dateGroups(split.active, T);
  assert.deepEqual(g[0].rows.map((x) => x.id), ["live"]);
  assert.deepEqual(g[1].rows.map((x) => x.id), ["past"]);
});

test("the pill is left alone and no group was added", () => {
  // A DONE pill in Upcoming is the point: it makes the contradiction visible.
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  // The pill still renders the status and nothing else. Matching on the word
  // "running" caught the implementation's own variable name, which is why this
  // asserts the markup instead.
  const pillFn = src.slice(src.indexOf("function statusPill(c){"),
                           src.indexOf("}", src.indexOf("return '<span class=\"pill")) + 1);
  assert.match(pillFn, /<span class="pill '\+toneClass\(t\)\+'"><span class="dot"><\/span>'\+esc\(st\)\+'<\/span>/,
    "statusPill markup changed: " + pillFn);
  assert.equal(/\.pill-running|\.badge-running|class="pill [^"]*running/i.test(src), false,
    "no running badge class was added");
  const labels = [...src.matchAll(/label:"(Upcoming|Needs closing out|Awaiting a date)"/g)]
    .map((m) => m[1]);
  assert.deepEqual(labels, ["Upcoming", "Needs closing out", "Awaiting a date"],
    "still exactly three groups");
});
