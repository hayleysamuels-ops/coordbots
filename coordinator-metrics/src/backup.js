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

/**
 * Last-run state, PERSISTED rather than held in memory.
 *
 * Two reasons, both found the hard way. A manual `npm run backup` runs
 * in its own process, so an in-memory record left the server reporting
 * `last: null` immediately after a successful upload. And the record
 * died on every redeploy, which is exactly when someone would want to
 * know whether backups were still working.
 *
 * `sync_meta` is keyed by client; "__backup__" is a sentinel that
 * belongs to no client, matching the "__overview__" convention in the
 * metrics cache.
 */
const META_CLIENT = "__backup__";
const META_KEY = "last_run";

function readLastRun() {
  const raw = store.getMeta(META_CLIENT, META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function writeLastRun(record) {
  try {
    store.setMeta(META_CLIENT, META_KEY, JSON.stringify(record));
  } catch (err) {
    // Never let bookkeeping fail a backup that actually worked.
    console.error(`[backup] could not record status: ${err.message}`);
  }
}

// A successful upload more than this old is not coverage. Backups run
// nightly, so two missed nights is a fault worth failing on rather
// than a slow day.
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

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
 * The snapshot lands on the same volume as the original. That protects
 * against a bad migration, an accidental delete or logical corruption,
 * but NOT against losing the volume — Railway's own daily volume
 * backups are what cover that, and BACKUP_PLATFORM_SNAPSHOTS says they
 * are on.
 *
 * With neither set this warns on every run, because a backup that only
 * appears to exist is worse than none: it removes the worry without
 * removing the risk.
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

    const record = {
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
      finishedAt: new Date().toISOString(),
    };
    writeLastRun(record);

    console.log(
      `[backup] ${reason}: ${(snap.bytes / 1048576).toFixed(1)}MB gz ` +
        `(from ${(snap.rawBytes / 1048576).toFixed(0)}MB), ${snap.checks.reschedules} observed reschedules, ` +
        `-> ${destination} in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
        (pruned.removed.length ? `, pruned ${pruned.removed.length}` : "")
    );
    if (!offsite) {
      console.warn(
        "[backup] WARNING: this snapshot is on the SAME volume as the database it backs up, so a volume " +
          "incident loses both. Configure BACKUP_S3_* for an off-site copy."
      );
    }
    return record;
  } catch (err) {
    const record = { ok: false, reason, startedAt, ms: Date.now() - t0, error: err.message, finishedAt: new Date().toISOString() };
    writeLastRun(record);
    console.error(`[backup] FAILED (${reason}): ${err.message}`);
    return record;
  }
}

/**
 * Is the database actually recoverable?
 *
 * Deliberately NOT derived from configuration. Having BACKUP_S3_*
 * present proves someone typed four variables, not that a byte ever
 * reached the bucket — and it was reporting `volumeLossCovered: true`
 * on the strength of that alone. The answer now rests on a real upload
 * having succeeded, recently.
 */
function status() {
  const last = readLastRun();
  const offsiteConfigured = Boolean(require("./backup-sinks").configured());

  const uploadedAt = last && last.ok && last.offsite ? Date.parse(last.finishedAt || last.startedAt) : null;
  const ageMs = uploadedAt ? Date.now() - uploadedAt : null;
  const stale = ageMs == null ? true : ageMs > STALE_AFTER_MS;

  return {
    offsiteConfigured,
    // The only field worth reading: an off-site copy demonstrably
    // exists and is recent enough to be worth something.
    volumeLossCovered: Boolean(uploadedAt) && !stale,
    lastOffsiteUploadAt: uploadedAt ? new Date(uploadedAt).toISOString() : null,
    staleAfterHours: STALE_AFTER_MS / 3600000,
    dir: backupDir(),
    last,
  };
}

module.exports = { run, snapshot, prune, status, backupDir, stamp };
