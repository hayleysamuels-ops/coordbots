"use strict";
// Auto-post's failures, one JSON line each, in <DATA_DIR>/auto-post-events.jsonl,
// for the daily digest (digest.js) to count "since the last digest".
// auto-post.json keeps only the latest state per schedule, so a failure that
// later recovered would otherwise leave no trace; the log line holds the HTTP
// status, but nothing on the dashboard can read Railway's logs.
//
// An event: { at, kind, scheduleId, name, why, status }. kind is "retry" (a
// failed round, tried again later), "gave_up", "needs_person" or "round" (the
// whole round failed). status is Ashby's HTTP status when the failure was an
// Ashby read through ashby-read.js (e.ashby.status), else null: the worker's
// own reads have none. Lines older than KEEP_MS are dropped when the file is
// rewritten, at most once a day.
const fs = require("fs");
const path = require("path");

const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

function createEventLog(dataDir, { now = () => Date.now(), log = console } = {}) {
  const file = path.join(dataDir, "auto-post-events.jsonl");
  let pruned = 0;
  function read() {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
    return text.split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch (_) { return []; } });
  }
  function prune() {
    if (now() - pruned < 24 * 60 * 60 * 1000) return;
    pruned = now();
    const kept = read().filter(e => now() - Date.parse(e.at) < KEEP_MS);
    fs.writeFileSync(file + ".tmp", kept.map(e => JSON.stringify(e) + "\n").join(""));
    fs.renameSync(file + ".tmp", file);
  }
  return {
    // Never throws: a failure to record must not stop auto-post.
    record(event) {
      try {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        prune();
        fs.appendFileSync(file, JSON.stringify({ at: new Date(now()).toISOString(), ...event }) + "\n");
      } catch (e) { log.warn(`[auto-post] The failure couldn't be recorded for the digest: ${e.message}`); }
    },
    since: ms => read().filter(e => Date.parse(e.at) >= ms),
  };
}

// The HTTP status of an error from ashby-read.js, else null.
const statusOf = e => Number.isInteger(e?.ashby?.status) ? e.ashby.status : null;

module.exports = { createEventLog, statusOf, KEEP_MS };
