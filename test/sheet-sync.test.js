"use strict";
/**
 * Acceptance tests for bot 10 (sheet sync).
 *
 * One test per rule the bot ships under. These are the guardrails, not examples:
 * each asserts that the bot does NOT do something, because every one of them is
 * a way a blank-filling bot could quietly corrupt the tracker.
 *
 *   node --test test/
 */
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

const CONFIG = require("../bots/sheet-sync.config");
const bot = require("../bots/sheet-sync");
const EFFECTIVE = require("../lib/effective");

/* ---------------------------------------------------------------- fixtures */

const COL = new Map(CONFIG.COLUMNS.map((c) => [c.col, c.i]));
const WIDTH = CONFIG.COLUMNS.length;

/** The full header row, as the live sheet now carries it. */
function fullHeader(over) {
  const r = new Array(WIDTH).fill("");
  CONFIG.COLUMNS.forEach((c) => { r[c.i] = c.header; });
  Object.keys(over || {}).forEach((letter) => { r[COL.get(letter)] = over[letter]; });
  return r;
}

/** A sheet row: mkRow("Andrew", "Mi", { J: "done", L: "yes" }). */
function mkRow(first, last, cells) {
  const r = new Array(WIDTH).fill("");
  r[COL.get("A")] = first;
  r[COL.get("B")] = last;
  Object.keys(cells || {}).forEach((letter) => {
    r[COL.get(letter)] = cells[letter];
  });
  return r;
}

/** Every syncable column filled with something the config will accept. */
const FULL_CELLS = {
  J: "done", L: "yes", M: "Sadiqeh", O: "yes", P: "yes", Q: "shared",
  S: "yes", T: "yes", U: "yes", V: "yes", W: "yes", X: "yes", Y: "yes",
};

function trackerRow(id, name, over) {
  return Object.assign(
    {
      id,
      name,
      values: {
        sheetRowKey: null,
        sheetLinkedBy: "coordinator@carrara.is",
        sheetLinkedAt: "2026-09-08T00:00:00.000Z",
      },
      fieldNotes: {},
      createdAt: 1,
      updatedAt: 1,
      updatedBy: "someone",
    },
    over || {}
  );
}

/** A linked tracker row with every syncable field empty. */
function linkedRow(id, name, key) {
  const r = trackerRow(id, name);
  r.values.sheetRowKey = key;
  return r;
}

function fakeSheets(rows, opts) {
  const o = opts || {};
  return {
    isConfigured: () => o.configured !== false,
    configError: () => o.configError || null,
    readRange: async () =>
      o.readFail ? { ok: false, reason: o.readFail } : { ok: true, rows, cachedAt: Date.now() },
    /**
     * Everything visible unless a test says otherwise.
     *   hiddenRows       — 1-based sheet rows hidden by a person
     *   filterHiddenRows — 1-based sheet rows hidden by a filter view
     *   visibilityFail   — the read fails with this reason
     *   visibilityShort  — return metadata for this many fewer rows than exist
     */
    readVisibility: async () => {
      if (o.visibilityFail) return { ok: false, reason: o.visibilityFail };
      const hidden = o.hiddenRows || [];
      const filtered = o.filterHiddenRows || [];
      const n = Math.max(0, (rows || []).length - (o.visibilityShort || 0));
      const out = [];
      for (let i = 1; i <= n; i++) {
        out.push({ hiddenByUser: hidden.includes(i), hiddenByFilter: filtered.includes(i) });
      }
      return { ok: true, startRow: 0, rows: out };
    },
  };
}

/** A store that records every write and refuses anything but a put. */
function fakeStore(rows) {
  const puts = [];
  return {
    rows,
    puts,
    getCandidates: async () => rows,
    putCandidate: async (c) => {
      puts.push(JSON.parse(JSON.stringify(c)));
    },
  };
}

const run = (rows, store, extra, sheetOpts) =>
  bot.run(Object.assign({
    sheets: fakeSheets(rows, sheetOpts),
    getCandidates: store.getCandidates,
    putCandidate: store.putCandidate,
    dryRun: false,
    runId: 42,
    log: () => {},
    now: new Date("2026-09-08T12:00:00Z"),
  }, extra || {}));

/* ============================================================ acceptance 1 */

test("never writes to a non-empty field, under any condition", async () => {
  const key = "andrew|mi";
  const row = linkedRow("c1", "Andrew Mi", key);
  // Every syncable field already answered — including one holding a placeholder,
  // which is blank on the SHEET side but an answer on the tracker side.
  CONFIG.SYNCABLE.forEach((spec, i) => {
    row.values[spec.field] = i === 0 ? "TBD" : "ALREADY SET";
  });
  const store = fakeStore([row]);
  const res = await run([mkRow("Andrew", "Mi", FULL_CELLS)], store);

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.writesPlanned, 0, "nothing should be planned");
  assert.equal(store.puts.length, 0, "no row should be written at all");
  assert.equal(row.values[CONFIG.SYNCABLE[0].field], "TBD", "placeholder must survive");
});

test("fills a field that is genuinely empty, so the test above is not vacuous", async () => {
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run([mkRow("Andrew", "Mi", { J: "done", M: "Sadiqeh" })], store);

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.wrote, 2);
  assert.equal(row.values.status, "DONE");
  assert.equal(row.values.driName, "Sadiqeh");
});

/* ============================================================ acceptance 2 */

test("never writes a field whose column mode is ashby", async () => {
  // Structural: an ashby column carries no field key, so it cannot be planned.
  const ashbyCols = CONFIG.COLUMNS.filter((c) => c.mode === "ashby");
  assert.ok(ashbyCols.length > 0, "fixture sanity: there are ashby columns");
  ashbyCols.forEach((c) => {
    assert.equal(c.field, undefined, "ashby column " + c.col + " must have no field key");
  });
  // And no syncable field is one the live panel answers.
  CONFIG.SYNCABLE.forEach((c) => {
    assert.ok(!EFFECTIVE.PANEL_COVERS[c.field], c.field + " is panel-owned and must not sync");
  });

  // Behavioural: even if the config were edited to map a panel-owned field,
  // the plan-time guard drops it.
  // plan() works from the resolved columns, so the smuggled mapping has to go
  // into COLUMNS — pushing it onto SYNCABLE alone no longer reaches the planner,
  // which is how this test quietly stopped testing anything after the refactor.
  const smuggled = { i: COL.get("H"), col: "H-smuggled", header: "Start Date (smuggled)",
                     mode: "sync", field: "startDate" };
  CONFIG.COLUMNS.push(smuggled);
  try {
    const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
    const store = fakeStore([row]);
    const res = await run([mkRow("Andrew", "Mi", { H: "2026-09-14" })], store);
    assert.equal(res.summary.wrote, 0, "a panel-owned field must never be filled");
    assert.equal(row.values.startDate, undefined);
    assert.ok(
      (res.summary.skippedFields || 0) > 0,
      "the skip should be recorded, not silent"
    );
  } finally {
    CONFIG.COLUMNS.splice(CONFIG.COLUMNS.indexOf(smuggled), 1);
  }
});

/* ============================================================ acceptance 3 */

test("never creates or deletes a tracker row", async () => {
  const rows = [linkedRow("c1", "Andrew Mi", "andrew|mi")];
  const before = rows.map((r) => r.id).sort();
  const store = fakeStore(rows);

  // A sheet row for somebody with no tracker row at all: must not be created.
  const res = await run(
    [mkRow("Andrew", "Mi", { J: "done" }), mkRow("Jannik", "Wiedenhaupt", FULL_CELLS)],
    store
  );

  assert.equal(res.outcome, "ok");
  assert.deepEqual(rows.map((r) => r.id).sort(), before, "row set must be unchanged");
  store.puts.forEach((p) => assert.ok(before.includes(p.id), "wrote an id that did not exist: " + p.id));
  assert.equal(store.puts.length, 1, "only the linked row is touched");
});

test("is not handed any way to delete a row", () => {
  // The guarantee is the shape of the call, as with the read-only Ashby client:
  // lib/bots.js passes putCandidate and nothing else that mutates the tracker.
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "bots.js"), "utf8");
  const injected = src.slice(src.indexOf("const result = await bot.run({"), src.indexOf("await botStore.finishRun(runId, result)"));
  assert.ok(injected.includes("putCandidate"), "putCandidate should be injected");
  assert.ok(!/delCandidate|deleteCandidate|removeCandidate/.test(injected),
    "no delete capability may be injected into a bot");
});

/* ============================================================ acceptance 4 */

const NAMES = [["Andrew","Mi"],["Jannik","Wiedenhaupt"],["Aakash","Japi"],
               ["Dana","Reed"],["Sam","Okoye"],["Priya","Raman"],["Tom","Vale"]];
const nameKey = (n) => n[0].toLowerCase() + "|" + n[1].toLowerCase();

test("aborts without writing if more than five candidates would have values CHANGED", async () => {
  // Six rows sync already owns, all moving to a new value. This is the shape a
  // restructured sheet has: many candidates whose existing values change at once.
  const many = NAMES.slice(0, 6);
  const sheet = [fullHeader()].concat(many.map((n) => mkRow(n[0], n[1], { G: "Desk 12" })));
  const rows = many.map((n, i) => syncOwned("c" + i, n.join(" "), nameKey(n), "desk", "Desk 9"));
  const store = fakeStore(rows);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.outcome, "aborted");
  assert.equal(res.summary.reason, "over_candidate_cap");
  assert.equal(res.summary.candidatesChanging, 6);
  assert.ok(res.summary.candidatesChanging > CONFIG.MAX_CANDIDATES_PER_RUN);
  assert.equal(res.summary.wrote, 0);
  assert.equal(store.puts.length, 0, "not one row may be written, not even the first five");
  rows.forEach((r) => assert.equal(r.values.desk, "Desk 9", "every row must be untouched"));
});

test("first fills on newly linked rows do not trip the cap, however many", async () => {
  // The 9 Sep case: somebody linked twenty candidates, seven of them needed
  // filling, and the cap stopped a legitimate run. A first fill onto a row sync
  // has no history on is ordinary work, not a blast radius.
  const many = NAMES.slice(0, 7);
  const sheet = [fullHeader()].concat(many.map((n) => mkRow(n[0], n[1], { J: "done", G: "Desk 12" })));
  const rows = many.map((n, i) => linkedRow("c" + i, n.join(" "), nameKey(n)));
  const store = fakeStore(rows);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.candidatesPlanned, 7, "seven candidates are written");
  assert.equal(res.summary.candidatesChanging, 0, "but none of them is a change");
  assert.equal(res.summary.candidatesFirstFill, 7);
  assert.equal(res.summary.wrote, 14);
  assert.equal(store.puts.length, 7);
});

test("a first fill on a field sync has never written is NOT a change, even on a row it has", async () => {
  // Sync wrote desk once; now it is filling status, which it has never written.
  // Row-level counting called that a change and produced a false positive on
  // three rows in the 9 Sep run. Per field, it is a first fill.
  const many = NAMES.slice(0, 6);
  const sheet = [fullHeader()].concat(many.map((n) => mkRow(n[0], n[1], { G: "Desk 9", J: "done" })));
  const rows = many.map((n, i) => syncOwned("c" + i, n.join(" "), nameKey(n), "desk", "Desk 9"));
  const store = fakeStore(rows);
  const res = await run(sheet, store, {}, {});

  // desk is a no-op (already Desk 9); status is a first fill on that field.
  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.candidatesChanging, 0);
  assert.equal(res.summary.candidatesFirstFill, 6);
  assert.equal(res.summary.wrote, 6, "six statuses filled");
  rows.forEach((r) => assert.equal(r.values.status, "DONE"));
});

test("a write to a field sync HAS written is a change, even if the field is now empty", async () => {
  // Somebody cleared a value sync wrote. Refilling it is not a first fill: sync
  // has a record on that field, so the cap counts it.
  const many = NAMES.slice(0, 6);
  const sheet = [fullHeader()].concat(many.map((n) => mkRow(n[0], n[1], { G: "Desk 12" })));
  const rows = many.map((n, i) => {
    const r = syncOwned("c" + i, n.join(" "), nameKey(n), "desk", "Desk 9");
    r.values.desk = "";   // cleared by hand
    return r;
  });
  const store = fakeStore(rows);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.outcome, "aborted");
  assert.equal(res.summary.reason, "over_candidate_cap");
  assert.equal(res.summary.candidatesChanging, 6);
  assert.equal(store.puts.length, 0);
});

test("the rule is exactly hadSource, per field", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { G: "Desk 12", J: "done" })];
  const row = syncOwned("c1", "Andrew Mi", "andrew|mi", "desk", "Desk 9");
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  const byField = {};
  res.summary.writeBreakdown.forEach((w) => { byField[w.field] = w; });
  assert.equal(byField.desk.hadSource, true, "sync wrote desk before");
  assert.equal(byField.desk.changing, true);
  assert.equal(byField.desk.fillReason, "resynced");
  assert.equal(byField.status.hadSource, false, "sync has never written status");
  assert.equal(byField.status.changing, false);
  assert.equal(res.summary.candidatesChanging, 1, "one changing field is enough to count the candidate");
});

