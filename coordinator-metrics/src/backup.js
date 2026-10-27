"use strict";

/**
 * Scheduled backups of the SQLite file.
 *
 * Railway volumes are NOT backed up by default, and most of what is in
 * this database is not re-derivable:
 *
 *   - `reschedules` is the directly observed reschedule history. It can
 *     only ever be recorded forward from the first sync. Lose it and it
 *     is gone — a re-sync produces the derived figure and nothing else.
 *   - `sync_runs` is the operational history behind "last synced".
 *
 * The rest (schedules, events, applications) is re-derivable at the cost
 * of a ~21-minute full backfill across six clients, which is painful
 * rather than fatal. The 503 observed reschedules are the reason this
 * file exists.
 *
 * TWO THINGS HERE ARE LOAD-BEARING:
 *
 * 1. **`VACUUM INTO`, never a file copy.** The database runs in WAL mode
 *    and is written to continuously by the sync. `cp metrics.sqlite`
 *    while a write is in flight produces a file that may open fine and
 *    be missing committed rows, or be outright corrupt — and you find
 *    out when you restore. `VACUUM INTO` takes a read lock and writes a
 *    consistent, fully-checkpointed snapshot with no WAL sidecar.
 *
 * 2. **Every snapshot is integrity-checked before it counts.** A backup
 *    that is never restored is a guess. This cannot restore on a
 *    schedule, but it can refuse to call a snapshot good until SQLite
 *    has opened it, run `PRAGMA integrity_check`, and found the
 *    not-re-derivable table present and readable.
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
const config = require("./config");
const store = require("./db");

// Kept in memory and surfaced through /api/config, because a backup that
// fails silently is worse than no backup: it removes the worry without
// removing the risk. This project has already shipped three failures
// behind a green suite.
let lastRun = null;

function backupDir() {
  return config.backupDir || path.join(config.dataDir, "backups");
}

/** ISO instant, filesystem-safe: 2026-10-27T14-30-05Z. */
function stamp(date = new Date()) {
  return date.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

/**
 * Consistent snapshot of the live database, verified, gzipped.
 * Returns { file, bytes, rawBytes, checks }.
 */
function snapshot(targetDir = backupDir()) {
  fs.mkdirSync(targetDir, { recursive: true });

  const base = `metrics-${stamp()}.sqlite`;
  const raw = path.join(targetDir, base);
  const gz = `${raw}.gz`;

  // VACUUM INTO refuses to overwrite, so a retry after a crash must not
  // trip over a half-written file from the previous attempt.
  for (const leftover of [raw, gz]) {
    try {
      fs.unlinkSync(leftover);
    } catch (_) {
      /* not there, which is the normal case */
    }
  }

  // The read-only handle is deliberate: this must never be able to
  // write to the live database, whatever else goes wrong here.
  const live = new DatabaseSync(store.FILE, { readOnly: true });
  try {
    live.exec(`VACUUM INTO '${raw.replace(/'/g, "''")}'`);
  } finally {
    live.close();
  }

  // Verify the snapshot, not the original. The point is to know this
  // specific file is restorable.
  const checks = {};
  const copy = new DatabaseSync(raw, { readOnly: true });
  try {
    checks.integrity = copy.prepare("PRAGMA integrity_check").get().integrity_check;
    checks.reschedules = Number(copy.prepare("SELECT COUNT(*) n FROM reschedules").get().n);
    checks.events = Number(copy.prepare("SELECT COUNT(*) n FROM events").get().n);
    checks.schedules = Number(copy.prepare("SELECT COUNT(*) n FROM schedules").get().n);
  } finally {
    copy.close();
  }

  if (checks.integrity !== "ok") {
    fs.unlinkSync(raw);
    throw new Error(`snapshot failed integrity_check: ${checks.integrity}`);
  }
  // A snapshot with no events is a sync that has not run yet or a
  // database that has been emptied. Either way it must not quietly
  // replace good backups in the retention window.
  if (!(checks.events > 0 && checks.schedules > 0)) {
    fs.unlinkSync(raw);
    throw new Error(`snapshot looks empty (events=${checks.events}, schedules=${checks.schedules}) — refusing it`);
  }

  const rawBytes = fs.statSync(raw).size;
  fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(raw), { level: 9 }));
  fs.unlinkSync(raw);

  return { file: gz, bytes: fs.statSync(gz).size, rawBytes, checks };
}

