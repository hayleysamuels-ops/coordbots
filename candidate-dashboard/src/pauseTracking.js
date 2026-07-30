"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");

// Same situation as rescheduleTracking.js: interviewerPool.info exposes
// only the CURRENT isPaused boolean on a trainee, never when it became
// true — checked the full trainee object shape live; the only timestamp
// present is `updatedAt`, which is the user record's generic
// last-modified time (changes for unrelated reasons too — permission
// changes, settings changes, etc.), not scoped to pause toggling. So this
// app tracks it itself: each refresh, record the moment a trainee's
// isPaused first flips to true, and keep that timestamp until they're
// unpaused. Timing necessarily starts from whenever this app first
// observes a given pause — it can't know how long someone was ALREADY
// paused before this existed.
const FILE = path.join(config.dataDir, "training-pause-tracking.json");

// `${poolId}:${userId}` -> { pausedSince: ISOString }
let store = {};

function load() {
  try {
    store = JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
  } catch (err) {
    store = {}; // missing/corrupt file -> start tracking fresh
  }
}

// Same atomic write pattern as rescheduleTracking.js.
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
    console.warn("[pauseTracking] save failed:", err.message);
  }
}

/**
 * Call once per refresh with every current trainee enrollment (as
 * `{ key, isPaused }`, where `key` uniquely identifies one trainee's
 * enrollment in one pool — e.g. `${poolId}:${userId}`, since the same
 * person could be paused in one pool and active in another
 * simultaneously). Returns a Map of key -> pausedSince (ISO string) for
 * every currently-paused entry. An entry that's no longer paused is
 * dropped from the store, so a later pause starts a fresh timestamp
 * rather than reusing a stale one; entries no longer seen at all (pool
 * archived, trainee removed) are pruned too.
 */
function trackAndGetPausedSince(entries) {
  let changed = false;
  const pausedSince = new Map();
  const seenKeys = new Set();

  for (const { key, isPaused } of entries) {
    if (!key) continue;
    seenKeys.add(key);

    if (isPaused) {
      if (!store[key]) {
        store[key] = { pausedSince: new Date().toISOString() };
        changed = true;
      }
      pausedSince.set(key, store[key].pausedSince);
    } else if (store[key]) {
      delete store[key];
      changed = true;
    }
  }

  for (const key of Object.keys(store)) {
    if (!seenKeys.has(key)) {
      delete store[key];
      changed = true;
    }
  }

  if (changed) save();
  return pausedSince;
}

load();

module.exports = { trackAndGetPausedSince };
