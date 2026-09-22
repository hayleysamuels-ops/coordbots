"use strict";
/**
 * Render checks for the two card panels' compact linked states.
 *
 * public/index.html is one file with no module boundary, so these pull the
 * relevant functions out of it by source slice and run them against stubs. That
 * makes them sensitive to the file being reorganised — deliberately: if a slice
 * stops matching, the panel logic has moved and wants re-checking rather than
 * silently losing its only coverage.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function slice(startMark, endMark) {
  const a = html.indexOf(startMark), b = html.indexOf(endMark);
  assert.ok(a >= 0, "start marker not found — panel code moved: " + startMark);
  assert.ok(b > a, "end marker not found — panel code moved: " + endMark);
  return html.slice(a, b);
}

const ESC = `function esc(s){ return (s==null?"":String(s)).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];}); }`;

function ashbyPanel() {
  const afield = slice("  function afield(label,f){", "  function panelHead(c,label,when){");
  const panel = slice("  var PANEL_ROWS=[", "  /* Whatever the derivation could not assert");
  return new Function(`
    ${ESC}
    var panelOpen = {};
    function panelHead(){ return "<HEAD>"; }
    function panelFlags(p){ return (p && p.dataFlags && p.dataFlags.length) ? "<FLAGS>" : ""; }
    ${afield}
    ${panel}
    return { PANEL_ROWS, fieldClear, panelFields, panelLive, panelOpen };
  `)();
}

function sheetPanel() {
  const src = slice("  function sheetLinkedRowOf(c){", "  function renderSheetPanel(c){") +
              slice("  function renderSheetPanel(c){", "  function unlinkCandidate(c){");
  return new Function(`
    ${ESC}
    function fmtDate(){ return "8 Sep"; }
    function field(k){ return { k: k, label: k }; }
    var sheetProvOpen = {}, sheetSuggests = {}, sheetSuggestMeta = {};
    var botsData = null;   // conflicts come from the run row; null = no run seen yet
    var sheetKeyOf = function(c){ return (c.values && c.values.sheetRowKey) || ""; };
    ${src}
    return { renderSheetPanel, sheetLinkedRowOf, sheetConflictsFor, sheetProvOpen, sheetSuggests,
             sheetSuggestMeta, setBots: function(d){ botsData = d; } };
  `)();
}

const cards = (h) => (h.match(/class="afield/g) || []).length;
const good = (v) => ({ value: v, detail: "detail" });
const ALL_CLEAR = {
  position: good("FDE"),
  workTrialScheduled: good("YES"),
  trialDates: good("8 Sep → 12 Sep"),
  preTrialSessions: good("NONE"),
  ebs: good("FEEDBACK IN"),
  agentShadow: good("SCHEDULED"),
  debriefScheduled: good("YES"),
};
const FETCHED = { fetchedAt: "2026-09-08T12:00:00.000Z", panel: {} };

/* ------------------------------------------------------------ Ashby panel */

test("Ashby live state: all values readable collapses to one line", () => {
  const M = ashbyPanel();
  const out = M.panelLive({ id: "c1" }, FETCHED, ALL_CLEAR);
  assert.equal(cards(out), 0, "no field cards when everything is clear");
  assert.ok(out.includes('class="asum"'));
  assert.ok(out.includes("all 7 clear"));
  assert.ok(out.includes("FDE · 8 Sep → 12 Sep"), "the summary carries position and dates");
});

test("Ashby live state: default is collapsed, and the control is a real button", () => {
  const M = ashbyPanel();
  const out = M.panelLive({ id: "fresh" }, FETCHED, ALL_CLEAR);
  assert.ok(out.includes('aria-expanded="false"'));
  assert.ok(out.includes("▸"));
  assert.ok(/<button class="asum"/.test(out), "keyboard reachable, not a hover target");
  assert.ok(/title=""/.test(out), "no content hidden in a title attribute");
});

test("Ashby live state: UNKNOWN stays expanded with its reason", () => {
  const M = ashbyPanel();
  const f = Object.assign({}, ALL_CLEAR, {
    ebs: { value: "UNKNOWN", detail: "could not read stage names from Ashby" },
  });
  const out = M.panelLive({ id: "c1" }, FETCHED, f);
  assert.equal(cards(out), 1, "only the unreadable field is shown");
  assert.ok(out.includes("could not read stage names from Ashby"));
  assert.ok(out.includes("1 of 7 need a look"));
});