test("the run row shows its own working, per write", async () => {
  // Twice on 9 Sep a question the plan already knew took rounds of arithmetic
  // over aggregates to answer. It is recorded now, not inferred.
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { J: "done", M: "Sadiqeh", G: "Desk 12" })];
  const row = syncOwned("c1", "Andrew Mi", "andrew|mi", "desk", "Desk 9");
  row.values.status = "NOT STARTED";   // the creation-seeded default
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, { });

  const b = res.summary.writeBreakdown;
  assert.equal(b.length, res.summary.writesPlanned, "one entry per planned write");
  b.forEach((w) => {
    assert.equal(w.candidate, "Andrew Mi");
    assert.ok(w.field && w.cell, "field and cell so it can be found in the sheet");
    assert.ok(["filled_unset", "filled_default", "resynced"].includes(w.fillReason), w.fillReason);
    assert.equal(typeof w.hadSource, "boolean");
    assert.equal(w.changing, w.hadSource, "changing is exactly hadSource");
  });
  // The three kinds, all visible on one row.
  const byField = {};
  b.forEach((w) => { byField[w.field] = w; });
  assert.equal(byField.status.fillReason, "filled_default", "seeded default, but a first fill");
  assert.equal(byField.status.hadSource, false);
  assert.equal(byField.driName.fillReason, "filled_unset");
  assert.equal(byField.desk.fillReason, "resynced");
  assert.equal(byField.desk.hadSource, true);
  // And the plan says it in words too.
  assert.ok(JSON.stringify(res.message).includes("sync wrote this field before"));
});

test("the breakdown is present on an abort, which is when it is needed", async () => {
  const many = NAMES.slice(0, 6);
  const sheet = [fullHeader()].concat(many.map((n) => mkRow(n[0], n[1], { G: "Desk 12" })));
  const rows = many.map((n, i) => syncOwned("c" + i, n.join(" "), nameKey(n), "desk", "Desk 9"));
  const store = fakeStore(rows);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.reason, "over_candidate_cap");
  assert.equal(res.summary.writeBreakdown.length, 6);
  assert.ok(res.summary.writeBreakdown.every((w) => w.changing), "and says which writes counted");
});

test("a bulk first fill is deliberately not capped at any volume", async () => {
  // Accepted knowingly: with no sheetSource anywhere, nothing counts, so
  // MAX_WRITES_PER_RUN is the only limit on this path.
  const nine = [];
  for (let n = 0; n < 9; n++) nine.push(["Cand" + n, "Sur" + n]);
  const sheet = [fullHeader()].concat(nine.map((n) => mkRow(n[0], n[1], FULL_CELLS)));
  const rows = nine.map((n, i) => linkedRow("c" + i, n.join(" "), n[0].toLowerCase() + "|" + n[1].toLowerCase()));
  const store = fakeStore(rows);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.candidatesChanging, 0);
  assert.equal(res.summary.candidatesPlanned, 9);
  assert.ok(res.summary.writesPlanned > CONFIG.MAX_CANDIDATES_PER_RUN * 2,
    "well past the candidate cap, and allowed: " + res.summary.writesPlanned);
  assert.ok(res.summary.writesPlanned < CONFIG.MAX_WRITES_PER_RUN,
    "the write backstop is what would stop this");
});

test("the two candidate counts are reported side by side", async () => {
  const sheet = [
    fullHeader(),
    mkRow("Andrew", "Mi", { G: "Desk 12" }),          // resync -> changing
    mkRow("Jannik", "Wiedenhaupt", { J: "done" }),    // first fill -> not changing
  ];
  const changing = syncOwned("c1", "Andrew Mi", "andrew|mi", "desk", "Desk 9");
  const fresh = linkedRow("c2", "Jannik Wiedenhaupt", "jannik|wiedenhaupt");
  const store = fakeStore([changing, fresh]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.candidatesPlanned, 2);
  assert.equal(res.summary.candidatesChanging, 1);
  assert.equal(res.summary.candidatesFirstFill, 1);
  assert.equal(res.summary.candidatesChanging + res.summary.candidatesFirstFill,
    res.summary.candidatesPlanned, "the two must account for every candidate written");
});

test("exactly five candidates is allowed — the cap is 'more than five'", async () => {
  const five = NAMES.slice(0, 5);
  const sheet = [fullHeader()].concat(five.map((n) => mkRow(n[0], n[1], { J: "done" })));
  const rows = five.map((n, i) => linkedRow("c" + i, n.join(" "), nameKey(n)));
  const store = fakeStore(rows);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.candidatesPlanned, 5);
  assert.equal(res.summary.wrote, 5);
  assert.equal(store.puts.length, 5);
});

test("one candidate may fill every syncable field — that is the case a write cap punished", async () => {
  // 15 fields in one go, which the old cap of 12 aborted on. This is the
  // ordinary shape of a freshly linked candidate.
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", FULL_CELLS)];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.candidatesPlanned, 1);
  assert.ok(res.summary.wrote >= 13, "expected a full row of fills, got " + res.summary.wrote);
  assert.equal(store.puts.length, 1, "one PUT for the candidate, however many fields");
});

test("the write backstop fires when the candidate count cannot see the problem", async () => {
  // Unreachable in normal operation — 5 candidates x 15 fields is 75, well under
  // 200 — so it is provoked by growing the column map, which is the shape of the
  // bug it exists for.
  const startAt = CONFIG.COLUMNS.length;
  const extra = [];
  for (let n = 0; n < 210; n++) {
    extra.push({ i: startAt + n, col: "FILL" + n, header: "Filler " + n, mode: "sync", field: "filler" + n });
  }
  CONFIG.COLUMNS.push(...extra);
  try {
    const width = CONFIG.COLUMNS.length;
    const header = new Array(width).fill("");
    CONFIG.COLUMNS.forEach((c) => { header[c.i] = c.header; });
    const data = new Array(width).fill("");
    data[COL.get("A")] = "Andrew";
    data[COL.get("B")] = "Mi";
    extra.forEach((c) => { data[c.i] = "something"; });

    const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
    const store = fakeStore([row]);
    const res = await run([header, data], store, {}, {});

    assert.equal(res.outcome, "aborted");
    assert.equal(res.summary.reason, "over_write_cap");
    assert.equal(res.summary.candidatesPlanned, 1, "one candidate, so the primary guard is silent");
    assert.ok(res.summary.writesPlanned > CONFIG.MAX_WRITES_PER_RUN);
    assert.equal(store.puts.length, 0);
  } finally {
    extra.forEach((c) => CONFIG.COLUMNS.splice(CONFIG.COLUMNS.indexOf(c), 1));
  }
});

test("the two caps are ordered so the candidate count is the primary guard", () => {
  assert.equal(CONFIG.MAX_CANDIDATES_PER_RUN, 5);
  assert.equal(CONFIG.MAX_WRITES_PER_RUN, 200);
  // A legitimate run cannot reach the backstop, which is what makes it a backstop.
  assert.ok(CONFIG.MAX_CANDIDATES_PER_RUN * CONFIG.SYNCABLE.length < CONFIG.MAX_WRITES_PER_RUN,
    "the write cap must sit above anything the candidate cap permits");
});

/* ============================================================ acceptance 5 */

test("aborts without writing if any entry in ASSERTIONS fails", async () => {
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  // A DATE in the Status column means J is no longer holding statuses at all,
  // which is a shape failure and does abort. An unknown WORD does not — that is
  // counted instead, see the unrecognised-value tests.
  const res = await run(
    [mkRow("Andrew", "Mi", { J: "2026-09-14", M: "Sadiqeh" })],
    store
  );

  assert.equal(res.outcome, "aborted");
  assert.equal(res.summary.reason, "assertion_failed");
  assert.equal(res.summary.wrote, 0);
  assert.equal(store.puts.length, 0);
  assert.equal(row.values.driName, undefined, "a valid cell elsewhere must not be written either");
  const failed = res.summary.assertions.filter((a) => !a.passed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].col, "J");
});

test("a thrown assertion counts as a failure, not a pass", () => {
  const thrower = { col: "A", describe: "explodes", test: () => { throw new Error("boom"); } };
  CONFIG.ASSERTIONS.push(thrower);
  try {
    const index = bot._internal.indexSheet([mkRow("Andrew", "Mi", {})]);
    const results = bot._internal.runAssertions(index);
    const mine = results.filter((r) => r.describe === "explodes")[0];
    assert.equal(mine.passed, false);
    assert.match(mine.error, /boom/);
  } finally {
    CONFIG.ASSERTIONS.splice(CONFIG.ASSERTIONS.indexOf(thrower), 1);
  }
});

/* ============================================================ acceptance 6 */

test("every write sets updatedBy = sheet-sync and records the source cell", async () => {
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  // Andrew is sheet row 1 here (no header row in the fixture), so Status is J1.
  const res = await run([mkRow("Andrew", "Mi", { J: "done", L: "yes" })], store);

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.wrote, 2);
  assert.equal(row.updatedBy, "sheet-sync");
  assert.equal(store.puts[0].updatedBy, "sheet-sync", "the persisted row carries it too");

  assert.equal(row.sheetSource.status.cell, "J1");
  assert.equal(row.sheetSource.status.tab, CONFIG.SHEET_TAB);
  assert.equal(row.sheetSource.status.raw, "done");
  assert.equal(row.sheetSource.status.runId, 42);
  assert.equal(row.sheetSource.status.by, "sheet-sync");
  assert.equal(row.sheetSource.calendarHold.cell, "L1");
  assert.ok(row.sheetSource.status.at, "provenance records when");

  // Every field written has provenance — no silent fills.
  Object.keys(row.sheetSource).forEach((k) => {
    assert.ok(row.sheetSource[k].cell, k + " must record a cell");
  });
});

test("the cell reference points at the sheet row a person can see, past a header", async () => {
  const header = fullHeader();
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run([header, mkRow("Andrew", "Mi", { J: "done" })], store);

  assert.equal(res.summary.hasHeader, true);
  assert.equal(row.sheetSource.status.cell, "J2", "Andrew is on sheet row 2 when row 1 is the header");
});

/* ============================================================ acceptance 7 */

test("ships enabled but dry-run", () => {
  assert.deepEqual(bot.defaults, { enabled: true, dryRun: true });
});

test("a dry run writes nothing but the plan", async () => {
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run([mkRow("Andrew", "Mi", { J: "done", M: "Sadiqeh" })], store, { dryRun: true });

  assert.equal(res.outcome, "dry_run");
  assert.equal(res.summary.writesPlanned, 2, "the plan is still computed");
  assert.equal(res.summary.wrote, 0);
  assert.equal(store.puts.length, 0, "a dry run must not touch the tracker");
  assert.equal(row.values.status, undefined);
  assert.equal(row.updatedBy, "someone", "not even updatedBy may move");
  // And the plan is legible in the Bots panel, which is the point of dry-run.
  assert.ok(res.message && res.message.blocks.length, "the plan is recorded as readable blocks");
  assert.ok(JSON.stringify(res.message).includes("DONE"));
});

