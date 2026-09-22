"use strict";
/**
 * bots/sheet-sync.js — bot 10. Fills empty tracker fields from the WT Tracker sheet, and
 * keeps Desk, Computer and MP/DRI matching it.
 *
 * The whole design is about what it CANNOT do:
 *
 *   - It cannot create a tracker row. It only ever mutates rows handed to it by
 *     getCandidates(), and a row that vanished mid-run is skipped, not re-made.
 *   - It cannot delete one. No delete function is passed in — same shape as the
 *     read-only Ashby client, where the absence of the method is the guarantee.
 *   - It cannot overwrite a person. For most fields it fills only what is empty. For
 *     the three the sheet owns — Desk, Computer, MP/DRI — it keeps the tracker
 *     matching, but only while the stored value is still what sync itself wrote.
 *     A value somebody edited is a CONFLICT: reported, never overwritten.
 *   - It cannot touch a panel-owned field, checked against effective.js at plan
 *     time rather than trusting the config to have got its modes right.
 *   - It cannot match by name. Writes go only to rows carrying a sheetRowKey a
 *     person confirmed by clicking; name similarity is used to SUGGEST and
 *     nowhere else.
 *
 * Ships enabled and dry-run: a dry run reads the sheet, plans every write, and
 * records the plan in run_log for a coordinator to read in the Bots panel.
 *
 * ROW IDENTITY. The Sheets values API exposes no stable row id, so identity is
 * built from columns A and B: the normalised "first|last" pair, which survives
 * re-sorting (a row number does not). Where two rows share a name the key is
 * pinned to a row number as "first|last@r7", so duplicates stay distinguishable
 * and a coordinator picks the row they mean. A pinned key whose row has since
 * moved resolves to nothing and writes nothing — the row resurfaces as a
 * suggestion instead of being guessed at.
 */
const CONFIG = require("./sheet-sync.config");
const EFFECTIVE = require("../lib/effective");
const FIELDS = require("../lib/fields");

const NAME = "sheet-sync";

const norm = (s) =>
  String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

/* ---------------------------------------------------------------- identity */

/** The name pair from columns A and B, normalised. null when both are blank. */
function baseKey(first, last) {
  const f = norm(first), l = norm(last);
  if (!f && !l) return null;
  return f + "|" + l;
}

const pinnedKey = (base, rowNumber) => base + "@r" + rowNumber;

function parseKey(key) {
  const s = String(key == null ? "" : key);
  const m = s.match(/^(.*)@r(\d+)$/);
  return m ? { base: m[1], rowNumber: Number(m[2]) } : { base: s, rowNumber: null };
}

/**
 * Index the sheet by row identity.
 *
 * Row numbers are A1 row numbers: the range starts at A1, so the first value
 * read is sheet row 1. That matters because the key can pin one, and a cell
 * reference in the provenance ("J7") has to point at the row a person can see.
 */
function indexSheet(rows, resolved, visibility) {
  const all = rows || [];
  const res = resolved || CONFIG.resolveColumns(all[0]);
  const hasHeader = res.byHeader;
  // Identity comes from the two "key" columns wherever they now sit, not from
  // positions 0 and 1.
  const keyCols = res.columns.filter((c) => c.mode === "key");
  const firstAt = keyCols[0] ? keyCols[0].at : 0;
  const lastAt = keyCols[1] ? keyCols[1].at : 1;

  // Visibility is optional here because suggest() does not read it. The sync
  // path requires it and refuses to run without it — see run().
  const vis = visibility && visibility.rows ? visibility : null;
  const visStart = vis ? (visibility.startRow || 0) : 0;
  const counts = { candidateRows: 0, visible: 0, hiddenByUser: 0, hiddenByFilter: 0,
                   visibilityKnown: !!vis };
  const missingVisibility = [];
  // Identity of the rows we skip, so a link pointing INTO the archive can be
  // told apart from a link pointing at nothing. Costs no extra read: it is the
  // visibility already fetched for this run.
  const hiddenByBase = new Map();

  const dataRows = [];
  all.forEach((cells, i) => {
    if (i === 0 && hasHeader) return;
    const base = baseKey(cells[firstAt], cells[lastAt]);
    if (!base) return; // spacer or trailing blank row
    counts.candidateRows++;

    if (vis) {
      const m = vis.rows[i + 1 - 1 - visStart];
      if (!m) {
        // Not knowable. Recorded so run() can abort rather than assume visible.
        missingVisibility.push(i + 1);
        return;
      }
      // hiddenByUser: a person filed this row away. Syncing it would resurrect
      // archive, so it is skipped.
      if (m.hiddenByUser) {
        counts.hiddenByUser++;
        if (!hiddenByBase.has(base)) hiddenByBase.set(base, []);
        hiddenByBase.get(base).push(i + 1);
        return;
      }
      // hiddenByFilter is deliberately NOT a reason to skip. A filter is a view
      // someone left switched on; it must never get to decide which candidates
      // sync. Counted so the choice stays visible in the run row.
      if (m.hiddenByFilter) counts.hiddenByFilter++;
      else counts.visible++;
    }
    dataRows.push({
      rowNumber: i + 1,
      cells: cells || [],
      first: String(cells[firstAt] == null ? "" : cells[firstAt]).trim(),
      last: String(cells[lastAt] == null ? "" : cells[lastAt]).trim(),
      base,
    });
  });

  const byBase = new Map();
  dataRows.forEach((r) => {
    if (!byBase.has(r.base)) byBase.set(r.base, []);
    byBase.get(r.base).push(r);
  });
  // Only duplicates get pinned, so the common case keeps a key that survives a re-sort.
  dataRows.forEach((r) => {
    r.key = byBase.get(r.base).length > 1 ? pinnedKey(r.base, r.rowNumber) : r.base;
  });

  return { hasHeader, resolved: res, counts, missingVisibility, hiddenByBase,
           rows: dataRows, byBase, byKey: new Map(dataRows.map((r) => [r.key, r])) };
}

