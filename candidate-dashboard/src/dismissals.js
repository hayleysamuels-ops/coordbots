"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");

// Persisted so a "dismiss indefinitely" survives restarts. See
// config.dataDir for where this lives. Hide is "forever" (until someone
// restores it); Snooze is "today" (until the next midnight in
// DISPLAY_TIMEZONE). Nothing else expires.
const DATA_DIR = config.dataDir;
const FILE = path.join(DATA_DIR, "dismissals.json");

// key -> { scope: "today" | "forever", expiresAt: number | null,
//          hiddenAt: number | null, by: string | null, label: string | null }
// key format: "candidate:<candidateId>", "interviewer:<userId>" or
// "schedule:<scheduleId>:<updatedAt>" (Ready to schedule, see ready-queue.js).
// hiddenAt, by and label were added with the Hidden & snoozed tab; entries
// from before that have none of them. `by` is whatever name the person typed
// into this browser: self-reported, not a record of who was signed in (the
// dashboard has one shared login), unless byVerified is true: then it's the
// name on the Google account that was signed in (signin.js).
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

// The next midnight after `ms` in `timeZone`. A snooze ("until tomorrow")
// lifts then, in the client's DISPLAY_TIMEZONE: the server runs in UTC on
// Railway, where its own local midnight is 4-5pm Pacific.
function nextMidnight(ms = Date.now(), timeZone = config.displayTimeZone) {
  const parts = (at) => Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at).map((x) => [x.type, +x.value || x.value]));
  // Offset of `timeZone` from UTC at `at`, in ms (wall clock minus UTC).
  const offset = (at) => { const p = parts(at); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000; };
  const today = parts(ms);
  const wall = Date.UTC(today.year, today.month - 1, today.day + 1);
  // Correct the guess with the offset at the result, so a DST change that day
  // still lands on midnight.
  let at = wall - offset(wall);
  at = wall - offset(at);
  return at;
}

function add(key, scope, { by = null, byVerified = false, label = null, now = Date.now() } = {}) {
  if (!key) return;
  const clean = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  store[key] = {
    scope: scope === "forever" ? "forever" : "today",
    expiresAt: scope === "forever" ? null : nextMidnight(now),
    hiddenAt: now,
    by: clean(by, 80),
    label: clean(label, 200),
  };
  if (byVerified && store[key].by) store[key].byVerified = true;
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

// Every dismissal still in force, as [{ key, scope, expiresAt, hiddenAt, by, byVerified, label }].
function list() {
  return Object.keys(store).filter(isDismissed).map((key) => ({
    key, scope: store[key].scope, expiresAt: store[key].expiresAt ?? null,
    hiddenAt: store[key].hiddenAt ?? null, by: store[key].by ?? null, byVerified: store[key].byVerified === true,
    label: store[key].label ?? null,
  }));
}

load();

module.exports = { add, remove, isDismissed, list, nextMidnight };
