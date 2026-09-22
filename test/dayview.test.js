"use strict";
const test = require("node:test");
const assert = require("node:assert");
const D = require("../lib/dateday.js");

/* Spec section 9, day expansion. The model is in lib/dateday.js rather than in
   the view, so these test the thing the view calls, not a copy of it.

   Note on section 2's "reuse lib/trialwindow.js": that module derives a window
   from Ashby interview SCHEDULES, which the browser never sees. The reuse is
   already transitive — bot 1 runs deriveTrialWindow and writes the panel entry,
   effective() reads that panel entry, and this model reads effective(). Calling
   deriveTrialWindow from the view would need data the view does not have. */

const day = (s) => D.parseDay(s);
const spanOf = (start, end) => D.trialSpan(day(start), end === undefined ? null : day(end));

/** Which of these days does the trial appear on? The question the view asks. */
function daysAppearing(span, columns) {
  return columns.filter((d) => D.coversDay(span, d));
}
/* A wide fixed range for the expansion tests, so a span cannot fail merely by
   sitting outside the default three-day window. Section 3 tests the window. */
const columns = (function () {
  const out = [];
  for (let d = day("2026-09-01"); d <= day("2026-10-31"); d = D.addDays(d, 1)) out.push(d);
  return out;
})();

test("a single-day trial appears on exactly one day", () => {
  const s = spanOf("2026-09-14", "2026-09-14");
  assert.deepEqual(daysAppearing(s, columns), [20260914]);
  assert.equal(s.days, 1);
});

test("a three-day trial appears on all three, with Day N of M on each", () => {
  const s = spanOf("2026-09-13", "2026-09-15");
  assert.deepEqual(daysAppearing(s, columns), [20260913, 20260914, 20260915]);
  assert.equal(s.days, 3);
  assert.deepEqual([20260913, 20260914, 20260915].map((d) => D.dayIndex(s, d)), [1, 2, 3]);
  // and the final day, which is where the debrief lands
  assert.deepEqual([20260913, 20260914, 20260915].map((d) => D.isFinalDay(s, d)),
    [false, false, true]);
});

test("a start date with no end date is a single day", () => {
  const s = spanOf("2026-09-14");
  assert.equal(s.days, 1);
  assert.equal(s.startDay, 20260914);
  assert.equal(s.endDay, 20260914);
  assert.deepEqual(daysAppearing(s, columns), [20260914]);
});

test("no start date is absent from every day column", () => {
  const s = D.trialSpan(null, day("2026-09-14"));
  assert.equal(s, null, "no span at all, so nothing can place it on a day");
  assert.deepEqual(daysAppearing(s, columns), []);
  // and a wide window changes nothing
  const wide = [];
  for (let d = day("2026-01-01"); d <= day("2026-12-31"); d = D.addDays(d, 1)) wide.push(d);
  assert.deepEqual(daysAppearing(s, wide), []);
});

test("an unparseable date is treated as null, with no second guard", () => {
  assert.equal(day("14/09/2026"), null);
  assert.equal(day("2026-02-31"), null);
  assert.equal(day(""), null);
  // start unparseable: excluded entirely
  assert.equal(D.trialSpan(day("not a date"), day("2026-09-14")), null);
  // end unparseable: falls into the start-only case, single day
  const s = D.trialSpan(day("2026-09-14"), day("nonsense"));
  assert.equal(s.days, 1);
  assert.equal(s.reversed, false, "a missing end is not a reversed end");
});

test("a reversed range appears once at the start day and carries the flag", () => {
  // Vivian (Yiting) G., one of the three rows in section 7.
  const s = spanOf("2026-09-18", "2026-09-17");
  assert.notEqual(s, null, "never dropped");
  assert.equal(s.reversed, true);
  assert.equal(s.days, 1);
  assert.equal(s.startDay, 20260918);
  const wide = D.dayColumns(day("2026-09-10"), [s]).days;
  const appears = daysAppearing(s, wide);
  assert.deepEqual(appears, [20260918],
    "present at startDay, which is the whole point: a naive range shows it on zero days");
  // the failure this exists to prevent
  assert.equal(appears.length > 0, true, "a reversed trial must not vanish");
});

test("all three of the section 7 rows survive expansion", () => {
  const rows = [
    ["Vivian (Yiting) G.", "2026-09-18", "2026-09-17"],
    ["Anthony El Raachini", "2026-09-21", "2026-09-20"],
    ["Andres Galeano", "2026-10-02", "2026-10-01"],
  ];
  for (const [name, start, end] of rows) {
    const s = spanOf(start, end);
    assert.equal(s.reversed, true, name + " should be flagged");
    assert.equal(s.days, 1, name + " should render as one day");
    assert.equal(s.startDay, day(start), name + " should sit on its start day");
  }
});

test("a trial spanning a DST boundary keeps the same day count as the card", () => {
  // DST ends in America/Los_Angeles on 1 Nov 2026, so 1 Nov is a 25-hour day.
  const fall = spanOf("2026-10-31", "2026-11-02");
  assert.equal(fall.days, 3, "25-hour day must not become 3.04 days");
  assert.deepEqual([20261031, 20261101, 20261102].map((d) => D.dayIndex(fall, d)), [1, 2, 3]);

  // DST begins 8 Mar 2026, a 23-hour day, which is the direction that truncates.
  const spring = D.trialSpan(day("2026-03-07"), day("2026-03-09"));
  assert.equal(spring.days, 3, "23-hour day must not become 2.96 days floored to 2");
  assert.deepEqual([20260307, 20260308, 20260309].map((d) => D.dayIndex(spring, d)), [1, 2, 3]);

  // and stepping across the boundary lands on real calendar days
  assert.equal(D.addDays(20261031, 1), 20261101);
  assert.equal(D.addDays(20260307, 1), 20260308);
});

test("status does not gate occupancy", () => {
  // A DONE candidate with live dates still occupies them, same as the Upcoming
  // rule. trialSpan is not given a status at all, which is the guarantee.
  assert.equal(D.trialSpan.length, 2, "trialSpan takes dates only, never a status");
  const s = spanOf("2026-09-13", "2026-09-15");
  assert.equal(D.coversDay(s, 20260914), true);
});

/* ---------------- section 3, window and scrolling ---------------- */

test("the window is anchored at today and always at least three days", () => {
  const w = D.dayColumns(day("2026-09-10"), []);
  assert.equal(w.anchorDay, 20260910);
  assert.equal(w.days.includes(20260910), true, "today");
  assert.equal(w.days.includes(20260911), true, "tomorrow");
  assert.equal(w.days.includes(20260912), true, "the day after");
  assert.equal(w.days[w.days.length - 1], 20260912, "no further, with no data");
});

test("the window reaches back exactly seven days", () => {
  const w = D.dayColumns(day("2026-09-10"), []);
  assert.equal(w.days[0], 20260903, "seven days back");
  assert.equal(D.diffDays(w.days[0], w.anchorDay), 7);
  assert.equal(w.days.includes(20260909), true, "yesterday, which is where debriefs are");
  assert.equal(w.days.includes(20260902), false, "and no further");
});

test("the window extends forward as far as there is data", () => {
  const late = D.trialSpan(day("2026-09-28"), day("2026-09-30"));
  const w = D.dayColumns(day("2026-09-10"), [late]);
  assert.equal(w.days[w.days.length - 1], 20260930, "out to the last day of the last trial");
  assert.equal(w.days.includes(20260919), true, "including the quiet days in between");
  assert.equal(w.beyond, 0);
});