/**
 * Keeps the most recent `keepDaily` snapshots, plus the first snapshot
 * of each of the last `keepMonthly` months.
 *
 * Monthly retention matters more than it looks: the failure this guards
 * against is not only "the volume died", it is "something corrupted a
 * table three weeks ago and nobody noticed". Thirty dailies do not help
 * if the damage predates all of them.
 */
function prune(dir = backupDir(), { keepDaily = 30, keepMonthly = 12 } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /^metrics-.*\.sqlite\.gz$/.test(n)).sort();
  } catch (_) {
    return { kept: [], removed: [] };
  }

  const keep = new Set(names.slice(-keepDaily));

  const monthSeen = new Map();
  for (const name of names) {
    const month = name.slice("metrics-".length, "metrics-".length + 7); // YYYY-MM
    if (!monthSeen.has(month)) monthSeen.set(month, name);
  }
  for (const name of [...monthSeen.values()].slice(-keepMonthly)) keep.add(name);

  const removed = [];
  for (const name of names) {
    if (keep.has(name)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch (_) {
      /* already gone */
    }
  }
  return { kept: [...keep].sort(), removed };
}

/**
 * Take a snapshot, hand it to the configured destination, prune.
 *
 * With no destination configured this still runs and still keeps the
 * snapshot — on the same volume as the original, which protects against
 * a bad migration, an accidental delete or logical corruption, but NOT
 * against losing the volume. That is a real gap, so it is reported as a
 * warning on every run and carried in the status this exposes, rather
 * than being allowed to look like a working backup.
 */
async function run({ reason = "manual" } = {}) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  try {
    const snap = snapshot();

    let destination = "volume";
    let offsite = false;
    const sink = require("./backup-sinks").configured();
    if (sink) {
      await sink.put(snap.file);
      await sink.prune({ keepDaily: config.backupKeepDaily, keepMonthly: config.backupKeepMonthly });
      destination = sink.name;
      offsite = true;
    }

    // With an off-site destination the local copies are only staging,
    // so a handful is enough for a fast restore. Without one they ARE
    // the backup and the full retention has to live on the volume —
    // which is both the reason this is not good enough on its own and
    // the reason it is still worth keeping.
    const pruned = offsite
      ? prune(backupDir(), { keepDaily: 3, keepMonthly: 1 })
      : prune(backupDir(), { keepDaily: config.backupKeepDaily, keepMonthly: config.backupKeepMonthly });

    lastRun = {
      ok: true,
      reason,
      startedAt,
      ms: Date.now() - t0,
      bytes: snap.bytes,
      rawBytes: snap.rawBytes,
      checks: snap.checks,
      destination,
      offsite,
      removed: pruned.removed.length,
      error: null,
    };

    console.log(
      `[backup] ${reason}: ${(snap.bytes / 1048576).toFixed(1)}MB gz ` +
        `(from ${(snap.rawBytes / 1048576).toFixed(0)}MB), ${snap.checks.reschedules} observed reschedules, ` +
        `-> ${destination} in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
        (pruned.removed.length ? `, pruned ${pruned.removed.length}` : "")
    );
    if (!offsite) {
      console.warn(
        "[backup] WARNING: no off-site destination configured, so this snapshot sits on the SAME volume as " +
          "the database it backs up. A volume incident loses both. Set BACKUP_S3_* to fix."
      );
    }
    return lastRun;
  } catch (err) {
    lastRun = { ok: false, reason, startedAt, ms: Date.now() - t0, error: err.message };
    console.error(`[backup] FAILED (${reason}): ${err.message}`);
    return lastRun;
  }
}

function status() {
  return {
    configured: Boolean(require("./backup-sinks").configured()),
    dir: backupDir(),
    last: lastRun,
  };
}

module.exports = { run, snapshot, prune, status, backupDir, stamp };
