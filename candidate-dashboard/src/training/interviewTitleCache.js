"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../config");

// interviewId -> title, persisted indefinitely.
//
// Needed because the training tracker keys a path on interview title + job
// title, and an interview EVENT carries only an interviewId. Two facts make a
// cache mandatory rather than a nicety:
//
//   1. `interview.list` does NOT return every interview. Confirmed live at
//      Forus: 364 distinct interviewIds appeared in 60 days of schedules,
//      but interview.list returns only 103. The missing 312 resolve fine via
//      interview.info — they're simply absent from the list endpoint.
//   2. Resolving those one-by-one on every refresh would add ~300 calls per
//      cycle to a refresh already dominated by application.info.
//
// An interview's title is effectively immutable in practice (a rename makes
// a new record far more often than it edits one), so unlike
// interviewerSettingsCache this has no TTL — entries are kept until the file
// is deleted. A stale title only ever affects the path PICKER's labels and
// the new-duplicate suggestion, never the counting, which runs off resolved
// interviewIds.
const FILE = path.join(config.dataDir, "interview-titles-cache.json");

let store = {};
let dirty = false;

function load() {
  try {
    store = JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
  } catch (err) {
    store = {};
  }
}

// Temp file then rename, so a crash mid-write can't leave a truncated file
// for the next process to read (same pattern as rescheduleTracking.js).
function flush() {
  if (!dirty) return;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, FILE);
    dirty = false;
  } catch (err) {
    console.warn("[training] interview title cache write failed:", err.message);
  }
}

function get(interviewId) {
  return store[interviewId];
}

function set(interviewId, title) {
  if (store[interviewId] === title) return;
  store[interviewId] = title;
  dirty = true;
}

function has(interviewId) {
  return Object.prototype.hasOwnProperty.call(store, interviewId);
}

function asMap() {
  return new Map(Object.entries(store));
}

function missing(interviewIds) {
  return [...new Set(interviewIds)].filter((id) => id && !has(id));
}

load();

module.exports = { get, set, has, asMap, missing, flush, _file: FILE };
