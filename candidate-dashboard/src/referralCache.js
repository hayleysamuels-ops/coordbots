"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");
const ashby = require("./ashby");

// Persisted so the expensive full scan only ever has to happen once (or
// again if an incremental sync's token gets rejected) — not on every server
// restart. See config.dataDir for where this lives.
const DATA_DIR = config.dataDir;
const FILE = path.join(DATA_DIR, "referral-cache.json");
// Separate from FILE on purpose: FILE always holds a complete, servable
// result set; this holds an IN-PROGRESS full scan's partial state, and only
// exists while one is running or was interrupted mid-scan.
const CHECKPOINT_FILE = path.join(DATA_DIR, "referral-scan-checkpoint.json");

// Bump this whenever toRecord()'s output shape changes (a field added,
// renamed, or removed). Persisted records don't get backfilled by adding a
// field to the code — an incremental sync only touches applications that
// actually changed, so most cached entries would silently keep their OLD
// shape indefinitely (this bit us for real once: adding `departmentId`
// left every existing cached record without the key at all, not even
// `null`, until something happened to touch it). A version mismatch on load
// discards the cache and forces a full rebuild instead of serving
// incomplete records.
const RECORD_SCHEMA_VERSION = 2; // 1: original shape. 2: added departmentId.

// { schemaVersion, syncToken: string|null, applications: { [applicationId]: referralRecord } }
// `applications` holds ONLY currently-qualifying (Active + Referral) records
// — this cache IS the Active Referrals result set, not an intermediate one.
let cache = { syncToken: null, applications: {} };
let lastUpdated = null;
let lastError = null;
let refreshPromise = null;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (raw.schemaVersion !== RECORD_SCHEMA_VERSION) {
      console.log(
        `[referralCache] cache schema changed (${raw.schemaVersion} -> ${RECORD_SCHEMA_VERSION}), discarding and doing a full rebuild`
      );
      cache = { syncToken: null, applications: {} };
      return;
    }
    cache = { syncToken: raw.syncToken || null, applications: raw.applications || {} };
  } catch (err) {
    cache = { syncToken: null, applications: {} }; // missing/corrupt file -> full scan
  }
}