test("a dry run records a dry_run row in run_log and nothing else", async () => {
  // Integration, through lib/bots.js: lib/sheets is stubbed in the require cache
  // so nothing reaches Google, and the file-backed botstore gets a temp dir.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-sheet-sync-"));
  const sheetsPath = require.resolve("../lib/sheets");
  const saved = require.cache[sheetsPath];
  require.cache[sheetsPath] = {
    id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets([mkRow("Andrew", "Mi", { J: "done" })]),
  };
  const savedEnv = { k: process.env.GOOGLE_SA_KEY_B64, s: process.env.POETIC_SHEET_ID };
  process.env.GOOGLE_SA_KEY_B64 = "stub";
  process.env.POETIC_SHEET_ID = "stub";
  delete require.cache[require.resolve("../lib/bots")];

  try {
    const rows = [linkedRow("c1", "Andrew Mi", "andrew|mi")];
    const puts = [];
    const bots = require("../lib/bots")({
      dir,
      getCandidates: async () => rows,
      putCandidate: async (c) => puts.push(c.id),
    });

    await bots.runNow("sheet-sync", "tester");
    // runNow is fire-and-forget; wait for the row to land.
    let last = null;
    for (let i = 0; i < 60 && !(last && last.outcome); i++) {
      await new Promise((r) => setTimeout(r, 25));
      const status = await bots.status();
      last = (status.filter((b) => b.name === "sheet-sync")[0].runs || [])[0] || null;
    }

    assert.ok(last, "a run_log row must exist");
    assert.equal(last.outcome, "dry_run");
    assert.equal(last.summary.wrote, 0);
    assert.equal(last.summary.writesPlanned, 1);
    assert.deepEqual(puts, [], "the tracker must not be written");
    assert.equal(rows[0].values.status, undefined);
  } finally {
    if (saved) require.cache[sheetsPath] = saved; else delete require.cache[sheetsPath];
    delete require.cache[require.resolve("../lib/bots")];
    if (savedEnv.k === undefined) delete process.env.GOOGLE_SA_KEY_B64; else process.env.GOOGLE_SA_KEY_B64 = savedEnv.k;
    if (savedEnv.s === undefined) delete process.env.POETIC_SHEET_ID; else process.env.POETIC_SHEET_ID = savedEnv.s;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ======================================================= matching: no guessing */

test("never matches by name at write time", async () => {
  // An unlinked row whose name is an exact match for a sheet row. The suggestion
  // strip would offer it; the bot must not act on it.
  const row = trackerRow("c1", "Andrew Mi");
  delete row.values.sheetRowKey;
  const store = fakeStore([row]);
  const res = await run([mkRow("Andrew", "Mi", FULL_CELLS)], store);

  assert.equal(res.summary.linkedRows, 0);
  assert.equal(res.summary.wrote, 0);
  assert.equal(store.puts.length, 0);
});

test("a key without provenance is not a confirmed link", async () => {
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  delete row.values.sheetLinkedBy; // never clicked by a person
  const store = fakeStore([row]);
  const res = await run([mkRow("Andrew", "Mi", FULL_CELLS)], store);

  assert.equal(res.summary.wrote, 0);
  assert.equal(store.puts.length, 0);
  assert.equal(res.summary.unresolved.length, 1);
  assert.match(res.summary.unresolved[0].reason, /not a confirmed link/);
});

test("multiple matches are distinguishable, and never guessed between", async () => {
  const rows = [mkRow("Andrew", "Mi", { J: "done" }), mkRow("Andrew", "Mi", { J: "in progress" })];

  // Suggestions: two rows, told apart by row number, each with its own pinned key.
  const sug = bot.suggest({ rows, name: "Andrew Mi" });
  assert.equal(sug.length, 2);
  assert.notEqual(sug[0].rowKey, sug[1].rowKey, "duplicate names must get distinct keys");
  assert.deepEqual(sug.map((s) => s.rowNumber), [1, 2]);
  assert.ok(sug.every((s) => s.pinned), "both should be pinned to a row");

  // The ambiguous base key resolves to nothing rather than picking one.
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run(rows, store);
  assert.equal(res.summary.wrote, 0);
  assert.equal(store.puts.length, 0);
  assert.match(res.summary.unresolved[0].reason, /share this name/);

  // A pinned key picks exactly one.
  const pinned = linkedRow("c2", "Andrew Mi", sug[1].rowKey);
  const store2 = fakeStore([pinned]);
  const res2 = await run(rows, store2);
  assert.equal(res2.summary.wrote, 1);
  assert.equal(pinned.values.status, "IN PROGRESS", "the pinned row's own value, not the other's");
});

test("a pinned key whose row has moved writes nothing", async () => {
  const rows = [mkRow("Andrew", "Mi", { J: "done" }), mkRow("Andrew", "Mi", { J: "in progress" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi@r9"); // row 9 does not exist
  const store = fakeStore([row]);
  const res = await run(rows, store);

  assert.equal(res.summary.wrote, 0);
  assert.equal(store.puts.length, 0);
  assert.match(res.summary.unresolved[0].reason, /no longer holds this name|carries this key/);
});

test("suggestions leave out sheet rows already linked to another candidate", () => {
  const rows = [mkRow("Andrew", "Mi", {}), mkRow("Andrew", "Mi", {})];
  const all = bot.suggest({ rows, name: "Andrew Mi" });
  const fewer = bot.suggest({ rows, name: "Andrew Mi", linkedKeys: [all[0].rowKey] });
  assert.equal(fewer.length, 1);
  assert.equal(fewer[0].rowKey, all[1].rowKey);
});

test("a shared first name alone is not a match", () => {
  const rows = [mkRow("Andrew", "Smith", {})];
  assert.equal(bot.suggest({ rows, name: "Andrew Jones" }).length, 0);
  assert.equal(bot.suggest({ rows, name: "Andrew Smith" })[0].relation, "exact");
  assert.equal(bot.suggest({ rows, name: "Andy Smith" })[0].relation, "possible");
});

/* ============================================================ read failures */

test("a failed sheet read is an error, never an empty sheet", async () => {
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await bot.run({
    sheets: fakeSheets([], { readFail: "sheets api returned 503" }),
    getCandidates: store.getCandidates,
    putCandidate: store.putCandidate,
    dryRun: false, runId: 1, log: () => {},
  });
  assert.equal(res.outcome, "error");
  assert.match(res.error, /503/);
  assert.equal(store.puts.length, 0);
});

test("an unconfigured sheet is a skip with a reason, not a crash", async () => {
  const store = fakeStore([]);
  const res = await bot.run({
    sheets: fakeSheets([], { configured: false, configError: "POETIC_SHEET_ID is not set" }),
    getCandidates: store.getCandidates,
    putCandidate: store.putCandidate,
    dryRun: false, runId: 1, log: () => {},
  });
  assert.equal(res.outcome, "skipped_unconfigured");
  assert.match(res.error, /POETIC_SHEET_ID/);
});

/* ================================================= columns E and G (8 Sep) */

test("fills computer and desk from columns E and G", async () => {
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run([mkRow("Andrew", "Mi", { E: "SF-Poetic 4", G: "Desk 12" })], store);

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.wrote, 2);
  assert.equal(row.values.computer, "SF-Poetic 4");
  assert.equal(row.values.desk, "Desk 12");
  assert.equal(row.sheetSource.computer.cell, "E1");
  assert.equal(row.sheetSource.desk.cell, "G1");
});

test("a placeholder in Computer is left as nothing to write", async () => {
  // "TBD" in Computer means no laptop assigned yet. Writing it would block the
  // real machine name for good, since non-empty is never overwritten.
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run([mkRow("Andrew", "Mi", { E: "TBD", G: "" })], store);

  assert.equal(res.summary.wrote, 0);
  assert.equal(row.values.computer, undefined);
});

test("the column-E assertion catches Laptop Cleared sliding left", async () => {
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  // F ("Laptop Cleared?") has shifted into E: free text would accept "yes"
  // silently, so the shape assertion is the only thing that can catch it.
  const res = await run(
    [mkRow("Andrew", "Mi", { E: "SF-Poetic 4" }), mkRow("Jannik", "Wiedenhaupt", { E: "yes" })],
    store
  );

  assert.equal(res.outcome, "aborted");
  assert.equal(res.summary.reason, "assertion_failed");
  assert.equal(store.puts.length, 0);
  assert.deepEqual(res.summary.assertions.filter((a) => !a.passed).map((a) => a.col), ["E"]);
  assert.equal(row.values.computer, undefined, "the valid row must not be written either");
});

test("the column-G assertion catches Start Date sliding left", async () => {
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run([mkRow("Andrew", "Mi", { G: "2026-09-14" })], store);

  assert.equal(res.outcome, "aborted");
  assert.deepEqual(res.summary.assertions.filter((a) => !a.passed).map((a) => a.col), ["G"]);
  assert.equal(store.puts.length, 0);
});

test("D syncs with its own shape assertion, and F and Z stay skipped", () => {
  // D was skipped as "every trial is SF". The real inventory has NY laptops,
  // NY desks and Hyde House, so it carries a location now and gets the same
  // kind of shape guard E and G have.
  assert.equal(CONFIG.ASSERTIONS.filter((a) => a.col === "D").length, 1);
  assert.deepEqual(CONFIG.ASSERTIONS.map((a) => a.col).sort(), ["A", "D", "E", "G", "J"]);
  assert.deepEqual(
    CONFIG.COLUMNS.filter((c) => c.mode === "skip").map((c) => c.col),
    ["F", "Z"]
  );
  CONFIG.COLUMNS.filter((c) => c.mode === "skip").forEach((c) => {
    assert.ok(c.reason && c.reason.length > 10, c.col + " must say why it is skipped");
    assert.equal(c.field, undefined, c.col + " is skipped and must carry no field key");
  });
});

/* ============================================ header resolution (8 Sep) */

test("binds columns by header text when a header row is present", async () => {
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run([fullHeader(), mkRow("Andrew", "Mi", { J: "done" })], store);

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.columnsBoundBy, "header");
  assert.deepEqual(res.summary.movedColumns, [], "nothing has moved in this fixture");
  assert.equal(row.values.status, "DONE");
});

test("falls back to fixed indices only when there is no header row", async () => {
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run([mkRow("Andrew", "Mi", { J: "done" })], store);

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.columnsBoundBy, "index");
  assert.equal(res.summary.hasHeader, false);
  assert.equal(row.values.status, "DONE", "the old positional behaviour still works");
});

test("a column inserted at the front is followed, not read by position", async () => {
  // Somebody adds a column at A. Every mapped column shifts one to the right.
  const shift = (r) => ["inserted"].concat(r);
  const header = shift(fullHeader());
  const data = shift(mkRow("Andrew", "Mi", { J: "done", M: "Sadiqeh", E: "SF-Poetic 4" }));

  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run([header, data], store);

  assert.equal(res.outcome, "ok", "a shifted sheet must still be readable");
  assert.equal(res.summary.columnsBoundBy, "header");
  assert.equal(res.summary.wrote, 3);
  assert.equal(row.values.status, "DONE", "read from the header, not from index 9");
  assert.equal(row.values.driName, "Sadiqeh");
  assert.equal(row.values.computer, "SF-Poetic 4");

  // Identity still comes from the name columns wherever they landed.
  assert.equal(res.summary.linkedRows, 1);

  // And the cell reference cites where the value ACTUALLY is, so it can be found.
  assert.equal(row.sheetSource.status.cell, "K2", "Status moved J -> K");
  assert.equal(row.sheetSource.computer.cell, "F2", "Computer moved E -> F");
  assert.ok(res.summary.movedColumns.length > 0, "the move should be reported");
  const statusMove = res.summary.movedColumns.filter((m) => m.header === "Status")[0];
  assert.deepEqual(statusMove, { header: "Status", from: "J", to: "K" });
});

test("assertions follow their column when it moves", async () => {
  // Column J is shape-broken, but J is now K. The assertion must still find it.
  const shift = (r) => ["inserted"].concat(r);
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run(
    [shift(fullHeader()), shift(mkRow("Andrew", "Mi", { J: "2026-09-14" }))],
    store
  );

  assert.equal(res.outcome, "aborted");
  assert.equal(res.summary.reason, "assertion_failed");
  assert.deepEqual(res.summary.assertions.filter((a) => !a.passed).map((a) => a.col), ["J"]);
  assert.equal(store.puts.length, 0);
});

test("a missing mapped header aborts loudly instead of falling back to a position", async () => {
  // "Status" is renamed. Its data is still sitting at index 9, and the old code
  // would have read it happily — which is the failure this refuses to have.
  const header = fullHeader({ J: "Overall progress" });
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run([header, mkRow("Andrew", "Mi", { J: "done", M: "Sadiqeh" })], store);

  assert.equal(res.outcome, "aborted");
  assert.equal(res.summary.reason, "header_missing");
  assert.equal(res.summary.wrote, 0);
  assert.equal(store.puts.length, 0);
  assert.deepEqual(res.summary.missingHeaders.map((m) => m.header), ["Status"]);
  assert.match(res.error, /missing mapped column/i);
  assert.match(res.error, /Refusing to fall back/i);
  assert.equal(row.values.status, undefined);
  assert.equal(row.values.driName, undefined, "nothing else is written either");
});

test("a missing context-only header is reported, not fatal", async () => {
  // Column C is mode "ashby": losing it costs a line of context on a suggestion.
  const header = fullHeader({ C: "" });
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run([header, mkRow("Andrew", "Mi", { J: "done" })], store);

  assert.equal(res.outcome, "ok");
  assert.equal(row.values.status, "DONE");
});

test("header matching ignores case, punctuation and spacing but nothing else", () => {
  const r = CONFIG.resolveColumns(fullHeader({ J: "  status  ", L: "CALENDAR-HOLD SENT?" }));
  assert.deepEqual(r.missing, [], "cosmetic differences must still match");
  assert.equal(CONFIG.resolvedFor(r, "J").resolvedBy, "header");

  // A near-miss is NOT a match: Int and Ext Slack differ by one letter, and
  // binding one to the other would swap two fields silently.
  const bad = CONFIG.resolveColumns(fullHeader({ U: "Internal Slack Updated" }));
  assert.deepEqual(bad.missing.map((m) => m.header), ["Int Slack Updated"]);
});

test("a duplicated header is reported and the first occurrence wins", () => {
  const header = fullHeader({ Z: "Status" }); // a second "Status"
  const r = CONFIG.resolveColumns(header);
  assert.equal(r.duplicated.length, 1);
  assert.deepEqual(r.duplicated[0].at, ["J", "Z"]);
  assert.equal(CONFIG.resolvedFor(r, "J").at, COL.get("J"), "the first one is used");
});

test("letterFor spans past Z", () => {
  assert.equal(CONFIG.letterFor(0), "A");
  assert.equal(CONFIG.letterFor(25), "Z");
  assert.equal(CONFIG.letterFor(26), "AA");
  assert.equal(CONFIG.letterFor(27), "AB");
  // The config's own letters must agree with its indices.
  CONFIG.COLUMNS.forEach((c) => assert.equal(CONFIG.letterFor(c.i), c.col));
});

/* ==================================== read width and trailing empties (8 Sep) */

/** "A" -> 0, "AA" -> 26, "BZ" -> 77. */
function indexOfLetter(s) {
  return String(s).toUpperCase().split("").reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
}

test("the read range is wide enough for inserted columns to land inside it", () => {
  assert.equal(CONFIG.RANGE, "'" + CONFIG.SHEET_TAB + "'!A:BZ");
  const lastMapped = CONFIG.COLUMNS[CONFIG.COLUMNS.length - 1];
  const headroom = indexOfLetter("BZ") - lastMapped.i;
  assert.ok(headroom > 0, "the range must extend past the last mapped column");
  // A mapped column pushed outside the read vanishes and the run aborts, so the
  // headroom is how many columns can be inserted before that happens.
  assert.ok(headroom >= 40, "expected room for dozens of insertions, got " + headroom);
});

test("trailing empty columns are ignored, not treated as missing or duplicate", () => {
  const paddings = [
    ["25 empty strings", new Array(25).fill("")],
    ["50 empty strings", new Array(50).fill("")],
    ["undefined / null / whitespace", [undefined, null, "", "   ", "\t"]],
    ["out to BZ width", new Array(indexOfLetter("BZ") - WIDTH + 1).fill("")],
  ];
  for (const [what, pad] of paddings) {
    const r = CONFIG.resolveColumns(fullHeader().concat(pad));
    assert.equal(r.byHeader, true, what + ": should still read as a header row");
    assert.deepEqual(r.missing, [], what + ": nothing may be reported missing");
    assert.deepEqual(r.duplicated, [], what + ": an empty header is not a duplicate");
    assert.deepEqual(r.moved, [], what + ": no mapped column may appear to have moved");
    assert.equal(CONFIG.resolvedFor(r, "Z").atCol, "Z", what + ": last column still binds");
  }
});

test("a whole run against a BZ-wide sheet with an inserted column still works", async () => {
  const pad = new Array(indexOfLetter("BZ") - WIDTH).fill("");
  const shift = (r) => ["inserted"].concat(r).concat(pad);
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run(
    [shift(fullHeader()), shift(mkRow("Andrew", "Mi", { J: "done", E: "SF-Poetic 4" }))],
    store
  );

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.columnsBoundBy, "header");
  assert.equal(res.summary.wrote, 2);
  assert.equal(row.values.status, "DONE");
  assert.equal(row.values.computer, "SF-Poetic 4");
  assert.equal(row.sheetSource.status.cell, "K2", "cited where the value now is");
});

test("a stray copy of a header out in the empty region cannot steal a column", () => {
  // Someone pastes a scratch label far to the right. It is reported as a
  // duplicate, but the leftmost occurrence — the real column — still wins.
  const header = fullHeader().concat(new Array(40).fill(""));
  header[60] = "Notes";
  const r = CONFIG.resolveColumns(header);
  assert.deepEqual(r.missing, []);
  assert.equal(r.duplicated.length, 1);
  assert.equal(CONFIG.resolvedFor(r, "Z").atCol, "Z", "the real Notes column keeps the binding");
});

/* ================================================== row visibility (8 Sep) */

test("skips rows a person has hidden", async () => {
  // Two sheet rows; row 2 is filed away. Only row 1 may be considered.
  const rows = [
    fullHeader(),
    mkRow("Andrew", "Mi", { J: "in progress" }),   // sheet row 2 — hidden
    mkRow("Jannik", "Wiedenhaupt", { J: "done" }), // sheet row 3 — visible
  ];
  const andrew = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const jannik = linkedRow("c2", "Jannik Wiedenhaupt", "jannik|wiedenhaupt");
  const store = fakeStore([andrew, jannik]);
  const res = await run(rows, store, {}, { hiddenRows: [2] });

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.candidateRows, 2);
  assert.equal(res.summary.visibleRows, 1);
  assert.equal(res.summary.hiddenByUserRows, 1);
  assert.equal(res.summary.rowsRead, 1, "only the visible row is considered");

  assert.equal(jannik.values.status, "DONE");
  assert.equal(andrew.values.status, undefined, "a hidden row must not be synced");
  // The linked-but-hidden row reads as unresolvable, not as silently fine.
  assert.equal(res.summary.unresolved.length, 1);
  assert.equal(res.summary.unresolved[0].candidateId, "c1");
});

test("does NOT skip rows hidden by a filter", async () => {
  // A filter is a view somebody left switched on. It must never get to decide
  // which candidates sync.
  const rows = [fullHeader(), mkRow("Andrew", "Mi", { J: "done" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run(rows, store, {}, { filterHiddenRows: [2] });

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.wrote, 1, "a filter-hidden row still syncs");
  assert.equal(row.values.status, "DONE");
  assert.equal(res.summary.hiddenByFilterRows, 1, "but it is counted, so the choice is visible");
  assert.equal(res.summary.hiddenByUserRows, 0);
  assert.equal(res.summary.visibleRows, 0, "it is not counted as plainly visible either");
  assert.equal(res.summary.rowsRead, 1);
});

test("a row hidden both ways is skipped — the person's hide wins", async () => {
  const rows = [fullHeader(), mkRow("Andrew", "Mi", { J: "done" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run(rows, store, {}, { hiddenRows: [2], filterHiddenRows: [2] });

  assert.equal(res.summary.hiddenByUserRows, 1);
  assert.equal(res.summary.hiddenByFilterRows, 0);
  assert.equal(res.summary.wrote, 0);
  assert.equal(store.puts.length, 0);
});

test("aborts when visibility cannot be read, rather than defaulting to visible", async () => {
  const rows = [fullHeader(), mkRow("Andrew", "Mi", { J: "done" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run(rows, store, {}, { visibilityFail: "sheets api returned 500 reading row visibility" });

  assert.equal(res.outcome, "aborted");
  assert.equal(res.summary.reason, "visibility_unreadable");
  assert.equal(res.summary.wrote, 0);
  assert.equal(store.puts.length, 0);
  assert.match(res.error, /Refusing to sync without knowing which rows are hidden/);
  assert.equal(row.values.status, undefined);
});

test("aborts when visibility stops short of the data, rather than assuming", async () => {
  // Metadata for the header row only: the candidate row's state is unknown.
  const rows = [fullHeader(), mkRow("Andrew", "Mi", { J: "done" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run(rows, store, {}, { visibilityShort: 1 });

  assert.equal(res.outcome, "aborted");
  assert.equal(res.summary.reason, "visibility_incomplete");
  assert.equal(res.summary.rowsWithoutVisibilityCount, 1);
  assert.deepEqual(res.summary.rowsWithoutVisibility, [2]);
  assert.equal(store.puts.length, 0);
  assert.match(res.error, /Refusing to default them to visible/);
});

test("visible and hidden counts are recorded on every run, including dry runs", async () => {
  const rows = [
    fullHeader(),
    mkRow("Andrew", "Mi", { J: "done" }),
    mkRow("Jannik", "Wiedenhaupt", { J: "done" }),
    mkRow("Aakash", "Japi", { J: "done" }),
  ];
  const store = fakeStore([linkedRow("c1", "Andrew Mi", "andrew|mi")]);
  const res = await run(rows, store, { dryRun: true }, { hiddenRows: [3], filterHiddenRows: [4] });

  assert.equal(res.outcome, "dry_run");
  assert.equal(res.summary.candidateRows, 3);
  assert.equal(res.summary.visibleRows, 1);
  assert.equal(res.summary.hiddenByUserRows, 1);
  assert.equal(res.summary.hiddenByFilterRows, 1);
  // The three buckets must account for every candidate row, or a change in one
  // could hide a change in another.
  const { visibleRows, hiddenByUserRows, hiddenByFilterRows, candidateRows } = res.summary;
  assert.equal(visibleRows + hiddenByUserRows + hiddenByFilterRows, candidateRows);
});

test("counts are recorded even when the run aborts on an assertion", async () => {
  const rows = [fullHeader(), mkRow("Andrew", "Mi", { J: "2026-09-14" }), mkRow("A", "B", { J: "done" })];
  const store = fakeStore([]);
  const res = await run(rows, store, {}, { hiddenRows: [3] });

  assert.equal(res.outcome, "aborted");
  assert.equal(res.summary.reason, "assertion_failed");
  assert.equal(res.summary.hiddenByUserRows, 1, "counts survive the abort path");
  assert.equal(res.summary.visibleRows, 1);
});

test("a hidden row's unknown status no longer aborts the whole run", async () => {
  // This is today's live sheet in miniature: WITHDREW and ENDED EARLY exist only
  // on rows somebody filed away, and were aborting all 120 rows every hour.
  const rows = [
    fullHeader(),
    mkRow("Andrew", "Mi", { J: "in progress" }),          // row 2, visible
    mkRow("Old", "Candidate", { J: "WITHDREW" }),         // row 3, hidden
    mkRow("Older", "Candidate", { J: "ENDED EARLY" }),    // row 4, hidden
  ];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run(rows, store, {}, { hiddenRows: [3, 4] });

  assert.equal(res.outcome, "ok", "the visible set is clean, so the run proceeds");
  assert.equal(res.summary.hiddenByUserRows, 2);
  assert.equal(row.values.status, "IN PROGRESS");

  // ...and since 9 Sep the same values on a VISIBLE row do not abort either.
  // They are counted and reported, and normalise() still declines to write them,
  // so the row simply does not get a status.
  const store2 = fakeStore([linkedRow("c2", "Old Candidate", "old|candidate")]);
  const res2 = await run(rows, store2, {}, { hiddenRows: [4] });
  assert.equal(res2.outcome, "ok", "an unknown word is not a shape failure");
  assert.equal(res2.summary.unrecognisedCount, 1);
  const u = res2.summary.unrecognised.find((x) => x.col === "J");
  assert.deepEqual(u.values, [{ value: "WITHDREW", rows: 1 }]);
  assert.equal(store2.rows[0].values.status, undefined, "and no status was written");
});

test("suggest() still works without visibility, and says so in the counts", () => {
  // suggest() takes no visibility read; the sync path is what requires it.
  const rows = [fullHeader(), mkRow("Andrew", "Mi", {})];
  const sug = bot.suggest({ rows, name: "Andrew Mi" });
  assert.equal(sug.length, 1);
  const index = bot._internal.indexSheet(rows, CONFIG.resolveColumns(rows[0]));
  assert.equal(index.counts.visibilityKnown, false);
  assert.equal(index.rows.length, 1, "no visibility means nothing is filtered out");
});

/* ============================ links pointing into the archive (8 Sep) */

test("counts linked candidates whose key names a hidden row", async () => {
  const rows = [
    fullHeader(),
    mkRow("Andrew", "Mi", { J: "in progress" }),        // row 2, visible
    mkRow("Jannik", "Wiedenhaupt", { J: "done" }),      // row 3, hidden
    mkRow("Aakash", "Japi", { J: "done" }),             // row 4, hidden
  ];
  const store = fakeStore([
    linkedRow("c1", "Andrew Mi", "andrew|mi"),
    linkedRow("c2", "Jannik Wiedenhaupt", "jannik|wiedenhaupt"),
    linkedRow("c3", "Aakash Japi", "aakash|japi"),
  ]);
  const res = await run(rows, store, {}, { hiddenRows: [3, 4] });

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.linkedRows, 3);
  assert.equal(res.summary.linkedToHiddenRows, 2);
  assert.equal(res.summary.wrote, 1, "only the visible one syncs");

  // The reason names the row, so it can be found in the sheet.
  const hidden = res.summary.unresolved.filter((u) => u.hiddenRow != null);
  assert.equal(hidden.length, 2);
  assert.deepEqual(hidden.map((u) => u.hiddenRow).sort(), [3, 4]);
  assert.match(hidden[0].reason, /points at sheet row \d+, which is hidden/);
});

test("a key that names nothing at all is not counted as pointing at a hidden row", async () => {
  const rows = [fullHeader(), mkRow("Andrew", "Mi", { J: "done" })];
  const gone = linkedRow("c1", "Someone Else", "someone|else"); // never in the sheet
  const store = fakeStore([gone]);
  const res = await run(rows, store, {}, { hiddenRows: [] });

  assert.equal(res.summary.linkedToHiddenRows, 0, "this is a different fact");
  assert.equal(res.summary.unresolved.length, 1);
  assert.equal(res.summary.unresolved[0].hiddenRow, undefined);
  assert.match(res.summary.unresolved[0].reason, /no sheet row carries this key/);
});

test("zero is reported, not omitted, so a jump from zero is visible", async () => {
  const rows = [fullHeader(), mkRow("Andrew", "Mi", { J: "done" })];
  const store = fakeStore([linkedRow("c1", "Andrew Mi", "andrew|mi")]);
  const res = await run(rows, store, {}, {});
  assert.equal(res.summary.linkedToHiddenRows, 0);
});

test("a pinned key counts only when its own row is the hidden one", async () => {
  // Two Andrew Mis: row 2 visible, row 3 hidden. Each pinned key must resolve to
  // its own row's fate, not the other's.
  const rows = [fullHeader(), mkRow("Andrew", "Mi", { J: "done" }), mkRow("Andrew", "Mi", { J: "in progress" })];
  const index = bot._internal.indexSheet(
    rows,
    CONFIG.resolveColumns(rows[0]),
    { startRow: 0, rows: [{}, {}, { hiddenByUser: true }].map((m) => ({ hiddenByUser: !!m.hiddenByUser, hiddenByFilter: false })) }
  );
  assert.equal(bot._internal.pointsAtHidden("andrew|mi@r3", index), 3, "row 3 is hidden");
  assert.equal(bot._internal.pointsAtHidden("andrew|mi@r2", index), null, "row 2 is visible");
  assert.equal(bot._internal.pointsAtHidden("nobody|here", index), null);
});

test("a link resolving to a visible twin is not counted as hidden", async () => {
  // Same name on a hidden row and a visible one. The bare key resolves to the
  // visible row, so it syncs and is not reported as archived.
  const rows = [fullHeader(), mkRow("Andrew", "Mi", { J: "done" }), mkRow("Andrew", "Mi", { J: "in progress" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run(rows, store, {}, { hiddenRows: [3] });

  assert.equal(res.summary.linkedToHiddenRows, 0);
  assert.equal(res.summary.wrote, 1);
  assert.equal(row.values.status, "DONE", "the visible row's value");
});

test("no extra sheet read is made to work this out", async () => {
  // Row 2 visible, row 3 hidden. The visible row has to exist: with everything
  // hidden, the column-A assertion ("First Name is populated") sees an empty
  // set and aborts the run before a plan is ever made.
  const rows = [fullHeader(), mkRow("Andrew", "Mi", { J: "done" }), mkRow("Jannik", "Wiedenhaupt", { J: "done" })];
  let rangeReads = 0, visibilityReads = 0;
  const counting = {
    isConfigured: () => true,
    configError: () => null,
    readRange: async () => { rangeReads++; return { ok: true, rows }; },
    readVisibility: async () => {
      visibilityReads++;
      return { ok: true, startRow: 0, rows: [{ hiddenByUser: false, hiddenByFilter: false },
                                             { hiddenByUser: false, hiddenByFilter: false },
                                             { hiddenByUser: true, hiddenByFilter: false }] };
    },
  };
  const store = fakeStore([linkedRow("c1", "Jannik Wiedenhaupt", "jannik|wiedenhaupt")]);
  const res = await bot.run({
    sheets: counting, getCandidates: store.getCandidates, putCandidate: store.putCandidate,
    dryRun: false, runId: 1, log: () => {}, now: new Date(),
  });

  assert.equal(res.summary.linkedToHiddenRows, 1);
  assert.equal(rangeReads, 1, "exactly one values read");
  assert.equal(visibilityReads, 1, "exactly one visibility read");
});

test("with every candidate row hidden, the run finishes ok with a note", async () => {
  // Everything filed away is an answer, not a fault. The assertions are skipped
  // because they mean nothing against an empty set — "First Name is populated"
  // would fail and read as a broken sheet when nothing is broken.
  const rows = [fullHeader(), mkRow("Andrew", "Mi", { J: "done" })];
  const store = fakeStore([linkedRow("c1", "Andrew Mi", "andrew|mi")]);
  const res = await run(rows, store, {}, { hiddenRows: [2] });

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.note, "no visible rows to sync");
  assert.equal(res.summary.assertionsRun, false);
  assert.equal(res.summary.assertions, undefined, "no assertion results to report");
  assert.equal(res.summary.reason, undefined, "not an abort");
  assert.equal(res.summary.candidateRows, 1);
  assert.equal(res.summary.hiddenByUserRows, 1);
  assert.equal(res.summary.visibleRows, 0);
  assert.equal(res.summary.wrote, 0);
  assert.equal(store.puts.length, 0, "an ok run with nothing to do still writes nothing");
  assert.ok(JSON.stringify(res.message).includes("no visible rows to sync"));
});

test("an empty visible set still reports counts, so the archive is visible", async () => {
  const rows = [fullHeader(), mkRow("A", "One", {}), mkRow("B", "Two", {})];
  const store = fakeStore([]);
  const res = await run(rows, store, {}, { hiddenRows: [2, 3] });

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.candidateRows, 2);
  assert.equal(res.summary.hiddenByUserRows, 2);
  assert.equal(res.summary.rowsRead, 0);
});

test("a genuinely empty sheet is NOT treated as 'all hidden'", async () => {
  // No candidate rows at all. Still ok with the same note — there is nothing to
  // sync either way — but the counts distinguish the two situations.
  const store = fakeStore([]);
  const res = await run([fullHeader()], store, {}, {});
  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.note, "no visible rows to sync");
  assert.equal(res.summary.candidateRows, 0);
  assert.equal(res.summary.hiddenByUserRows, 0, "nothing was hidden — the sheet is empty");
});

/* ================================= default-aware emptiness + no-op guard */

const FIELDS = require("../lib/fields");

test("NOT YET is overwritten by a real value", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { L: "yes" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  row.values.calendarHold = "NOT YET"; // the toggle's default, stored explicitly
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.wrote, 1);
  assert.equal(row.values.calendarHold, "YES");
});

test("DONE is not overwritten by NOT STARTED", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { J: "not started" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  row.values.status = "DONE";
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.wrote, 0);
  assert.equal(row.values.status, "DONE", "a person's answer stands");
  assert.equal(store.puts.length, 0);
  const why = res.summary.skipped || [];
  assert.ok(res.summary.skippedFields >= 1);
});

test("an identical value plans no write", async () => {
  // Nothing stored, so the card already shows the select's first option. The
  // sheet says the same thing: there is no change to make.
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { J: "not started" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.writesPlanned, 0, "a no-op is not a planned write");
  assert.equal(res.summary.candidatesPlanned, 0, "and does not count as a candidate touched");
  assert.equal(store.puts.length, 0, "no PUT at all, so updatedBy does not move");
  assert.equal(row.values.status, undefined, "still unset, not set to its own default");
});

test("a field a person set to a non-default value is untouched", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { S: "yes", T: "yes" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  row.values.nda = "SENT";          // mid-way, chosen by a person
  row.values.rampLinear = "IN PROGRESS";
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.wrote, 0);
  assert.equal(row.values.nda, "SENT");
  assert.equal(row.values.rampLinear, "IN PROGRESS");
});

test("defaults come from the field spec, not from a list in the bot", () => {
  // Every syncable field's notion of "empty" must agree with lib/fields.js, and
  // lib/fields.js is what the card renders from.
  CONFIG.SYNCABLE.forEach((spec) => {
    const f = FIELDS.field(spec.field);
    assert.ok(f, spec.field + " must exist in the schema");
    const dflt = FIELDS.defVal(f);
    assert.equal(bot._internal.isTrackerEmpty(dflt, spec.field), true,
      spec.field + ": its own default must read as empty");
    assert.equal(bot._internal.isTrackerEmpty(undefined, spec.field), true,
      spec.field + ": unset must read as empty");
  });
});

test("a red/green check reads false as empty and true as an answer", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { O: "yes" })];
  const unset = linkedRow("c1", "Andrew Mi", "andrew|mi");
  unset.values.fdeShareDocs = false; // the pcheck default
  const s1 = fakeStore([unset]);
  const r1 = await run(sheet, s1, {}, {});
  assert.equal(r1.summary.wrote, 1);
  assert.equal(unset.values.fdeShareDocs, true);

  // Already ticked: the sheet agreeing is a no-op, not a write.
  const done = linkedRow("c2", "Andrew Mi", "andrew|mi");
  done.values.fdeShareDocs = true;
  const s2 = fakeStore([done]);
  const r2 = await run(sheet, s2, {}, {});
  assert.equal(r2.summary.wrote, 0);
  assert.equal(s2.puts.length, 0);
});

test("the no-op guard keeps the candidate cap counting real changes", async () => {
  // Six candidates, all of whose sheet values match what the card already shows.
  // Under a cap that counted planned writes regardless, this would abort.
  const six = NAMES.slice(0, 6);
  const sheet = [fullHeader()].concat(six.map((n) => mkRow(n[0], n[1], { J: "not started" })));
  const rows = six.map((n, i) => linkedRow("c" + i, n.join(" "), nameKey(n)));
  const store = fakeStore(rows);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.outcome, "ok", "six no-ops are not six changes");
  assert.equal(res.summary.candidatesPlanned, 0);
  assert.equal(res.summary.wrote, 0);
  assert.equal(store.puts.length, 0);
});

test("skip reasons tell an answered field from an unchanged one", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { J: "not started", S: "yes" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  // Answered, and DISAGREEING with the sheet: the sheet says COMPLETED. If the
  // stored value agreed it would be "no change" instead, because the no-op
  // check runs first — an agreeing sheet is never an overwrite or a conflict.
  row.values.nda = "SENT";
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, { dryRun: true });

  const reasons = (bot._internal.plan({
    trackerRows: [row],
    index: bot._internal.indexSheet(sheet, CONFIG.resolveColumns(sheet[0]),
      { startRow: 0, rows: [{ hiddenByUser: false, hiddenByFilter: false },
                            { hiddenByUser: false, hiddenByFilter: false }] }),
  }).skipped || []).map((x) => x.field + ":" + x.reason);

  assert.ok(reasons.includes("nda:already answered"), reasons.join(" | "));
  assert.ok(reasons.includes("status:no change"), reasons.join(" | "));
});

test("an explicit choice of the default is indistinguishable from unanswered", () => {
  // The consequence of default-aware emptiness, recorded deliberately: somebody
  // who deliberately selects "NOT STARTED" stores the same value as somebody who
  // never touched the field, so the sheet may fill over it.
  assert.equal(bot._internal.isTrackerEmpty("NOT STARTED", "status"), true);
  assert.equal(bot._internal.isTrackerEmpty("NOT YET", "calendarHold"), true);
  assert.equal(bot._internal.isTrackerEmpty("NOT SENT", "nda"), true);
});

/* ============================================ filled_unset vs filled_default */

test("a fill over an unset field is labelled filled_unset", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { J: "done" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");   // status never touched
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.wrote, 1);
  assert.equal(res.summary.filledUnset, 1);
  assert.equal(res.summary.filledDefault, 0);
  assert.equal(row.sheetSource.status.fillReason, "filled_unset");
});

test("a fill over a stored default is labelled filled_default", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { J: "done" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  row.values.status = "NOT STARTED";  // the default, but actually stored
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.wrote, 1);
  assert.equal(res.summary.filledUnset, 0);
  assert.equal(res.summary.filledDefault, 1);
  assert.equal(row.sheetSource.status.fillReason, "filled_default");
  assert.equal(row.values.status, "DONE");
});

test("a stored blank counts as unset, not as a default", async () => {
  // "" is a stored value, but it is not an answer on any field type, and on a
  // select it is not the default either — so it belongs with unset.
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { J: "done", M: "Sadiqeh" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  row.values.status = "";
  row.values.driName = "";           // "" IS the default for a text field
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.wrote, 2);
  assert.equal(res.summary.filledUnset, 2);
  assert.equal(res.summary.filledDefault, 0);
  assert.equal(row.sheetSource.status.fillReason, "filled_unset");
  assert.equal(row.sheetSource.driName.fillReason, "filled_unset");
});

test("a pcheck default of false is a stored default, not unset", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { O: "yes" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  row.values.fdeShareDocs = false;   // the pcheck default, stored
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.filledDefault, 1);
  assert.equal(res.summary.filledUnset, 0);
  assert.equal(row.sheetSource.fdeShareDocs.fillReason, "filled_default");
});

