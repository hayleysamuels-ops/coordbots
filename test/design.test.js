"use strict";
/**
 * DESIGN.md, locked 11 Sep 2026. The visual rules that a future change could
 * break silently, checked rather than trusted.
 *
 * The contrast rule is the reason this file exists. --ink-3 on a role ground
 * measures about 2:1 and fails AA outright, and nothing about the page would
 * look broken if it happened.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

/** One function's source, by brace matching. A marker-to-marker slice ran past
    render() and silently checked four thousand characters of the wrong code. */
function fnSource(decl) {
  const a = html.indexOf(decl);
  assert.ok(a >= 0, "not found: " + decl);
  let depth = 0, i = html.indexOf("{", a);
  for (let j = i; j < html.length; j++) {
    if (html[j] === "{") depth++;
    else if (html[j] === "}" && --depth === 0) return html.slice(a, j + 1);
  }
  throw new Error("unbalanced: " + decl);
}

const token = (name) => {
  const m = new RegExp("--" + name + ":\\s*(#[0-9A-Fa-f]{6})").exec(html);
  assert.ok(m, "token --" + name + " not found");
  return m[1];
};

/* WCAG 2.1 relative luminance and contrast ratio. */
function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

test("the contrast helper agrees with the brief's own worked example", () => {
  // "#827F7D on #A4C69B measures about 2:1 and fails AA outright." Checked
  // against the brief's literal hex, not the token, so the helper is pinned to
  // the same arithmetic the brief did even though the ground has since moved.
  const r = contrast("#827F7D", "#A4C69B");
  assert.ok(r > 1.8 && r < 2.2, "expected about 2:1, got " + r.toFixed(2));
  assert.ok(r < 4.5, "and it fails AA, which is the whole point");
});

test("every text colour clears 4.5:1 on every role ground", () => {
  /* The brief's #A4C69B put --ink-2 at 4.48:1, just under AA, while stating it
     cleared. Ruled on 11 Sep 2026: lighten the FDS ground one step. Every
     combination now meets 4.5 outright, so there is no exception here any
     more, and there must not be a new one. */
  const grounds = { FDE: token("role-fde"), FDS: token("role-fds"), Sales: token("role-sales") };
  const inks = { "--ink": token("ink"), "--ink-2": token("ink-2") };
  for (const [role, ground] of Object.entries(grounds)) {
    for (const [name, ink] of Object.entries(inks)) {
      const r = contrast(ink, ground);
      assert.ok(r >= 4.5,
        name + " on " + role + " (" + ground + ") is " + r.toFixed(2) + ":1, needs 4.5");
    }
  }
});

test("ink-3 would fail on all three grounds, which is why it is banned there", () => {
  const ink3 = token("ink-3");
  for (const g of [token("role-fde"), token("role-fds"), token("role-sales")]) {
    assert.ok(contrast(ink3, g) < 4.5, "ink-3 on " + g + " must not be usable");
  }
});

