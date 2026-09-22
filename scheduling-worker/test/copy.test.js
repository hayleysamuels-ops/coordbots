"use strict";
/**
 * Carrara copy rules, enforced.
 *
 * Em dashes are forbidden in Carrara copy. Two were introduced on 9 Sep 2026 and
 * shipped for an afternoon, so the rule is a test rather than a habit.
 *
 * Comments are NOT copy, and this file goes to some trouble to tell them apart:
 * string literals are walked with a small state machine that skips comments AND
 * regex literals. Without the regex handling, esc()'s /[&<>"]/g opens a phantom
 * string on its double quote and everything after it is mis-parsed — which is
 * exactly how a code comment first showed up in the offender list.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

/* ------------------------------------------------------------- extraction */

function jsStrings(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let prev = "";
  const regexMayFollow = () =>
    prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev) || /\breturn$/.test(prev);
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === "/" && regexMayFollow()) {
      i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) { i++; break; }
        else if (src[i] === "\n") break;
        i++;
      }
      while (i < n && /[a-z]/.test(src[i])) i++;
      prev = "/";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; let buf = ""; i++;
      while (i < n) {
        if (src[i] === "\\") { buf += src[i + 1] || ""; i += 2; continue; }
        if (src[i] === q) { i++; break; }
        buf += src[i++];
      }
      out.push(buf);
      prev = q;
      continue;
    }
    if (!/\s/.test(c)) prev = /[A-Za-z0-9_$]/.test(c) ? (/[A-Za-z0-9_$]/.test(prev) ? prev + c : c) : c;
    i++;
  }
  return out;
}

function htmlText(src) {
  return src
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .split("\n").map((l) => l.trim()).filter(Boolean);
}

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).join("\n;\n");
}

const JS_FILES = [
  "server.js", "users.js",
  "bots/sheet-sync.js", "bots/sheet-sync.config.js", "bots/ashby-panel.js",
  "bots/ashby-panel.config.js", "bots/work-trial-suggestions.js", "bots/readiness-sweep.js",
  "bots/readiness-sweep.config.js", "bots/pool-health.js", "bots/pool-health.config.js",
  "bots/pre-trial-sessions.config.js", "bots/housekeeping.js",
  "lib/sheets.js", "lib/trialwindow.js", "lib/fields.js", "lib/effective.js",
  "lib/bots.js", "lib/botstore.js", "lib/ashby.js", "lib/slack.js",
  "lib/scheduler.js", "lib/interviewtitles.js", "lib/http.js",
];

/** Every user-facing string in the app, with where it came from. */
function userFacingStrings() {
  const out = [];
  JS_FILES.forEach((f) => {
    jsStrings(fs.readFileSync(path.join(root, f), "utf8")).forEach((s) => out.push({ f, s }));
  });
  const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  jsStrings(inlineScripts(html)).forEach((s) => out.push({ f: "public/index.html [js]", s }));
  htmlText(html).forEach((s) => out.push({ f: "public/index.html [html]", s }));
  return out;
}

/**
 * The one permitted em dash: a string that is EXACTLY "—", used as the
 * empty-value glyph. It is load-bearing, not copy — fieldClear() compares
 * v === "—", the Ashby panel uses it as its unknown-value sentinel, and
 * BLANK_EQUIVALENTS matches it against real sheet cells. Changing it would be a
 * behaviour change, so prose is what this rule polices.
 */
const isProse = (s) => s.includes("—") && s !== "—";

/* ------------------------------------------------------------------ tests */

test("no em dash appears in any user-facing string", () => {
  const bad = userFacingStrings().filter(({ s }) => isProse(s))
    .map(({ f, s }) => f + ": " + JSON.stringify(s.length > 120 ? s.slice(0, 120) + "..." : s));
  assert.deepEqual(bad, [], "em dashes in copy:\n  " + bad.join("\n  "));
});

test("the em dash guard actually catches one", () => {
  // A guard that cannot fail is not a guard. These are the two strings that
  // shipped on 9 Sep, run through the same matcher.
  assert.equal(isProse("Never overwrites a value someone edited by hand — it flags a conflict instead"), true);
  assert.equal(isProse("Nothing filled from the sheet yet — it only fills fields that are empty"), true);
  assert.equal(isProse("Aborted — nothing written."), true);
  assert.equal(isProse(" — "), true, "a bare separator with spaces is still prose");
  // ...and the permitted sentinel is not flagged.
  assert.equal(isProse("—"), false);
});

test("the extractor reads strings and not comments", () => {
  const src = [
    '// a comment with an em dash —',
    '/* a block comment with an em dash — */',
    'const re = /[&<>"]/g;',              // the regex that broke the first version
    'const msg = "a string with an em dash —";',
    "const other = 'plain';",
  ].join("\n");
  const found = jsStrings(src);
  assert.ok(found.includes("a string with an em dash —"), "the string is found");
  assert.ok(found.includes("plain"), "and the one after the regex is still found: " + JSON.stringify(found));
  assert.ok(!found.some((s) => s.includes("a comment")), "comments are not copy");
  assert.ok(!found.some((s) => s.includes("block comment")), "block comments are not copy");
});

test("no banned words appear in any user-facing string", () => {
  const BANNED = ["leverage", "utilize", "unlock", "harness", "streamline", "robust",
                  "cutting-edge", "best-in-class", "delve", "unleash", "empower",
                  "seamless", "world-class", "synergize", "operationalize"];
  const bad = [];
  userFacingStrings().forEach(({ f, s }) => {
    BANNED.forEach((w) => {
      if (new RegExp("\\b" + w.replace("-", "\\-") + "\\b", "i").test(s)) {
        bad.push(f + ": " + JSON.stringify(w) + " in " + JSON.stringify(s.slice(0, 90)));
      }
    });
  });
  assert.deepEqual(bad, [], "banned words:\n  " + bad.join("\n  "));
});

test("the banned-word guard actually catches one", () => {
  const re = (w) => new RegExp("\\b" + w + "\\b", "i");
  assert.ok(re("leverage").test("We leverage the sheet"), "must catch a planted word");
  assert.ok(re("seamless").test("A seamless experience"));
  // and must not fire on an innocent substring
  assert.ok(!re("delve").test("delved into nothing"), "word boundaries, not substrings");
});