test("the two labels account for every write, on both paths", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", FULL_CELLS)];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  row.values.status = "NOT STARTED";      // default, stored
  row.values.calendarHold = "NOT YET";    // default, stored
  const store = fakeStore([row]);

  const dry = await run(sheet, store, { dryRun: true }, {});
  assert.equal(dry.summary.filledUnset + dry.summary.filledDefault, dry.summary.writesPlanned);
  assert.equal(dry.summary.filledDefault, 2);
  // The plan says which, so a surprising fill can be understood before it happens.
  assert.ok(JSON.stringify(dry.message).includes("was showing the default"));

  const live = await run(sheet, store, {}, {});
  assert.equal(live.summary.filledUnset + live.summary.filledDefault, live.summary.wrote);
  assert.equal(live.summary.filledDefault, 2);
  Object.keys(row.sheetSource).forEach((k) => {
    assert.ok(["filled_unset", "filled_default"].includes(row.sheetSource[k].fillReason),
      k + " must carry one of the two labels");
  });
});

test("a no-op is neither label, because it is not a fill", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { J: "not started" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.wrote, 0);
  assert.equal(res.summary.filledUnset, 0);
  assert.equal(res.summary.filledDefault, 0);
  assert.equal(row.sheetSource, undefined, "nothing written, so no provenance");
});