test("Ashby live state: unbooked values stay expanded", () => {
  const M = ashbyPanel();
  ["NO", "NOT SCHEDULED", "SCHEDULED, NO FEEDBACK"].forEach((v) => {
    assert.equal(M.fieldClear(good(v)), false, v + " must not collapse");
  });
  const out = M.panelLive({ id: "c1" }, FETCHED,
    Object.assign({}, ALL_CLEAR, { debriefScheduled: good("NO"), ebs: good("NOT SCHEDULED") }));
  assert.equal(cards(out), 2);
  assert.ok(out.includes("2 of 7 need a look"));
});

test("Ashby live state: NONE is a complete answer and collapses", () => {
  const M = ashbyPanel();
  // Most candidates have no pre-trial sessions; treating NONE as a problem would
  // leave nearly every card expanded and the feature pointless.
  assert.equal(M.fieldClear(good("NONE")), true);
  assert.equal(M.fieldClear({ value: null }), false);
  assert.equal(M.fieldClear(undefined), false);
});

test("Ashby live state: clicking the summary expands all seven", () => {
  const M = ashbyPanel();
  M.panelOpen.c1 = true;
  const out = M.panelLive({ id: "c1" }, FETCHED, ALL_CLEAR);
  assert.equal(cards(out), M.PANEL_ROWS.length);
  assert.equal(M.PANEL_ROWS.length, 7);
  assert.ok(out.includes('aria-expanded="true"'));
  assert.ok(out.includes("▾"));
});

test("Ashby live state: data flags are never behind the click", () => {
  const M = ashbyPanel();
  const out = M.panelLive({ id: "x" },
    { fetchedAt: null, panel: { dataFlags: [{ level: "warn", text: "one session" }] } }, ALL_CLEAR);
  assert.ok(out.includes("<FLAGS>"), "a warning nobody sees is not a warning");
});

/* ------------------------------------------------------------ sheet panel */

const linkedCard = (over) => ({
  id: "c1",
  values: Object.assign({
    sheetRowKey: "andrew|mi", sheetLinkedName: "Andrew Mi", sheetLinkedRow: 7,
    sheetLinkedBy: "coordinator@carrara.is", sheetLinkedAt: "2026-09-08T00:00:00.000Z",
  }, over || {}),
});

test("sheet panel linked: one line with the row's name and number", () => {
  const M = sheetPanel();
  const out = M.renderSheetPanel(linkedCard());
  assert.ok(out.includes("Andrew Mi"));
  assert.ok(out.includes("row 7"));
  assert.ok(!out.includes("coordinator@carrara.is"), "provenance is not on the collapsed line");
  assert.ok(!out.includes('class="aprov"'));
  assert.ok(out.includes('aria-expanded="false"'), "default collapsed");
  assert.ok(/<button class="asum"/.test(out));
  assert.ok(/title=""/.test(out), "not a hover disclosure");
});

test("sheet panel linked: provenance appears on click", () => {
  const M = sheetPanel();
  M.sheetProvOpen.c1 = true;
  const out = M.renderSheetPanel(linkedCard());
  assert.ok(out.includes('class="aprov"'));
  assert.ok(out.includes("coordinator@carrara.is"));
  assert.ok(out.includes("andrew|mi"), "the key is provenance too");
  assert.ok(out.includes('aria-expanded="true"'));
});

test("sheet panel linked: the row number is recovered or admitted, never guessed", () => {
  const M = sheetPanel();
  assert.equal(M.sheetLinkedRowOf({ values: { sheetRowKey: "andrew|mi@r12" } }), 12);
  assert.equal(M.sheetLinkedRowOf({ values: { sheetRowKey: "andrew|mi", sheetLinkedRow: 3 } }), 3);
  assert.equal(M.sheetLinkedRowOf({ values: { sheetRowKey: "andrew|mi" } }), null);
  const out = M.renderSheetPanel(linkedCard({ sheetLinkedRow: undefined }));
  assert.ok(out.includes("row unknown"), "a link made before the row was stored says so");
});

test("sheet panel: unlinked, no-match and picker states keep their prominence", () => {
  const M = sheetPanel();

  let out = M.renderSheetPanel({ id: "c2", values: {} });
  assert.ok(out.includes("Not linked to the WT Tracker sheet"));
  assert.ok(out.includes("Find sheet row"));
  assert.ok(!out.includes('class="asum"'), "unlinked must not collapse");

  M.sheetSuggests.c3 = [];
  out = M.renderSheetPanel({ id: "c3", values: {} });
  assert.ok(out.includes("No sheet row matches"));
  assert.ok(!out.includes('class="asum"'));

  M.sheetSuggests.c4 = [{ rowKey: "a|b", sheetName: "A B", rowNumber: 2, relation: "exact", context: [] }];
  out = M.renderSheetPanel({ id: "c4", values: {} });
  assert.ok(out.includes('data-act="sheetpick"'));
  assert.ok(!out.includes('class="asum"'));
});