test("days with no trials still get a column", () => {
  const only = D.trialSpan(day("2026-09-14"), day("2026-09-14"));
  const w = D.dayColumns(day("2026-09-10"), [only]);
  const empty = w.days.filter((d) => !D.coversDay(only, d));
  assert.equal(empty.length, w.days.length - 1);
  assert.equal(w.days.includes(20260913), true, "a blank day is information");
});

test("a mistyped year is capped and counted, not rendered as ten thousand columns", () => {
  // Not in the spec. Three rows have already arrived with dates entered
  // backwards, so a 2126 typo is a realistic way to hang this page.
  const typo = D.trialSpan(day("2126-09-14"), day("2126-09-16"));
  const w = D.dayColumns(day("2026-09-10"), [typo]);
  assert.equal(w.days.length <= D.WINDOW_BACK + D.WINDOW_FORWARD_CAP + 1, true);
  assert.equal(w.beyond, 1, "counted so it can be reported rather than silently cut");
  const ok = D.trialSpan(day("2026-09-14"), day("2026-09-14"));
  assert.equal(D.dayColumns(day("2026-09-10"), [ok]).beyond, 0);
});

test("a null span in the list does not break the window", () => {
  const w = D.dayColumns(day("2026-09-10"), [null, D.trialSpan(null, null), undefined]);
  assert.equal(w.days.length, 10);
  assert.equal(w.beyond, 0);
});

/* ---------------- one definition, two consumers ---------------- */

const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("the browser does not keep its own copy of the day parser", () => {
  // Section 2: do not introduce a second date helper. One already existed —
  // index.html carried a full parseDay while lib/dateday.js was server-only, so
  // the list sort and the save validation could have drifted on what a date is.
  assert.match(html, /<script src="\/dateday\.js"><\/script>/,
    "the browser must load the shared module");
  assert.match(server, /app\.get\("\/dateday\.js"/, "and the server must serve it");

  assert.match(html, /function parseDay\(v\)\{ return DATEDAY\.parseDay\(v\); \}/,
    "the browser's parseDay must delegate, not reimplement");
  assert.equal(/probe\.getUTCFullYear\(\)/.test(html), false,
    "the round-trip probe belongs to lib/dateday.js alone");
  assert.equal(/y\*10000\+mo\*100\+d/.test(html), false,
    "and so does the integer encoding");
});

test("both sides ask the same question about a reversed range", () => {
  assert.match(html, /DATEDAY\.isReversed\(startRaw,endRaw\)/, "the view");
  assert.match(server, /DATEDAY\.isReversed\(startDate, endDate\)/, "and the server");
  // The rule the two now share, including the cases that are not reversals.
  assert.equal(D.isReversed("2026-09-18", "2026-09-17"), true);
  assert.equal(D.isReversed("2026-09-18", "2026-09-18"), false, "a single-day trial");
  assert.equal(D.isReversed("2026-09-18", null), false, "nothing to compare");
  assert.equal(D.isReversed("2026-09-18", "not a date"), false);
});


/* ================ addendum: the calendar ================
   Replaces the section 3, 5 and 6 rendering tests. The day model above is
   unchanged and still underpins all of this.

   Sliced out of index.html so it fails loudly if the code moves. */

const DRI = require("../lib/dri-aliases");
const INV = require("../lib/assignment-inventory");
const SUGGEST = require("../lib/suggest-assignments");
const EFFECTIVE = require("../lib/effective");
const FIELDS = require("../lib/fields");

function dayRenderer(candidates, today, opts) {
  const a = html.indexOf("  function daySpan(c){");
  const b = html.indexOf("  /* Hover is primary.");
  assert.ok(a >= 0 && b > a, "the Day view moved");
  const src = html.slice(a, b);
  const store = Object.assign({}, (opts || {}).store);
  return new Function("DATEDAY", "DRI", "INVENTORY", "SUGGEST", "EFFECTIVE", "FIELDS", "CANDS", "TODAY", "STORE", `
    /* A DOM stub big enough for the render path: the band looks up its two
       scrollers, wires a scroll listener, and the panel layer is created on
       the body. None of it needs to lay anything out. */
    var els={};
    function stubEl(id){
      if(!els[id]) els[id]={ id:id, innerHTML:"", scrollLeft:0, style:{}, dataset:{},
        classList:{ has:{}, add:function(c){ this.has[c]=true; },
                    remove:function(c){ delete this.has[c]; },
                    contains:function(c){ return !!this.has[c]; },
                    toggle:function(c,on){ if(on) this.add(c); else this.remove(c); } },
        setAttribute:function(){}, addEventListener:function(){},
        appendChild:function(){}, contains:function(){ return false; },
        querySelector:function(){ return null; },
        querySelectorAll:function(){ return []; },
        getBoundingClientRect:function(){ return { left:0,right:0,top:0,bottom:0 }; },
        offsetWidth:264, offsetHeight:200 };
      return els[id];
    }
    var dayViewEl = stubEl("dayView");
    var listEl = stubEl("list");
    var document = { getElementById:function(id){ return els[id]||null; },
                     createElement:function(){ return stubEl("__layer"+Math.random()); },
                     body:{ appendChild:function(){} },
                     addEventListener:function(){} };
    var window = { innerWidth:1200, innerHeight:900, addEventListener:function(){} };
    function lsGet(k){ return Object.prototype.hasOwnProperty.call(STORE,k)?STORE[k]:null; }
    function lsSet(k,v){ STORE[k]=String(v); }
    function scrollToToday(){}
    var uiOpen={}, selectedCandidateId=null;
    function render(){}
    function esc(s){ return (s==null?"":String(s)).replace(/[&<>"]/g,function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
    function get(c,k){
      return c.values[k] === undefined ? FIELDS.defVal(FIELDS.field(k)) : c.values[k];
    }
    function effective(c,key){ return EFFECTIVE.resolve(c, key, null, get(c,key)); }
    function parseDay(v){ return DATEDAY.parseDay(v); }
    function todayDay(){ return TODAY; }
    function filtered(){ return CANDS; }
    function nameSortKey(c){
      var parts=String(c.name||"").trim().split(/\\s+/).filter(Boolean);
      return [ (parts.length?parts[parts.length-1]:"").toLowerCase(),
               (parts.length?parts[0]:"").toLowerCase() ];
    }
    function statusPill(c){ return '<span class="pill">'+esc(get(c,"status"))+'</span>'; }
    ${src}
    return { layoutBars: layoutBars, windowSize: windowSize, setWindowSize: setWindowSize,
             isWeekend: isWeekend, daySpan: daySpan, driOf: driOf,
             concurrentFor: concurrentFor, recentFor: recentFor, collisionsOn: collisionsOn,
             CONCURRENT_WARN: CONCURRENT_WARN, store: STORE,
             dayPanels: function(){ return dayPanels; },
             daySignature: daySignature, renderDayIfChanged: renderDayIfChanged,
             renderCount: function(){ return dayRenderCount; },
             positionPanel: positionPanel, showPanel: showPanel, hidePanel: hidePanel,
             setPanelState: setPanelState,
             out: function(){ renderDay(); return dayViewEl.innerHTML; } };
  `)(D, DRI, INV, SUGGEST, EFFECTIVE, FIELDS, candidates, today, store);
}

const row = (id, name, start, end, dri, over) => ({
  id, name,
  values: Object.assign({ status: "NOT STARTED", position: "FDE" },
    start === undefined ? {} : { startDate: start },
    end === undefined ? {} : { endDate: end },
    dri === undefined ? {} : { driName: dri }, over || {}),
});
const entriesOf = (v, cands) => cands.map((c) => ({ c, span: v.daySpan(c), dri: v.driOf(c) }));
/** A contiguous window, for the layout tests that need an explicit one. */
const windowOf = (from, n) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(D.addDays(D.parseDay(from), i));
  return out;
};
/** Every grid-column declaration in the output, in order. */
const gridCols = (out) => (out.match(/grid-column:\d+ \/ span \d+/g) || []);