/* ============================ authoritative fields and conflicts (9 Sep) */

/** A linked row whose `field` was last written by sync as `value`. */
function syncOwned(id, name, key, field, value, cell) {
  const r = linkedRow(id, name, key);
  r.values[field] = value;
  r.sheetSource = { [field]: { tab: CONFIG.SHEET_TAB, cell: cell || "G2", header: field,
                               raw: value, value, fillReason: "filled_unset", by: "sheet-sync" } };
  return r;
}

test("exactly three fields are authoritative", () => {
  assert.deepEqual(CONFIG.AUTHORITATIVE.slice().sort(), ["computer", "desk", "driName"]);
  CONFIG.SYNCABLE.forEach((c) => {
    if (!CONFIG.AUTHORITATIVE.includes(c.field)) {
      assert.ok(!c.authoritative, c.field + " must not be authoritative");
    }
  });
});

test("a value sync still owns is updated to the new sheet value", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { G: "Desk 12" })];
  const row = syncOwned("c1", "Andrew Mi", "andrew|mi", "desk", "Desk 9");
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.wrote, 1);
  assert.equal(res.summary.resynced, 1, "a resync, not a fill");
  assert.equal(res.summary.conflictCount, 0);
  assert.equal(row.values.desk, "Desk 12");
  assert.equal(row.sheetSource.desk.fillReason, "resynced");
  assert.equal(row.sheetSource.desk.value, "Desk 12", "so the next run knows sync still owns it");
});