/**
 * The ONE place a stored sheetRowKey becomes a sheet row, and it is exact key
 * equality — never a name comparison. Returns { row } or { error }.
 */
function resolveKey(key, index) {
  const { base, rowNumber } = parseKey(key);
  if (!base) return { error: "empty sheetRowKey" };
  const group = index.byBase.get(base) || [];
  if (!group.length) return { error: "no sheet row carries this key any more" };
  if (rowNumber != null) {
    const hit = group.filter((r) => r.rowNumber === rowNumber);
    if (hit.length !== 1) {
      return { error: "pinned sheet row " + rowNumber + " no longer holds this name. Re-link" };
    }
    return { row: hit[0] };
  }
  if (group.length > 1) {
    return {
      error: group.length + " sheet rows now share this name (rows " +
        group.map((r) => r.rowNumber).join(", ") + "). Re-link to the row you mean",
    };
  }
  return { row: group[0] };
}

/**
 * Does this key name a row that exists but was hidden by a person?
 *
 * Returns the hidden sheet row number, or null. This is the difference between
 * "somebody archived this candidate" — expected, and nobody's problem — and
 * "this key resolves to nothing", which means the sheet changed under a
 * confirmed link and a person needs to look.
 */
function pointsAtHidden(key, index) {
  const { base, rowNumber } = parseKey(key);
  const group = (index.hiddenByBase && index.hiddenByBase.get(base)) || [];
  if (!group.length) return null;
  if (rowNumber != null) return group.indexOf(rowNumber) >= 0 ? rowNumber : null;
  return group[0];
}

/* -------------------------------------------------------------- suggesting */

/**
 * How a tracker row's name relates to a sheet row's A/B pair. Same three-way
 * answer as the Ashby suggestion strip, and for the same reason: a shared first
 * name alone would propose linking strangers.
 */
function relation(trackerName, first, last) {
  const a = norm(trackerName);
  const b = norm(String(first || "") + " " + String(last || ""));
  if (!a || !b) return null;
  if (a === b) return "exact";
  if (a.includes(b) || b.includes(a)) return "possible";
  const ta = a.split(" "), tb = b.split(" ");
  const la = ta[ta.length - 1], lb = tb[tb.length - 1];
  if (la && la === lb && la.length >= 3) return "possible";
  return null;
}

/** Columns that identify a person without being written — for telling rows apart. */
const contextColumns = (resolved) =>
  resolved.columns.filter((c) => c.mode === "ashby" && c.at != null);

/**
 * Sheet rows that might be this tracker row, best first. Proposals only: the
 * browser saves the chosen key through PUT /api/candidates/:id.
 */
function suggest({ rows, name, linkedKeys = [], visibility = null }) {
  const resolved = CONFIG.resolveColumns((rows || [])[0]);
  // Deliberately indexed WITHOUT visibility, so archived rows are still found.
  // Hiding them would answer "no match" for somebody who is looking at a real
  // person, and the next thing they do is create a duplicate. They come back
  // marked instead, and the browser shows them greyed out and unpickable.
  const index = indexSheet(rows, resolved);
  const context = contextColumns(resolved);
  const taken = new Set(linkedKeys.map(String));

  const vis = visibility && visibility.rows ? visibility : null;
  const visStart = vis ? (visibility.startRow || 0) : 0;
  /** true archived, false live, null when visibility could not be read. */
  const archivedAt = (rowNumber) => {
    if (!vis) return null;
    const m = vis.rows[rowNumber - 1 - visStart];
    return m ? !!m.hiddenByUser : null;
  };

  const out = [];
  for (const r of index.rows) {
    if (taken.has(r.key)) continue; // already linked to another tracker row
    const rel = relation(name, r.first, r.last);
    if (!rel) continue;
    out.push({
      rowKey: r.key,
      sheetName: (r.first + " " + r.last).trim(),
      rowNumber: r.rowNumber,
      pinned: r.key !== r.base,
      relation: rel,
      archived: archivedAt(r.rowNumber),
      // Enough to tell two same-named rows apart before clicking.
      context: context.map((c) => ({
        header: c.header,
        value: String(r.cells[c.at] == null ? "" : r.cells[c.at]).trim(),
      })).filter((x) => x.value),
    });
  }
  // Live rows first — an archived row is context, not a candidate for linking —
  // then exact matches, then sheet order.
  out.sort((a, b) =>
    Number(!!a.archived) - Number(!!b.archived) ||
    (a.relation === b.relation ? a.rowNumber - b.rowNumber : a.relation === "exact" ? -1 : 1)
  );
  return out;
}

/* ----------------------------------------------------------------- planning */