/* ---- production fixture, section H ---- */
const PROD = [
  row("p1", "Mykhailo Skrobach", "2026-09-10", "2026-09-10", "fds-dillon"),
  row("p2", "Brandon Wagoner", "2026-09-13", "2026-09-15", "neel"),
  row("p3", "Ari Blumkin", "2026-09-13", "2026-09-14", "shantam"),
  row("p4", "Ahmet Hatip", "2026-09-14", "2026-09-14", ""),
  row("p5", "Vivian (Yiting) G.", "2026-09-17", "2026-09-18", "NOT YET"),
];

/* ---------------- spanning ---------------- */

test("an N-day trial is one element spanning N columns, not N elements", () => {
  const cands = [row("c1", "Ada Lovelace", "2026-09-13", "2026-09-15", "sam h")];
  const out = dayRenderer(cands, 20260910).out();
  assert.equal((out.match(/class="tcard/g) || []).length, 1, "one bar, not three");
  assert.equal((out.match(/class="tc-name">Ada Lovelace/g) || []).length, 1,
    "and the name appears on one bar, not once per day");
  assert.deepEqual(gridCols(out), ["grid-column:11 / span 3"], "13th is column 11 of the window");
});

test("a single-day trial spans one column", () => {
  const out = dayRenderer([row("c1", "Ada", "2026-09-11", "2026-09-11", "sam h")], 20260910).out();
  assert.deepEqual(gridCols(out), ["grid-column:9 / span 1"]);
});

test("three overlapping trials occupy three lanes with no overlap", () => {
  // The 14th is the only day in production with three concurrent trials.
  const v = dayRenderer(PROD, 20260910);
  const days = windowOf("2026-09-13", 3);
  const laid = v.layoutBars(days, entriesOf(v, PROD));
  const on14 = laid.bars.filter((b) => b.startCol <= 1 && b.startCol + b.spanCols - 1 >= 1);
  assert.equal(on14.length, 3, "Brandon, Ari and Ahmet");
  assert.equal(new Set(on14.map((b) => b.lane)).size, 3, "three distinct lanes");
  assert.equal(laid.lanes, 3);
  // and no two bars in one lane share a column
  const byLane = {};
  laid.bars.forEach((b) => { (byLane[b.lane] = byLane[b.lane] || []).push(b); });
  for (const lane of Object.keys(byLane)) {
    const cells = [];
    byLane[lane].forEach((b) => {
      for (let i = 0; i < b.spanCols; i++) cells.push(b.startCol + i);
    });
    assert.equal(new Set(cells).size, cells.length, "lane " + lane + " has no overlap");
  }
});

test("a lane is reused once it is free", () => {
  const cands = [row("c1", "A", "2026-09-11", "2026-09-11", "sam h"),
                 row("c2", "B", "2026-09-12", "2026-09-12", "shantam")];
  const v = dayRenderer(cands, 20260910);
  const laid = v.layoutBars(windowOf("2026-09-11", 2), entriesOf(v, cands));
  assert.equal(laid.lanes, 1, "consecutive, not concurrent, so one lane");
  assert.deepEqual(laid.bars.map((b) => b.lane), [0, 0]);
});

test("one DOM element per trial per window, for every trial in the fixture", () => {
  const out = dayRenderer(PROD, 20260910).out();
  assert.equal((out.match(/class="tcard/g) || []).length, 5, "five trials, five bars");
  for (const c of PROD) {
    const name = c.name.replace(/[()]/g, "\\$&");
    assert.equal((out.match(new RegExp('class="tc-name">' + name)) || []).length, 1,
      c.name + " appears once");
  }
});

/* ---------------- clipping ---------------- */

test("a trial starting before the window is clipped left, and is present", () => {
  // Section H: anchor at 14 Sep and Brandon Wagoner, 13 to 15, must show cut.
  const v = dayRenderer(PROD, 20260914);
  const days = windowOf("2026-09-14", 3);
  const laid = v.layoutBars(days, entriesOf(v, PROD));
  const brandon = laid.bars.filter((b) => b.entry.c.name === "Brandon Wagoner")[0];
  assert.ok(brandon, "present, not dropped");
  assert.equal(brandon.clippedLeft, true);
  assert.equal(brandon.clippedRight, false);
  assert.equal(brandon.startCol, 0, "drawn from the window edge");
  assert.equal(brandon.spanCols, 2, "the 14th and the 15th");
  // and the real start date is not rewritten to the window edge
  assert.equal(brandon.entry.span.startDay, 20260913, "still starts on the 13th");
});

test("a trial ending after the window is clipped right, and is present", () => {
  const v = dayRenderer(PROD, 20260910);
  const days = windowOf("2026-09-12", 2);   // 12th and 13th
  const laid = v.layoutBars(days, entriesOf(v, PROD));
  const brandon = laid.bars.filter((b) => b.entry.c.name === "Brandon Wagoner")[0];
  assert.ok(brandon, "present, not dropped");
  assert.equal(brandon.clippedRight, true);
  assert.equal(brandon.clippedLeft, false);
  assert.equal(brandon.startCol, 1);
  assert.equal(brandon.spanCols, 1, "only the 13th is in view");
  assert.equal(brandon.entry.span.endDay, 20260915, "still ends on the 15th");
});

test("a trial spanning the whole window is clipped at both ends", () => {
  const cands = [row("c1", "Long", "2026-09-01", "2026-09-30", "sam h")];
  const v = dayRenderer(cands, 20260910);
  const laid = v.layoutBars(windowOf("2026-09-10", 3), entriesOf(v, cands));
  assert.equal(laid.bars.length, 1);
  assert.equal(laid.bars[0].clippedLeft, true);
  assert.equal(laid.bars[0].clippedRight, true);
  assert.equal(laid.bars[0].spanCols, 3);
});

test("the clip cue is rendered, on the cut side only", () => {
  const v = dayRenderer(PROD, 20260914);
  const days = windowOf("2026-09-14", 3);
  const laid = v.layoutBars(days, entriesOf(v, PROD));
  const brandon = laid.bars.filter((b) => b.entry.c.name === "Brandon Wagoner")[0];
  assert.equal(brandon.clippedLeft && !brandon.clippedRight, true);
  assert.match(html, /\.tcard\.clip-l\{border-top-left-radius:0/, "squared off on the cut edge");
  assert.match(html, /\.tcard\.clip-r\{border-top-right-radius:0/);
  assert.match(html, /\.tcard\.clip-l::before,\.tcard\.clip-r::after\{content:""/,
    "cued with a painted stripe, not an inset shadow");
  // the declaration, not the comment explaining why it is not used
  assert.equal(/box-shadow\s*:/.test(html), false, "the brief says no shadows, without exception");
  assert.equal(/clip-l/.test(dayRenderer(PROD, 20260910).out()), false,
    "not applied when nothing is cut");
});
test("only a trial entirely outside the window is absent", () => {
  const cands = [row("c1", "Inside", "2026-09-11", "2026-09-11", "sam h"),
                 row("c2", "Before", "2026-09-01", "2026-09-02", "sam h"),
                 row("c3", "After", "2026-09-20", "2026-09-21", "sam h")];
  const v = dayRenderer(cands, 20260910);
  const laid = v.layoutBars(windowOf("2026-09-10", 3), entriesOf(v, cands));
  assert.deepEqual(laid.bars.map((b) => b.entry.c.id), ["c1"]);
  // absent from THIS window is not absent from the view
  const wide = v.layoutBars(windowOf("2026-09-01", 30), entriesOf(v, cands));
  assert.equal(wide.bars.length, 3);
});

/* ---------------- window control ---------------- */

test("the window control offers 3 and 7 days, defaulting to 3", () => {
  const v = dayRenderer([], 20260910);
  assert.equal(v.windowSize(), 3);
  const out = v.out();
  assert.match(out, /data-act="wsize" data-n="3"[^>]*aria-pressed="true"/);
  assert.match(out, /data-act="wsize" data-n="7"[^>]*aria-pressed="false"/);
  assert.match(out, /--vis:3/);
});

test("the window choice survives a reload", () => {
  const v = dayRenderer([], 20260910);
  v.setWindowSize(7);
  assert.equal(v.store["wt-day-window"], "7");
  // a fresh render with the same storage, which is what a reload is
  const after = dayRenderer([], 20260910, { store: v.store });
  assert.equal(after.windowSize(), 7);
  assert.match(after.out(), /--vis:7/);
});

test("toggling 3 to 7 and back preserves the anchor date", () => {
  const anchorOf = (out) => (out.match(/id="daycol-(\d+)"[^>]*>(?:(?!<\/span>)[\s\S])*?/g) || [])[0];
  const three = dayRenderer(PROD, 20260910, { store: { "wt-day-window": "3" } }).out();
  const seven = dayRenderer(PROD, 20260910, { store: { "wt-day-window": "7" } }).out();
  const back = dayRenderer(PROD, 20260910, { store: { "wt-day-window": "3" } }).out();
  for (const out of [three, seven, back]) {
    assert.match(out, /id="daycol-20260910"/, "today is still rendered");
    assert.equal((out.match(/class="dtile is-today"/g) || []).length, 1, "exactly one today");
  }
  assert.equal(anchorOf(three), anchorOf(back), "same first column either side of the toggle");
  assert.equal(anchorOf(three), anchorOf(seven), "and the same one at 7 days");
});

test("a bad stored window size falls back rather than rendering nothing", () => {
  for (const bad of ["", "0", "99", "abc", null]) {
    const v = dayRenderer([], 20260910, { store: { "wt-day-window": bad } });
    assert.equal(v.windowSize(), 3, JSON.stringify(bad));
  }
});

test("the 90-day cap still counts and reports rather than cutting silently", () => {
  const out = dayRenderer([row("c1", "Typo", "2126-09-14", "2126-09-16", "sam h")], 20260910).out();
  assert.match(out, /1 trial sits more than 90 days ahead and is not shown/);
  assert.equal(/daycol-21260914/.test(out), false);
});

/* ---------------- calendar chrome ---------------- */

test("day tiles are a lowercase weekday over a large numeral", () => {
  const out = dayRenderer([], 20260910).out();
  assert.match(out, /<span class="dt-wd">thu<\/span><span class="dt-num">10<\/span>/);
  assert.match(out, /<span class="dt-wd">fri<\/span><span class="dt-num">11<\/span>/);
  assert.equal(/class="dt-wd">Thu</.test(out), false, "lowercase, not title case");
  assert.equal(/class="dt-wd">THU</.test(out), false, "uppercase is for status pills");
  assert.match(html, /\.dt-num\{font-size:30px;font-weight:700;line-height:1;letter-spacing:-\.02em/);
  assert.match(html, /\.dt-wd\{font-size:12px;font-weight:600[^}]*text-transform:lowercase/);
});

test("today is a white bordered tile, and there is no second today marker", () => {
  const out = dayRenderer([], 20260910).out();
  assert.equal((out.match(/class="dtile is-today"/g) || []).length, 1, "exactly one");
  assert.match(html, /\.dtile\.is-today\{background:var\(--paper\);border:1\.5px solid var\(--ink\)\}/);
  assert.match(html, /\.dtile\{[^}]*background:var\(--surface\)/, "siblings are tinted");
  assert.equal(/>Today</.test(out.slice(out.indexOf("dayband"))), false,
    "the tile IS the marker; a label beside it says the same thing weakly");
});
test("weekend tiles render the numeral in ink-3, and trials still run there", () => {
  const v = dayRenderer([], 20260910);
  assert.equal(v.isWeekend(20260912), true, "Saturday");
  assert.equal(v.isWeekend(20260913), true, "Sunday");
  assert.equal(v.isWeekend(20260911), false, "Friday");
  assert.match(v.out(), /class="dtile weekend"/);
  assert.match(html, /\.dtile\.weekend \.dt-num\{color:var\(--ink-3\)\}/);
  assert.equal(/\.dtile\.weekend\{[^}]*opacity/.test(html), false, "not dimmed");
  assert.equal(/\.dtile\.weekend\{[^}]*line-through/.test(html), false, "not struck out");
  const sat = [row("c1", "Sat", "2026-09-12", "2026-09-12", "sam h")];
  const vs = dayRenderer(sat, 20260910);
  assert.equal(vs.layoutBars(windowOf("2026-09-12", 1), entriesOf(vs, sat)).bars.length, 1);
});
test("an empty day renders a tinted ground and says so, with no border", () => {
  const out = dayRenderer(PROD, 20260910).out();
  const ground = (d) => {
    const m = new RegExp('id="daycol-' + d + '"[^>]*>(.*?)</span>').exec(out);
    return m ? m[1] : null;
  };
  // the helper stops at the first </span>, so the label's own close is not in it
  assert.match(ground("20260911"), /class="dcol-empty">No trials/);
  assert.match(ground("20260912"), /No trials/);
  assert.equal(/No trials/.test(ground("20260910")), false, "the 10th has Mykhailo");
  const rule = html.slice(html.indexOf("  .dcol{"), html.indexOf("  .dcol-empty{"));
  assert.match(rule, /color-mix\(in srgb, var\(--surface\) 55%, var\(--paper\)\)/);
  assert.equal(/border\s*:/.test(rule), false, "no border, no box (radius is not a border)");
  assert.match(html, /\.dcol-empty\{font-size:11\.5px;font-weight:600;color:var\(--ink-3\)/);
});
test("the compact card shows name, role, resource summary and status", () => {
  // DESIGN.md supersedes addendum 1's "keep it to what survives the narrowest
  // case". The card now carries the kit row; the panel still carries the rest.
  const out = dayRenderer([row("c1", "Ada Lovelace", "2026-09-11", "2026-09-11", "sam h",
    { computer: "SF-Poetic 7", desk: "SF-Desk 1" })], 20260910).out();
  const card = out.slice(out.indexOf('class="tcard'));
  assert.match(card, /<span class="tc-name">Ada Lovelace<\/span>/);
  assert.match(card, /class="tc-role">FDE<\/span>/, "role is secondary");
  assert.match(card, /Resources assigned/, "concise resource status");
  assert.doesNotMatch(card, /Sam Henderson|SF-Desk 1|SF-Poetic 7/, "details stay in panel");
  assert.match(card, /class="pill"/, "and the status pill");
  assert.equal(/1 concurrent/.test(card), false);
});

test("a missing desk or laptop reads as a deliberate absence, not a dash", () => {
  const out = dayRenderer([row("c1", "Ada", "2026-09-11", "2026-09-11", "sam h")], 20260910).out();
  assert.match(out, /No desk/);
  assert.match(out, /No laptop/);
  assert.equal(/>—</.test(out), false, "words, never a dash");
  // Manrope, not mono: there is no machine name to set in a machine face
  assert.match(html, /\.chip\.none\{font-weight:600;background:transparent;border:1px dashed/);
  assert.equal(/\.chip\.none\{[^}]*--mono/.test(html), false);
});
test("the name survives every width, including a clipped card", () => {
  const out = dayRenderer([row("c1", "A Very Long Candidate Name Indeed", "2026-09-11",
    "2026-09-11", "")], 20260910).out();
  assert.match(out, /class="tc-name">A Very Long Candidate Name Indeed</);
  assert.match(html, /\.tc-name\{[^}]*text-overflow:ellipsis/, "truncates rather than wrapping");
  // a card cut at the left edge still shows who it is
  const v = dayRenderer([row("c1", "Brandon Wagoner", "2026-09-01", "2026-09-30", "sam h")], 20260910);
  const clipped = v.out();
  assert.match(clipped, /class="tcard clip-l"/);
  assert.match(clipped, /class="tc-name">Brandon Wagoner</,
    "clipped at the left used to render with no label at all");
});
test("the candidate view opens on click and keyboard", () => {
  // No CSS :hover rule any more: the layer is on the body and JS decides.
  assert.match(html, /dayViewEl\.addEventListener\("mouseover"/, "hover");
  assert.match(html, /dayViewEl\.addEventListener\("focusin"/, "keyboard focus");
  assert.match(html, /if\(act==="bar"\)\{ togglePin\(t\); return; \}/, "click pins");
  assert.match(html, /if\(e\.key==="Enter"\|\|e\.key===" "\)\{ e\.preventDefault\(\); togglePin\(bar\); \}/,
    "Enter and Space pin");
  assert.match(html, /if\(e\.key==="Escape"\)\{ hidePanel\(true\); return; \}/, "Escape dismisses");
  assert.match(html, /if\(!t\)\{ hidePanel\(true\); return; \}/, "and a click outside dismisses");
  // the bar stays reachable by keyboard
  const out = dayRenderer([row("c1", "A", "2026-09-11", "2026-09-11", "sam h")], 20260910).out();
  assert.match(out, /<div class="tcard[^"]*" data-act="bar" data-id="c1" role="button" tabindex="0"/);
  assert.equal(/<button[^>]*class="tcard/.test(out), false, "no nested interactive elements");
});
test("hover never opens or replaces the candidate detail panel", () => {
  const events = html.slice(html.indexOf('  dayViewEl.addEventListener("mouseover"'), html.indexOf('  function renderKeepingPanel'));
  assert.doesNotMatch(events, /showPanel\(/);
  assert.match(html, /function togglePin\(bar\)\{ selectCandidate\(bar.getAttribute\("data-id"\),bar\); \}/);
});
test("the panel carries everything the bar does not", () => {
  const v = dayRenderer([row("c1", "Ada", "2026-09-11", "2026-09-12", "sam h",
    { computer: "SF-Poetic 7", desk: "SF-Desk 1" })], 20260910);
  v.out();
  const panel = v.dayPanels()["c1"];
  assert.ok(panel, "built and keyed by candidate id");
  assert.match(panel, /class="pill">NOT STARTED/, "status");
  assert.match(panel, /Fri, Sep 11 to Sat, Sep 12/, "the full range");
  assert.match(panel, /Day 1 of 2/);
  assert.match(panel, /Sam Henderson/);
  assert.match(panel, /1 running</);
  assert.match(panel, /0 in last 30d/);
  assert.match(panel, /SF-Poetic 7/);
  assert.match(panel, /SF-Desk 1/);
  assert.match(panel, /counts what was booked, not what happened/);
});
test("the panel is placed against the viewport, and flips at both edges", () => {
  const v = dayRenderer([row("c1", "A", "2026-09-11", "2026-09-11", "sam h")], 20260910);
  v.out();
  const layer = { style: {}, offsetWidth: 264, offsetHeight: 200,
    classList: { has: { open: true }, contains(c) { return !!this.has[c]; },
                 add(c) { this.has[c] = true; }, remove(c) { delete this.has[c]; } },
    innerHTML: "", setAttribute() {}, addEventListener() {}, dataset: {} };
  const at = (rect) => {
    const bar = { getAttribute: () => "c1", getBoundingClientRect: () => rect };
    v.setPanelState(layer, bar);
    v.positionPanel();
    return { left: parseInt(layer.style.left, 10), top: parseInt(layer.style.top, 10) };
  };
  // room to the right: left edge of the bar, just below it
  assert.deepEqual(at({ left: 100, right: 200, top: 300, bottom: 340 }), { left: 100, top: 346 });
  // against the right edge of a 1200px viewport: flips so it stays inside
  const flipped = at({ left: 1050, right: 1180, top: 300, bottom: 340 });
  assert.equal(flipped.left, 1180 - 264, "aligned to the bar's right edge");
  assert.ok(flipped.left + 264 <= 1200, "and inside the viewport");
  // against the bottom of a 900px viewport: opens upward instead
  const up = at({ left: 100, right: 200, top: 800, bottom: 860 });
  assert.equal(up.top, 800 - 200 - 6);
  assert.ok(up.top >= 0, "and not off the top either");
  // clamped rather than negative when the bar is at the very left
  assert.equal(at({ left: -40, right: 20, top: 300, bottom: 340 }).left, 8);
});
test("a clipped bar says so in its panel, with the real dates", () => {
  // The rendered window runs seven days back and forward to the last trial
  // day, so this one is cut at the left only.
  const v = dayRenderer([row("c1", "Long", "2026-09-01", "2026-09-30", "sam h")], 20260910);
  const out = v.out();
  const panel = v.dayPanels()["c1"];
  assert.match(panel, /Started before this window, on Tue, Sep 1/);
  assert.match(panel, /Tue, Sep 1 to Wed, Sep 30/, "the real range, not the clipped one");
  assert.equal(/Runs past this window/.test(panel), false, "it does not run past this one");
  assert.match(out, /class="tcard clip-l"/);
  assert.equal(/clip-r/.test(out), false);
});
test("concurrent counts occupancy and merges aliases", () => {
  const cands = [row("c1", "A", "2026-09-13", "2026-09-15", "sam h"),
                 row("c2", "B", "2026-09-14", "2026-09-14", "FDE-Sam H")];
  const v = dayRenderer(cands, 20260910);
  const e = entriesOf(v, cands);
  assert.equal(v.concurrentFor(e, "Sam Henderson", 20260913), 1);
  assert.equal(v.concurrentFor(e, "Sam Henderson", 20260914), 2, "one person, two trials");
  assert.equal(v.concurrentFor(e, "Sam Henderson", 20260915), 1);
});

test("recent excludes the day in view and includes exactly 30 days back", () => {
  const day = 20260914;
  const mk = (id, d) => row(id, id, d, d, "sam h");
  const v = dayRenderer([], 20260910);
  const only = (c) => v.recentFor(entriesOf(v, [c]), "Sam Henderson", day);
  assert.equal(only(mk("in", "2026-08-15")), 1, "day - 30 is inside");
  assert.equal(only(mk("out", "2026-08-14")), 0, "day - 31 is outside");
  assert.equal(only(mk("yest", "2026-09-13")), 1, "day - 1 is inside");
  assert.equal(only(mk("same", "2026-09-14")), 0, "the day in view is not counted twice");
  const three = row("t", "t", "2026-09-01", "2026-09-03", "sam h");
  assert.equal(only(three), 1, "a three-day trial counts once");
});

test("unassigned is flagged per trial and never aggregated", () => {
  const cands = [row("c1", "A", "2026-09-11", "2026-09-11", ""),
                 row("c2", "B", "2026-09-11", "2026-09-11", "NOT YET")];
  const v = dayRenderer(cands, 20260910);
  assert.equal(v.concurrentFor(entriesOf(v, cands), null, 20260911), 0);
  const out = v.out();
  // DESIGN.md: unassigned suppresses the meta row and shows the flag instead.
  assert.equal((out.match(/No main partner/g) || []).length, 2, "each card flags it itself");
  assert.equal(/class="tc-meta"/.test(out), false,
    "and shows no partner row at all rather than an empty one");
  const panels = Object.values(v.dayPanels()).join("");
  assert.equal((panels.match(/No main partner/g) || []).length, 2,
    "and each panel flags it exactly once, not twice in one panel");
});
test("the stretched dot appears at the threshold and the threshold is config", () => {
  const two = [row("c1", "A", "2026-09-11", "2026-09-11", "sam h"),
               row("c2", "B", "2026-09-11", "2026-09-11", "sam h")];
  const v2 = dayRenderer(two, 20260910); v2.out();
  assert.match(Object.values(v2.dayPanels()).join(""), /dot ember/);
  const v1 = dayRenderer([two[0]], 20260910); v1.out();
  assert.equal(/dot ember/.test(Object.values(v1.dayPanels()).join("")), false);
  assert.match(html, /var CONCURRENT_WARN\s*=\s*2;/);
  assert.equal(dayRenderer([], 20260910).CONCURRENT_WARN, 2);
});
test("same desk on the same day flags both bars, different days flags neither", () => {
  const same = [row("c1", "Preston Vaughn", "2026-09-03", "2026-09-03", "sam h", { desk: "SF-Desk 3" }),
                row("c2", "Joe Khosbayar", "2026-09-03", "2026-09-03", "shantam", { desk: "SF-Desk 3" })];
  const v = dayRenderer(same, 20260903);
  const clash = v.collisionsOn(entriesOf(v, same));
  assert.equal(clash.desk.c1, true);
  assert.equal(clash.desk.c2, true);
  v.out();
  const panels = Object.values(v.dayPanels()).join("");
  assert.equal((panels.match(/The same desk is recorded on another trial this day/g) || []).length, 2);
  // and both bars carry the flag dot
  assert.equal((v.out().match(/Same desk recorded on another trial this day/g) || []).length, 2);

  const apart = [row("c1", "A", "2026-09-11", "2026-09-11", "sam h", { desk: "SF-Desk 3" }),
                 row("c2", "B", "2026-09-12", "2026-09-12", "shantam", { desk: "SF-Desk 3" })];
  const v2 = dayRenderer(apart, 20260910); v2.out();
  assert.equal(/recorded on another trial this day/.test(Object.values(v2.dayPanels()).join("")), false,
    "a desk reused on another day is reassignment, not a clash");
});
test("no collision fires anywhere in the production fixture", () => {
  // Section H: if one fires on the 13th or 14th it is a false positive.
  const out = dayRenderer(PROD, 20260910).out();
  assert.equal(/recorded on another trial this day/.test(out), false);
});

/* ---------------- the production fixture, section H ---------------- */

test("the production fixture renders exactly the bars it should", () => {
  const v = dayRenderer(PROD, 20260910);
  const expected = {
    "Mykhailo Skrobach": { cols: 1, partner: "Dillon Bogart" },
    "Brandon Wagoner":   { cols: 3, partner: "Neel" },
    "Ari Blumkin":       { cols: 2, partner: "Shantam Jain" },
    "Ahmet Hatip":       { cols: 1, partner: null },
    "Vivian (Yiting) G.": { cols: 2, partner: null },
  };
  const laid = v.layoutBars(windowOf("2026-09-10", 12), entriesOf(v, PROD));
  assert.equal(laid.bars.length, 5);
  for (const b of laid.bars) {
    const want = expected[b.entry.c.name];
    assert.ok(want, "unexpected bar: " + b.entry.c.name);
    assert.equal(b.spanCols, want.cols, b.entry.c.name + " column count");
    assert.equal(b.entry.dri.canonical, want.partner, b.entry.c.name + " partner");
    if (want.partner === null) assert.equal(b.entry.dri.unassigned, true);
  }
});

/* ---------------- branding, addendum F ---------------- */

test("cards carry role colour and never status colour", () => {
  // DESIGN.md narrows the old rule rather than dropping it: the ground encodes
  // the ROLE, status stays a pill.
  const ground = (pos) => {
    const out = dayRenderer([row("c1", "A", "2026-09-11", "2026-09-11", "sam h",
      { position: pos })], 20260910).out();
    return (/--ground:var\((--[a-z-]+)\)/.exec(out) || [])[1];
  };
  assert.equal(ground("FDE"), "--role-fde");
  assert.equal(ground("FDS"), "--role-fds");
  assert.equal(ground("Sales"), "--role-sales");

  // the same candidate in every status produces the same ground
  const grounds = ["NOT STARTED", "IN PROGRESS", "DONE", "CANCELED"].map((st) => {
    const out = dayRenderer([row("c1", "A", "2026-09-11", "2026-09-11", "sam h",
      { status: st })], 20260910).out();
    return (/--ground:var\((--[a-z-]+)\)/.exec(out) || [])[1];
  });
  assert.deepEqual(new Set(grounds).size, 1, "status must not reach the ground");
  const rule = html.slice(html.indexOf("  .tcard{"), html.indexOf("  .tcard:hover"));
  assert.match(rule, /background:var\(--ground\)/);
  assert.match(rule, /border:0/, "filled and borderless");
});

test("the three role hexes are exactly as locked, and Sales is not ember-tint", () => {
  const tok = (t) => (new RegExp("--" + t + ":(#[0-9A-F]{6})").exec(html) || [])[1];
  assert.equal(tok("role-fde"), "#B2CDED", "FDE, as locked");
  assert.equal(tok("role-sales"), "#E0D8CC", "Sales, as locked");
  // FDS moved one step lighter than the locked #A4C69B so --ink-2 clears AA.
  assert.equal(tok("role-fds"), "#A8CA9F", "FDS, lightened by ruling");
  assert.notEqual(tok("role-sales"), "#FDDED4", "warm orange keeps meaning attention");
  // and the role grounds are their own tokens, so a nudge to the list's
  // complete tint cannot silently change what a card is painted
  assert.equal(tok("green"), "#A4C69B", "the list's tint is untouched");
  assert.match(html, /var ROLE_GROUNDS=\{FDE:"--role-fde",FDS:"--role-fds",Sales:"--role-sales"\};/);
});

test("a fourth role falls back to a neutral and raises a flag", () => {
  const out = dayRenderer([row("c1", "A", "2026-09-11", "2026-09-11", "sam h",
    { position: "Design" })], 20260910).out();
  assert.match(out, /--ground:var\(--paper\)/, "neutral, not a new colour");
  assert.match(out, /class="tcard[^"]*role-unknown/);
  assert.match(out, /Unrecognised role Design/, "and it says so");
  for (const t of ["--role-fde", "--role-fds", "--role-sales", "--ember"]) {
    assert.equal(out.includes("--ground:var(" + t + ")"), false,
      "must not borrow " + t);
  }
});
test("Ember is not spent on today, the weekend, the tiles or the cards", () => {
  for (const sel of [".dtile.is-today", ".dtile.weekend .dt-num", ".dcol", ".dcol-empty",
                     ".tcard", ".tc-name", ".tc-meta", ".chip", ".chip.none"]) {
    const i = html.indexOf("  " + sel + "{");
    assert.ok(i > 0, sel + " should exist");
    const rule = html.slice(i, html.indexOf("}", i));
    assert.equal(rule.includes("--ember"), false, sel + " must not use Ember");
  }
  // it survives on exactly the two things it means
  assert.match(html, /\.tc-flag \.dot\{[^}]*background:var\(--ember\)/, "flag dots");
  assert.match(html, /\.tc-meta \.dot\.ember\{[^}]*background:var\(--ember\)/,
    "and the stretched-capacity indicator");
});
test("no em dashes in the Day view copy", () => {
  const a = html.indexOf("  function daySpan(c){");
  const b = html.indexOf("  /* Hover is primary.");
  const strings = html.slice(a, b).match(/"[^"\n]*"|'[^'\n]*'/g) || [];
  for (const s of strings) assert.equal(s.includes("—"), false, "em dash: " + s);
});

/* ---------------- anchors are fixed, deliberately ----------------
   Production moves every day; these fixtures must not. npm run test:clock
   runs the whole suite at twenty offsets to prove it. */

test("no day view test reads the wall clock", () => {
  const src = fs.readFileSync(__filename, "utf8");
  const body = src.slice(src.indexOf("/* ================ addendum"));
  assert.equal(/new Date\(\)/.test(body), false,
    "anchor to a fixed day integer, not to today");
  // Every render is handed an explicit anchor. Scanned with a paren counter
  // rather than a regex, because the argument lists contain parens of their
  // own and a lazy match silently checks a truncated call.
  let n = 0;
  for (let i = body.indexOf("dayRenderer("); i >= 0; i = body.indexOf("dayRenderer(", i + 1)) {
    let depth = 0, j = i + "dayRenderer".length;
    for (; j < body.length; j++) {
      if (body[j] === "(") depth++;
      else if (body[j] === ")" && --depth === 0) break;
    }
    if (body[i - 1] === '"') continue;                          // this test's own source
    const call = body.slice(i, j + 1);
    if (call.startsWith("dayRenderer(candidates")) continue;   // the definition
    assert.match(call, /,\s*20\d{6}\b/, "no fixed anchor in: " + call);
    n++;
  }
  assert.ok(n > 20, "sanity: the renderer is exercised, got " + n);
});

test("the production window on 11 Sep: two empty days, then two bars", () => {
  // State on 11 Sep 2026. Written as a fixed anchor so it stays a record of
  // that day rather than quietly re-asserting itself against whatever today is.
  const v = dayRenderer(PROD, 20260911);
  const out = v.out();
  const ground = (d) => {
    const m = new RegExp('id="daycol-' + d + '"[^>]*>(.*?)</span>').exec(out);
    return m ? m[1] : null;
  };
  assert.ok(ground("20260911") !== null, "today renders");
  assert.match(ground("20260911"), /No trials/, "today is empty");
  assert.match(ground("20260912"), /No trials/, "and so is tomorrow");
  assert.equal(/No trials/.test(ground("20260913")), false, "the 13th is not");

  const laid = v.layoutBars(windowOf("2026-09-11", 3), entriesOf(v, PROD));
  assert.deepEqual(laid.bars.map((b) => b.entry.c.name).sort(),
    ["Ari Blumkin", "Brandon Wagoner"], "two bars on the 13th");
  // both start there, so neither is clipped and they need two lanes
  assert.deepEqual(laid.bars.map((b) => b.startCol), [2, 2]);
  assert.equal(laid.lanes, 2);
  laid.bars.forEach((b) => {
    assert.equal(b.clippedLeft, false, b.entry.c.name + " starts inside the window");
    assert.equal(b.clippedRight, true, b.entry.c.name + " runs past it");
  });
  // Mykhailo was yesterday: still reachable by scrolling back, not in these 3
  assert.match(out, /id="daycol-20260910"/, "yesterday is still rendered");
});

/* ---------------- the calendar is always live, so it must be cheap ---------------- */

test("a list edit that cannot move a bar does not rebuild the grid", () => {
  // Both views are always on screen now. The day grid used to cost nothing
  // while somebody typed, because it was not rendered at all.
  const cands = [row("c1", "Ada", "2026-09-11", "2026-09-12", "sam h"),
                 row("c2", "Grace", "2026-09-13", "2026-09-13", "shantam")];
  const v = dayRenderer(cands, 20260910);

  assert.equal(v.renderDayIfChanged(), true, "first call builds it");
  assert.equal(v.renderCount(), 1);
  assert.equal(v.renderDayIfChanged(), false, "an unchanged call does not");
  assert.equal(v.renderCount(), 1);

  // the things a list edit actually touches
  cands[0].values.notes = "typed a character";
  cands[0].values.nda = "COMPLETED";
  cands[0].values.laptopChat = "YES";
  cands[0].fieldNotes = { nda: "a note" };
  cands[0].updatedAt = 999;
  assert.equal(v.renderDayIfChanged(), false, "none of that appears on a bar");
  assert.equal(v.renderCount(), 1, "so the grid is not touched");
});

test("anything the calendar shows does rebuild it", () => {
  const base = () => [row("c1", "Ada", "2026-09-11", "2026-09-12", "sam h",
                          { computer: "SF-Poetic 7", desk: "SF-Desk 1" })];
  const changes = {
    startDate: (c) => { c.values.startDate = "2026-09-10"; },
    endDate: (c) => { c.values.endDate = "2026-09-14"; },
    driName: (c) => { c.values.driName = "shantam"; },
    computer: (c) => { c.values.computer = "SF-Poetic 9"; },
    desk: (c) => { c.values.desk = "SF-Desk 4"; },
    status: (c) => { c.values.status = "DONE"; },
    position: (c) => { c.values.position = "Sales"; },
    name: (c) => { c.name = "Ada L"; },
  };
  for (const [what, apply] of Object.entries(changes)) {
    const cands = base();
    const v = dayRenderer(cands, 20260910);
    v.renderDayIfChanged();
    apply(cands[0]);
    assert.equal(v.renderDayIfChanged(), true, what + " must rebuild the calendar");
  }
});

test("adding or removing a candidate rebuilds it", () => {
  const cands = [row("c1", "Ada", "2026-09-11", "2026-09-11", "sam h")];
  const v = dayRenderer(cands, 20260910);
  v.renderDayIfChanged();
  cands.push(row("c2", "Grace", "2026-09-12", "2026-09-12", "shantam"));
  assert.equal(v.renderDayIfChanged(), true, "a new row");
  cands.pop();
  assert.equal(v.renderDayIfChanged(), true, "and a removed one");
});

test("changing the window size rebuilds it", () => {
  const v = dayRenderer([row("c1", "A", "2026-09-11", "2026-09-11", "sam h")], 20260910);
  v.renderDayIfChanged();
  v.setWindowSize(7);
  assert.equal(v.renderDayIfChanged(), true, "the size is part of the signature");
});

test("the signature is derived, not a flag somebody has to remember to set", () => {
  // A dirty flag has to be set in every place something changes, and the one
  // place it is forgotten is a stale calendar nobody can explain.
  assert.match(html, /var DAY_SIG_KEYS=\["startDate","endDate","driName","computer","desk","status","position"\];/);
  assert.equal(/dayDirty\s*=|calendarDirty\s*=/.test(html), false, "no dirty flag");
  const sig = html.slice(html.indexOf("  function daySignature(){"),
                         html.indexOf("  var lastDaySig="));
  assert.match(sig, /filtered\(\)\.forEach/, "over the filtered set, so search rebuilds");
  assert.match(sig, /effective\(c,k\)/, "reading the same values the bars read");
});

test("horizontal position survives a rebuild", () => {
  // The calendar re-renders while somebody types in the search box; snapping
  // back to the anchor every keystroke would make it unusable.
  assert.match(html, /var keepLeft=prevScroll\?prevScroll\.scrollLeft:null;/);
  assert.match(html, /if\(scroller&&keepLeft!==null&&dayScrolledOnce\)\{\s*\n\s*scroller\.scrollLeft=keepLeft;/,
    "but only once today has actually been anchored");
  assert.match(html, /\}else\{\s*\n\s*anchorToday\(\);/,
    "until then every render re-attempts the anchor");
});

test("Platform is a known role with no ground yet, and is not flagged", () => {
  // The colour was deferred rather than picked. A known role with no colour is
  // a decision not yet taken; an unknown role is data nobody has ruled on.
  // Only the second gets a flag.
  const out = dayRenderer([row("c1", "A", "2026-09-11", "2026-09-11", "sam h",
    { position: "Platform" })], 20260910).out();
  assert.match(out, /--ground:var\(--paper\)/, "neutral, no colour invented");
  assert.match(out, /role-unknown/, "styled as the neutral card");
  assert.equal(/Unrecognised role/.test(out), false,
    "Platform is recognised; it just has no colour yet");
  assert.match(html, /var KNOWN_ROLES=\["FDE","FDS","Sales","Platform"\];/);
  assert.equal(/Platform:"--/.test(html), false, "and no ground was slipped in");
});

test("an unknown role is still flagged, distinctly from Platform", () => {
  const out = dayRenderer([row("c1", "A", "2026-09-11", "2026-09-11", "sam h",
    { position: "Design" })], 20260910).out();
  assert.match(out, /Unrecognised role Design/);
  assert.match(out, /--ground:var\(--paper\)/);
});

test("Platform is enumerated everywhere role is", () => {
  const FIELDS = require("../lib/fields");
  assert.deepEqual(FIELDS.field("position").opts, ["FDE", "FDS", "Sales", "Platform"]);
  assert.match(html, /<option>Platform<\/option>/, "the filter dropdown");
  const INV = require("../lib/assignment-inventory");
  assert.ok(INV.ROLES.includes("Platform"));
  assert.ok(INV.PARTNER_ROLES.Platform.length, "and the partner roster");
  // the legend only names grounds that exist, so Platform is absent from it
  assert.match(html, /Object\.keys\(ROLE_GROUNDS\)\.map/);
});

/* ---------------- a candidate whose dates disappear (14 Sep) ----------------
   Brandon Wagoner's sheet row went to TBD in every column while the tracker
   still held 13 to 15 Sep. If dates are ever unset, the board must let go of
   the candidate rather than keep drawing them where they used to be. This path
   had never been exercised. */

test("a candidate whose dates are unset leaves the board entirely", () => {
  const withDates = [row("c1", "Brandon Wagoner", "2026-09-13", "2026-09-15", "neel"),
                     row("c2", "Ari Blumkin", "2026-09-13", "2026-09-14", "shantam")];
  const before = dayRenderer(withDates, 20260910).out();
  assert.match(before, /Brandon Wagoner/);

  // the same candidate, dates gone
  const gone = [row("c1", "Brandon Wagoner", undefined, undefined, "neel"),
                row("c2", "Ari Blumkin", "2026-09-13", "2026-09-14", "shantam")];
  const after = dayRenderer(gone, 20260910).out();
  assert.equal(/Brandon Wagoner/.test(after), false, "no bar, no name, nowhere");
  assert.match(after, /Ari Blumkin/, "and the rest of the board is unaffected");
});

test("an unset date does not leave the candidate at its old position", () => {
  // The specific worry: a stale span held somewhere and reused.
  const cands = [row("c1", "Brandon Wagoner", "2026-09-13", "2026-09-15", "neel")];
  const v = dayRenderer(cands, 20260910);
  assert.equal(v.layoutBars(windowOf("2026-09-13", 3), entriesOf(v, cands)).bars.length, 1);
  delete cands[0].values.startDate;
  delete cands[0].values.endDate;
  const e = entriesOf(v, cands);
  assert.equal(e[0].span, null, "no span at all");
  assert.equal(v.layoutBars(windowOf("2026-09-13", 3), e).bars.length, 0, "and nothing placed");
});

test("losing a date changes the signature, so the calendar actually rebuilds", () => {
  // Without this the board would keep the old bars until something else moved.
  const cands = [row("c1", "Brandon Wagoner", "2026-09-13", "2026-09-15", "neel")];
  const v = dayRenderer(cands, 20260910);
  assert.equal(v.renderDayIfChanged(), true);
  assert.equal(v.renderDayIfChanged(), false);
  delete cands[0].values.startDate;
  assert.equal(v.renderDayIfChanged(), true, "the date is in the signature");
  delete cands[0].values.endDate;
  assert.equal(v.renderDayIfChanged(), true);
});

test("only the start date going is a single-day trial, not a disappearance", () => {
  // trialSpan's four cases: end alone going leaves a one-day bar at the start.
  const cands = [row("c1", "Brandon Wagoner", "2026-09-13", undefined, "neel")];
  const v = dayRenderer(cands, 20260910);
  const e = entriesOf(v, cands);
  assert.equal(e[0].span.days, 1);
  assert.match(v.out(), /Brandon Wagoner/, "still on the board, on one day");
});