// Writes to a temp file in the same directory, then renames over the real
// path — fs.rename is atomic on POSIX as long as source and destination are
// on the same filesystem (true here: both live under DATA_DIR), so a reader
// only ever sees either the old complete file or the new complete one, never
// a partial write. Matters because this data dir sits on a Railway volume
// that survives container restarts — a plain writeFileSync killed mid-write
// (container restart, crash) would otherwise leave a truncated file behind
// for the next process to read on startup.
function atomicWriteFileSync(filePath, contents) {
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}`);
  fs.writeFileSync(tempPath, contents);
  fs.renameSync(tempPath, filePath);
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    atomicWriteFileSync(FILE, JSON.stringify({ schemaVersion: RECORD_SCHEMA_VERSION, ...cache }));
  } catch (err) {
    console.warn("[referralCache] save failed:", err.message);
  }
}

// The checkpoint stores the *config value* (REFERRAL_LOOKBACK_DAYS, a stable
// number of days) rather than the computed `createdAfter` timestamp — that
// timestamp is "now minus N days" computed fresh at scan start, so it's a
// different absolute value on every run even when the config hasn't changed
// at all. Comparing computed timestamps would make every checkpoint look
// stale and never actually resume. If the *days* value changed between
// restarts, the checkpoint is genuinely stale (a different query) and gets
// discarded; otherwise its own stored `createdAfter` is reused verbatim on
// resume (see fullScan) so pagination continues under the exact filter its
// cursor was issued for, not a freshly recomputed one.
function loadCheckpoint(expectedLookbackDays) {
  try {
    const raw = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
    if (raw.lookbackDays !== expectedLookbackDays) {
      console.log("[referralCache] discarding stale scan checkpoint (lookback window changed)");
      return null;
    }
    return raw;
  } catch (err) {
    return null;
  }
}

function saveCheckpoint(checkpoint) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    atomicWriteFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint));
  } catch (err) {
    console.warn("[referralCache] checkpoint save failed:", err.message);
  }
}

function clearCheckpoint() {
  try {
    fs.unlinkSync(CHECKPOINT_FILE);
  } catch (err) {
    // Nothing to clean up if it was never written (e.g. scan crashed before
    // the first page even completed) — not an error worth logging.
  }
}

function qualifies(app) {
  return app.status === "Active" && ashby.classifySource(app) === "Referral";
}

function toRecord(app) {
  const candidate = app.candidate || {};
  const stage = app.currentInterviewStage || {};
  return {
    applicationId: app.id,
    candidateId: candidate.id,
    candidateName: candidate.name,
    jobTitle: (app.job && app.job.title) || "Unknown role",
    departmentId: (app.job && app.job.departmentId) || null,
    stageTitle: stage.title || "Unknown stage",
    stageOrder: stage.orderInInterviewPlan ?? 0,
    ashbyProfileUrl: ashby.profileUrl(candidate.id, app.id),
  };
}

/**
 * Full active-application scan — the expensive path. Instrumented on this
 * org (unbounded, before REFERRAL_LOOKBACK_DAYS existed): 317 pages, 740.0s
 * network, 39ms client-side filtering, 31,669 applications scanned, 372
 * referrals found — virtually all cost is pagination/network, none of it
 * per-application processing. Only taken when there's no persisted
 * syncToken yet, or an incremental sync's token was rejected. Captures the
 * final page's syncToken so every subsequent refresh can go incremental
 * instead.
 *
 * Bounded by REFERRAL_LOOKBACK_DAYS (`createdAfter`) — trades completeness
 * (a referral active longer than that window and never otherwise touched
 * won't appear) for a materially shorter scan. See README for the measured
 * page-count impact.
 *
 * Checkpoints progress (cursor + partial results) to disk after every page,
 * so a restart mid-scan resumes from the last completed page instead of
 * starting over at page 1 — see loadCheckpoint/saveCheckpoint above. The one
 * gap: a crash in the narrow window after the last page arrives but before
 * this function finalizes (cache/save/clearCheckpoint below) would resume
 * from scratch rather than replaying that already-complete result — rare,
 * and self-correcting (it just re-scans), not incorrect.
 */
async function fullScan() {
  const checkpoint = loadCheckpoint(config.referralLookbackDays);
  // Reuse the checkpoint's own createdAfter verbatim when resuming — its
  // cursor was issued against that exact value, not a freshly-computed one.
  // Only compute a new createdAfter when starting a scan from scratch.
  const createdAfter = checkpoint
    ? checkpoint.createdAfter
    : config.referralLookbackDays
    ? Date.now() - config.referralLookbackDays * 24 * 60 * 60 * 1000
    : null;

  const applications = checkpoint ? { ...checkpoint.applications } : {};
  const priorPages = checkpoint ? checkpoint.pagesCompleted : 0;
  const priorScanned = checkpoint ? checkpoint.scannedCount : 0;

  if (checkpoint) {
    console.log(
      `[referralCache] resuming interrupted full scan: ${priorPages} pages already done, ` +
        `${Object.keys(applications).length} referrals found so far`
    );
  }

  const baseBody = { limit: 100, status: "Active" };
  if (createdAfter) baseBody.createdAfter = createdAfter;
  if (checkpoint && checkpoint.cursor) baseBody.cursor = checkpoint.cursor;

  const stats = {};
  let scannedThisRun = 0;

  await ashby.fetchAllPages("application.list", baseBody, stats, (pageResults, nextCursor) => {
    scannedThisRun += pageResults.length;
    for (const app of pageResults) {
      if (qualifies(app)) applications[app.id] = toRecord(app);
    }
    saveCheckpoint({
      lookbackDays: config.referralLookbackDays,
      createdAfter,
      cursor: nextCursor,
      applications,
      pagesCompleted: priorPages + stats.pages,
      scannedCount: priorScanned + scannedThisRun,
    });
  });

  cache = { syncToken: stats.syncToken || null, applications };
  save();
  clearCheckpoint();

  const totalPages = priorPages + stats.pages;
  const totalScanned = priorScanned + scannedThisRun;
  console.log(
    `[referralCache] full scan: ${totalPages} pages` +
      (checkpoint ? ` (resumed after ${priorPages} pages from a prior run)` : "") +
      `, ${(stats.networkMs / 1000).toFixed(1)}s network this run, ${totalScanned} applications scanned, ` +
      `${Object.keys(applications).length} active referrals, lookback ${
        config.referralLookbackDays || "unbounded"
      } days` +
      (stats.syncToken ? "" : " — WARNING: no syncToken returned, next refresh will full-scan again")
  );
}

/**
 * Incremental sync: fetch only applications that changed since the last
 * syncToken, and merge into the persisted cache — add/update if an
 * application now qualifies (Active + Referral), remove if it no longer
 * does (archived, hired, or its source changed — rare). Deliberately sends
 * NO status/source filter on this call: Ashby's syncToken filtering
 * semantics aren't documented, and applying status server-side risks
 * silently hiding exactly the transition we need to see — an application
 * leaving Active status must still come back in the diff so we can evict
 * it. All qualification filtering happens here, client-side, on fresh data.
 * No createdAfter bound here either — REFERRAL_LOOKBACK_DAYS only applies to
 * the full scan; a changed application shows up in a diff regardless of how
 * old it is, which is correct (it just changed, so it's relevant now).
 */
async function incrementalSync() {
  const stats = {};
  const changed = await ashby.fetchAllPages(
    "application.list",
    { limit: 100, syncToken: cache.syncToken },
    stats
  );

  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const app of changed) {
    const existed = Object.prototype.hasOwnProperty.call(cache.applications, app.id);
    if (qualifies(app)) {
      cache.applications[app.id] = toRecord(app);
      if (existed) updated++;
      else added++;
    } else if (existed) {
      delete cache.applications[app.id];
      removed++;
    }
  }

  if (stats.syncToken) cache.syncToken = stats.syncToken;
  save();

  console.log(
    `[referralCache] incremental sync: ${stats.pages} pages, ${(stats.networkMs / 1000).toFixed(1)}s, ` +
      `${changed.length} changed applications (+${added} ~${updated} -${removed}), ` +
      `${Object.keys(cache.applications).length} active referrals now cached`
  );
}

// Guards against overlapping refreshes, same reasoning as issues.js's
// refreshPromise — even though incremental syncs are expected to be fast,
// a full-scan fallback isn't, and this section already caused one real
// overlapping-refresh bug (see CLAUDE.md).
async function refresh() {
  if (refreshPromise) {
    console.log("[referralCache] refresh already in progress, skipping duplicate trigger");
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      if (cache.syncToken) {
        try {
          await incrementalSync();
        } catch (err) {
          console.warn(
            "[referralCache] incremental sync failed, falling back to full scan:",
            err.message
          );
          await fullScan();
        }
      } else {
        await fullScan();
      }
      lastUpdated = new Date();
      lastError = null;
    } catch (err) {
      lastError = err.message;
      console.warn("[referralCache] refresh failed, serving stale cache:", err.message);
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

function start() {
  load();
  refresh();
  setInterval(refresh, config.activeReferralsRefreshIntervalMinutes * 60 * 1000);
}

function getSnapshot() {
  const activeReferrals = Object.values(cache.applications).sort((a, b) => a.stageOrder - b.stageOrder);
  return { activeReferrals, lastUpdated, lastError };
}

module.exports = { start, refresh, getSnapshot };