/**
 * Empty means the tracker holds no ANSWER: absent, blank, or exactly the default
 * the card would have shown anyway — "NOT YET" on a toggle, the first option of
 * a select, false on a red/green check.
 *
 * The default comes from the field's own spec in lib/fields.js, never from a list
 * written out here. A hand-kept copy would drift from what the card renders, and
 * the drift would show up as the bot either refusing to fill an untouched field
 * or overwriting an answer — the two failures this function exists to prevent.
 *
 * Deliberately NOT CONFIG.isBlank(). The config treats "TBD" as blank on the
 * SHEET side, which is right: it means nothing was decided. On the TRACKER side
 * a person who typed "TBD" has answered, and an answer is never overwritten.
 */
function isTrackerEmpty(v, fieldKey) {
  return FIELDS.isDefault(fieldKey, v);
}

/** What the card shows today: the stored value, or the field's default if unset. */
function currentValue(values, fieldKey) {
  const stored = values ? values[fieldKey] : undefined;
  if (stored !== undefined && stored !== null && stored !== "") return stored;
  return FIELDS.defVal(FIELDS.field(fieldKey));
}

/**
 * What sync last wrote to this field, or undefined if it never has.
 *
 * Prefers the normalised value it actually stored over the raw cell text. For
 * the three authoritative fields those are the same string — all three are
 * plain text — but they are not the same thing, and comparing a tracker value
 * against a raw sheet cell would go wrong the moment an authoritative field has
 * a vocabulary of its own.
 */
/**
 * Which of the three things is this field's current value?
 *
 *   "sync"      sync wrote it and nobody has touched it since
 *   "accepted"  a person accepted a suggestion, and it still stands
 *   "typed"     somebody typed it, or it predates all of this
 *
 * SELF-INVALIDATING, and that is the useful part: provenance is confirmed
 * against the value that is actually stored, not merely by the presence of a
 * record. Accept a desk on Thursday, hand-edit it on Friday, and this reads
 * "typed" from Friday on with nothing needing to clean up acceptedSource.
 *
 * Used ONLY to word the conflict. Resolution is identical for all three: on a
 * difference the sheet is reported and the tracker is left alone. Bot 10 never
 * overwrites the tracker on this branch, whatever wrote the value, so
 * "conflict" keeps one meaning across every field and every provenance.
 */
function provenanceOf(row, fieldKey, stored) {
  const last = lastSyncedValue(row, fieldKey);
  if (last !== undefined && String(stored) === String(last)) return "sync";
  const acc = ((row && row.acceptedSource) || {})[fieldKey];
  if (acc && String(stored) === String(acc.value)) return "accepted";
  return "typed";
}

function lastSyncedValue(row, fieldKey) {
  const src = (row && row.sheetSource && row.sheetSource[fieldKey]) || null;
  if (!src) return undefined;
  return src.value !== undefined ? src.value : src.raw;
}

/** Confirmed means a person clicked: the key AND who linked it are both present. */
function linkOf(row) {
  const v = (row && row.values) || {};
  if (!v.sheetRowKey) return null;
  if (!v.sheetLinkedBy) return { key: v.sheetRowKey, unconfirmed: true };
  return { key: v.sheetRowKey, unconfirmed: false };
}

