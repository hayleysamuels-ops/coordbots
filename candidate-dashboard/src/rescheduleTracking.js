"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");

// Ashby has no reschedule count or history anywhere — checked schedule
// fields, event fields, application.listHistory, and extraData across a
// live sample of 131 interview events; only the event's *current*
// startTime exists, never a log of previous values. So this app tracks it
// itself: each refresh, compare every interview event's startTime against
// what was last seen for that event id, and increment a counter when it
// changed. Counting necessarily starts at zero the first time this ever
// runs on a given event — it can only catch reschedules going forward, not
// ones that already happened before this existed.
const FILE = path.join(config.dataDir, "reschedule-tracking.json");

// interviewEventId -> { lastKnownStartTime, rescheduleCount }
let store = {};

function load() {
  try {
    store = JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
  } catch (err) {
    store = {}; // missing/corrupt file -> start counting fresh from zero
  }
}

// Same atomic write pattern established for referralCache.js's persisted
// files — write to a temp file in the same directory, then rename over the
// real path, so a crash/restart mid-write can't leave a truncated file
// behind for the next process to read.
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
    console.warn("[rescheduleTracking] save failed:", err.message);
  }
}

/**
 * Call once per refresh with every currently-visible interview event (as
 * `{ id, startTime }`, from every schedule in the lookback window,
 * regardless of candidate status — this is a property of the event, not
 * the candidate). Returns a Map of interviewEventId -> rescheduleCount for
 * every event rescheduled at least once, so callers can flag whichever
 * cross their own threshold.
 *
 * Events no longer seen (schedule cancelled, event removed, or aged out of
 * the schedule lookback window) are dropped so this file doesn't grow
 * forever — same lookback tradeoff `SCHEDULE_LOOKBACK_DAYS` already makes
 * elsewhere.
 */
function trackAndGetCounts(events) {
  let changed = false;
  const counts = new Map();
  const seenIds = new Set();

  for (const { id, startTime } of events) {
    if (!id || !startTime) continue;
    seenIds.add(id);

    const existing = store[id];
    if (!existing) {
      // A brand-new event still needs persisting — otherwise a restart
      // before its first-ever reschedule would lose this baseline
      // entirely and have to re-establish it from scratch.
      store[id] = { lastKnownStartTime: startTime, rescheduleCount: 0 };
      changed = true;
    } else if (existing.lastKnownStartTime !== startTime) {
      existing.lastKnownStartTime = startTime;
      existing.rescheduleCount += 1;
      changed = true;
    }

    if (store[id].rescheduleCount > 0) counts.set(id, store[id].rescheduleCount);
  }

  for (const id of Object.keys(store)) {
    if (!seenIds.has(id)) {
      delete store[id];
      changed = true;
    }
  }

  if (changed) save();
  return counts;
}

load();

module.exports = { trackAndGetCounts };