test("no rule puts ink-3 on a card", () => {
  // Every selector inside the card, checked against the ink it sets.
  const band = html.slice(html.indexOf("  /* ---------- Calendar band"),
                          html.indexOf("  /* ---------- Card body ---------- */"))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const cardSelectors = /(^|\n)\s*(\.tcard[^{]*|\.tc-[a-z]+[^{]*|\.chip[^{]*)\{([^}]*)\}/g;
  let m, checked = 0;
  while ((m = cardSelectors.exec(band))) {
    checked++;
    // The ban is on ink-3 as TEXT on a role ground. .tcard.role-unknown uses it
    // for a dashed outline, and that card's ground is --paper by construction.
    const colours = (m[3].match(/(^|;)\s*color:[^;]*/g) || []).join(";");
    assert.equal(colours.includes("--ink-3"), false,
      "--ink-3 text on a role ground in: " + m[2].trim());
  }
  assert.ok(checked >= 8, "sanity: card rules were actually found, got " + checked);
});

test("ink is never alpha-blended on a card", () => {
  const band = html.slice(html.indexOf("  .tcard{"), html.indexOf("  /* Controls */"));
  assert.equal(/rgba\(/.test(band), false, "no rgba ink");
  assert.equal(/color-mix[^;]*--ink/.test(band), false, "and no mixed ink");
  // the one opacity in there is a dot separator, not text
  const opacities = band.match(/opacity:[^;}]+/g) || [];
  for (const o of opacities) {
    assert.ok(band.slice(0, band.indexOf(o)).lastIndexOf(".tc-sep") >
              band.slice(0, band.indexOf(o)).lastIndexOf(".tc-name"),
      "opacity is only on the separator dot: " + o);
  }
});

test("the type scale is the one that was locked", () => {
  const rule = (sel) => {
    const i = html.indexOf("  " + sel + "{");
    assert.ok(i > 0, sel + " missing");
    return html.slice(i, html.indexOf("}", i));
  };
  assert.match(rule(".dt-num"), /font-size:30px/);
  assert.match(rule(".dt-num"), /font-weight:700/);
  assert.match(rule(".dt-wd"), /font-size:12px/);
  assert.match(rule(".tc-name"), /font-size:15px;font-weight:700/);
  assert.match(rule(".tc-days"), /font-size:10\.5px;font-weight:600/);
  assert.match(rule(".tc-meta"), /font-size:12px;font-weight:600/);
  assert.match(rule(".chip"), /font-size:10\.5px/);
  assert.match(rule(".tc-flag"), /font-size:11\.5px;font-weight:600/);
});

test("mono is for machine names only", () => {
  const band = html.slice(html.indexOf("  /* ---------- Calendar band"),
                          html.indexOf("  /* ---------- Card body ---------- */"));
  const monoRules = (band.match(/(^|\n)\s*([^\n{]+)\{[^}]*--mono[^}]*\}/g) || [])
    .map((r) => r.trim().split("{")[0].trim());
  assert.deepEqual(monoRules.sort(),
    [".chip.mono", ".day-broken-why", ".mfield-value", ".ps-val.mono", ".sugg-val.mono"],
    "desk and laptop identifiers, plus the raw error text on a failed render, " +
    "which is a machine string and is set as one deliberately");
  // a suggested PARTNER is never mono, on the card or in the panel
  assert.match(html, /\(key === "driName" \? "" : " mono"\)/);
  // a suggested PERSON is not a machine name and must not be set as one
  assert.match(html, /suggChip\("Partner", s\.driName, false\)/);
  assert.match(html, /suggChip\("Desk", s\.desk, true\)/);
  assert.match(html, /suggChip\("Laptop", s\.computer, true\)/);
});

test("the space scale is the one that was locked", () => {
  const rule = (sel) => html.slice(html.indexOf("  " + sel + "{"),
                                   html.indexOf("}", html.indexOf("  " + sel + "{")));
  assert.match(rule(".calshell"), /border-radius:16px/);
  assert.match(rule(".calshell"), /padding:18px 18px 22px/);
  assert.match(rule(".dtile"), /border-radius:12px/);
  assert.match(rule(".dtile"), /min-height:74px/);
  assert.match(rule(".dcol"), /border-radius:12px;padding:8px;min-height:340px/);
  assert.match(rule(".tcard"), /border-radius:12px/);
  assert.match(rule(".chip"), /border-radius:6px;padding:3px 7px/);
  assert.match(html, /\.daygrid\{[^}]*gap:8px/, "8px base unit between columns");
});

test("no gradients anywhere, and the reference's header wash is not there", () => {
  assert.equal(/linear-gradient|radial-gradient|conic-gradient/.test(html), false);
});

test("motion is almost none, and reduced motion renders final states", () => {
  const band = html.slice(html.indexOf("  /* ---------- Calendar band"),
                          html.indexOf("  /* ---------- Card body ---------- */"));
  const motionBlock = band.indexOf("@media (prefers-reduced-motion:reduce)");
  const transitions = (band.slice(0, motionBlock).match(/transition:[^;}]+/g) || []);
  for (const t of transitions) {
    assert.match(t, /120ms ease/, "120ms ease only: " + t);
    assert.ok(/background|outline-color|border/.test(t),
      "only background and border may animate: " + t);
  }
  assert.match(html, /@media \(prefers-reduced-motion:reduce\)\{[\s\S]*?transition:none/);
  // Scrolling is not handled here any more: there is no CSS scroll-behavior to
  // override, and the only animated scroll asks reducedMotion() first.
  assert.match(html, /if\(smooth&&!reducedMotion\(\)/);
});

test("the role legend names every ground on the board", () => {
  assert.match(html, /<span class="rl"><span class="rsw"/);
  assert.match(html, /\.rsw\{width:9px;height:9px;border-radius:3px/, "9px rounded squares");
  // built from the same map the cards use, so a colour cannot appear unlabelled
  assert.match(html, /Object\.keys\(ROLE_GROUNDS\)\.map/);
});

test("the window control says Week, not 7 days", () => {
  assert.match(html, /\(n===7\?"Week":n\+" days"\)/);
});

/* ---------------- the scroll anchor ----------------

   HONEST LIMIT, stated because the previous version of these tests did not
   state it: node has no layout engine. Nothing here proves today is visible in
   a browser. What these do is check the mechanism, and model the exact failure
   that was measured live, so the harness can fail the way the browser did.

   The live failure, 11 Sep 2026: on load scrollLeft stayed 0, today sat at
   x=1617 off the right edge, and clicking Today fixed it. Three causes, all
   now covered below. */

test("no CSS scroll-behavior anywhere, because it also governs scripted scrolls", () => {
  /* THE ROOT CAUSE, third attempt and the right one.
     .dayscroll carried scroll-behavior:smooth. CSS scroll-behavior applies to
     PROGRAMMATIC scrolls too, so every "instant" anchor was starting an
     animation that the next render cancelled by replacing the element, while
     the synchronous read-back saw 0 and reported failure.
     Setting style.scrollBehavior="auto" first did not fix it: writing to
     .style only marks style dirty, and a scrollLeft WRITE does not force a
     flush, so the assignment still ran under the stale computed value. */
  assert.equal(/scroll-behavior\s*:/.test(html.replace(/\/\*[\s\S]*?\*\//g, "")), false,
    "smoothness is opt-in per call, never ambient");
  const fn = fnSource("function scrollToToday(smooth){");
  assert.equal(/style\.scrollBehavior/.test(fn), false,
    "and no inline override, which did not work and hid the real cause");
  assert.match(fn, /scroller\.scrollLeft=left;/, "a plain assignment, now genuinely instant");
  assert.match(fn, /scroller\.scrollTo\(\{left:left,behavior:"smooth"\}\)/,
    "the button asks for smooth explicitly");
});

test("the anchor reads back from the node it wrote to", () => {
  // "A rAF retry cannot help if the element it captured no longer exists."
  // Both the attempt and the retry look the node up by id when they run.
  const fn = fnSource("function scrollToToday(smooth){");
  assert.match(fn, /var scroller=document\.getElementById\("dayScroll"\);/,
    "looked up at call time, never captured");
  assert.match(fn, /var got=scroller\.scrollLeft;/);
  assert.match(fn, /var ok=Math\.abs\(got-left\)<=1;/, "verified against the target");
  assert.match(fn, /inDoc:document\.body\.contains\(scroller\)/,
    "and records whether that node was still in the document");
  const anchor = fnSource("function anchorToday(){");
  assert.equal(/scroller|el\b/.test(anchor), false,
    "anchorToday holds no node of its own");
});

test("reduced motion makes even the button instant", () => {
  const fn = fnSource("function scrollToToday(smooth){");
  assert.match(fn, /if\(smooth&&!reducedMotion\(\)&&typeof scroller\.scrollTo==="function"\)/);
  const rm = fnSource("function reducedMotion(){");
  assert.match(rm, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/);
  assert.match(rm, /catch\(e\)\{ return false; \}/, "and never throws the render away");
});

test("every attempt is recorded, so this can be diagnosed from a live page", () => {
  // Two fixes for this were wrong before the third. Reasoning about it from
  // here was the problem; the page can now say what it observed.
  assert.match(html, /window\.__dayAnchor=anchorLog;/);
  const fn = fnSource("function scrollToToday(smooth){");
  for (const field of ["no node", "no layout", "instant", "smooth"]) {
    assert.ok(fn.includes(field), "logs the " + field + " outcome");
  }
  assert.match(fn, /scrollW:scroller\.scrollWidth,clientW:scroller\.clientWidth/,
    "including whether there was anything to scroll");
  assert.match(html, /if\(anchorLog\.length>20\) anchorLog\.shift\(\);/, "bounded");
});

test("a scroll that did not land is not reported as done", () => {
  const fn = fnSource("function scrollToToday(smooth){");
  assert.match(fn, /return ok;/, "success is the observed position, not that an assignment ran");
  assert.equal(/return left===0\|\|/.test(fn), false,
    "a target of 0 is indistinguishable from a failed measurement, so it is not a pass");
  assert.match(fn, /if\(!el\.offsetWidth\)\{ logAnchor\(\{why:"no layout",w:0\}\); return false; \}/);
  const anchor = fnSource("function anchorToday(){");
  assert.match(anchor, /if\(scrollToToday\(false\)\)\{ dayScrolledOnce=true; return; \}/);
});

test("a failed anchor is retried after layout, not after a timeout", () => {
  const anchor = fnSource("function anchorToday(){");
  assert.match(anchor, /requestAnimationFrame\(function\(\)\{/,
    "rAF runs after layout; a timeout would be guessing how long that takes");
  assert.equal(/setTimeout/.test(anchor), false);
  assert.match(anchor, /if\(!dayScrolledOnce&&scrollToToday\(false\)\) dayScrolledOnce=true;/);
});

test("a rebuild does not preserve a scroll position from before today was anchored", () => {
  // The third cause. The first paint happens against an empty candidate list
  // before pull() returns. Its scrollLeft of 0 was then carried across the
  // second render, pinning the calendar to the back-7 region forever.
  assert.match(html, /if\(scroller&&keepLeft!==null&&dayScrolledOnce\)\{/,
    "keepLeft only applies once the anchor has actually taken");
  assert.match(html, /\}else\{\n\s*anchorToday\(\);\n\s*\}/,
    "otherwise every render re-attempts it");
});

test("the anchor recovers from a pre-layout render, simulated end to end", () => {
  /* The harness cannot lay anything out, so it models what the browser did:
     offsetLeft reads 0 and scrollLeft clamps to 0 until layout has happened.
     A test that only asserts "today is in the scrollport" against stubs passes
     no matter what the code does, which is how this shipped broken. */
  let laidOut = false;
  let scrollLeft = 0;
  const scroller = {
    style: {},
    get scrollLeft() { return scrollLeft; },
    set scrollLeft(v) { scrollLeft = laidOut ? v : 0; },   // clamps before layout
  };
  // An element that has not been laid out reports zero for both, which is the
  // ambiguity that defeated the first version of the success check.
  const col = { get offsetLeft() { return laidOut ? 1599 : 0; },
                get offsetWidth() { return laidOut ? 320 : 0; } };
  const head = { scrollLeft: 0 };
  let done = false, rafQueue = [];

  function scrollToToday() {
    if (!col.offsetWidth) return false;
    const lead = (col.offsetWidth + 8) * 1;
    const left = Math.max(0, col.offsetLeft - lead);
    const prev = scroller.style.scrollBehavior;
    scroller.style.scrollBehavior = "auto";
    scroller.scrollLeft = left;
    head.scrollLeft = left;
    scroller.style.scrollBehavior = prev || "";
    return left === 0 || scroller.scrollLeft > 0;
  }
  function anchorToday() {
    if (done) return;
    if (scrollToToday()) { done = true; return; }
    rafQueue.push(() => { if (!done && scrollToToday()) done = true; });
  }

  // first paint, before layout
  anchorToday();
  assert.equal(scrollLeft, 0, "it cannot scroll yet");
  assert.equal(done, false, "and must not claim it did");
  assert.equal(rafQueue.length, 1, "a retry is queued");

  // layout happens, then the frame fires
  laidOut = true;
  rafQueue.shift()();
  assert.equal(done, true);
  assert.equal(scrollLeft, 1599 - 328, "today anchored with one column of lead-in");
  assert.equal(head.scrollLeft, scrollLeft, "and the day tiles came with it");

  // and the old code's shape: no layout gate, success assumed
  done = false; scrollLeft = 0; laidOut = false;
  const naive = () => { scroller.scrollLeft = col.offsetLeft; return true; };
  done = naive();
  assert.equal(done, true, "the old code reported success");
  assert.equal(scrollLeft, 0, "having scrolled nowhere");
});

test("a smooth scroll is not mistaken for a landed one", () => {
  /* What actually shipped twice. CSS scroll-behavior:smooth made the
     assignment animate, so the position read back as 0 immediately. The old
     check called that a failure and retried forever; a check that assumed
     success would have called it done while it was still moving. Either way
     the next render replaced the element and the animation died at 0. */
  let scrollLeft = 0, animating = false;
  const smoothScroller = {
    get scrollLeft() { return animating ? 0 : scrollLeft; },   // mid-animation
    set scrollLeft(v) { if (animating) return; scrollLeft = v; },
  };
  const target = 1271;

  animating = true;                       // CSS said smooth
  smoothScroller.scrollLeft = target;
  const gotAnimated = smoothScroller.scrollLeft;
  assert.equal(Math.abs(gotAnimated - target) <= 1, false,
    "an animated scroll cannot verify, which is the trap");

  animating = false;                      // no CSS scroll-behavior
  smoothScroller.scrollLeft = target;
  assert.equal(Math.abs(smoothScroller.scrollLeft - target) <= 1, true,
    "an instant assignment verifies immediately");
});

test("the lead-in is deliberate and named", () => {
  // Measured live at about 1.4 columns and preferred over flush-left. Made
  // explicit rather than left as an artefact of whatever offsetLeft returned.
  assert.match(html, /var LEAD_IN_COLS=1, GRID_GAP=8;/);
  const fn = fnSource("function scrollToToday(smooth){");
  assert.match(fn, /var lead=\(el\.offsetWidth\+GRID_GAP\)\*LEAD_IN_COLS;/);
  assert.match(fn, /var left=Math\.max\(0,el\.offsetLeft-lead\);/,
    "and never negative at the start of the window");
});

test("the Today control works from any scroll position", () => {
  assert.match(html, /if\(act==="today"\)\{ scrollToToday\(true\); return; \}/);
  const fn = fnSource("function scrollToToday(smooth){");
  assert.equal(/scrollBy|\+=|-=/.test(fn), false, "absolute, never relative");
  assert.equal(/scrollIntoView/.test(fn), false,
    "scrollIntoView can scroll the page too, and nearest is satisfied by merely visible");
  assert.match(fn, /behavior:"smooth"/, "the button animates; the initial anchor does not");
});

/* ---------------- day column grounds, spec Part 1 ---------------- */

test("every day column ground stretches to the tallest column", () => {
  /* node has no layout engine, so the "same offsetHeight" check the spec asks
     for cannot run here. What is asserted is the three declarations that
     produce it, and the one that used to prevent it. */
  const rule = html.slice(html.indexOf("  .dcol{"), html.indexOf("  .dcol-empty{"));
  assert.match(rule, /grid-row:1 \/ -1/, "spans every lane row");
  assert.match(rule, /align-self:stretch/,
    "the grid sets align-items:start for the cards, so the grounds opt back in");
  assert.match(rule, /min-height:340px/, "the floor for a quiet week stays");
  assert.match(html, /\.daygrid\{[^}]*align-items:start/,
    "cards still sit at the top of their lane");
  // and the ground is painted on the stretching element, not on a child
  assert.match(rule, /background:color-mix/);
});

test("the empty state keeps its tint and label at full height", () => {
  const empty = html.slice(html.indexOf("  .dcol-empty{"), html.indexOf("}", html.indexOf("  .dcol-empty{")));
  assert.match(empty, /color:var\(--ink-3\)/);
  assert.equal(/height|position:absolute/.test(empty), false,
    "it is laid out by the column, not sized or floated on its own");
  const out = dayRendererLite();
  assert.match(out, /class="dcol[^"]*"[^>]*><span class="dcol-empty">No trials/);
});

/** A minimal render, just to read the column markup back. */
function dayRendererLite() {
  const D = require("../lib/dateday");
  const DRI = require("../lib/dri-aliases");
  const EFFECTIVE = require("../lib/effective");
  const FIELDS = require("../lib/fields");
  const t = fs.readFileSync(path.join(__dirname, "dayview.test.js"), "utf8");
  const stub = t.slice(t.indexOf("    /* A DOM stub big enough"), t.indexOf("    function lsGet"));
  const a = html.indexOf("  function daySpan(c){");
  const b = html.indexOf("  /* Hover is primary.");
  return new Function("DATEDAY", "DRI", "EFFECTIVE", "FIELDS", `
    ${stub}
    var STORE={};
    function lsGet(k){ return null; } function lsSet(){}
    function scrollToToday(){ return true; } var uiOpen={}; function render(){}
    function esc(s){ return (s==null?"":String(s)).replace(/[&<>"]/g,function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
    function get(c,k){ return c.values[k]===undefined?FIELDS.defVal(FIELDS.field(k)):c.values[k]; }
    function effective(c,key){ return EFFECTIVE.resolve(c,key,null,get(c,key)); }
    function parseDay(v){ return DATEDAY.parseDay(v); }
    function todayDay(){ return 20260910; }
    function filtered(){ return []; }
    function nameSortKey(c){ return ["",""]; }
    function statusPill(c){ return ""; }
    ${html.slice(a, b)}
    renderDay();
    return dayViewEl.innerHTML;
  `)(D, DRI, EFFECTIVE, FIELDS);
}