function plan({ trackerRows, index }) {
  const writes = [], skipped = [], unresolved = [], hiddenLinks = [], conflicts = [];
  /* How many cells read TBD, per field, on the rows this run actually looked
     at. Counted whether or not TBD_IS_A_VALUE is on, so the blast radius of
     turning it on can be read off a normal run rather than discovered by
     making the change. */
  const tbdSeen = {};
  // Resolved, so a column that moved is read and cited where it actually is.
  const syncable = index.resolved.columns.filter((c) => c.mode === "sync" && c.at != null);

  for (const row of trackerRows || []) {
    const link = linkOf(row);
    if (!link) continue; // unlinked rows are never matched by name
    if (link.unconfirmed) {
      unresolved.push({
        candidateId: row.id, name: row.name, key: link.key,
        reason: "sheetRowKey present but sheetLinkedBy missing, so not a confirmed link",
      });
      continue;
    }

    const r = resolveKey(link.key, index);
    if (r.error) {
      // A key that resolves to nothing BECAUSE its row is hidden is a different
      // fact from a key that resolves to nothing at all, and is reported as one.
      const hiddenAt = pointsAtHidden(link.key, index);
      if (hiddenAt != null) {
        hiddenLinks.push({ candidateId: row.id, name: row.name, key: link.key, rowNumber: hiddenAt });
        unresolved.push({
          candidateId: row.id, name: row.name, key: link.key,
          reason: "points at sheet row " + hiddenAt + ", which is hidden",
          hiddenRow: hiddenAt,
        });
      } else {
        unresolved.push({ candidateId: row.id, name: row.name, key: link.key, reason: r.error });
      }
      continue;
    }

    const values = row.values || {};
    for (const spec of syncable) {
      // Independent of the config's own modes: if the live panel answers this
      // field, Ashby owns it and the sheet does not get a say.
      if (EFFECTIVE.PANEL_COVERS[spec.field]) {
        skipped.push({ candidateId: row.id, field: spec.field, reason: "panel-owned field" });
        continue;
      }
      const raw = r.row.cells[spec.at];
      if (CONFIG.isTbd(raw)) {
        const k = spec.field || spec.col;
        tbdSeen[k] = (tbdSeen[k] || 0) + 1;
      }
      const value = CONFIG.normalise(raw, spec);
      // A blank cell never blanks a field: nothing decided in the sheet is not a
      // decision to clear the tracker.
      if (value === null) continue;

      const stored = values[spec.field];
      const empty = isTrackerEmpty(stored, spec.field);

      // No-op guard first, so an agreeing sheet is never a write, a conflict, or
      // a candidate against the cap. The counts should mean "things that changed".
      if (value === currentValue(values, spec.field)) {
        skipped.push({ candidateId: row.id, field: spec.field, reason: "no change" });
        continue;
      }

      let fillKind = "fill";
      if (!empty) {
        if (!spec.authoritative) {
          // Fill-once field that already has an answer: leave it, as before.
          skipped.push({ candidateId: row.id, field: spec.field, reason: "already answered" });
          continue;
        }
        // Authoritative field with something already in it. Whose value is it?
        const last = lastSyncedValue(row, spec.field);
        if (last !== undefined && String(stored) === String(last)) {
          // Still exactly what sync put there, so sync may move it on.
          fillKind = "resync";
        } else {
          // Somebody edited it, it predates sync entirely, or a person accepted
          // a suggestion. Leave it alone and say so. A coordinator who fixed a
          // desk assignment must not have it reverted an hour later by a stale
          // sheet row, and neither must a decision somebody actively took.
          //
          // The accepted case needs no special handling to be SAFE: an accepted
          // value has no sheetSource entry, so lastSyncedValue is undefined and
          // it lands here already. What it needs is to be distinguishable, so
          // the conflict reads as "a person chose this" rather than as "this
          // predates sync", which are very different things to a reader.
          const provenance = provenanceOf(row, spec.field, stored);
          const acc = ((row.acceptedSource || {})[spec.field]) || null;
          const accepted = provenance === "accepted" ? acc : null;
          conflicts.push({
            provenance,
            candidateId: row.id,
            candidateName: row.name,
            field: spec.field,
            header: spec.header,
            trackerValue: stored,
            sheetValue: value,
            cell: spec.atCol + r.row.rowNumber,
            lastSynced: last === undefined ? null : last,
            never: last === undefined,
            accepted: accepted
              ? { by: accepted.by || null, at: accepted.at || null,
                  value: accepted.value === undefined ? null : accepted.value }
              : null,
          });
          skipped.push({ candidateId: row.id, field: spec.field, reason: "conflict" });
          continue;
        }
      }

      // Which kind of write this is. All three change a value, but they answer
      // different questions afterwards: nothing was ever there, the card was
      // showing its default, or the sheet moved a value sync already owned.
      const fillReason =
        fillKind === "resync" ? "resynced"
        : stored === undefined || stored === null || stored === "" ? "filled_unset"
        : "filled_default";

      writes.push({
        candidateId: row.id,
        candidateName: row.name,
        field: spec.field,
        value,
        fillReason,
        // Has sync written to THIS FIELD on this candidate before? This one
        // fact decides whether the cap counts the write — see run(). Recorded
        // per write so the run row can show its own working.
        hadSource: !!(row.sheetSource && row.sheetSource[spec.field]),
        cell: spec.atCol + r.row.rowNumber,
        tab: CONFIG.SHEET_TAB,
        header: spec.header,
        raw: String(raw == null ? "" : raw).trim(),
      });
    }
  }

  return { writes, skipped, unresolved, hiddenLinks, conflicts, tbdSeen };
}

/* ----------------------------------------------------------------- guards */

/**
 * Values this bot could not interpret, per column.
 *
 * "Unrecognised" means exactly one thing: the cell is not blank and not a
 * placeholder, and normalise() still declined to produce a value. So it is
 * already safe — nothing is written for it — and the only problem is that
 * nobody was told.
 *
 * This replaces aborting on an unknown vocabulary. On 8 Sep two hidden rows
 * reading "WITHDREW" and "ENDED EARLY" stopped all 120 rows from syncing, every
 * hour, over two words missing from a list. A count says the same thing without
 * costing everybody else their run.
 *
 * Only columns with a vocabulary can appear here. Free text has nothing to
 * violate, so Computer, Desk and MP/DRI can never be unrecognised — a value
 * there is either content or a placeholder.
 *
 * Counted over the rows actually considered, so a hidden row's odd wording is
 * not reported as work.
 */
function countUnrecognised(index) {
  const sync = (index.resolved.columns || []).filter((c) => c.mode === "sync" && c.at != null);
  const out = [];
  for (const spec of sync) {
    const tally = new Map();
    for (const r of index.rows) {
      const raw = r.cells[spec.at];
      if (CONFIG.isBlankFor(raw, spec)) continue;          // absence, not a mystery
      if (CONFIG.normalise(raw, spec) !== null) continue;  // understood
      const t = String(raw).trim();
      tally.set(t, (tally.get(t) || 0) + 1);
    }
    if (!tally.size) continue;
    const values = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    out.push({
      col: spec.atCol,
      header: spec.header,
      field: spec.field,
      count: values.reduce((n, pair) => n + pair[1], 0),
      distinct: values.length,
      // Listed, not just counted: "3 unrecognised" tells nobody what to fix.
      // Capped because run_log.summary is read by the panel, not archived.
      values: values.slice(0, 10).map((pair) => ({ value: pair[0], rows: pair[1] })),
    });
  }
  return out;
}