test("a value a person edited is NOT overwritten, and becomes a conflict", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { G: "Desk 12" })];
  const row = syncOwned("c1", "Andrew Mi", "andrew|mi", "desk", "Desk 9");
  row.values.desk = "SF-2F-04";   // a coordinator fixed it after sync wrote Desk 9
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.wrote, 0);
  assert.equal(store.puts.length, 0, "nothing is written at all");
  assert.equal(row.values.desk, "SF-2F-04", "the person's value stands");
  assert.equal(res.summary.conflictCount, 1);
  const c = res.summary.conflicts[0];
  assert.equal(c.field, "desk");
  assert.equal(c.trackerValue, "SF-2F-04");
  assert.equal(c.sheetValue, "Desk 12");
  assert.equal(c.lastSynced, "Desk 9", "so the run row shows what sync had put there");
  assert.equal(c.never, false);
  assert.ok(c.cell, "and where to go and fix it");
});

test("a value that predates sync entirely is a conflict, not an overwrite", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { M: "Sadiqeh" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  row.values.driName = "Tess";     // typed before sync ever ran; no sheetSource
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.wrote, 0);
  assert.equal(res.summary.conflictCount, 1);
  assert.equal(res.summary.conflicts[0].never, true, "sync has no claim on it");
  assert.equal(res.summary.conflicts[0].lastSynced, null);
  assert.equal(row.values.driName, "Tess");
});

test("an agreeing sheet is never a conflict", async () => {
  // The person's edit and the sheet happen to match: nothing to do, and
  // certainly nothing to flag.
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { G: "Desk 12" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  row.values.desk = "Desk 12";
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.conflictCount, 0);
  assert.equal(res.summary.wrote, 0);
  assert.equal(store.puts.length, 0);
});

test("an empty authoritative field is still just filled", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { E: "SF-Poetic 4", G: "Desk 12", M: "Sadiqeh" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.wrote, 3);
  assert.equal(res.summary.filledUnset, 3);
  assert.equal(res.summary.resynced, 0);
  assert.equal(res.summary.conflictCount, 0);
});

test("a blank sheet cell never blanks a field, authoritative or not", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { G: "", E: "TBD", M: "" })];
  const row = syncOwned("c1", "Andrew Mi", "andrew|mi", "desk", "Desk 9");
  row.values.computer = "SF-Poetic 4";
  row.values.driName = "Sadiqeh";
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.wrote, 0);
  assert.equal(res.summary.conflictCount, 0, "a blank cell is not a disagreement");
  assert.equal(row.values.desk, "Desk 9");
  assert.equal(row.values.computer, "SF-Poetic 4");
  assert.equal(row.values.driName, "Sadiqeh");
});

test("a non-authoritative field is still fill-once, never resynced", async () => {
  // nda is not authoritative: an answer in it is final as far as sync is
  // concerned, and it does not raise a conflict either.
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { S: "yes" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  row.values.nda = "SENT";
  row.sheetSource = { nda: { raw: "sent", value: "SENT", by: "sheet-sync" } };
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.wrote, 0, "sync does not keep nda matching the sheet");
  assert.equal(res.summary.conflictCount, 0, "and does not call it a conflict");
  assert.equal(row.values.nda, "SENT");
});

test("a dry run reports conflicts but writes nothing", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { G: "Desk 12" })];
  const row = syncOwned("c1", "Andrew Mi", "andrew|mi", "desk", "Desk 9");
  row.values.desk = "SF-2F-04";
  const store = fakeStore([row]);
  const res = await run(sheet, store, { dryRun: true }, {});

  assert.equal(res.outcome, "dry_run");
  assert.equal(res.summary.conflictCount, 1);
  assert.equal(store.puts.length, 0);
  assert.ok(JSON.stringify(res.message).includes("not overwritten") ||
            JSON.stringify(res.message).includes("Not overwritten"),
    "the plan says so, so it can be read before it is live");
});

test("conflicts are reported on a hidden-row-filtered, capped, guarded run", async () => {
  // Everything else still applies: a hidden row contributes neither writes nor
  // conflicts, because it is not considered at all.
  const sheet = [
    fullHeader(),
    mkRow("Andrew", "Mi", { G: "Desk 12" }),
    mkRow("Old", "Candidate", { G: "Desk 99" }),
  ];
  const visible = syncOwned("c1", "Andrew Mi", "andrew|mi", "desk", "Desk 9");
  visible.values.desk = "SF-2F-04";
  const hidden = syncOwned("c2", "Old Candidate", "old|candidate", "desk", "Desk 1");
  hidden.values.desk = "EDITED";
  const store = fakeStore([visible, hidden]);
  const res = await run(sheet, store, {}, { hiddenRows: [3] });

  assert.equal(res.summary.hiddenByUserRows, 1);
  assert.equal(res.summary.conflictCount, 1, "only the visible row can conflict");
  assert.equal(res.summary.conflicts[0].candidateId, "c1");
});

test("a conflict does not count as a candidate against the cap", async () => {
  // Six candidates, all conflicting, none written: the cap is about writes.
  const six = NAMES.slice(0, 6);
  const sheet = [fullHeader()].concat(six.map((n) => mkRow(n[0], n[1], { G: "Desk 12" })));
  const rows = six.map((n, i) => {
    const r = syncOwned("c" + i, n.join(" "), nameKey(n), "desk", "Desk 9");
    r.values.desk = "EDITED " + i;
    return r;
  });
  const store = fakeStore(rows);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.outcome, "ok", "six conflicts are not six writes");
  assert.equal(res.summary.candidatesPlanned, 0);
  assert.equal(res.summary.conflictCount, 6);
  assert.equal(store.puts.length, 0);
});

test("nothing is ever written back to the sheet", () => {
  // The client handed to the bot has no write surface at all.
  const sheets = fakeSheets([]);
  assert.deepEqual(Object.keys(sheets).sort(),
    ["configError", "isConfigured", "readRange", "readVisibility"]);
  const real = require("../lib/sheets");
  Object.keys(real).forEach((k) => {
    assert.ok(!/^(write|update|append|set|clear|delete)/i.test(k),
      "lib/sheets exports a write-shaped method: " + k);
  });
});

/* ================================ placeholders are absence, not data (9 Sep) */

test("a not-yet marker in a free-text column writes nothing", async () => {
  // The live case: column M held "NOT YET" and two candidates were about to be
  // given a main partner named NOT YET.
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { M: "NOT YET", E: "NOT YET", G: "NOT YET" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.writesPlanned, 0);
  assert.equal(res.summary.candidatesPlanned, 0, "a candidate with only placeholders drops out");
  assert.equal(store.puts.length, 0);
  assert.equal(row.values.driName, undefined);
  assert.equal(row.values.computer, undefined);
  assert.equal(row.values.desk, undefined);
});

test("every listed marker is treated as blank, in any case or padding", () => {
  ["computer", "desk", "driName"].forEach((f) => {
    const spec = CONFIG.SYNCABLE.find((c) => c.field === f);
    ["NOT YET", "not yet", "Not Yet", "  NOT YET  ", "TBD", "tbd", "N/A", "n/a", "-", "—"]
      .forEach((v) => {
        assert.equal(CONFIG.normalise(v, spec), null, f + " must treat " + JSON.stringify(v) + " as blank");
      });
    assert.equal(CONFIG.isBlankFor("NOT YET", spec), true);
  });
});

test("NOT YET stays real data in a toggle column", () => {
  // The reason this is per-column and not global: the same five characters are
  // absence in a name field and the tracker's own "not done" in a toggle.
  ["calendarHold", "laptopChat", "laptopInvites", "himaReminder"].forEach((f) => {
    const spec = CONFIG.SYNCABLE.find((c) => c.field === f);
    assert.equal(CONFIG.normalise("NOT YET", spec), "NOT YET", f + " must keep NOT YET");
    assert.equal(CONFIG.isBlankFor("NOT YET", spec), false);
    assert.ok(!spec.blankAlso, f + " must not declare not-yet markers");
  });
});

test("only the free-text columns declare markers", () => {
  const declared = CONFIG.SYNCABLE.filter((c) => c.blankAlso).map((c) => c.field).sort();
  assert.deepEqual(declared, ["computer", "desk", "driName", "location"]);
  // And they are exactly the columns with no vocabulary of their own, which is
  // what makes a marker indistinguishable from content there.
  declared.forEach((f) => {
    const spec = CONFIG.SYNCABLE.find((c) => c.field === f);
    assert.equal(spec.type, undefined, f + " should be free text");
  });
});

test("a real value alongside a placeholder still writes", async () => {
  // Ahmet's shape: one column is a marker, the rest are real.
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { M: "NOT YET", E: "SF-Poetic 4", G: "Desk 12" })];
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.writesPlanned, 2, "the marker drops, the two real values stay");
  assert.equal(row.values.computer, "SF-Poetic 4");
  assert.equal(row.values.desk, "Desk 12");
  assert.equal(row.values.driName, undefined);
});

test("a placeholder never clears a value a person put there", async () => {
  // A marker is absence, and absence never blanks a field — including on an
  // authoritative field, and including one sync itself last wrote.
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { M: "NOT YET", G: "TBD" })];
  const row = syncOwned("c1", "Andrew Mi", "andrew|mi", "desk", "Desk 9");
  row.values.driName = "Sadiqeh";
  const store = fakeStore([row]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.wrote, 0);
  assert.equal(res.summary.conflictCount, 0, "a marker is not a disagreement");
  assert.equal(row.values.desk, "Desk 9");
  assert.equal(row.values.driName, "Sadiqeh");
});

test("the description says what the bot actually does to people's data", () => {
  // This is the sentence a coordinator reads before deciding whether to trust
  // it, so it is asserted rather than left to drift. It promised "blanks only —
  // never overwrites" for a day after that stopped being true.
  const d = bot.description;
  assert.ok(!/blanks only/i.test(d), d);
  assert.match(d, /Desk, Computer and MP\/DRI/, "names the three fields it keeps matching");
  assert.match(d, /matching the sheet/, "and says it keeps them matching");
  assert.match(d, /flags a conflict/, "says what happens instead of overwriting");
  assert.match(d, /never writes to the sheet/, "and that nothing goes back to Google");
  assert.match(d, /only touches rows a person linked/);
});

