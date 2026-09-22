"use strict";
/**
 * Addendum 2: one page, calendar above the list, and no internal scrolling.
 *
 * Replaces the tab tests. Section 1 of the original spec and section A of the
 * first addendum are superseded; everything else in both still stands.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

/* ---------------- one page ---------------- */

test("no tabs remain anywhere", () => {
  assert.equal(/role="tab"/.test(html), false, "no tab roles");
  assert.equal(/role="tablist"/.test(html), false);
  assert.equal(/role="tabpanel"/.test(html), false);
  assert.equal(/class="viewtabs"/.test(html), false, "and no tab markup");
  assert.equal(/\.vtab\{/.test(html), false, "and no tab styles");
  for (const gone of ["applyView", "setView(", "storedView", "viewMode", "VIEW_KEY"]) {
    assert.equal(html.includes(gone), false, "dead view machinery: " + gone);
  }
});

test("the calendar and the list are both in the DOM, calendar first", () => {
  const cal = html.indexOf('id="dayView"');
  const list = html.indexOf('id="list"');
  const stats = html.indexOf('id="stats"');
  assert.ok(cal > 0, "the calendar is present");
  assert.ok(list > 0, "and so is the list");
  assert.ok(cal < list, "calendar above the list");
  assert.ok(cal < stats, "and first on the page");
  // neither starts hidden: there is nothing to switch to
  assert.equal(/id="dayView"[^>]*class="[^"]*hidden/.test(html), false);
  assert.equal(/class="[^"]*hidden[^"]*"[^>]*id="dayView"/.test(html), false);
  assert.match(html, /<div class="dayview-wrap" id="dayView"><\/div>/);
});

