"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");

// user.interviewerSettings (an interviewer's configured weeklyLimit) almost
// never changes -- unlike application-info-cache.js's cache below, this one
// is a pure time-based TTL, no "did anything change" signal needed. One
// call per unique interviewer referenced in this week's schedules, every
// refresh, previously -- persisted so a server restart doesn't force
// re-fetching every interviewer's settings on the very next cycle either.
const FILE = path.join(config.dataDir, "interviewer-settings-cache.json");
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // "at most daily"

// userId -> { settings, fetchedAt }
let store = {};

function load() {
  try {
    store = JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
  } catch (err) {
    store = {}; // missing/corrupt file -> start with an empty cache, refetch everything once
  }
}

// Write to a temp file in the same directory, then rename over the real
// path, so a crash/restart mid-write can't leave a truncated file behind
// for the next process to read (same pattern as rescheduleTracking.js).
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
    console.warn("[interviewerSettingsCache] save failed:", err.message);
  }
}

// Returns the cached settings object if still fresh (< 24h old), else null
// -- null means the caller should fetch fresh and call set().
function get(userId) {
  const entry = store[userId];
  if (!entry) return null;
  if (Date.now() - new Date(entry.fetchedAt).getTime() >= MAX_AGE_MS) return null;
  return entry.settings;
}

function set(userId, settings) {
  store[userId] = { settings, fetchedAt: new Date().toISOString() };
}

// Call once after a batch of get()/set() calls (see listInterviewerLimits()
// in ashby.js) -- drops entries old enough that MAX_AGE_MS would force a
// refetch anyway (keeps the file from accumulating interviewers who've
// since left this org indefinitely), then persists. Age-based, not
// "referenced this batch"-based, so this is safe to call even if a given
// refresh only touches a subset of previously-cached interviewers.
function flush() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const userId of Object.keys(store)) {
    if (new Date(store[userId].fetchedAt).getTime() < cutoff) delete store[userId];
  }
  save();
}

load();

module.exports = { get, set, flush };