test("no copy of the blanks-only promise survives anywhere", () => {
  // The claim was true for one day and had been written down in nine places.
  //
  // Checked against whitespace-collapsed text with JS string concatenation
  // joined up, because the qualifier that makes the sentence true is often on
  // the next line: 'never overwrites a value ' + 'someone edited by hand'.
  // A line-by-line grep reads that as the bare claim and is wrong twice over.
  const files = ["bots/sheet-sync.js", "bots/sheet-sync.config.js", "public/index.html",
                 "README.md", "server.js"];
  const flat = (t) => t
    .replace(/['"]\s*\+\s*\n?\s*['"]/g, " ")   // "a" + \n "b"  ->  a b
    .replace(/\n\s*\*\s?/g, " ")                // docblock continuation
    .replace(/\s+/g, " ");

  const forbidden = [
    { re: /blanks only/i, why: "the blanks-only promise" },
    { re: /only fills fields that are empty/i, why: "fills-only-empty, now untrue of three fields" },
    // Unqualified: the sentence is only true when it says WHOSE value.
    { re: /never overwrites a value(?!\s+(someone|somebody)\s+edited)/i,
      why: "an unqualified never-overwrites claim" },
    { re: /cannot overwrite\. A field with any stored value is skipped/i,
      why: "the old absolute no-overwrite rule" },
  ];

  const bad = [];
  files.forEach((f) => {
    const t = flat(fs.readFileSync(path.join(__dirname, "..", f), "utf8"));
    forbidden.forEach(({ re, why }) => {
      const m = t.match(re);
      if (m) bad.push(f + ": " + why + " — ..." + t.slice(Math.max(0, m.index - 40), m.index + 70) + "...");
    });
  });
  assert.deepEqual(bad, [], "stale claims:\n  " + bad.join("\n  "));
});

test("the guard above would catch the claim coming back", () => {
  // A guard that cannot fail is not a guard. These are the exact shapes that
  // were live, run through the same matcher.
  const flat = (t) => t.replace(/['"]\s*\+\s*\n?\s*['"]/g, " ").replace(/\s+/g, " ");
  const bare = /never overwrites a value(?!\s+(someone|somebody)\s+edited)/i;
  assert.ok(bare.test(flat('"It never overwrites a value and never touches a field"')),
    "the old card wording must still be caught");
  assert.ok(/blanks only/i.test("Blanks only — never overwrites"),
    "the old description must still be caught");
  // ...and the qualified sentence must pass.
  assert.ok(!bare.test(flat('"never overwrites a value " + "someone edited by hand"')),
    "the true sentence must not be flagged, even split across a concatenation");
  assert.ok(!bare.test(flat("never overwrites a value somebody edited by hand")));
});



/* ================== unrecognised values are counted, never fatal (9 Sep) */

test("an unknown status is counted and reported, not aborted", async () => {
  // The live case that started this: two words missing from a list stopped all
  // 120 rows syncing, hourly.
  const sheet = [
    fullHeader(),
    mkRow("Andrew", "Mi", { J: "WITHDREW" }),
    mkRow("Jannik", "Wiedenhaupt", { J: "ENDED EARLY" }),
    mkRow("Aakash", "Japi", { J: "WITHDREW" }),
    mkRow("Dana", "Reed", { J: "done" }),
  ];
  const rows = [["Andrew","Mi"],["Jannik","Wiedenhaupt"],["Aakash","Japi"],["Dana","Reed"]]
    .map((n, i) => linkedRow("c" + i, n.join(" "), n[0].toLowerCase() + "|" + n[1].toLowerCase()));
  const store = fakeStore(rows);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.outcome, "ok", "the run completes");
  assert.equal(res.summary.unrecognisedCount, 3);
  const j = res.summary.unrecognised.find((u) => u.col === "J");
  assert.equal(j.header, "Status");
  assert.equal(j.field, "status");
  assert.equal(j.distinct, 2);
  // Listed with counts, commonest first — "3 unrecognised" tells nobody what to fix.
  assert.deepEqual(j.values, [{ value: "WITHDREW", rows: 2 }, { value: "ENDED EARLY", rows: 1 }]);

  // The recognised row still syncs; the others simply get no status.
  assert.equal(rows[3].values.status, "DONE");
  [0, 1, 2].forEach((i) => assert.equal(rows[i].values.status, undefined));
});

test("a shape failure in the same column still aborts", async () => {
  // Shape and vocabulary are different questions. A date in Status means the
  // column has stopped holding statuses, and that is worth stopping for.
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { J: "2026-09-14" })];
  const store = fakeStore([linkedRow("c1", "Andrew Mi", "andrew|mi")]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.outcome, "aborted");
  assert.equal(res.summary.reason, "assertion_failed");
  assert.deepEqual(res.summary.assertions.filter((a) => !a.passed).map((a) => a.col), ["J"]);
  assert.equal(store.puts.length, 0);
});

test("DONE is a status, not a yes — J cannot reject yes/no the way E and G do", () => {
  const J = CONFIG.ASSERTIONS.find((a) => a.col === "J");
  assert.equal(J.test(["DONE"]), true, "DONE is in TRUEISH but is a perfectly good status");
  assert.equal(J.test(["NOT STARTED", "IN PROGRESS", "DONE", "CANCELED", "WITHDREW"]), true);
  assert.equal(J.test(["2026-09-14"]), false);
  assert.equal(J.test(["14/09/2026"]), false);
  assert.equal(J.test(["x".repeat(31)]), false, "a paragraph is not a status");
  assert.ok(!/one of|vocabulary/i.test(J.describe), "it is a shape check now: " + J.describe);
});

test("counts are reported on an abort too", async () => {
  // "What could the bot not read" is most useful when something else is wrong.
  const sheet = [
    fullHeader(),
    mkRow("Andrew", "Mi", { J: "2026-09-14" }),   // shape failure -> abort
    mkRow("Jannik", "Wiedenhaupt", { Q: "mayble" }), // unrecognised -> counted
  ];
  const store = fakeStore([]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.outcome, "aborted");
  // Two, not one: the date in J is BOTH a shape failure and a value normalise
  // cannot interpret. The two mechanisms are independent and both fire.
  assert.equal(res.summary.unrecognisedCount, 2);
  assert.deepEqual(res.summary.unrecognised.map((u) => u.col).sort(), ["J", "Q"]);
  assert.deepEqual(res.summary.assertions.filter((a) => !a.passed).map((a) => a.col), ["J"],
    "but only J failed a shape check");
});

test("free-text columns can never be unrecognised", async () => {
  // They have no vocabulary to violate: a value there is content or a
  // placeholder, and both are already handled.
  const sheet = [fullHeader(), mkRow("Andrew", "Mi",
    { E: "whatever this is", G: "?!?", M: "someone's name" })];
  const store = fakeStore([linkedRow("c1", "Andrew Mi", "andrew|mi")]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.unrecognisedCount, 0);
  assert.deepEqual(res.summary.unrecognised, []);
  assert.equal(res.summary.wrote, 3, "all three are just content");
});

test("a placeholder is absence, not an unrecognised value", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { M: "NOT YET", J: "TBD", L: "n/a" })];
  const store = fakeStore([linkedRow("c1", "Andrew Mi", "andrew|mi")]);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.summary.unrecognisedCount, 0, "markers are not mysteries");
  assert.equal(res.summary.wrote, 0);
});

test("a hidden row's odd wording is not reported as work", async () => {
  const sheet = [
    fullHeader(),
    mkRow("Andrew", "Mi", { J: "done" }),
    mkRow("Old", "Candidate", { J: "WITHDREW" }),
  ];
  const store = fakeStore([linkedRow("c1", "Andrew Mi", "andrew|mi")]);
  const res = await run(sheet, store, {}, { hiddenRows: [3] });

  assert.equal(res.summary.unrecognisedCount, 0, "counted over considered rows only");
});

test("the distinct list is capped but the count is not", async () => {
  const many = [];
  for (let n = 0; n < 14; n++) many.push(mkRow("Cand" + n, "Sur" + n, { J: "odd-" + n }));
  const sheet = [fullHeader()].concat(many);
  const store = fakeStore([]);
  const res = await run(sheet, store, {}, {});

  const j = res.summary.unrecognised.find((u) => u.col === "J");
  assert.equal(j.count, 14, "every occurrence is counted");
  assert.equal(j.distinct, 14);
  assert.equal(j.values.length, 10, "but the listing is capped for the panel");
});

test("the plan says what it could not read", async () => {
  const sheet = [fullHeader(), mkRow("Andrew", "Mi", { J: "WITHDREW" })];
  const store = fakeStore([linkedRow("c1", "Andrew Mi", "andrew|mi")]);
  const res = await run(sheet, store, { dryRun: true }, {});

  const msg = JSON.stringify(res.message);
  assert.ok(msg.includes("Not recognised, so not written"));
  assert.ok(msg.includes("WITHDREW"));
  assert.ok(msg.includes("Status"));
});

/* ============================= per-column synonyms for Q, W, X (9 Sep) */

test("column Q maps both of its own words onto tracker options", () => {
  const spec = CONFIG.SYNCABLE.find((c) => c.field === "agentShadowRec");
  assert.equal(CONFIG.normalise("RECORDING SHARED", spec), "SHARED");
  assert.equal(CONFIG.normalise("recording shared", spec), "SHARED", "case-insensitive");
  assert.equal(CONFIG.normalise("NOT YET", spec), "NOT SHARED");
  assert.equal(CONFIG.normalise("SHARED", spec), "SHARED", "the real option still works");
  assert.equal(CONFIG.normalise("mystery", spec), null, "and an unknown word is still unknown");
});

test("columns W and X map NOT COMPLETED without touching teamSlack or chatSlack", () => {
  ["laptopInvites", "laptopChat"].forEach((f) => {
    const spec = CONFIG.SYNCABLE.find((c) => c.field === f);
    assert.equal(CONFIG.normalise("NOT COMPLETED", spec), "NOT YET", f);
    assert.equal(CONFIG.normalise("COMPLETED", spec), "YES", f);
  });
  // The reason this is per column and not a global FALSEISH entry: NOT COMPLETED
  // is a real option of these two, and must stay itself.
  ["teamSlack", "chatSlack"].forEach((f) => {
    const spec = CONFIG.SYNCABLE.find((c) => c.field === f);
    assert.equal(CONFIG.normalise("NOT COMPLETED", spec), "NOT COMPLETED", f);
    assert.equal(CONFIG.normalise("COMPLETED", spec), "COMPLETED", f);
    assert.ok(!spec.synonyms, f + " needs no synonyms");
  });
});

test("an explicit synonym beats the generic yes/no rules", () => {
  // "completed" is in TRUEISH, so whenTrue would also have produced YES here —
  // but the column's own mapping is checked first, so the answer never depends
  // on which generic list a word happens to be in.
  const spec = CONFIG.SYNCABLE.find((c) => c.field === "laptopInvites");
  assert.equal(CONFIG.normalise("completed", spec), "YES");
  assert.equal(spec.synonyms["completed"], "YES");
  // And for Q, "not yet" is in NEITHER TRUEISH nor FALSEISH, so without the
  // synonym it was silently unrecognised — which is how 4 cells did nothing.
  const q = CONFIG.SYNCABLE.find((c) => c.field === "agentShadowRec");
  assert.ok(!CONFIG.BLANK_EQUIVALENTS.includes("not yet"));
  assert.equal(q.synonyms["not yet"], "NOT SHARED");
});

test("only Q, W and X declare synonyms", () => {
  assert.deepEqual(CONFIG.SYNCABLE.filter((c) => c.synonyms).map((c) => c.col), ["Q", "W", "X"]);
  // Every synonym must resolve to a real option of its own field.
  CONFIG.SYNCABLE.filter((c) => c.synonyms).forEach((c) => {
    Object.entries(c.synonyms).forEach(([word, target]) => {
      assert.ok(c.values.includes(target),
        c.col + ": " + JSON.stringify(word) + " maps to " + JSON.stringify(target) +
        ", which is not one of " + JSON.stringify(c.values));
      assert.equal(word, word.toLowerCase(), c.col + ": synonym keys must be lowercase");
    });
  });
});

test("the mapped words stop being counted as unrecognised", async () => {
  // The 25 the count found on 9 Sep, in miniature.
  const sheet = [
    fullHeader(),
    mkRow("Andrew", "Mi", { Q: "RECORDING SHARED", W: "NOT COMPLETED", X: "NOT COMPLETED" }),
    mkRow("Jannik", "Wiedenhaupt", { Q: "NOT YET" }),
  ];
  const rows = [
    linkedRow("c1", "Andrew Mi", "andrew|mi"),
    linkedRow("c2", "Jannik Wiedenhaupt", "jannik|wiedenhaupt"),
  ];
  const store = fakeStore(rows);
  const res = await run(sheet, store, {}, {});

  assert.equal(res.outcome, "ok");
  assert.equal(res.summary.unrecognisedCount, 0, "nothing is a mystery any more");
  // Only the SHARED one is a real change: NOT SHARED and NOT YET are defaults.
  assert.equal(res.summary.wrote, 1);
  assert.equal(rows[0].values.agentShadowRec, "SHARED");
  assert.equal(rows[1].values.agentShadowRec, undefined, "NOT SHARED is the default — a no-op");
  assert.equal(rows[0].values.laptopInvites, undefined, "NOT YET is the default — a no-op");
});

/* ============================================ column D, the location (11 Sep) */

test("column D fills the location field from the sheet", async () => {
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const store = fakeStore([row]);
  const res = await run([mkRow("Andrew", "Mi", { D: "SF" })], store);
  assert.equal(res.outcome, "ok");
  assert.equal(row.values.location, "SF");
  assert.equal(row.sheetSource.location.cell, "D1");
  assert.equal(row.sheetSource.location.header, "WT Location");
  assert.equal(row.updatedBy, "sheet-sync");
});

test("location is fill-only, so a corrected value is not reverted", () => {
  // E, G and M are authoritative because the sheet decides a desk, a laptop
  // and a partner. A location is decided before any of that and rarely
  // changes, so there is no case for overwriting a person's correction.
  assert.equal(CONFIG.AUTHORITATIVE.indexOf("location"), -1);
  assert.deepEqual(CONFIG.AUTHORITATIVE.slice().sort(), ["computer", "desk", "driName"]);
});

test("a corrected location survives the next run", async () => {
  const row = syncOwned("c1", "Andrew Mi", "andrew|mi", "location", "SF");
  row.values.location = "NY";                 // fixed by hand after sync wrote SF
  const store = fakeStore([row]);
  const res = await run([mkRow("Andrew", "Mi", { D: "SF" })], store);
  assert.equal(res.outcome, "ok");
  assert.equal(row.values.location, "NY", "the person's value stands");
});