test("wt-view is removed from localStorage on load, and nothing reads it", () => {
  assert.match(html, /try\{ localStorage\.removeItem\("wt-view"\); \}catch\(e\)\{\}/,
    "cleared, not merely ignored");
  // the only code reference left is the removal itself
  const literals = (html.match(/"wt-view"/g) || []).length;
  assert.equal(literals, 1, "the string should appear once, in removeItem");
  assert.equal(/lsGet\("wt-view"\)|lsSet\("wt-view"/.test(html), false, "never read or written");
  // the other stored preferences are untouched
  for (const key of ["wt-day-window", "wt-group-collapsed", "wt-done-collapsed"]) {
    assert.ok(html.includes(key), key + " must survive");
  }
});

test("no route was added or removed for this", () => {
  for (const r of ["/day", "/view", "/list"]) {
    assert.equal(new RegExp('app\\.(get|post)\\("' + r + '"').test(server), false);
  }
});

/* ---------------- no internal vertical scrolling ---------------- */

test("nothing caps the calendar's height", () => {
  // Every lane visible at once, so hovering a bar never moves the view.
  // Comments in here talk about max-height and overflow-y on purpose, so the
  // rules are what gets checked, not the prose around them.
  const band = html.slice(html.indexOf("  .dayview-wrap{"), html.indexOf("  /* ---------- Card body ---------- */"))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(/max-height/.test(band), false, "no max-height on the band");
  assert.equal(/\boverflow-y\s*:/.test(band), false,
    "and no overflow-y: setting it to visible would not work anyway");
  assert.match(band, /\.dayscroll\{overflow-x:auto/, "horizontal scrolling is unchanged");
  // the grid declares exactly as many rows as there are lanes, so it sizes to
  // its content rather than to a fixed height
  assert.match(html, /";grid-template-rows:repeat\("\+Math\.max\(laid\.lanes,1\)\+",auto\)/);
  assert.equal(/\.daygrid\{[^}]*height:/.test(html), false, "and no height on the grid");
});

test("the overflow trap is recorded where someone would undo it", () => {
  // A future reader will try overflow-y: visible. The comment has to be next to
  // the rule, not in a commit message.
  const band = html.slice(html.indexOf("  .dayview-wrap{"), html.indexOf("  /* ---------- Card body ---------- */"));
  assert.match(band, /overflow-y still computes to\s*\n\s*auto because of overflow-x/);
});

test("the panel layer is on the body, not inside the scroller", () => {
  assert.match(html, /panelLayer=document\.createElement\("div"\);/);
  assert.match(html, /document\.body\.appendChild\(panelLayer\);/);
  assert.match(html, /\.bpanel-layer\{position:fixed/, "positioned against the viewport");
  // the bar no longer contains one
  const bar = html.slice(html.indexOf("  function renderBar(bar,days"),
                         html.indexOf("  function renderDay(){"));
  assert.equal(/panelFor\([^)]*\)\+/.test(bar), false,
    "the panel must not be concatenated into the bar's markup");
  assert.match(bar, /dayPanels\[c\.id\]=panelFor\(bar,day,entries,today\);/,
    "it is built and stored for the layer");
  // and the old in-flow positioning is gone
  assert.equal(/\.bpanel\{position:absolute/.test(html), false);
  assert.equal(/\.daybar:hover \.bpanel/.test(html), false, "no CSS-only hover opening");
  assert.equal(/\.bpanel\.flip\{/.test(html), false, "flipping is measured, not classed");
});

test("opening the panel never scrolls anything", () => {
  // Just the panel's own code: scrollToToday sits below it and legitimately
  // assigns scrollLeft, which is a different concern.
  const layer = html.slice(html.indexOf("  function ensurePanelLayer(){"),
                           html.indexOf("   * Put today's column near the left edge"));
  assert.equal(/scrollIntoView/.test(layer), false, "no scrollIntoView on the open path");
  assert.equal(/scrollTop\s*=/.test(layer), false, "and nothing assigns a scroll position");
  assert.equal(/scrollLeft\s*=/.test(layer), false);
  assert.equal(/\.focus\(\)/.test(layer), false,
    "and no focus call, which would scroll the bar into view as a side effect");
});

test("the panel repositions on scroll and on resize", () => {
  // A fixed element does not follow the bar on its own.
  assert.match(html, /window\.addEventListener\("scroll",positionPanel,true\);/,
    "capture, so the band's own scroll counts too");
  assert.match(html, /window\.addEventListener\("resize",positionPanel\);/);
  // and the horizontal scroller repositions it directly
  assert.match(html, /headScroller\.scrollLeft=scroller\.scrollLeft;[\s\S]{0,200}positionPanel\(\);/);
  // it gives up rather than pointing at a bar that has scrolled away
  assert.match(html, /if\(r\.bottom<0\|\|r\.top>vh\|\|r\.right<0\|\|r\.left>vw\)\{ hidePanel\(true\); return; \}/);
});

/* ---------------- sticky headers ---------------- */

test("the weekday row sticks to the page, which needs it outside the scroller", () => {
  assert.match(html, /\.dayhead-scroll\{position:sticky;top:0/);
  // sticky resolves against the nearest scrollport, so it cannot be inside
  // .dayscroll. Two grids, one scrollLeft.
  // From renderDay's OWN assignment: the error boundary above it also sets
  // dayViewEl.innerHTML, and a first-match slice would read that instead.
  const dayFn = html.indexOf("  function renderDay(){");
  const render = html.slice(html.indexOf("    dayViewEl.innerHTML=", dayFn),
                            html.indexOf("    var scroller=document.getElementById", dayFn));
  assert.ok(render.indexOf('id="dayHeadScroll"') < render.indexOf('id="dayScroll"'),
    "header band above the body band");
  assert.ok(render.indexOf('id="dayHeadScroll"') < render.indexOf("heads"),
    "and the headers are in it");
  assert.equal(/id="dayScroll"[\s\S]*heads\+/.test(render), false,
    "the headers must not also be in the scrolling grid");
  assert.match(html, /headScroller\.scrollLeft=scroller\.scrollLeft;/, "kept in step");
  assert.match(html, /\.dayhead-scroll\{[^}]*overflow:hidden/,
    "the header band never gets its own scrollbar");
});

test("both grids are laid out from the same column template", () => {
  // Two renderings of one truth, not two truths.
  assert.match(html, /var gridStyle="--cols:"\+cols\+";--vis:"\+vis\+/);
  assert.equal((html.match(/style="'\+gridStyle/g) || []).length, 2,
    "the header grid and the body grid share it");
});

test("a rebuild does not leave a panel aimed at a detached bar", () => {
  const day = html.slice(html.indexOf("  function renderDay(){"),
                         html.indexOf("    var today=todayDay();") + 40);
  assert.match(day, /hidePanel\(true\);/,
    "every bar is replaced, so an open panel must close with them");
});

test("the sticky row is opaque and in the page's ground", () => {
  const rule = html.slice(html.indexOf("  .dayhead-scroll{"), html.indexOf("  .dayscroll{"));
  // The shell is white now, so the band's own ground is paper.
  assert.match(rule, /background:var\(--paper\)/,
    "tiles and cards scroll underneath it, so it cannot be transparent");
  assert.equal(/rgba|opacity/.test(rule), false);
});