/** Every ASSERTIONS entry, against the column it names. A throw counts as a failure. */
function runAssertions(index) {
  return (CONFIG.ASSERTIONS || []).map((a) => {
    const spec = CONFIG.resolvedFor(index.resolved, a.col);
    const i = spec ? spec.at : null;
    if (i == null) {
      return { col: a.col, describe: a.describe, passed: false,
               error: spec ? "column " + a.col + " (" + spec.header + ") is not in the sheet"
                           : "column not in COLUMNS" };
    }
    const vals = index.rows.map((r) => r.cells[i]);
    try {
      return { col: a.col, describe: a.describe, passed: !!a.test(vals), error: null };
    } catch (e) {
      return { col: a.col, describe: a.describe, passed: false, error: String((e && e.message) || e) };
    }
  });
}

/* ---------------------------------------------------------------- message */

/** What a coordinator reads in the Bots panel. Dry-run is only useful if legible. */
function planMessage({ writes, unresolved, skipped, conflicts, unrecognised, dryRun, reason, cap, candidateCap, candidates, note, hiddenLinks, tbdSeen }) {
  const blocks = [
    { type: "header", text: { type: "plain_text", text: dryRun ? "Sheet sync (dry run)" : "Sheet sync" } },
  ];
  if (note) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_" + note + "._" } });
    return { blocks };
  }
  if (reason === "over_candidate_cap") {
    blocks.push({ type: "section", text: { type: "mrkdwn",
      text: ":warning: *Aborted. Nothing written.* " + candidates + " candidates would have been written, over " +
            "the cap of " + candidateCap + ". Many candidates changing in one run is what a restructured sheet " +
            "looks like." } });
  } else if (reason === "over_write_cap") {
    blocks.push({ type: "section", text: { type: "mrkdwn",
      text: ":warning: *Aborted. Nothing written.* " + writes.length + " writes planned, over the backstop of " +
            cap + ". The candidate count looked fine, so this is not an ordinary restructure." } });
  } else if (reason === "assertion_failed") {
    blocks.push({ type: "section", text: { type: "mrkdwn",
      text: ":warning: *Aborted. Nothing written.* A shape assertion failed, so the read is not trusted." } });
  }

  if (!writes.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "No empty fields to fill." } });
  } else {
    const byCandidate = new Map();
    writes.forEach((w) => {
      if (!byCandidate.has(w.candidateName)) byCandidate.set(w.candidateName, []);
      byCandidate.get(w.candidateName).push(w);
    });
    for (const [who, ws] of byCandidate) {
      blocks.push({ type: "section", text: { type: "mrkdwn",
        text: "*" + who + "*\n" + ws.map((w) =>
          "• " + w.header + " → `" + String(w.value) + "`  _(" + w.tab + "!" + w.cell +
          (w.fillReason === "filled_default" ? ", was showing the default" : "") +
          (w.hadSource ? ", sync wrote this field before, so it counts against the cap" : "") + ")_"
        ).join("\n") } });
    }
  }

  if (unrecognised && unrecognised.length) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn",
      text: "*Not recognised, so not written.* These cells hold something this bot has no " +
        "rule for. Nothing was written for them, and nothing else in the run was affected:\n" +
        unrecognised.map((u) =>
          "• " + u.header + " _(" + u.col + ")_: " +
          u.values.map((v) => "`" + v.value + "`" + (v.rows > 1 ? " ×" + v.rows : "")).join(", ") +
          (u.distinct > u.values.length ? ", …and " + (u.distinct - u.values.length) + " more" : "")
        ).join("\n") } });
  }

  if (conflicts && conflicts.length) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn",
      text: ":warning: *Not overwritten. The tracker and the sheet disagree.* " +
        "These hold a value sync did not put there, so they were left alone:\n" +
        conflicts.slice(0, 20).map((c) =>
          "• *" + c.candidateName + "* " + c.header + ": tracker `" + String(c.trackerValue) +
          "`, sheet `" + String(c.sheetValue) + "` _(" + c.cell +
          (c.accepted
            /* A decision somebody actively took, not an old value nobody has
               touched. Worth saying, because the reader's next move differs. */
            ? ", accepted by " + (c.accepted.by || "someone") +
              (c.accepted.at ? " on " + String(c.accepted.at).slice(0, 10) : "")
            : c.never ? ", never synced before"
                      : ", sync last wrote `" + String(c.lastSynced) + "`") +
          ")_"
        ).join("\n") +
        (conflicts.length > 20 ? "\n…and " + (conflicts.length - 20) + " more" : "") } });
  }

  /* A LINK THAT POINTS AT A HIDDEN ROW IS NOT SYNCING, and the run says "ok"
     around it. That is a lookup that failed reading as an answer, which is the
     third instance of the same shape this week, so it is a condition on the
     post rather than a number in the summary somebody has to go and read. */
  if (hiddenLinks && hiddenLinks.length) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn",
      text: ":eyes: *" + hiddenLinks.length + " linked row(s) are hidden or filtered in the sheet, " +
        "so these candidates are NOT syncing.* The run is otherwise fine, which is exactly why " +
        "this is said out loud:\n" +
        hiddenLinks.slice(0, 20).map((h) => "• *" + h.name + "* _(sheet row " + h.rowNumber + ")_").join("\n") +
        (hiddenLinks.length > 20 ? "\n…and " + (hiddenLinks.length - 20) + " more" : "") } });
  }

  /* The measurement for TBD_IS_A_VALUE, on every run whether it is on or off. */
  if (tbdSeen && Object.keys(tbdSeen).length) {
    const total = Object.keys(tbdSeen).reduce((n, k) => n + tbdSeen[k], 0);
    const authoritative = Object.keys(tbdSeen).filter((k) => CONFIG.AUTHORITATIVE.includes(k));
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn",
      text: ":triangular_flag_on_post: *" + total + " cell(s) read TBD* on the rows this run looked at." +
        (CONFIG.TBD_IS_A_VALUE
          ? " TBD is being written to the authoritative fields."
          : " TBD is currently treated as blank. Turning TBD_IS_A_VALUE on would write it to " +
            (authoritative.length
              ? authoritative.map((k) => "*" + k + "* (" + tbdSeen[k] + ")").join(", ")
              : "no authoritative field") + ".") + "\n" +
        Object.keys(tbdSeen).sort().map((k) => "• " + k + ": " + tbdSeen[k]).join("\n") } });
  }

  if (unresolved && unresolved.length) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn",
      text: "*Needs a person.* Linked but not resolvable:\n" +
        unresolved.map((u) => "• " + (u.name || u.candidateId) + ": " + u.reason).join("\n") } });
  }
  if (skipped && skipped.length) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn",
      text: skipped.length + " field(s) left alone because they already have a value" }] });
  }
  return { blocks };
}

