"use strict";

/**
 * bots/sheet-sync.config.js — column map for the WT Tracker sheet.
 *
 * Fills empty tracker fields from the sheet, and keeps the three fields the sheet
 * owns matching it. Never overwrites a value somebody edited by hand — that is a
 * conflict — never touches an Ashby-owned field, never creates or deletes rows,
 * and never writes back to the sheet.
 *
 * Deliberate exception to the 27 Aug standing rule (no bot writes without approval),
 * accepted 8 Sep because filling a blank is trivially reversible: undo is clearing it.
 * Everything below exists to protect that property.
 */

// ---------------------------------------------------------------- source

const SHEET_TAB = "WT Tracker";
// Read well past the mapped columns (AA today). Columns are bound by header
// name, not position, so extra width costs nothing and leaves room for inserted
// columns to land INSIDE the read — outside it, a mapped column simply vanishes
// and the run aborts. Trailing empty columns are ignored by the resolver.
const RANGE = `'${SHEET_TAB}'!A:BZ`;

// ---------------------------------------------------------------- blanks

/**
 * Treated as empty on BOTH sides. Confirmed with Hayley 8 Sep: "TBD" in Computer
 * means no laptop assigned yet, so writing it would permanently block the real
 * machine name from ever landing (non-empty is never overwritten).
 */
/* One definition of the sentinel, shared with the suggester rather than
   restated. The two disagreeing about this string is the defect. */
const INVENTORY = require("../lib/assignment-inventory");
const TBD = "TBD";
const TBD_MARKERS = INVENTORY.DESK_NEEDS_SUGGESTION.map((v) => String(v).toLowerCase());
function isTbd(v) {
  return TBD_MARKERS.includes(String(v == null ? "" : v).trim().toLowerCase());
}

/* Flip to true to let TBD overwrite a real value on desk, computer and
   driName. Measure first: every run reports tbdSeen per field whatever this
   says. */
const TBD_IS_A_VALUE = false;

const BLANK_EQUIVALENTS = ["", "-", "—", "?", "tbd", "tbc", "n/a", "na", "none", "pending"];

function isBlank(v) {
  return v === null || v === undefined ||
    BLANK_EQUIVALENTS.includes(String(v).trim().toLowerCase());
}

/**
 * Not-yet markers, for columns whose vocabulary is "a real value OR a marker
 * saying there is not one yet". A placeholder is absence, not content.
 *
 * "NOT YET" is the one that was getting through — the rest are already in
 * BLANK_EQUIVALENTS, and are repeated here so this reads as a rule rather than
 * as one patched value.
 *
 * THIS CANNOT BE GLOBAL, and that is the whole point. "NOT YET" is a real,
 * meaningful value in every toggle column: it is the tracker's own word for
 * "not done". Blanking it everywhere would stop the sheet ever saying a toggle
 * is outstanding. The same five characters are absence in a name field and data
 * in a toggle field, and the only thing that can tell them apart is the column.
 *
 * Without this, column M's "NOT YET" was going to be written into driName as a
 * main partner's name for two candidates.
 */
const NOT_YET_MARKERS = ["not yet", "tbd", "n/a", "-", "—"];

/** Blank for THIS column: the global set, plus any markers the column declares. */
function isBlankFor(v, spec) {
  if (isBlank(v)) return true;
  const extra = (spec && spec.blankAlso) || null;
  if (!extra) return false;
  return extra.includes(String(v == null ? "" : v).trim().toLowerCase());
}

// KNOWN LIMITATION — a deliberate default is indistinguishable from an
// untouched field, and that is accepted.
//
// A field holding its default value looks the same whether a coordinator chose
// that value on purpose or nobody has ever touched it. isTrackerEmpty() treats
// both as empty, and sync fills from the sheet.
//
// Accepted 9 Sep 2026, on the grounds that the sheet is the more current
// operational record, and that a stored default is far more often the creation
// seed than a considered answer — both creation paths in the tracker store
// status: "NOT STARTED" outright.
//
// Two consequences, both intended:
//   - these writes are first fills, so they do not count against
//     MAX_CANDIDATES_PER_RUN and are not reviewed
//   - a person who deliberately set a default has no way to say so, and will
//     see it overwritten
//
// Do NOT "fix" this by counting filled_default as a changing write. That was
// tried — see the cap history in run() — and it made every newly linked
// candidate count against the cap, blocking two consecutive runs on 9 Sep for
// no benefit. If this limitation ever has to actually go away, the fix is a real
// "set by a person" marker on the field, not an inference from its current
// value.

