"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");

// Each interview stage's group, for Interviewer Load's split by stage
// (<DATA_DIR>/interview-stages.json): stageId → { groupId, title, at }.
// interviewSchedule.list gives only interviewStageId; interviewStage.info
// gives its interviewStageGroupId. A stage that can't be read (deleted:
// three at Pace) is kept with groupId null, so it counts as Other and isn't
// asked for on every refresh. A client can move a stage to another group, so
// an entry is read again once it's `maxAgeMs` old. Dropped only when no kept
// schedule references the stage any more (prune).
const FILE = path.join(config.dataDir, "interview-stages.json");

function createInterviewStageCache({ file = FILE, log = console, now = () => Date.now(), maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  let store = {};
  try { store = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch (_) { store = {}; }
  let dirty = false;
  return {
    get: (id) => store[id] || null,
    has: (id) => Boolean(store[id]),
    // Never read, then read longest ago, among `ids`.
    due(ids) {
      const t = now();
      const never = [], stale = [];
      for (const id of ids) {
        const e = store[id];
        if (!e) never.push(id);
        else if (!(t - e.at < maxAgeMs)) stale.push(id);
      }
      stale.sort((a, b) => store[a].at - store[b].at);
      return { never, stale };
    },
    set(id, { groupId = null, title = null } = {}) { store[id] = { groupId, title, at: now() }; dirty = true; },
    prune(keepIds) {
      for (const id of Object.keys(store)) if (!keepIds.has(id)) { delete store[id]; dirty = true; }
    },
    size: () => Object.keys(store).length,
    flush() {
      if (!dirty) return;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(store));
        fs.renameSync(tmp, file);
        dirty = false;
      } catch (err) {
        log.warn(`[interview-stages] save failed: ${err.message}`);
      }
    },
  };
}

module.exports = { createInterviewStageCache };