/* -------------------------------------------------------------------- run */

async function run({ sheets, getCandidates, putCandidate, dryRun, runId, log = console.log, now = new Date() }) {
  if (!sheets || !sheets.isConfigured()) {
    return {
      outcome: "skipped_unconfigured",
      error: (sheets && sheets.configError && sheets.configError()) || "lib/sheets is not configured",
    };
  }

  const read = await sheets.readRange(CONFIG.RANGE);
  // A failed read is never an empty sheet: that distinction is the whole reason
  // readRange returns a reason instead of [].
  if (!read.ok) return { outcome: "error", error: "sheet read failed: " + read.reason };

  // Bind columns by header before anything reads a cell. A header row that is
  // missing a column we map is a hard stop: the fixed index is a fallback for
  // having no header at all, never for having one that disagrees.
  const resolved = CONFIG.resolveColumns((read.rows || [])[0]);
  if (resolved.missing.length) {
    const names = resolved.missing.map((m) => '"' + m.header + '"').join(", ");
    log("[" + NAME + "] aborted: header row is missing " + names);
    return {
      outcome: "aborted",
      summary: {
        reason: "header_missing", wrote: 0,
        missingHeaders: resolved.missing, movedColumns: resolved.moved,
        duplicatedHeaders: resolved.duplicated,
      },
      error: "Header row is missing mapped column(s): " + names +
             ". Refusing to fall back to a fixed position.",
    };
  }

  // Row visibility is a second read — the values API does not carry it — and it
  // is required, not best-effort. Without it the bot cannot tell an active
  // candidate from one somebody filed away, and defaulting to "visible" would
  // quietly sync the archive.
  const visibility = await sheets.readVisibility({
    tab: CONFIG.SHEET_TAB, rowCount: (read.rows || []).length,
  });
  if (!visibility.ok) {
    log("[" + NAME + "] aborted: row visibility unreadable: " + visibility.reason);
    return {
      outcome: "aborted",
      summary: { reason: "visibility_unreadable", wrote: 0, visibilityError: visibility.reason },
      error: "Could not read row visibility: " + visibility.reason +
             ". Refusing to sync without knowing which rows are hidden.",
    };
  }

  const index = indexSheet(read.rows, resolved, visibility);

  // Metadata that stops short of the data is the same problem as no metadata:
  // those rows would have to be assumed visible, and assuming is the thing this
  // is here to avoid.
  if (index.missingVisibility.length) {
    log("[" + NAME + "] aborted: no visibility for " + index.missingVisibility.length + " row(s)");
    return {
      outcome: "aborted",
      summary: {
        reason: "visibility_incomplete", wrote: 0,
        rowsWithoutVisibility: index.missingVisibility.slice(0, 20),
        rowsWithoutVisibilityCount: index.missingVisibility.length,
        candidateRows: index.counts.candidateRows,
      },
      error: "Row visibility missing for " + index.missingVisibility.length +
             " candidate row(s). Refusing to default them to visible.",
    };
  }

  // Computed before the assertions so it is reported even when a run aborts:
  // "what could the bot not read" is useful precisely when something is wrong.
  const unrecognised = countUnrecognised(index);
  const unrecognisedCount = unrecognised.reduce((n, u) => n + u.count, 0);

  // An empty considered set is an answer, not a fault. Everything is filed
  // away — normal at the end of a cycle — and there is nothing to check the
  // shape of. The assertions only mean anything against rows that exist:
  // "First Name is populated" is false for an empty set and would abort here,
  // reading as a broken sheet when nothing is broken.
  if (index.counts.visibilityKnown && index.rows.length === 0) {
    return {
      outcome: "ok",
      summary: {
        note: "no visible rows to sync",
        rowsRead: 0,
        candidateRows: index.counts.candidateRows,
        visibleRows: index.counts.visible,
        hiddenByUserRows: index.counts.hiddenByUser,
        hiddenByFilterRows: index.counts.hiddenByFilter,
        hasHeader: index.hasHeader,
        columnsBoundBy: resolved.byHeader ? "header" : "index",
        assertionsRun: false,
        unrecognisedCount,
        unrecognised,
        writesPlanned: 0,
        wrote: 0,
      },
      message: planMessage({ writes: [], unresolved: [], skipped: [], conflicts: [], unrecognised, dryRun,
                             note: "no visible rows to sync" }),
    };
  }

  // Assertions next, now that there is something to assert about.
  const assertions = runAssertions(index);
  const failed = assertions.filter((a) => !a.passed);
  if (failed.length) {
    log("[" + NAME + "] aborted: " + failed.length + " assertion(s) failed");
    return {
      outcome: "aborted",
      summary: {
        reason: "assertion_failed", rowsRead: index.rows.length, assertions, wrote: 0,
        unrecognisedCount, unrecognised,
        candidateRows: index.counts.candidateRows,
        visibleRows: index.counts.visible,
        hiddenByUserRows: index.counts.hiddenByUser,
        hiddenByFilterRows: index.counts.hiddenByFilter,
      },
      message: planMessage({ writes: [], unresolved: [], skipped: [], conflicts: [], unrecognised, dryRun, reason: "assertion_failed" }),
    };
  }

  const trackerRows = (await getCandidates()) || [];
  const { writes, skipped, unresolved, hiddenLinks, conflicts, tbdSeen } = plan({ trackerRows, index });

  const summary = {
    // Rows actually considered, i.e. everything not hidden by a person.
    rowsRead: index.rows.length,
    candidateRows: index.counts.candidateRows,
    filledUnset: writes.filter((w) => w.fillReason === "filled_unset").length,
    filledDefault: writes.filter((w) => w.fillReason === "filled_default").length,
    resynced: writes.filter((w) => w.fillReason === "resynced").length,
    // Conflicts ride on every run row whether or not anything was written: they
    // are the point of the authoritative fields, not an edge case. Capped
    // because run_log.summary is read by the panel, not archived.
    conflictCount: conflicts.length,
    conflicts: conflicts.slice(0, 50),
    /* Per field, so the cost of TBD_IS_A_VALUE is a number somebody can read
       before flipping it rather than a surprise afterwards. */
    tbdSeen,
    tbdTotal: Object.keys(tbdSeen).reduce((n, k) => n + tbdSeen[k], 0),
    // Counted, never fatal: one person's word choice must not halt a run.
    unrecognisedCount,
    unrecognised,
    // The plan's own working, per write: which field, why it is a write, and
    // whether sync had written that field before — which is the one fact the
    // cap turns on. Twice today a question the plan already knew took rounds of
    // arithmetic over aggregates to answer, so it is recorded rather than
    // inferred. Capped because run_log.summary is read by the panel.
    writeBreakdown: writes.slice(0, 200).map((w) => ({
      candidateId: w.candidateId,
      candidate: w.candidateName,
      field: w.field,
      cell: w.cell,
      fillReason: w.fillReason,
      hadSource: w.hadSource,
      changing: w.hadSource,
    })),
    // Logged every run so a sudden move in either number is visible in the panel:
    // a jump in hidden means someone archived a batch, a drop means rows came back.
    visibleRows: index.counts.visible,
    hiddenByUserRows: index.counts.hiddenByUser,
    hiddenByFilterRows: index.counts.hiddenByFilter,
    // Linked candidates whose confirmed key names a row somebody hid. Expected
    // as trials finish and get filed away, but a jump means either a batch was
    // archived early or a link is pointing at the wrong person.
    linkedToHiddenRows: hiddenLinks.length,
    hasHeader: index.hasHeader,
    columnsBoundBy: resolved.byHeader ? "header" : "index",
    movedColumns: resolved.moved,
    duplicatedHeaders: resolved.duplicated,
    trackerRows: trackerRows.length,
    linkedRows: trackerRows.filter((r) => linkOf(r)).length,
    writesPlanned: writes.length,
    skippedFields: skipped.length,
    unresolved,
    candidateCap: CONFIG.MAX_CANDIDATES_PER_RUN,
    writeCap: CONFIG.MAX_WRITES_PER_RUN,
    wrote: 0,
  };

  // Blast radius. Over either cap the run writes NOTHING — not the first few.
  const candidatesTouched = new Set(writes.map((w) => w.candidateId));
  summary.candidatesPlanned = candidatesTouched.size;

  // The cap counts candidates whose values sync is CHANGING, drawn on sync's own
  // record, per field:
  //
  //   CHANGING    sheetSource already has an entry for that field
  //   FIRST FILL  it does not — empty or default, no difference
  //
  // The failure it guards is a restructured sheet rewriting the visible set from
  // the wrong columns. Every one of those writes lands on a field sync itself
  // wrote earlier, so every one has a sheetSource entry, so they all count and
  // the cap fires. A bulk link touches fields with no history and passes.
  //
  // Two earlier attempts got this wrong in the same way, by inferring "change"
  // from a label instead of from the record:
  //
  //   - counting filled_default aborted at 9 candidates, because both creation
  //     paths store status: "NOT STARTED" explicitly, so every row carries a
  //     stored default and every first status fill read as a change. It also
  //     contradicted isTrackerEmpty(), which treats a stored default as
  //     unanswered.
  //   - counting any write on a row with ANY history was still wrong: three of
  //     those nine rows had sheetSource from an earlier live run, and were being
  //     counted for writes to fields sync has never touched.
  //
  // KNOWN AND ACCEPTED: a bulk first fill is not capped at any volume. 22
  // candidates at ~7 writes is ~160, so MAX_WRITES_PER_RUN (200) is the only
  // limit on that path. That is the blanks-only safety property intact — no
  // history, on rows a person linked — but if the visible population jumps
  // again, expect a large uncapped run rather than being surprised by one.
  const changing = writes.filter((w) => w.hadSource);
  const candidatesChanging = new Set(changing.map((w) => w.candidateId));
  summary.candidatesChanging = candidatesChanging.size;
  summary.candidatesFirstFill = candidatesTouched.size - candidatesChanging.size;

  if (candidatesChanging.size > CONFIG.MAX_CANDIDATES_PER_RUN) {
    log("[" + NAME + "] aborted: " + candidatesChanging.size +
        " candidates would have values changed, cap is " + CONFIG.MAX_CANDIDATES_PER_RUN);
    return {
      outcome: "aborted",
      summary: { ...summary, reason: "over_candidate_cap" },
      message: planMessage({ writes, unresolved, skipped, conflicts, unrecognised, dryRun, hiddenLinks, tbdSeen,
        reason: "over_candidate_cap", candidateCap: CONFIG.MAX_CANDIDATES_PER_RUN,
        candidates: candidatesChanging.size }),
    };
  }

  // Should be unreachable while the candidate cap holds — see the config.
  if (writes.length > CONFIG.MAX_WRITES_PER_RUN) {
    log("[" + NAME + "] aborted: " + writes.length + " writes planned, backstop is " + CONFIG.MAX_WRITES_PER_RUN);
    return {
      outcome: "aborted",
      summary: { ...summary, reason: "over_write_cap" },
      message: planMessage({ writes, unresolved, skipped, conflicts, unrecognised, dryRun, hiddenLinks, tbdSeen,
        reason: "over_write_cap", cap: CONFIG.MAX_WRITES_PER_RUN }),
    };
  }

  if (dryRun) {
    return {
      outcome: "dry_run",
      summary,
      message: planMessage({ writes, unresolved, skipped, conflicts, unrecognised, dryRun: true, hiddenLinks, tbdSeen }),
    };
  }

  // Apply: one PUT per candidate, so a row is never left half-filled.
  const byId = new Map(trackerRows.map((r) => [r.id, r]));
  const groups = new Map();
  writes.forEach((w) => {
    if (!groups.has(w.candidateId)) groups.set(w.candidateId, []);
    groups.get(w.candidateId).push(w);
  });

  const at = now.toISOString();
  let wrote = 0, rowsTouched = 0;
  for (const [id, ws] of groups) {
    const row = byId.get(id);
    if (!row) continue; // gone since the read — never re-create it
    row.values = row.values || {};
    row.sheetSource = row.sheetSource || {};
    for (const w of ws) {
      row.values[w.field] = w.value;
      // Where the value came from, down to the cell, so any fill can be traced
      // back and undone by hand.
      row.sheetSource[w.field] = {
        tab: w.tab, cell: w.cell, header: w.header, raw: w.raw,
        // The value actually stored. A later run compares the tracker against
        // this to tell "sync still owns it" from "somebody edited it".
        value: w.value,
        fillReason: w.fillReason,
        at, runId: runId == null ? null : runId, by: NAME,
      };
    }
    row.updatedAt = Date.now();
    row.updatedBy = NAME;
    await putCandidate(row);
    wrote += ws.length;
    rowsTouched++;
  }

  log("[" + NAME + "] filled " + wrote + " field(s) across " + rowsTouched + " row(s)");
  return {
    outcome: "ok",
    summary: { ...summary, wrote, rowsTouched },
    message: planMessage({ writes, unresolved, skipped, conflicts, unrecognised, dryRun: false, hiddenLinks, tbdSeen }),
  };
}

module.exports = {
  name: NAME,
  title: "Sheet sync",
  description:
    "Fills empty tracker fields from the WT Tracker sheet, and keeps Desk, Computer and " +
    "MP/DRI matching the sheet. Never overwrites a value someone edited by hand. It flags " +
    "a conflict instead. Never creates or deletes a row, never writes to the sheet, and only " +
    "touches rows a person linked.",
  schedule: { timeZone: "America/Los_Angeles", everyMinutes: 60 },
  // Writes to tracker rows, so it ships dry until a coordinator has read a run.
  defaults: { enabled: true, dryRun: true },
  // Needs the sheet, not Ashby or Slack.
  requires: ["GOOGLE_SA_KEY_B64", "POETIC_SHEET_ID"],
  run,
  suggest,
  _internal: { baseKey, pinnedKey, parseKey, indexSheet, resolveKey, relation, pointsAtHidden,
    provenanceOf,
               currentValue, lastSyncedValue, countUnrecognised,
               isTrackerEmpty, linkOf, plan, runAssertions, planMessage, norm },
};
