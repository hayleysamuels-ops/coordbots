"use strict";
/**
 * Section 7: reversed date validation.
 *
 * Preventive only. Three rows were saved reversed on 10 Sep and have already
 * been corrected in production; this stops the next one, and nothing here
 * inspects or migrates existing data.
 *
 * dateOrderError is pulled out of public/index.html the same way the panel and
 * sorting tests pull their functions, so the rule is tested where it lives.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const EFFECTIVE = require("../lib/effective");
const FIELDS = require("../lib/fields");
const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function slice(startMark, endMark) {
  const a = html.indexOf(startMark), b = html.indexOf(endMark);
  assert.ok(a >= 0, "start marker not found, validation moved: " + startMark);
  assert.ok(b > a, "end marker not found, validation moved: " + endMark);
  return html.slice(a, b);
}

function validator() {
  const dates = slice("  function trialDay(c){", "  function byName(a,b){");
  const val = slice("  /* Inline validation errors, keyed candidateId|field.",
                    "  function renderField(c,f){");
  return new Function("EFFECTIVE", "FIELDS", "DATEDAY", `
    var panels = {};
    function linkOf(c){ return (c.values && c.values.ashbyCandidateId) || ""; }
    function panelEntry(c){ var aid = linkOf(c); return aid ? panels[aid] : null; }
    function get(c,k){
      return c.values[k] === undefined ? FIELDS.defVal(FIELDS.field(k)) : c.values[k];
    }
    function effective(c,key){ return EFFECTIVE.resolve(c, key, panelEntry(c), get(c,key)); }
    function fmtDate(s){ if(!s) return "not set"; var d=new Date(s+"T00:00:00");
      return d.toLocaleDateString("en-GB",{month:"short",day:"numeric"}); }
    ${dates}
    ${val}
    return { dateOrderError, parseDay, fieldError };
  `)(EFFECTIVE, FIELDS, DATEDAY);
}

const card = (start, end) => ({ id: "c1", name: "A Person",
  values: Object.assign({}, start === undefined ? {} : { startDate: start },
                            end === undefined ? {} : { endDate: end }) });

test("a save with the end date before the start is rejected", () => {
  const M = validator();
  // Vivian (Yiting) G.: 2026-09-18 -> 2026-09-17, taken without complaint.
  const err = M.dateOrderError(card("2026-09-18", undefined), "endDate", "2026-09-17");
  assert.ok(err, "must be rejected");
  assert.match(err, /before start date/);
  // The message names BOTH dates, so the person can see which one is wrong.
  assert.match(err, /17/);
  assert.match(err, /18/);
  assert.match(err, /Nothing was saved/);
});

test("it catches the reversal from either end of the range", () => {
  const M = validator();
  // Editing the start upward past a fixed end is the same defect.
  assert.ok(M.dateOrderError(card(undefined, "2026-09-17"), "startDate", "2026-09-18"));
  assert.ok(M.dateOrderError(card("2026-09-18", undefined), "endDate", "2026-09-17"));
});

test("equal start and end is allowed, that is a single-day trial", () => {
  const M = validator();
  assert.equal(M.dateOrderError(card("2026-09-18", undefined), "endDate", "2026-09-18"), null);
  assert.equal(M.dateOrderError(card(undefined, "2026-09-18"), "startDate", "2026-09-18"), null);
});

test("a normal range is allowed", () => {
  const M = validator();
  assert.equal(M.dateOrderError(card("2026-09-14", undefined), "endDate", "2026-09-18"), null);
});

test("an incomplete or unparseable pair is not rejected", () => {
  const M = validator();
  // Nothing to compare against yet: rejecting here would block the first of two
  // edits and make a valid range unreachable.
  assert.equal(M.dateOrderError(card(undefined, undefined), "endDate", "2026-09-17"), null);
  assert.equal(M.dateOrderError(card("", undefined), "endDate", "2026-09-17"), null);
  // parseDay already returns null rather than NaN, so there is no second guard.
  assert.equal(M.parseDay("TBD"), null);
  assert.equal(M.dateOrderError(card("TBD", undefined), "endDate", "2026-09-17"), null);
  assert.equal(M.dateOrderError(card("2026-09-18", undefined), "endDate", "nonsense"), null);
});

test("only the two date fields are validated", () => {
  const M = validator();
  assert.equal(M.dateOrderError(card("2026-09-18", "2026-09-17"), "driName", "Sam H"), null);
  assert.equal(M.dateOrderError(card("2026-09-18", "2026-09-17"), "status", "DONE"), null);
});

test("a rejected edit is neither written nor sent", () => {
  // The handler writes nothing on rejection: it records the message, puts the
  // input back to the stored value, and returns before setVal.
  const handler = html.slice(html.indexOf('editorEl.addEventListener("change"'),
                             html.indexOf('editorEl.addEventListener("input"'));
  const reject = handler.slice(handler.indexOf("if(err){"), handler.indexOf("delete fieldError"));
  assert.ok(!/setVal/.test(reject), "setVal must not run on a rejected edit: " + reject);
  assert.match(reject, /t\.value=get\(c,k\)/, "the input is put back to what is stored");
  assert.match(reject, /return;/);
  // And the happy path still saves.
  assert.match(handler.slice(handler.indexOf("delete fieldError")), /setVal\(c,k,t\.value\)/);
});

test("the message renders inline, at the field", () => {
  assert.match(html, /class="field-error"/, "an inline element, not a toast");
  assert.match(html, /fieldError\[noteKey\]/, "keyed per candidate and field");
  // Flag treatment: sentence case, weight 600, Ember dot. Not uppercase.
  const css = html.slice(html.indexOf(".field-error{"), html.indexOf(".field-error .dot{") + 200);
  assert.match(css, /font-weight:600/);
  assert.equal(/text-transform:uppercase/.test(css), false);
  assert.match(css, /background:var\(--ember\)/);
});

test("no migration and no auto-correction was added", () => {
  // The three existing rows are already fixed in production. A person decides
  // what the right dates are.
  assert.equal(/autoCorrect|fixReversed|swapDates|migrateDates/i.test(html), false);
  const files = fs.readdirSync(path.join(__dirname, ".."));
  assert.equal(files.some((f) => /migrat/i.test(f)), false, "no migration script");
});

/* ------------------------------- the server side of the same rule */

