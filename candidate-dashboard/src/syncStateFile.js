"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");

// Where a syncToken-driven read (interviewer-load.js's createScheduleSync,
// feedback-sync.js's createFeedbackSync) keeps its state on the volume, so a
// restart or redeploy carries on from the last sync token instead of
// re-reading everything. Without it, the first refresh after every deploy at
// Forus made ~350 interviewSchedule.list calls plus ~60
// applicationFeedback.list calls (557s on 2026-11-17), and the Dashboard and
// Feedback tabs both waited on it.
//
// Same file pattern as applicationInfoCache.js / interviewerSettingsCache.js:
// JSON in config.dataDir, written to a temp file and renamed so a restart
// mid-write can't leave a truncated file. A missing, unreadable or corrupt
// file loads as null, and the caller does a full read as before. What a
// caller stores, and when it trusts it, is up to the caller.
function createSyncStateFile(fileName, { dir = config.dataDir, log = console } = {}) {
  const file = path.join(dir, fileName);
  return {
    file,
    load() {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (err) {
        if (err.code !== "ENOENT") log.warn(`[sync-state] ${fileName} unreadable, reading from Ashby instead: ${err.message}`);
        return null;
      }
    },
    save(state) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const tempPath = path.join(dir, `.${fileName}.tmp-${process.pid}`);
        fs.writeFileSync(tempPath, JSON.stringify(state));
        fs.renameSync(tempPath, file);
      } catch (err) {
        log.warn(`[sync-state] saving ${fileName} failed: ${err.message}`);
      }
    },
  };
}

module.exports = { createSyncStateFile };
