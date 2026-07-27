"use strict";

const fs = require("fs");
const path = require("path");

// Persisted so a "dismiss indefinitely" survives restarts. Point DATA_DIR at a
// mounted volume on a cloud host if you want dismissals to survive redeploys.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "dismissals.json");

// key -> { scope: "today" | "forever", expiresAt: number | null }
// key format: "candidate:<candidateId>" or "interviewer:<userId>".
let store = {};

function load() {
  try {
    store = JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
  } catch (err) {
    store = {}; // missing/corrupt file -> start empty
  }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.warn("[dismissals] save failed:", err.message);
  }
}

// Next local midnight — "dismiss until the next day" clears at the start of
// tomorrow in the server's local timezone (this runs on the coordinator's own
// machine, so local time is what they mean by "tomorrow").
function nextMidnight() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function add(key, scope) {
  if (!key) return;
  store[key] =
    scope === "forever"
      ? { scope: "forever", expiresAt: null }
      : { scope: "today", expiresAt: nextMidnight() };
  save();
}

function remove(key) {
  if (store[key]) {
    delete store[key];
    save();
  }
}

// True if `key` is currently dismissed. Expired "today" dismissals are pruned
// lazily on read so the store doesn't accumulate stale entries.
function isDismissed(key) {
  const d = store[key];
  if (!d) return false;
  if (d.expiresAt != null && Date.now() >= d.expiresAt) {
    delete store[key];
    save();
    return false;
  }
  return true;
}

load();

module.exports = { add, remove, isDismissed };