/* ------------------------------------------------- conflicts on the card */

/** A bots payload carrying one conflict for candidate c1. */
const withConflict = (over) => ({
  bots: [{
    name: "sheet-sync",
    runs: [{ outcome: "ok", summary: { conflicts: [Object.assign({
      candidateId: "c1", field: "desk", header: "Desk",
      trackerValue: "SF-2F-04", sheetValue: "Desk 12", cell: "G7", lastSynced: "Desk 9",
    }, over || {})] } }],
  }],
});

test("sheet panel: a conflict is shown, never collapsed and never behind the click", () => {
  const M = sheetPanel();
  M.setBots(withConflict());
  const out = M.renderSheetPanel(linkedCard());

  assert.ok(out.includes('class="aconflict"'), "the conflict block renders");
  assert.ok(out.includes("not overwritten"));
  assert.ok(out.includes("SF-2F-04"), "the tracker's value");
  assert.ok(out.includes("Desk 12"), "and the sheet's");
  assert.ok(out.includes("G7"), "and the cell to go and fix");
  // It is outside the collapsed summary, so it shows with the panel closed.
  assert.ok(out.indexOf('class="aconflict"') < out.indexOf('class="asum"'),
    "the conflict sits above the collapsed line, not inside it");
  assert.ok(out.includes('aria-expanded="false"'), "the panel is still collapsed");
});

test("sheet panel: a conflict shows even when the row is not linked", () => {
  // Unlinking does not make a disagreement go away.
  const M = sheetPanel();
  M.setBots(withConflict());
  const out = M.renderSheetPanel({ id: "c1", values: {} });
  assert.ok(out.includes('class="aconflict"'));
  assert.ok(out.includes("Not linked to the WT Tracker sheet"), "and the unlinked message keeps its place");
});

test("sheet panel: only this candidate's conflicts appear", () => {
  const M = sheetPanel();
  M.setBots(withConflict({ candidateId: "someone-else" }));
  const out = M.renderSheetPanel(linkedCard());
  assert.ok(!out.includes('class="aconflict"'));
  assert.deepEqual(M.sheetConflictsFor("c1"), []);
  assert.equal(M.sheetConflictsFor("someone-else").length, 1);
});

test("sheet panel: no bots data yet is not an error", () => {
  const M = sheetPanel();
  M.setBots(null);
  assert.deepEqual(M.sheetConflictsFor("c1"), []);
  const out = M.renderSheetPanel(linkedCard());
  assert.ok(!out.includes('class="aconflict"'));
  assert.ok(out.includes('class="asum"'), "and the panel still renders");
});


/* ------------------------------------- archived sheet rows in the picker */

const proposal = (over) => Object.assign({
  rowKey: "sam|lisowski", sheetName: "Sam Lisowski", rowNumber: 105,
  relation: "exact", pinned: false, archived: false, context: [],
}, over || {});

test("sheet panel: an archived row is shown, greyed, and cannot be picked", () => {
  const M = sheetPanel();
  M.sheetSuggests.c1 = [proposal({ archived: true })];
  const out = M.renderSheetPanel({ id: "c1", values: {} });

  assert.ok(out.includes("Sam Lisowski"), "the person is still findable");
  assert.ok(out.includes("row 105"));
  assert.ok(out.includes('class="row archived"'), "greyed out");
  assert.ok(out.includes("archived, hidden in the sheet"), "with the reason on the row");
  assert.ok(!/data-act="sheetpick"/.test(out), "and no way to link it");
  assert.ok(out.includes('aria-disabled="true"'));
  // The point: not "no match".
  assert.ok(!out.includes("No sheet row matches"));
});

test("sheet panel: a live row is still pickable alongside an archived one", () => {
  const M = sheetPanel();
  M.sheetSuggests.c1 = [
    proposal({ rowKey: "sam|lisowski", rowNumber: 105, archived: true }),
    proposal({ rowKey: "sam|lisowski@r120", sheetName: "Sam Lisowski", rowNumber: 120, archived: false }),
  ];
  const out = M.renderSheetPanel({ id: "c1", values: {} });
  assert.equal((out.match(/data-act="sheetpick"/g) || []).length, 1, "exactly one pickable row");
  assert.ok(out.includes('class="row archived"'), "and the archived one is still listed");
  assert.ok(!out.includes("Every match is archived"));
});