const DATEDAY = require("../lib/dateday");

test("the shared rule is one definition, used by both sides", () => {
  // A validation rule that disagrees between client and server is the kind of
  // defect nobody sees until it lets something through, so parseDay lives in
  // lib/dateday.js and both sides call it.
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /require\("\.\/lib\/dateday"\)/);
  assert.match(server, /DATEDAY\.isReversed\(startDate, endDate\)/);
});

test("isReversed agrees with the view's own rule on every case", () => {
  const M = validator();
  const cases = [
    ["2026-09-18", "2026-09-17", true],
    ["2026-09-18", "2026-09-18", false],
    ["2026-09-14", "2026-09-18", false],
    ["2026-09-18", null, false],
    [null, "2026-09-17", false],
    ["TBD", "2026-09-17", false],
    ["2026-09-18", "nonsense", false],
    ["2026-02-31", "2026-02-01", false],   // an impossible date is no date
  ];
  cases.forEach(([s, e, expected]) => {
    assert.equal(DATEDAY.isReversed(s, e), expected, "isReversed " + s + " -> " + e);
    // The view refuses exactly the same pairs.
    const viewRefuses = M.dateOrderError({ id: "c", name: "n", values: { startDate: s } },
                                         "endDate", e) !== null;
    assert.equal(viewRefuses, expected, "the view disagrees on " + s + " -> " + e);
  });
});

test("the server returns 400 with both dates, and never coerces", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const block = server.slice(server.indexOf("DATEDAY.isReversed(startDate, endDate)"),
                             server.indexOf("if (!c.updatedAt) c.updatedAt = Date.now();",
                                            server.indexOf("DATEDAY.isReversed")));
  assert.match(block, /res\.status\(400\)/);
  assert.match(block, /startDate,/, "both dates come back to the caller");
  assert.match(block, /endDate,/);
  assert.match(block, /is before start date/);
  // Refused, not repaired: no swap, no clamp, no silent write.
  assert.equal(/store\.put/.test(block), false, "a refused row is never written");
  assert.equal(/startDate = |endDate = /.test(block), false, "and never coerced");
});

test("the server logs the rejection with the id and both values", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const at = server.indexOf("console.warn(", server.indexOf("DATEDAY.isReversed"));
  // Searching for the end from 0 finds the earlier id-mismatch 400 and yields
  // an empty slice, which passes nothing.
  const log = server.slice(at, server.indexOf("return res.status(400)", at));
  assert.match(log, /rejected reversed dates/);
  assert.match(log, /c\.id/, "the candidate id, so a blocked import is traceable");
  assert.match(log, /startDate/);
  assert.match(log, /endDate/);
});

test("a refusal is not reported as a network failure", () => {
  // pushCandidate used to funnel every non-ok response into "Offline,
  // retrying", so a 400 would have looked like a network problem and the row
  // would sit unsaved while the card showed the value. That is a silent drop.
  const push = html.slice(html.indexOf("function pushCandidate(c){"),
                          html.indexOf("function removeRemote(id){"));
  assert.match(push, /r\.status===400/, "a 400 is handled on its own");
  const branchAt = push.indexOf("if(e&&e.rejected){");
  const rejected = push.slice(branchAt, push.indexOf("return;", branchAt));
  assert.match(rejected, /rejectedSaves\[c\.id\]/, "recorded so an import can count it");
  assert.match(rejected, /fieldError\[/, "and said at the field");
  assert.equal(/Offline/.test(rejected), false, "never as an offline error");
  // The row stays dirty: dirty is only cleared on a successful save.
  const success = push.slice(push.indexOf('.then(function(){ delete dirty'));
  assert.match(success, /delete dirty\[c\.id\]/);
});

test("an import says how many rows the server turned away", () => {
  const imp = html.slice(html.indexOf("importFile.addEventListener"),
                         html.indexOf("var toastEl=document.getElementById"));
  assert.match(imp, /rejectedSaves=\{\}/, "the count starts clean for each import");
  assert.match(imp, /not saved: end date before start date/);
  assert.match(imp, /Object\.keys\(rejectedSaves\)\.length/);
});
