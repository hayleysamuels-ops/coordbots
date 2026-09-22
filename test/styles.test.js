"use strict";
/**
 * Carrara styling invariants.
 *
 * The first of these exists because of a real bug: renaming --good-bg and --good
 * both onto --green painted six labels the same colour as their fill, and the
 * Synced pill and every group count chip shipped as empty green blobs. A tint
 * carries no text colour of its own, so the label must always be ink.
 *
 * This is the first Carrara app UI and the next tool copies its tokens, so the
 * palette rules are asserted rather than trusted.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const cssRaw = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "";
// Strip comments FIRST: otherwise a rule's preceding comment lands inside the
// captured selector and every lookup by name misses.
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, sel, decls]) => ({ sel: sel.trim().replace(/\s+/g, " "), decls }));
const root = (css.match(/:root\{([\s\S]*?)\}/) || [])[1] || "";
const tokenValue = (t) => {
  const m = root.match(new RegExp(t.replace(/[-]/g, "\\-") + "\\s*:\\s*([^;]+);"));
  return m ? m[1].trim() : null;
};

test("no label is painted the same colour as its own fill", () => {
  const bad = [];
  rules.forEach(({ sel, decls }) => {
    const fg = (decls.match(/(?:^|;)\s*color\s*:\s*var\((--[a-z0-9-]+)\)/) || [])[1];
    const bg = (decls.match(/background(?:-color)?\s*:\s*var\((--[a-z0-9-]+)\)/) || [])[1];
    if (fg && bg && fg === bg) bad.push(sel + " uses " + fg + " for both");
  });
  assert.deepEqual(bad, [], "invisible labels:\n  " + bad.join("\n  "));
});

test("the guard above catches a collapsed pair", () => {
  // The exact shape that shipped.
  const decls = "background:var(--green);color:var(--green)";
  const fg = (decls.match(/(?:^|;)\s*color\s*:\s*var\((--[a-z0-9-]+)\)/) || [])[1];
  const bg = (decls.match(/background(?:-color)?\s*:\s*var\((--[a-z0-9-]+)\)/) || [])[1];
  assert.equal(fg, "--green");
  assert.equal(bg, "--green");
  assert.equal(fg === bg, true, "a guard that cannot fail is not a guard");
});

test("the ten Carrara tokens are defined, with the agreed values", () => {
  const expected = {
    "--ink": "#2E2B2B", "--ink-2": "#4D4D4D", "--ink-3": "#827F7D",
    "--surface": "#EBE8E4", "--paper": "#FFFFFF", "--line": "#EEEEEE",
    "--ember": "#EB4C18", "--ember-tint": "#FDDED4",
    "--blue": "#B2CDED", "--green": "#A4C69B",
    "--role-fde": "#B2CDED", "--role-fds": "#A8CA9F", "--role-sales": "#E0D8CC",
  };
  Object.entries(expected).forEach(([t, v]) => {
    assert.equal(tokenValue(t), v, t + " should be " + v);
  });
});

test("only the canonical tokens are referenced", () => {
  const allowed = new Set(["--ink", "--ink-2", "--ink-3", "--surface", "--paper", "--line",
    "--ember", "--ember-tint", "--blue", "--green",
    "--role-fde", "--role-fds", "--role-sales",
    "--radius", "--radius-control", "--radius-pill", "--sans", "--mono",
    // Layout counts set inline by the Day view grid, not part of the palette.
    // Listed so a stray COLOUR still fails this test.
    "--cols", "--vis", "--lanes",
    // Set per card from ROLE_GROUNDS, which is itself only ever one of the
    // three role tokens or --paper. The role hexes are pinned in dayview.test.js.
    "--ground"]);
  const used = new Set([...html.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
  const strays = [...used].filter((t) => !allowed.has(t));
  assert.deepEqual(strays, [], "tokens outside the agreed set: " + strays.join(", "));
});

test("solid Ember appears on exactly two elements", () => {
  // 15 of 36 candidates carry Needs attention, so a third solid Ember would
  // start the accent losing its meaning. Dots do not count: those are the
  // sanctioned way to use it everywhere else.
  // .bot-last .err is a 7px status dot — .bot-last .dot sizes it — so it is a
  // dot despite the selector not saying so. Named here rather than pattern
  // matched, because the exemption is the point and should be explicit.
  const DOTS = [".bot-last .err"];
  const solid = rules.filter(({ sel, decls }) =>
    /background(?:-color)?\s*:\s*var\(--ember\)/.test(decls) &&
    !/\.dot|\.sdot/.test(sel) && !DOTS.includes(sel)
  ).map((r) => r.sel);
  assert.deepEqual(solid.sort(), [".btn-primary", ".stat.attn .rail"],
    "solid Ember found on: " + solid.join(" | "));
});

test("no shadows, and no PT Serif", () => {
  assert.equal(/box-shadow/.test(css), false, "carrara.is is flat: hairline borders only");
  assert.equal(/pt serif/i.test(html), false);
  assert.match(tokenValue("--sans"), /^'Manrope'/);
});

test("uppercase belongs to status pills, not to the attention flag", () => {
  const pill = rules.find((r) => r.sel === ".pill");
  const attn = rules.find((r) => r.sel === ".attn-flag");
  assert.match(pill.decls, /text-transform:uppercase/, "status pills are uppercase");
  assert.equal(/text-transform:uppercase/.test(attn.decls), false,
    "a flag is not a status and must not compete with one");
  assert.match(attn.decls, /font-weight:600/, "and it sits below the pill");
  assert.match(attn.decls, /background:var\(--ember-tint\)/);
});

test("the flag dots are elements, not bullet characters", () => {
  // A bullet character inherits the label colour, so the dot was ink however the
  // CSS was written. That is why the accent signal was missing.
  assert.equal(html.includes("●"), false, "no bullet characters left in markup");
  assert.match(css, /\.attn-flag \.dot\{[^}]*background:var\(--ember\)/);
  assert.match(css, /\.stale-flag \.dot\{[^}]*background:var\(--ink-3\)/);
});

test("the progress bar is monochrome ink-2", () => {
  const fill = rules.find((r) => r.sel === ".prog-fill");
  assert.match(fill.decls, /background:var\(--ink-2\)/);
  assert.equal(tokenValue("--ink-2"), "#4D4D4D");
  const bar = rules.find((r) => r.sel === ".prog-bar");
  assert.match(bar.decls, /height:4px/);
  assert.match(bar.decls, /background:var\(--line\)/);
});

/* ------------------------------------------------------- Ember discipline */

