"use strict";
/**
 * The inline script may only reference globals the BROWSER actually receives.
 *
 * This exists because of a production outage on 11 Sep. lib/assignment-inventory.js
 * exposes root.INVENTORY; the inline script said INV. Every test passed, because
 * every test runs in node where the harness had required it under that name and
 * injected it. In the browser it was undefined, the throw was inside renderDay,
 * and the whole calendar rendered as "No trials" in every column while the stat
 * tiles said five trials were in progress.
 *
 * Node's namespace and the browser's are not the same thing, and nothing
 * checked that. This checks it.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const inline = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || "";

/** Every <script src="/x.js"> the page loads, in order. */
const scriptSrcs = [...html.matchAll(/<script src="(\/[^"]+\.js)"><\/script>/g)].map((m) => m[1]);

// Standalone UI controllers are served from public/ and intentionally expose
// no browser globals. Keep them distinct from the shared UMD modules.
const staticScripts = new Set(["/scheduling-review.js"]);

/** What global does lib/<name>.js actually assign in a browser? */
function globalOf(file) {
  const src = fs.readFileSync(path.join(root, "lib", file), "utf8");
  // Two UMD shapes in use: "else root.X = factory()" and a braced else block.
  // Match the assignment itself rather than the statement around it.
  const m = /root\.([A-Za-z_$][\w$]*)\s*=\s*factory/.exec(src);
  assert.ok(m, file + " does not assign a browser global the expected way");
  return m[1];
}

test("every script the page loads is actually served", () => {
  for (const src of scriptSrcs) {
    if (staticScripts.has(src)) {
      assert.ok(fs.existsSync(path.join(root, "public", src.slice(1))), src + " is missing from public");
      assert.ok(server.includes("express.static"), "public controller needs static serving");
      continue;
    }
    assert.ok(server.includes('app.get("' + src + '"'),
      src + " is loaded by the page but has no route");
  }
  assert.ok(scriptSrcs.length >= 5, "sanity: the UMD modules are loaded");
});

/** The globals the browser really has after those scripts run. */
const SERVED_GLOBALS = scriptSrcs.filter(s => !staticScripts.has(s)).map((s) => globalOf(s.replace(/^\//, "")));

test("the served globals are the names the modules assign", () => {
  assert.deepEqual(SERVED_GLOBALS.slice().sort(),
    ["DATEDAY", "DECLINES", "DRI", "EFFECTIVE", "FIELDS", "INVENTORY", "SUGGEST"],
    "if this changes, the inline script's references must change with it");
});

/* Browser globals the inline script may use without declaring them. Uppercase
   only: this test is about MODULE namespaces, which are the ones that differ
   between node and the browser and the ones that go undefined silently. */
const BROWSER_BUILTINS = new Set([
  "Array", "Boolean", "Date", "Error", "Function", "Infinity", "Intl", "JSON",
  "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy", "RegExp", "Set",
  "String", "Symbol", "TypeError", "URL", "WeakMap", "FormData", "Blob",
  "FileReader", "Image", "Event", "CustomEvent", "AbortController", "Intl",
]);

/**
 * Code only: comments and string literals stripped.
 *
 * Scanned rather than regexed, because prose ends sentences with a capitalised
 * word and a full stop ("LOUDLY.") which reads exactly like a namespace
 * reference, and because this file contains regex literals holding quotes that
 * a naive string-skipper would mistake for the start of a string and then eat
 * live code, hiding the very thing this is looking for.
 */
function codeOnly(src) {
  let out = "", i = 0, prev = "";
  const regexCanStart = () => !prev || "(,=:[!&|?{};+-*%~^<>".includes(prev);
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      i++; out += " "; prev = "0"; continue;
    }
    if (c === "/" && regexCanStart()) {
      i++;
      while (i < src.length && src[i] !== "/") {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") { while (i < src.length && src[i] !== "]") { if (src[i] === "\\") i++; i++; } }
        i++;
      }
      i++; while (i < src.length && /[gimsuy]/.test(src[i])) i++;
      out += " "; prev = "0"; continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

test("the code scanner survives this file's own regex literals", () => {
  // The failure it guards: a quote inside a regex opening a phantom string.
  const sample = 'var x = /[&<>"]/g; INV.personFor(a);';
  assert.match(codeOnly(sample), /INV\.personFor/, "code after a regex must survive");
  assert.equal(/LOUDLY/.test(codeOnly("/* LOUDLY. no */ ok();")), false, "comments go");
  assert.equal(/HELLO/.test(codeOnly('var s = "HELLO.";')), false, "strings go");
});

test("no ALL-CAPS namespace is referenced that the browser will not have", () => {
  /* Names declared inside the script itself are fine: they are the script's
     own constants. What must not appear is a namespace that only exists
     because a test harness or a node require supplied it. */
  const code = codeOnly(inline);
  const declared = new Set();
  for (const m of code.matchAll(/\b(?:var|let|const)\s+([A-Z][A-Z0-9_]{1,})\b/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\bfunction\s+([A-Z][A-Z0-9_]{1,})\b/g)) declared.add(m[1]);
  // multiple declarators: var A=1, B=2
  for (const m of code.matchAll(/[,(]\s*([A-Z][A-Z0-9_]{1,})\s*=/g)) declared.add(m[1]);

  const used = new Set();
  for (const m of code.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*\./g)) used.add(m[1]);

  const stray = [...used].filter((n) =>
    !declared.has(n) && !BROWSER_BUILTINS.has(n) && !SERVED_GLOBALS.includes(n));

  assert.deepEqual(stray, [],
    "referenced but not served and not declared: " + stray.join(", ") +
    ". This is the INV/INVENTORY outage.");
});

test("the guard catches the exact shape that shipped", () => {
  // A guard that cannot fail is not a guard.
  const sample = 'personId: INV.personFor(effective(e.c, "driName")),';
  const used = [...sample.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*\./g)].map((m) => m[1]);
  assert.deepEqual(used, ["INV"]);
  assert.equal(SERVED_GLOBALS.includes("INV"), false, "INV is not a served global");
  assert.equal(BROWSER_BUILTINS.has("INV"), false);
});

test("the suggester's own browser dependencies are loaded before it", () => {
  // suggest-assignments.js reads root.DATEDAY and root.INVENTORY at load time,
  // so their script tags have to come first or it captures undefined.
  const order = scriptSrcs.map((s) => s.replace(/^\/|\.js$/g, ""));
  assert.ok(order.indexOf("dateday") < order.indexOf("suggest-assignments"));
  assert.ok(order.indexOf("assignment-inventory") < order.indexOf("suggest-assignments"));
  const src = fs.readFileSync(path.join(root, "lib", "suggest-assignments.js"), "utf8");
  assert.match(src, /factory\(root\.DATEDAY, root\.INVENTORY\)/);
});

test("the test harnesses inject modules under their browser names", () => {
  // The outage survived because the harness bound the module to INV, which is
  // the name node used and the browser never had.
  for (const f of ["dayview.test.js", "design.test.js"]) {
    const t = fs.readFileSync(path.join(__dirname, f), "utf8");
    const params = /new Function\(([^`]*)`/.exec(t);
    if (!params) continue;
    assert.equal(/"INV"/.test(params[1]), false,
      f + " must inject INVENTORY, the name the browser uses");
  }
});
