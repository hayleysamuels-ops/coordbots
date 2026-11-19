"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");

// Each application's role details for Interviewer Load's filter: job,
// department, recruiter, coordinator (<DATA_DIR>/application-roles.json).
// Kept apart from applicationInfoCache, which drops entries after 45 days:
// "interviewed for this role in the last 90 days" needs every application
// on a schedule the sync still keeps, and a job rarely changes, so an entry
// here never expires by age. Dropped only when no kept schedule references
// it any more (prune).
const FILE = path.join(config.dataDir, "application-roles.json");

function createApplicationRoles({ file = FILE, log = console } = {}) {
  let store = {};
  try { store = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch (_) { store = {}; }
  let dirty = false;
  return {
    get: (id) => store[id] || null,
    has: (id) => Boolean(store[id]),
    set(id, role) { store[id] = role; dirty = true; },
    // Keep only applications still referenced.
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
        log.warn(`[application-roles] save failed: ${err.message}`);
      }
    },
  };
}

module.exports = { createApplicationRoles };