test("a placeholder location is absence, not a place", async () => {
  // The laptop suggester must read this as "location unknown" and offer
  // nothing, rather than treating TBD as a site and matching nothing.
  for (const marker of CONFIG.NOT_YET_MARKERS) {
    const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
    const store = fakeStore([row]);
    const res = await run([mkRow("Andrew", "Mi", { D: marker })], store);
    assert.equal(res.outcome, "ok");
    assert.equal(row.values.location, undefined,
      JSON.stringify(marker) + " must not be written as a location");
  }
});

test("the D assertion catches the shapes that mean a column shifted", () => {
  const d = CONFIG.ASSERTIONS.filter((a) => a.col === "D")[0];
  assert.equal(d.test(["SF", "NY", "Hyde House", ""]), true, "real locations pass");
  assert.equal(d.test(["2026-09-14"]), false, "a date means H or C slid into D");
  assert.equal(d.test(["14/09/2026"]), false);
  assert.equal(d.test(["Yes"]), false, "a yes/no means F slid left");
  assert.equal(d.test(["no"]), false);
  assert.equal(d.test(["x".repeat(41)]), false, "a paragraph is a note, not a place");
  assert.equal(d.test([]), true, "an empty column is not a failure");
});

test("the location field exists on the card, as free text", () => {
  const f = FIELDS.field("location");
  assert.ok(f, "defined");
  assert.equal(f.type, "text");
  assert.equal(f.label, "WT location");
});

/* ====================== accepted suggestions vs the sheet (11 Sep) ====== */

test("an accepted suggestion is never overwritten by the sheet", () => {
  // Ruled 11 Sep: neither side wins, it is a conflict for a person, the same
  // shape as the Preston Vaughn case. The safety falls out of the existing
  // rule — an accepted value has no sheetSource entry — and this pins it.
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  row.values.desk = "SF-Desk 4";
  row.acceptedSource = {
    desk: { value: "SF-Desk 4", by: "hayley", at: "2026-09-11T10:00:00.000Z",
            source: "suggester", reason: "Not used since Sep 3." },
  };
  assert.equal(row.sheetSource, undefined, "no cell behind it, which is the point");
  return run([mkRow("Andrew", "Mi", { G: "SF-Desk 2" })], fakeStore([row])).then((res) => {
    assert.equal(res.outcome, "ok");
    assert.equal(row.values.desk, "SF-Desk 4", "the accepted value stands");
    assert.equal(res.summary.conflictCount, 1);
    const c = res.summary.conflicts[0];
    assert.equal(c.field, "desk");
    assert.equal(c.trackerValue, "SF-Desk 4");
    assert.equal(c.sheetValue, "SF-Desk 2");
  });
});

test("the conflict says a person accepted it, not that it predates sync", () => {
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  row.values.desk = "SF-Desk 4";
  row.acceptedSource = { desk: { value: "SF-Desk 4", by: "hayley", at: "2026-09-11T10:00:00.000Z" } };
  return run([mkRow("Andrew", "Mi", { G: "SF-Desk 2" })], fakeStore([row])).then((res) => {
    const c = res.summary.conflicts[0];
    assert.deepEqual(c.accepted, { by: "hayley", at: "2026-09-11T10:00:00.000Z", value: "SF-Desk 4" });
    const msg = JSON.stringify(res.message);
    assert.match(msg, /accepted by hayley on 2026-09-11/);
    assert.equal(/never synced before/.test(msg), false,
      "a decision somebody took reads differently from an old untouched value");
  });
});

test("a hand-typed value still reads as never synced, not as accepted", () => {
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  row.values.desk = "SF-2F-04";                 // typed, no acceptance recorded
  return run([mkRow("Andrew", "Mi", { G: "SF-Desk 2" })], fakeStore([row])).then((res) => {
    assert.equal(res.summary.conflicts[0].accepted, null);
    assert.match(JSON.stringify(res.message), /never synced before/);
  });
});

test("an agreeing sheet is not a conflict, even for an accepted value", () => {
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  row.values.desk = "SF-Desk 4";
  row.acceptedSource = { desk: { value: "SF-Desk 4", by: "hayley", at: "2026-09-11T10:00:00.000Z" } };
  return run([mkRow("Andrew", "Mi", { G: "SF-Desk 4" })], fakeStore([row])).then((res) => {
    assert.equal(res.summary.conflictCount, 0, "the sheet caught up, so there is nothing to resolve");
    assert.equal(row.values.desk, "SF-Desk 4");
  });
});

test("bot 10 still never writes to the sheet", () => {
  // Ruled 11 Sep: accepting reaches the tracker only. The read-only client is
  // the guarantee, and it is a guarantee by absence rather than by a check.
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "bots", "sheet-sync.js"), "utf8");
  for (const w of ["values.update", "values.append", "batchUpdate", "spreadsheets.values.update"]) {
    assert.equal(src.includes(w), false, "no write path: " + w);
  }
});

test("provenance is confirmed against the stored value, not the record", () => {
  const { provenanceOf } = require("../bots/sheet-sync")._internal;
  const row = {
    sheetSource: { desk: { value: "SF-Desk 1" } },
    acceptedSource: { desk: { value: "SF-Desk 4" } },
  };
  assert.equal(provenanceOf(row, "desk", "SF-Desk 1"), "sync");
  assert.equal(provenanceOf(row, "desk", "SF-Desk 4"), "accepted");
  // accepted on Thursday, hand-edited on Friday: it is typed from Friday on,
  // with nothing needing to clean acceptedSource up
  assert.equal(provenanceOf(row, "desk", "SF-2F-04"), "typed");
  assert.equal(provenanceOf({}, "desk", "anything"), "typed");
});

test("THE INVARIANT: bot 10 never changes an accepted value, it only reports", () => {
  // This is the assertion the sheet-wins rule would have broken. It checks the
  // stored value after the run, not merely that something was reported.
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  row.values.desk = "SF-Desk 4";
  row.acceptedSource = { desk: { value: "SF-Desk 4", by: "Hayley", at: "2026-09-11T10:00:00.000Z" } };
  return run([mkRow("Andrew", "Mi", { G: "SF-Desk 2" })], fakeStore([row])).then((res) => {
    assert.equal(row.values.desk, "SF-Desk 4", "UNCHANGED. The tracker is never overwritten here.");
    assert.equal(res.summary.conflictCount, 1);
    assert.equal(res.summary.conflicts[0].provenance, "accepted");
    assert.equal(res.summary.conflicts[0].sheetValue, "SF-Desk 2", "and the sheet value is reported");
  });
});

test("a hand-edited accepted value reports as typed, not as accepted", () => {
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  row.values.desk = "SF-2F-04";                 // edited after accepting
  row.acceptedSource = { desk: { value: "SF-Desk 4", by: "Hayley", at: "2026-09-11T10:00:00.000Z" } };
  return run([mkRow("Andrew", "Mi", { G: "SF-Desk 2" })], fakeStore([row])).then((res) => {
    const c = res.summary.conflicts[0];
    assert.equal(c.provenance, "typed");
    assert.equal(c.accepted, null, "the stale acceptance must not be claimed");
    assert.match(JSON.stringify(res.message), /never synced before/);
    assert.equal(row.values.desk, "SF-2F-04", "and still unchanged");
  });
});

test("conflict means one thing: the tracker was left alone, whoever wrote it", () => {
  // No second wording, nothing for a reader to disambiguate. If an overwrite
  // path is ever added for accepted values, this fails.
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "bots", "sheet-sync.js"), "utf8");
  const branch = src.slice(src.indexOf("const provenance = provenanceOf(row"),
                           src.indexOf('skipped.push({ candidateId: row.id, field: spec.field, reason: "conflict" });'));
  assert.equal(/values\[spec\.field\]\s*=/.test(branch), false, "no write in the conflict branch");
  // "never overwritten" is the correct wording; what must not exist is a
  // second heading saying the tracker WAS overwritten.
  assert.equal(/Overwritten from|took the sheet value/i.test(src), false,
    "no second conflict wording for a reader to disambiguate");
  assert.match(src, /Not overwritten\. The tracker and the sheet disagree\./);
});

/* ====================== TBD is a decision, not a blank (14 Sep) ====== */

test("TBD is the same string the suggester already treats as a request", () => {
  // The defect: two files disagreeing about what one cell means.
  const INV = require("../lib/assignment-inventory");
  assert.deepEqual(INV.DESK_NEEDS_SUGGESTION, ["TBD"]);
  assert.equal(CONFIG.isTbd("TBD"), true);
  assert.equal(CONFIG.isTbd(" tbd "), true);
  assert.equal(CONFIG.isTbd("not yet"), false, "only TBD, not the whole blank vocabulary");
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "bots", "sheet-sync.config.js"), "utf8");
  assert.match(src, /INVENTORY\.DESK_NEEDS_SUGGESTION\.map/,
    "derived from the suggester's list, not restated beside it");
});

test("with the flag off, TBD is still blank and nothing is written", async () => {
  assert.equal(CONFIG.TBD_IS_A_VALUE, false, "off until the blast radius is read");
  const row = syncOwned("c1", "Andrew Mi", "andrew|mi", "desk", "SF-Desk 1");
  const res = await run([mkRow("Andrew", "Mi", { G: "TBD" })], fakeStore([row]));
  assert.equal(res.outcome, "ok");
  assert.equal(row.values.desk, "SF-Desk 1", "unchanged, exactly as today");
});

test("every run counts TBD per field, whether the flag is on or not", async () => {
  // The measurement, decoupled from the behaviour, so the size of the change
  // is readable before it is made.
  const row = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const res = await run([mkRow("Andrew", "Mi", { E: "TBD", G: "TBD", M: "TBD", J: "TBD" })],
                        fakeStore([row]));
  assert.equal(res.summary.tbdSeen.computer, 1);
  assert.equal(res.summary.tbdSeen.desk, 1);
  assert.equal(res.summary.tbdSeen.driName, 1);
  assert.equal(res.summary.tbdSeen.status, 1, "counted on non-authoritative columns too");
  assert.equal(res.summary.tbdTotal, 4);
  const msg = JSON.stringify(res.message);
  assert.match(msg, /4 cell\(s\) read TBD/);
  assert.match(msg, /Turning TBD_IS_A_VALUE on would write it to/);
});

test("with the flag on, TBD overwrites a real value on an authoritative field", () => {
  // Driven directly, because the shipped default is off.
  const desk = CONFIG.COLUMNS.filter((c) => c.field === "desk")[0];
  const status = CONFIG.COLUMNS.filter((c) => c.field === "status")[0];
  const withFlag = (spec, raw) => {
    if (CONFIG.TBD_IS_A_VALUE && spec.authoritative && CONFIG.isTbd(raw)) return CONFIG.TBD;
    return CONFIG.normalise(raw, spec);
  };
  // the rule as written, with the flag forced on
  const forced = (spec, raw) => (spec.authoritative && CONFIG.isTbd(raw)) ? CONFIG.TBD
                                                                         : CONFIG.normalise(raw, spec);
  assert.equal(forced(desk, "TBD"), "TBD", "a real value on desk");
  assert.equal(forced(status, "TBD"), null, "still a blank on an enum column");
  assert.equal(withFlag(desk, "TBD"), null, "and off by default today");
});

test("TBD is written, never cleared to empty", () => {
  // Empty means nobody has said anything; TBD means a person said not yet.
  // The provenance differs and must survive in the data.
  assert.equal(CONFIG.TBD, "TBD");
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "bots", "sheet-sync.config.js"), "utf8");
  assert.match(src, /if \(TBD_IS_A_VALUE && spec\.authoritative && isTbd\(raw\)\) return TBD;/);
  assert.equal(/return "";/.test(src), false, "nothing clears a field to empty");
});

test("an actually empty cell still does nothing", async () => {
  const row = syncOwned("c1", "Andrew Mi", "andrew|mi", "desk", "SF-Desk 1");
  const res = await run([mkRow("Andrew", "Mi", { G: "" })], fakeStore([row]));
  assert.equal(res.outcome, "ok");
  assert.equal(row.values.desk, "SF-Desk 1");
  assert.equal(res.summary.tbdSeen.desk, undefined, "and is not counted as TBD");
});

test("linked rows that are hidden are a reported condition, not a summary field", async () => {
  // The bot reports ok while rows it exists to maintain are invisible to it.
  const visible = linkedRow("c1", "Andrew Mi", "andrew|mi");
  const hidden = linkedRow("c2", "Old Candidate", "old|candidate");
  const store = fakeStore([visible, hidden]);
  const res = await run([mkRow("Andrew", "Mi", {}), mkRow("Old", "Candidate", {})], store,
                        {}, { hiddenRows: [2] });
  const msg = JSON.stringify(res.message);
  assert.match(msg, /linked row\(s\) are hidden or filtered in the sheet/);
  assert.match(msg, /NOT syncing/);
  assert.match(msg, /Old Candidate/, "and names them");
  assert.match(msg, /The run is otherwise fine, which is exactly why/);
});