// ---------------------------------------------------------------- columns

/**
 * mode:
 *   "key"    — identity, used for matching, never written
 *   "ashby"  — Ashby owns it, bot 1 renders it live. NEVER WRITE.
 *   "sync"   — fill when the tracker field is empty; if the column is also
 *                marked authoritative, keep it matching the sheet thereafter
 *   "skip"   — deliberately excluded, reason given
 *
 * authoritative: true — the sheet is the source of truth for this field, so it
 *   is kept matching the sheet on every run, not filled once. Only where the
 *   sheet is genuinely where the answer is decided: the desk and laptop come
 *   from IT's own columns, and the MP/DRI is agreed in the sheet.
 *
 *   It never overwrites a person. sheetSource records what sync last wrote, so
 *   a tracker value that still equals it is sync's to update, and one that does
 *   not is somebody's edit — that becomes a CONFLICT and is left alone. A
 *   coordinator who fixed a desk assignment must not have it reverted an hour
 *   later by a stale sheet row.
 *
 * `field` values are the tracker's keys in `values`, verified 8 Sep 2026 against the
 * live definitions in public/index.html (var SECTIONS, line 414) — the 27 keys of
 * ALLFIELDS. assertFieldsExist() below refuses to run if any key is unknown.
 */
const COLUMNS = [
  { i: 0,  col: "A",  header: "First Name",                    mode: "key" },
  { i: 1,  col: "B",  header: "Last Name",                     mode: "key" },
  { i: 2,  col: "C",  header: "Position",                      mode: "ashby" },

  // D was skipped on the grounds that "every trial is SF", which the real
  // inventory disproves: there are NY laptops, NY desks and Hyde House. The
  // laptop suggester filters on location and must not guess, so the column is
  // carried across as text.
  //
  // FILL-ONLY, not authoritative. E, G and M are authoritative because the
  // sheet is where a desk, a laptop and a partner are decided. A location is
  // decided before any of that and rarely changes, so there is no case for
  // reverting a coordinator's correction to it an hour later.
  { i: 3,  col: "D",  header: "WT Location",                   mode: "sync", field: "location",
    blankAlso: NOT_YET_MARKERS },

  // E and G now have fields of their own (added 8 Sep), so the machine name and the
  // desk are carried across as text. F stays out: "Laptop Cleared?" is the evidence
  // behind laptopDesk moving to ASSIGNED, not a fact the tracker holds separately.
  { i: 4,  col: "E",  header: "Computer",                      mode: "sync", field: "computer", authoritative: true,
    blankAlso: NOT_YET_MARKERS },
  { i: 5,  col: "F",  header: "Laptop Cleared?",               mode: "skip",
    reason: "evidence for laptopDesk status, not a separate fact" },
  { i: 6,  col: "G",  header: "Desk",                          mode: "sync", field: "desk", authoritative: true,
    blankAlso: NOT_YET_MARKERS },

  { i: 7,  col: "H",  header: "Start Date",                    mode: "ashby" },
  { i: 8,  col: "I",  header: "End Date",                      mode: "ashby" },
  { i: 9,  col: "J",  header: "Status",                        mode: "sync", field: "status", type: "enum",
    values: ["NOT STARTED", "IN PROGRESS", "DONE", "CANCELED"] },
  { i: 10, col: "K",  header: "Excep bg screen status",        mode: "ashby" },
  { i: 11, col: "L",  header: "Calendar Hold Sent?",           mode: "sync", field: "calendarHold", type: "enum",
    values: ["YES", "NOT YET"], whenTrue: "YES", whenFalse: "NOT YET" },
  { i: 12, col: "M",  header: "Confirmed MP/DRI",              mode: "sync", field: "driName", authoritative: true,
    blankAlso: NOT_YET_MARKERS },
  { i: 13, col: "N",  header: "Work Trial Scheduled",          mode: "ashby" },
  { i: 14, col: "O",  header: "FDE: Share AS Docs",            mode: "sync", field: "fdeShareDocs",  type: "bool" },
  { i: 15, col: "P",  header: "FDS: 9pm DRI Reminder",         mode: "sync", field: "fds9pm",        type: "bool" },

  // NOT the Ashby field. Ashby knows agent shadowing is *scheduled*; it has no idea
  // whether the recording was shared afterward. Different fact, similar name.
  // Maps to agentShadowRec, NOT agentShadowSched — the tracker draws the same distinction.
  // Synonyms are per column, for the same reason the not-yet markers are: these
  // are words THIS column uses, and the same word means something else
  // elsewhere. "NOT YET" here means the recording was not shared; in column L it
  // is a toggle's own value. A global list would be defensible and would also
  // quietly couple columns that have nothing to do with each other.
  //
  // Found on 9 Sep by the unrecognised-value count: 9 cells in this column had
  // been silently doing nothing, 5 of them saying the recording WAS shared.
  /* SEEN 14 Sep 2026, one row: "BOOKING LINK SENT". Not mapped, deliberately.
     It is neither SHARED nor N/A, and whether a sent booking link counts as
     the recording being shared is Tess's shadowing-scope question, still open.
     normalise() declines it, countUnrecognised reports it every run, and
     nothing is written. Recorded here so the value is not lost while the
     question is, and so the next person to widen this column knows it exists. */
  { i: 16, col: "Q",  header: "FDE: Agent Shadowing Recording Shared?",
    mode: "sync", field: "agentShadowRec", type: "enum",
    values: ["NOT SHARED", "SHARED", "N/A"], whenTrue: "SHARED", whenFalse: "NOT SHARED",
    synonyms: { "recording shared": "SHARED", "not yet": "NOT SHARED" } },

  { i: 17, col: "R",  header: "Debrief Scheduled?",            mode: "ashby" },

  // Header says "(Ashby)" but there is no e-signature endpoint — ten plausible names
  // 404 (bot 1 API findings). This is manual despite the label.
  { i: 18, col: "S",  header: "NDA & Workplace Agreement (Ashby)",
    mode: "sync", field: "nda", type: "enum",
    values: ["NOT SENT", "SENT", "COMPLETED"], whenTrue: "COMPLETED", whenFalse: "NOT SENT" },

  { i: 19, col: "T",  header: "Ramp + make Linear ticket",     mode: "sync", field: "rampLinear", type: "enum",
    values: ["NOT COMPLETED", "IN PROGRESS", "COMPLETED"], whenTrue: "COMPLETED", whenFalse: "NOT COMPLETED" },

  // Int/Ext -> Team/Chat, on the pairing at column X: the sheet's "Ext Channel" is the
  // tracker's "Chat Slack" (laptopChat), so Ext = Chat and Int = Team.
  { i: 20, col: "U",  header: "Int Slack Updated",             mode: "sync", field: "teamSlack", type: "enum",
    values: ["NOT COMPLETED", "IN PROGRESS", "COMPLETED"], whenTrue: "COMPLETED", whenFalse: "NOT COMPLETED" },
  { i: 21, col: "V",  header: "Ext Slack Updated",             mode: "sync", field: "chatSlack", type: "enum",
    values: ["NOT COMPLETED", "IN PROGRESS", "COMPLETED"], whenTrue: "COMPLETED", whenFalse: "NOT COMPLETED" },

  // "NOT COMPLETED" is this sheet's word for a toggle that is not done — 8 cells
  // in each of these two columns. It is NOT put in the global FALSEISH list:
  // "NOT COMPLETED" is a real option of teamSlack and chatSlack, and a global
  // rule would mean one word carrying two jobs across columns that share nothing.
  { i: 22, col: "W",  header: "Laptops Added to Cal?",         mode: "sync", field: "laptopInvites", type: "enum",
    values: ["YES", "NOT YET"], whenTrue: "YES", whenFalse: "NOT YET",
    synonyms: { "not completed": "NOT YET", "completed": "YES" } },
  { i: 23, col: "X",  header: "Laptops Added to Ext Channel?", mode: "sync", field: "laptopChat", type: "enum",
    values: ["YES", "NOT YET"], whenTrue: "YES", whenFalse: "NOT YET",
    synonyms: { "not completed": "NOT YET", "completed": "YES" } },
  // Column Y was "Pre-work status" until 9 Sep 2026, when it was deleted from the
  // sheet and this column became the text-intro reminder. preWork is therefore
  // NOT remapped: the tracker field stays and stays manual, because no sheet
  // column holds that answer any more. Repointing it at a neighbour would be a
  // guess dressed as a mapping.
  //
  // Y itself was empty in all 22 visible rows when it was mapped, so the YES /
  // NOT YET vocabulary below is taken from the tracker's own toggle rather than
  // confirmed against data. An unexpected value normalises to null and writes
  // nothing, so the failure mode is silence, not a wrong value.
  { i: 24, col: "Y",  header: "Slack Reminder for Text Intro",  mode: "sync", field: "himaReminder",
    type: "enum", values: ["YES", "NOT YET"], whenTrue: "YES", whenFalse: "NOT YET" },

  // "Introduced candidate to welcome DRI over text" was column Z until 9 Sep 2026.
  // It is gone from the sheet, replaced by the text-intro reminder now mapped at
  // Y, so its entry is removed rather than left pointing at nothing. It was
  // mode "skip", which is why its disappearance did NOT abort a run: only key
  // and sync columns are required. A deleted column we were ignoring costs
  // nothing — but it does mean the map can drift from the sheet in silence.
  //
  // For the record, it was skipped on 8 Sep because himaReminder tracks the
  // reminder being sent, not the introduction having happened. The new Y column
  // is the reminder, which is the thing the tracker actually holds.

  // Excluded 8 Sep. Notes are narrative: under fill-once the first sheet note ever
  // seen would win permanently and later ones vanish silently. Making it
  // authoritative would be worse — it would overwrite whatever a coordinator had
  // written. Show it read-only beside the tracker's notes instead of merging.
  // Moved AA -> Z on 9 Sep 2026 when Pre-work status was deleted. Position is a
  // fallback for a sheet with no header row, but col is the identity the
  // assertions and letterFor() agree on, so both move together.
  { i: 25, col: "Z", header: "Notes", mode: "skip",
    reason: "narrative field, so blank-fill would silently drop later notes" },
];