test("sheet panel: all-archived says so, and says what to do instead", () => {
  const M = sheetPanel();
  M.sheetSuggests.c1 = [proposal({ archived: true })];
  const out = M.renderSheetPanel({ id: "c1", values: {} });
  assert.ok(out.includes("Every match is archived"));
  assert.ok(out.includes("unhide the row in the sheet rather than linking it here"),
    "the repair is in the sheet, not in the tracker");
});

test("sheet panel: an unreadable visibility check is stated, not hidden", () => {
  const M = sheetPanel();
  M.sheetSuggests.c1 = [proposal({ archived: null })];
  M.sheetSuggestMeta.c1 = { visibilityError: "sheets api returned 503 reading row visibility" };
  const out = M.renderSheetPanel({ id: "c1", values: {} });
  assert.ok(out.includes("Could not check which rows are archived"));
  assert.ok(out.includes("503"));
  // archived === null is not archived: the row stays pickable rather than being
  // blocked on a fact we could not establish.
  assert.ok(out.includes('data-act="sheetpick"'));
});

/* ==================== collapsible group headings (10 Sep) */

/**
 * The collapse rules are pulled out of index.html and run against a fake
 * localStorage, so persistence and the search override are tested without a
 * browser. Defaults matter here: all three groups start EXPANDED, because
 * Awaiting a date is people who need a date booked.
 */
function groupCollapse(store) {
  // isNarrowing() reads DOM inputs, so it is stubbed out of the slice: the
  // narrowing flag is passed in explicitly by every caller here.
  const src = slice("  /* Every localStorage read and write here is wrapped.",
                    "  /* Is a filter or search narrowing") +
              slice("  /* Whether a group renders open.", "  function get(c,k){");
  return new Function("STORE", `
    const localStorage = STORE;
    ${src}
    return { lsGet, lsSet, groupCollapsed, groupSlug, saveGroupCollapsed, groupIsOpen,
             raw: function(){ return groupCollapsed; } };
  `)(store);
}

/** A localStorage that works, or one that throws on every access. */
function fakeStore(initial, throwing) {
  const data = Object.assign({}, initial || {});
  return {
    getItem(k) { if (throwing) throw new Error("site data blocked"); return k in data ? data[k] : null; },
    setItem(k, v) { if (throwing) throw new Error("site data blocked"); data[k] = String(v); },
    dump() { return data; },
  };
}

test("all three groups default to expanded", () => {
  const M = groupCollapse(fakeStore());
  ["upcoming", "needs-closing-out", "awaiting-a-date"].forEach((slug) => {
    assert.equal(M.groupIsOpen(slug, false), true, slug + " must start open");
  });
});

test("the slug is derived from the label, so all three behave the same", () => {
  const M = groupCollapse(fakeStore());
  assert.equal(M.groupSlug("Upcoming"), "upcoming");
  assert.equal(M.groupSlug("Needs closing out"), "needs-closing-out");
  assert.equal(M.groupSlug("Awaiting a date"), "awaiting-a-date");
});

test("a collapse persists across a reload", () => {
  const store = fakeStore();
  const first = groupCollapse(store);
  first.raw()["awaiting-a-date"] = true;
  first.saveGroupCollapsed();
  assert.equal(store.dump()["wt-group-collapsed"], '{"awaiting-a-date":true}');

  // A fresh page load reading the same storage.
  const second = groupCollapse(store);
  assert.equal(second.groupIsOpen("awaiting-a-date", false), false, "still shut tomorrow");
  assert.equal(second.groupIsOpen("upcoming", false), true, "and the others are untouched");
});

test("a search match inside a collapsed group expands it", () => {
  // Otherwise somebody searches a name, sees nothing, and concludes the
  // candidate is not in the tracker.
  const M = groupCollapse(fakeStore({ "wt-group-collapsed": '{"awaiting-a-date":true}' }));
  assert.equal(M.groupIsOpen("awaiting-a-date", false), false, "shut when not searching");
  assert.equal(M.groupIsOpen("awaiting-a-date", true), true, "open while narrowing");
});