test("card section headings are structure, not signal", () => {
  const title = rules.find((r) => r.sel === ".section-title");
  assert.match(title.decls, /color:var\(--ink-3\)/,
    "CANDIDATE & TRIAL and friends are labels, and read as one more warning in Ember");
  assert.equal(/var\(--ember\)/.test(title.decls), false);
  // Same treatment as the group headings in the list, so the two agree.
  const group = rules.find((r) => r.sel === ".group-header");
  assert.match(group.decls, /color:var\(--ink-3\)/);
  [title, group].forEach((r) => {
    assert.match(r.decls, /font-size:11px/);
    assert.match(r.decls, /font-weight:700/);
    assert.match(r.decls, /text-transform:uppercase/);
  });
  // And no dark-mode rule may put it back.
  assert.equal(/prefers-color-scheme:dark[^}]*section-title/.test(css), false);
});

test("Ember appears only where it means look at this", () => {
  /**
   * Two solid fills in the page chrome, and inside a card only warnings and
   * flag dots. Every other use is named here with what it is, because the
   * point of the rule is that the list stays short: while the four section
   * headings were Ember, a real Ashby warning directly above them read as one
   * more label.
   */
  const SOLID_CHROME = {
    ".btn-primary": "the primary action",
    ".stat.attn .rail": "the Needs attention tile rule",
  };
  const ALLOWED = {
    ".bot-last .err": "7px dot, a failed run in the Bots panel",
    ".bots-warn": "Bots panel warning text",
    ".aconflict .ct": "conflict warning, inside a card",
    ".apanel.stale": "Ashby unreachable, warning border",
    ".apanel.stale .apanel-head": "the same warning, its text",
    ".apanel.gone": "linked candidate no longer exists, warning border",
    ".aflag.warn": "Ashby derivation warning",
    ".aflag.error": "Ashby derivation error",
    ".t-warn .dot": "flag dot",
    ".attn-flag .dot": "Needs attention dot",
    "select.inp:focus,input.inp:focus,textarea.inp:focus": "focus ring",
    ".group-header:focus-visible,.done-header:focus-visible": "focus ring on the collapse buttons",
    ".del-btn:hover": "the one destructive action on a card",
    ".pcheck.red": "the red half of a red-to-green check, as its border",
    ".aconflict": "the conflict block's warning border",
  };
  const known = new Set([...Object.keys(SOLID_CHROME), ...Object.keys(ALLOWED)]);

  // var(--ember), never var(--ember-tint): a tint fill is always allowed.
  // A 6px dot is the sanctioned Ember usage everywhere, so dots are exempt by
  // shape rather than named one at a time.
  const users = rules
    .filter((r) => /var\(--ember\)/.test(r.decls) && !/\.dot\b|\.sdot\b/.test(r.sel))
    .map((r) => r.sel);
  const strays = users.filter((sel) => !known.has(sel));
  assert.deepEqual(strays, [], "unaccounted Ember:\n  " + strays.join("\n  "));

  // The two solid fills are still exactly two, and still those two.
  const solid = rules.filter((r) =>
    /background(?:-color)?:var\(--ember\)/.test(r.decls) && !/\.dot|\.sdot/.test(r.sel) &&
    r.sel !== ".bot-last .err"
  ).map((r) => r.sel).sort();
  assert.deepEqual(solid, Object.keys(SOLID_CHROME).sort());
});

test("the Ember guard catches a heading painted with the accent", () => {
  // A guard that cannot fail is not a guard: this is the exact rule that shipped.
  const decls = "font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ember)";
  assert.equal(/var\(--ember\)/.test(decls), true);
  assert.equal(/color:var\(--ink-3\)/.test(decls), false);
});