const ASHBY_OWNED = COLUMNS.filter((c) => c.mode === "ashby").map((c) => c.col);
const SYNCABLE = COLUMNS.filter((c) => c.mode === "sync");
/** Fields the sheet keeps matching, rather than filling once. */
const AUTHORITATIVE = SYNCABLE.filter((c) => c.authoritative).map((c) => c.field);

// ---------------------------------------------------------------- resolving

/** Header text, compared insensitively to case, punctuation and spacing. */
const normHeader = (s) =>
  String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
function letterFor(i) {
  let n = Number(i);
  if (!Number.isInteger(n) || n < 0) return null;
  let out = "";
  n += 1;
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Columns whose absence changes what the bot does: identity (A and B) and
 * anything it writes. A missing "ashby" or "skip" header costs only context on a
 * suggestion, so it is reported rather than treated as a failure.
 */
const REQUIRED_MODES = ["key", "sync"];

/**
 * Bind every column to a live position by MATCHING ITS HEADER TEXT.
 *
 * The fixed `i` above stays as the fallback for a sheet with NO header row —
 * which is how this one read until 8 Sep 2026. It is deliberately not a fallback
 * for a header row that is present but does not carry a column we map: that
 * comes back in `missing` and the run aborts. Falling through to a position is
 * exactly how a single inserted column ends up writing one field's data into the
 * next field along, with every value still looking plausible.
 *
 * Matching is exact once normalised, never fuzzy or partial. "Int Slack Updated"
 * and "Ext Slack Updated" differ by one letter, and a partial match could bind
 * either to the other — which would silently swap two fields.
 */
function resolveColumns(headerRow) {
  if (!headerRow || !isHeaderRow(headerRow)) {
    return {
      byHeader: false,
      columns: COLUMNS.map((c) => ({ ...c, at: c.i, atCol: letterFor(c.i), resolvedBy: "index" })),
      missing: [], moved: [], duplicated: [],
    };
  }

  // First occurrence wins; a repeated header is ambiguous and worth saying so.
  const seen = new Map(), duplicated = [];
  headerRow.forEach((h, i) => {
    const k = normHeader(h);
    if (!k) return;
    if (seen.has(k)) duplicated.push({ header: String(h).trim(), at: [letterFor(seen.get(k)), letterFor(i)] });
    else seen.set(k, i);
  });

  const columns = [], missing = [], moved = [];
  for (const c of COLUMNS) {
    const at = seen.has(normHeader(c.header)) ? seen.get(normHeader(c.header)) : null;
    if (at == null) {
      if (REQUIRED_MODES.includes(c.mode)) {
        missing.push({ col: c.col, header: c.header, mode: c.mode, field: c.field || null });
      }
      columns.push({ ...c, at: null, atCol: null, resolvedBy: "absent" });
      continue;
    }
    if (at !== c.i) moved.push({ header: c.header, from: c.col, to: letterFor(at) });
    columns.push({ ...c, at, atCol: letterFor(at), resolvedBy: "header" });
  }
  return { byHeader: true, columns, missing, moved, duplicated };
}

/** One resolved column, found by the letter it was mapped at — its stable identity. */
function resolvedFor(resolved, col) {
  return ((resolved && resolved.columns) || []).filter((c) => c.col === col)[0] || null;
}

// ---------------------------------------------------------------- normalising

const TRUEISH  = ["yes", "y", "true", "done", "complete", "completed", "✓", "x", "1"];
const FALSEISH = ["no", "n", "false", "not done", "0"];

/**
 * Returns the value to write, or null meaning "nothing to write".
 *
 * The value written is always in the TRACKER's vocabulary, never the sheet's. Verified
 * 8 Sep against public/index.html: a "pcheck" field stores a real boolean (`v === true`,
 * line 481), a "toggle" stores "YES" / "NOT YET", and a "select" stores its own uppercase
 * option string. Writing a boolean into a select renders as nothing at all, so `values`
 * below is the tracker's option list, matched case-insensitively but returned in the
 * tracker's casing.
 *
 * whenTrue / whenFalse exist for the yes-no sheet columns whose tracker field is a
 * select: "Yes" in the sheet means COMPLETED, not `true`. A field without them accepts
 * only a real option name, so an unexpected cell writes nothing rather than a guess.
 */
function normalise(raw, spec) {
  /* TBD IS A DECISION, NOT A BLANK. In this sheet it means "this needs
     assigning", which is not the same thing as nobody having said anything.
     The suggester has always known that — assignment-inventory's
     DESK_NEEDS_SUGGESTION is exactly this string — and the sync did not, so
     the two disagreed about what one cell meant.

     Only for the AUTHORITATIVE fields. Everywhere else TBD stays blank,
     because on a yes/no or an enum column it really is an absence of answer.

     OFF BY DEFAULT. Turning it on rewrites real values in the tracker, and
     the count of how many is reported by every run regardless, so the size of
     the change can be read before it is made rather than discovered. */
  if (TBD_IS_A_VALUE && spec.authoritative && isTbd(raw)) return TBD;
  if (isBlankFor(raw, spec)) return null;
  const v = String(raw).trim();
  const l = v.toLowerCase();

  // Only pcheck fields genuinely store booleans.
  if (spec.type === "bool") {
    if (TRUEISH.includes(l)) return true;
    if (FALSEISH.includes(l)) return false;
    return null; // unrecognised — never guess
  }

  if (spec.type === "enum") {
    // 1. the cell already names one of the tracker's options
    const match = spec.values.find((x) => x.toLowerCase() === l);
    if (match) return match;
    // 2. a word this column uses for one of them. Declared per column, and
    //    checked before the generic yes/no rules so an explicit mapping always
    //    beats a guess from TRUEISH.
    if (spec.synonyms && Object.prototype.hasOwnProperty.call(spec.synonyms, l)) {
      return spec.synonyms[l];
    }
    // 3. a yes/no cell, mapped onto the option the field nominates
    if (spec.whenTrue && TRUEISH.includes(l)) return spec.whenTrue;
    if (spec.whenFalse && FALSEISH.includes(l)) return spec.whenFalse;
    return null; // unrecognised — never guess
  }

  return v;
}

// ---------------------------------------------------------------- guards

/**
 * Blast radius, primary guard: how many CANDIDATES one run may touch.
 *
 * Counted in candidates rather than fields because a candidate is the unit a
 * person reviews. One candidate can legitimately need every syncable field
 * filled at once — a freshly linked row does — so a cap counted in writes
 * punishes the ordinary case and says nothing about the failure it is for.
 *
 * The failure it IS for: the sheet gets restructured, and the bot fills blanks
 * across the whole visible set from the wrong columns. That shows up as many
 * candidates changing in one run, which is what this catches. Over the cap,
 * write nothing and raise — not the first five.
 */
const MAX_CANDIDATES_PER_RUN = 5;

/**
 * Backstop only, deliberately far above anything the candidate cap allows.
 *
 * With 15 syncable fields and a candidate cap of 5, a legitimate run cannot
 * plan more than 75 writes, so this should never fire. It is here for the
 * pathological case the candidate count cannot see — a bug planning the same
 * field repeatedly, or the column map growing enormously — where the run should
 * stop rather than proceed on the strength of a low candidate count.
 */
const MAX_WRITES_PER_RUN = 200;

/**
 * Shape assertions — cheap sanity checks that the columns still mean what we think.
 * Modelled on bot 6's zero-pools guard: a wrong-shaped read must fail loudly,
 * never produce a clean-looking result.
 */
/**
 * Shape assertions. SHAPE, not vocabulary.
 *
 * These exist for one failure: this column has stopped holding the kind of thing
 * it used to hold. They abort the run, so the bar for including one is that
 * continuing would be worse than stopping.
 *
 * They no longer carry the weight they did. Columns bind by header text now, so a
 * column cannot be mis-assigned by a shift — if "Status" moves, its data moves
 * with it. What is left is the case where the header stays and the content
 * changes kind, e.g. somebody repurposes a column to hold dates.
 *
 * A value this bot simply does not recognise is NOT a shape failure. It is
 * counted and reported, and normalise() declines to write it.
 */
const ASSERTIONS = [
  // Column J used to assert the Status VOCABULARY, and aborted the whole run on
  // anything it did not know. On 8 Sep it did exactly that: two hidden rows read
  // "WITHDREW" and "ENDED EARLY", and all 120 rows stopped syncing hourly over
  // two words nobody had added to a list.
  //
  // A vocabulary is not a shape. One person's word choice must never halt a run,
  // so unrecognised values are COUNTED and reported instead — see
  // countUnrecognised() in bots/sheet-sync.js — and normalise() already declines
  // to write them, so nothing wrong reaches the tracker either way.
  //
  // What is left here is shape only: a value long enough to be a note, or shaped
  // like a date, means this column is no longer holding statuses at all.
  //
  // Note it cannot reject yes/no the way E and G do: "DONE" is in TRUEISH, and it
  // is a perfectly good status.
  {
    col: "J",
    describe: "Status looks like a status, not a date or a paragraph",
    test: (vals) => vals.filter((v) => !isBlank(v)).every((v) => {
      const t = String(v).trim();
      if (t.length > 30) return false;
      if (/^\d{4}-\d{1,2}-\d{1,2}/.test(t)) return false;      // 2026-09-14
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t)) return false; // 14/09/2026
      return true;
    }),
  },
  {
    col: "D",
    describe: "Location looks like a location, not a date or a yes/no",
    test: (vals) => vals.filter((v) => !isBlank(v)).every((v) => {
      const t = String(v).trim();
      if (t.length > 40) return false;                          // a note, not a place
      if (/^\d{4}-\d{1,2}-\d{1,2}/.test(t)) return false;       // C or H slid into D
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t)) return false;
      if (/^(yes|no|y|n|true|false)$/i.test(t)) return false;   // F slid left
      return true;
    }),
  },
  // E and G replaced the old column-D length check when they became syncable.
  // Both guard the same failure: the sheet gains or loses a column, everything
  // shifts by one, and a free-text field quietly accepts whatever lands in it.
  // A yes/no in Computer means F ("Laptop Cleared?") has slid left; a date in
  // Desk means H ("Start Date") has slid left. Neither can be normalised away,
  // because free text accepts anything — so it has to be caught here.
  {
    col: "E",
    describe: "Computer looks like a machine name, not a yes/no",
    test: (vals) => vals.filter((v) => !isBlank(v)).every((v) => {
      const t = String(v).trim();
      if (t.length > 40) return false;
      const l = t.toLowerCase();
      return !TRUEISH.includes(l) && !FALSEISH.includes(l);
    }),
  },
  {
    col: "G",
    describe: "Desk looks like a desk, not a date or a yes/no",
    test: (vals) => vals.filter((v) => !isBlank(v)).every((v) => {
      const t = String(v).trim();
      if (t.length > 40) return false;
      if (/^\d{4}-\d{1,2}-\d{1,2}/.test(t)) return false;      // 2026-09-14
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t)) return false; // 14/09/2026
      const l = t.toLowerCase();
      return !TRUEISH.includes(l) && !FALSEISH.includes(l);
    }),
  },
  {
    col: "A",
    describe: "First Name column is populated",
    test: (vals) => vals.filter((v) => !isBlank(v)).length > 0,
  },
];