test("that expansion does not overwrite the stored preference", () => {
  const store = fakeStore({ "wt-group-collapsed": '{"awaiting-a-date":true}' });
  const M = groupCollapse(store);
  // Render while searching, several times over.
  M.groupIsOpen("awaiting-a-date", true);
  M.groupIsOpen("awaiting-a-date", true);
  assert.equal(store.dump()["wt-group-collapsed"], '{"awaiting-a-date":true}',
    "storage is untouched by the override");
  assert.equal(M.raw()["awaiting-a-date"], true, "and so is the in-memory preference");
  // Search cleared: it is shut again.
  assert.equal(M.groupIsOpen("awaiting-a-date", false), false);
});

test("localStorage throwing does not break the render", () => {
  // A browser with site data blocked throws on every access, and this runs at
  // the top of the script: an unguarded read takes the page down.
  const store = fakeStore({}, true);
  let M;
  assert.doesNotThrow(() => { M = groupCollapse(store); }, "reading must not throw");
  assert.deepEqual(M.raw(), {}, "no stored preferences, so everything defaults open");
  assert.equal(M.groupIsOpen("awaiting-a-date", false), true);
  assert.doesNotThrow(() => {
    M.raw()["upcoming"] = true;
    M.saveGroupCollapsed();
  }, "writing must not throw either");
  assert.equal(M.lsGet("anything"), null, "a blocked read reads as absent");
});

test("malformed stored JSON falls back to expanded rather than throwing", () => {
  const M = groupCollapse(fakeStore({ "wt-group-collapsed": "{not json" }));
  assert.deepEqual(M.raw(), {});
  assert.equal(M.groupIsOpen("upcoming", false), true);
});

test("the heading is a button, with a chevron and aria-expanded", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const block = src.slice(src.indexOf('data-act="togglegroup"') - 400,
                          src.indexOf('data-act="togglegroup"') + 700);
  assert.match(block, /<button class="group-header/, "a real button, not a div");
  assert.match(block, /aria-expanded="/);
  assert.match(block, /class="chev"/, "chevron on the left");
  assert.match(block, /class="done-count"/, "and the count chip stays");
  // Rows are only emitted when open.
  assert.match(block, /\(open\?g\.rows\.map\(renderCard\)\.join\(""\):""\)/);
  // Same mechanism for all three: no group is special-cased.
  assert.equal(/Awaiting a date"\s*\?/.test(src), false, "no special casing by label");
});

test("the chevron rotates on open and the button takes an Ember focus ring", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(src, /\.group-header\.open \.chev\{transform:rotate\(90deg\)\}/);
  assert.match(src, /\.group-header:focus-visible[^{]*\{outline:2px solid var\(--ember\)/);
});

test("sheet re-link shows replacements while preserving the saved link", () => {
  const M = sheetPanel();
  const c = linkedCard();
  M.sheetSuggests.c1 = "loading";
  assert.ok(M.renderSheetPanel(c).includes("Looking for"));
  M.sheetSuggests.c1 = [{ rowKey: "andrew|new", sheetName: "Andrew New", rowNumber: 120, context: [] }];
  const out = M.renderSheetPanel(c);
  assert.ok(out.includes("Andrew New"));
  assert.ok(out.includes('data-act="sheetpick"'));
  assert.ok(out.includes("Cancel re-link"));
  assert.equal(c.values.sheetRowKey, "andrew|mi");
  delete M.sheetSuggests.c1;
  assert.ok(M.renderSheetPanel(c).includes("Andrew Mi"));
});

test("sheet re-link with no match remains cancellable", () => {
  const M = sheetPanel();
  M.sheetSuggests.c1 = [];
  const out = M.renderSheetPanel(linkedCard());
  assert.ok(out.includes("No sheet row matches"));
  assert.ok(out.includes("Cancel re-link"));
  assert.ok(!out.includes('data-act="sheetpick"'));
});

test("broken sheet link is visible on candidate, and old-key warning clears after replacement", () => {
  const M = sheetPanel();
  M.setBots({bots:[{name:"sheet-sync",runs:[{summary:{unresolved:[{
    candidateId:"c1",key:"andrew|mi",reason:"no sheet row carries this key any more"
  }]}}]}]});
  const out = M.renderSheetPanel(linkedCard());
  assert.ok(out.includes("Sheet link needs attention"));
  assert.ok(out.includes("no sheet row carries this key any more"));
  assert.ok(!M.renderSheetPanel(linkedCard({sheetRowKey:"andrew|new"})).includes("Sheet link needs attention"));
});
