"use strict";
const { digest } = require("./service");
// Retention for Google Calendar data held in scheduling.json drafts. The only
// Google-derived data a draft keeps is per session: "busy" flags (an
// interviewer's busy interval from free/busy) and the interviewer label saying
// whether they were free on their primary calendar. Ninety days after the later
// of the draft's last session end and its last audit entry, both are removed.
// The draft itself stays, as do "hours" flags, which come from the client's
// scheduling rules, not Google.
//
// Raw free/busy results are never persisted (booking-routes returns them in the
// response only), and booking-ledger.json plans have no calendar field, so this
// is the one store with anything to remove.
const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = DAY_MS;
// The wording service.postScheduleOption writes after the interviewer's name.
const GOOGLE_LABEL = / \((?:free on primary calendar|calendar clash flagged)\)$/;
const REMOVED_LABEL = " (calendar check details removed after 90 days)";

const latest = values => Math.max(...values.map(v => Date.parse(v)).filter(Number.isFinite));

// When this draft's calendar data falls due, or null if no date can be read
// (kept, and counted in the sweep log, rather than guessed at).
function dueAt(row) {
  const interview = latest((row.plan?.sessions || []).map(s => s.end));
  const updated = latest((row.audit || []).map(a => a.at));
  const from = Math.max(interview, updated);
  return Number.isFinite(from) ? from + RETENTION_DAYS * DAY_MS : null;
}

// The row with its calendar data removed, plus counts, or null if it has none.
function strip(row) {
  let busyFlags = 0, labels = 0;
  const sessions = (row.plan?.sessions || []).map(s => {
    const next = { ...s };
    if (Array.isArray(s.flags)) {
      const kept = s.flags.filter(f => f.kind !== "busy");
      busyFlags += s.flags.length - kept.length;
      if (kept.length) next.flags = kept; else delete next.flags;
    }
    if (typeof s.interviewers === "string" && GOOGLE_LABEL.test(s.interviewers)) {
      next.interviewers = s.interviewers.replace(GOOGLE_LABEL, REMOVED_LABEL);
      labels++;
    }
    return next;
  });
  if (!busyFlags && !labels) return null;
  return { busyFlags, labels, sessions };
}

// One pass over every draft. Each change goes through the store's revision
// check, and the digest is recomputed so the row stays internally consistent:
// a Slack button posted with the old digest is then refused, which is right,
// since the content it showed is gone.
async function sweep({ store, now = Date.now(), log = console.log }) {
  const totals = { drafts: 0, busyFlags: 0, labels: 0, undated: 0, failed: 0 };
  for (const row of await store.list()) {
    const due = dueAt(row);
    if (due === null) { if (strip(row)) totals.undated++; continue; }
    if (due > now) continue;
    const removed = strip(row);
    if (!removed) continue;
    const at = new Date(now).toISOString();
    const plan = { ...row.plan, sessions: removed.sessions };
    const next = { ...row, plan, digest: digest(plan), revision: row.revision + 1,
      audit: [...(row.audit || []), { action: "calendar_data_removed", by: "retention", at, busyFlags: removed.busyFlags, labels: removed.labels }] };
    try {
      if (!await store.replace(row.id, row.revision, next)) throw new Error("draft changed during the sweep");
    } catch (e) {
      totals.failed++;
      log(`[calendar-retention] could not update draft ${row.id}: ${e.message}. It will be retried on the next sweep.`);
      continue;
    }
    totals.drafts++; totals.busyFlags += removed.busyFlags; totals.labels += removed.labels;
    log(`[calendar-retention] draft ${row.id}: removed ${removed.busyFlags} busy interval(s) and ${removed.labels} calendar label(s); due ${new Date(due).toISOString().slice(0, 10)}`);
  }
  log(`[calendar-retention] sweep done: ${totals.drafts} draft(s) updated, ${totals.busyFlags} busy interval(s) and ${totals.labels} label(s) removed` +
    (totals.failed ? `, ${totals.failed} failed (retried next sweep)` : "") +
    (totals.undated ? `, ${totals.undated} with calendar data but no readable date (kept)` : ""));
  return totals;
}

// On startup, then daily. The timer is unref'd so it never holds the process open.
function startCalendarRetention({ store, log = console.log }) {
  const run = () => sweep({ store, log }).catch(e => log(`[calendar-retention] sweep failed: ${e.message}`));
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = { sweep, strip, dueAt, startCalendarRetention, RETENTION_DAYS };
