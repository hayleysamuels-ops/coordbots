"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");

// application.info is by far the most expensive part of a refresh -- one
// call per unique applicationId referenced by this cycle's schedules/offers
// (confirmed live: this is what makes listIssues() take minutes on an org
// with hundreds of active schedules -- 523s on Profound in one observed
// case). Ashby has no cheaper way to check whether a specific application
// changed without fetching it in full (checked: interviewSchedule.list and
// offer.list results embed only applicationId, never the application's own
// updatedAt), so "the record hasn't changed" is approximated using the best
// FREE signal already available from whatever led us to this applicationId
// in the first place: a schedule's own updatedAt for schedule-driven
// lookups (listIssues), or an offer's own status/version/decidedAt for
// offer-driven ones (listOffers) -- see the `signature` callers pass in
// ashby.js. A signature match means "nothing that would have bumped this
// signal has happened since we cached it," which is a good proxy for the
// application itself being unchanged, but not a guarantee (e.g. a recruiter
// reassignment with no accompanying schedule/offer event wouldn't move the
// signature) -- MAX_AGE_MS is the backstop against that gap, same as
// interviewerSettingsCache.js's pure-TTL approach.
const FILE = path.join(config.dataDir, "application-info-cache.json");
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// applicationId -> { app, signature, fetchedAt }
let store = {};

function load() {
  try {
    store = JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
  } catch (err) {
    store = {};
  }
}

function atomicWriteFileSync(filePath, contents) {
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}`);
  fs.writeFileSync(tempPath, contents);
  fs.renameSync(tempPath, filePath);
}

function save() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    atomicWriteFileSync(FILE, JSON.stringify(store));
  } catch (err) {
    console.warn("[applicationInfoCache] save failed:", err.message);
  }
}

// Returns the cached application.info result only if BOTH the signature
// still matches (nothing signaled a change since) AND the entry isn't
// older than MAX_AGE_MS, else null.
function get(applicationId, signature) {
  const entry = store[applicationId];
  if (!entry || entry.signature !== signature) return null;
  if (Date.now() - new Date(entry.fetchedAt).getTime() >= MAX_AGE_MS) return null;
  return entry.app;
}

function set(applicationId, signature, app) {
  store[applicationId] = { app, signature, fetchedAt: new Date().toISOString() };
}

// Call once after a batch of get()/set() calls (see fetchApplicationsById()
// in ashby.js) -- drops entries old enough that no client's lookback window
// could still plausibly reference them (a generous cushion over the
// SCHEDULE_LOOKBACK_DAYS default of 30d, not tied to any one client's exact
// setting), then persists. Age-based, not "referenced this batch"-based:
// listIssues()'s schedule-driven applications and listOffers()'s
// offer-driven applications are independent SECTION_GROUPS now (see
// issues.js) that can run concurrently, each calling this after its own
// batch -- set-based pruning would let one call's flush() delete entries
// the other call still needs.
const PRUNE_AGE_MS = 45 * 24 * 60 * 60 * 1000;

function flush() {
  const cutoff = Date.now() - PRUNE_AGE_MS;
  for (const id of Object.keys(store)) {
    if (new Date(store[id].fetchedAt).getTime() < cutoff) delete store[id];
  }
  save();
}

load();

module.exports = { get, set, flush };