/**
 * Is this row the header?
 *
 * Detected rather than assumed: row 1 of the live sheet read as data until 8 Sep
 * 2026 (Andrew Mi), and both shapes still have to work.
 *
 * It looks for the identity headers ANYWHERE in the row, not at positions 0 and
 * 1. Detecting the header by position would defeat resolveColumns entirely: a
 * column inserted at A moves "First Name" to B, the row stops looking like a
 * header, every mapped column falls back to its old index, and the header row
 * itself gets read as a candidate. Which is precisely the failure the header
 * matching exists to prevent.
 */
function isHeaderRow(row = []) {
  const wanted = COLUMNS.filter((c) => c.mode === "key").map((c) => normHeader(c.header));
  if (!wanted.length) return false;
  const present = new Set((row || []).map(normHeader).filter(Boolean));
  return wanted.every((h) => present.has(h));
}

/** Refuse to run if any mapped field key is unknown to the tracker. */
function assertFieldsExist(knownFieldKeys) {
  const unknown = SYNCABLE.map((c) => c.field).filter((f) => !knownFieldKeys.includes(f));
  if (unknown.length) {
    throw new Error(
      `sheet-sync: unknown tracker field keys, refusing to run: ${unknown.join(", ")}`
    );
  }
}

module.exports = {
  SHEET_TAB,
  RANGE,
  COLUMNS,
  SYNCABLE,
  ASHBY_OWNED,
  AUTHORITATIVE,
  REQUIRED_MODES,
  normHeader,
  letterFor,
  resolveColumns,
  resolvedFor,
  BLANK_EQUIVALENTS,
  NOT_YET_MARKERS,
  MAX_CANDIDATES_PER_RUN,
  MAX_WRITES_PER_RUN,
  ASSERTIONS,
  isBlank,
  isBlankFor,
  isTbd,
  TBD,
  TBD_IS_A_VALUE,
  normalise,
  isHeaderRow,
  assertFieldsExist,
};
