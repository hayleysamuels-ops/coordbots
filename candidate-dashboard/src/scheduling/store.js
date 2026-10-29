"use strict";
const fs = require("fs");
const path = require("path");
// Revision-checked transitions follow the work-trial scheduling shell's store
// contract. Reload under a filesystem lock so overlapping workers cannot claim
// the same delivery. A crash leaving the lock requires operator reconciliation.
// Whether an earlier post of a Full schedule option still blocks posting the
// same option again: while it could still lead to a booking, or could still
// have a draft in Ashby. It stops blocking once rejected, or once it was
// approved and its Ashby check ended with nothing booked and no draft left:
//   refused, with no draft made, its delete confirmed, or the schedule
//     plainly showing no drafts;
//   not_started (no draft was made);
//   availability_changed (the candidate's availability changed before the
//     check; nothing was made in Ashby);
//   deleted (the sweep deleted the unsent draft) or gone (the draft left Ashby
//     unsent), or released (a person released the schedule: ashby-check.js).
// Everything else blocks, including an approval with no check, or one skipped
// or too close (booked by hand), an uncertain check or a failed delete (a
// draft may be left), and superseded: a later approval for the schedule may
// still be waiting to be booked by hand, and reposting this one could book it
// twice. An unknown state blocks.
function blocksRepost(row) {
  if (row.state === "rejected") return false;
  if (row.state !== "discussion_approved" || !row.ashbyCheck) return true;
  const check = row.ashbyCheck;
  if (check.state === "refused") return !(!check.draftId || check.cleanup?.deleted === true || check.cleanup?.absent === true);
  return !["not_started", "availability_changed", "deleted", "gone", "released"].includes(check.state);
}

function createStore(dir) {
  const file = path.join(dir, "scheduling.json");
  const lock = file + ".lock";
  function read() {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { if (e.code === "ENOENT") return {}; throw e; }
  }
  function mutate(fn) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let fd;
    try { fd = fs.openSync(lock, "wx", 0o600); }
    catch (e) { if (e.code === "EEXIST") throw Object.assign(new Error("Scheduling is busy or requires recovery."), { status: 409 }); throw e; }
    try {
      const rows = read();
      const result = fn(rows);
      const temp = file + ".tmp";
      const output = fs.openSync(temp, "w", 0o600);
      try { fs.writeFileSync(output, JSON.stringify(rows)); fs.fsyncSync(output); }
      finally { fs.closeSync(output); }
      fs.renameSync(temp, file);
      const directory = fs.openSync(dir, "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      return result;
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  return {
    list: async () => Object.values(read()),
    get: async id => read()[id] || null,
    insert: async row => mutate(rows => {
      if (rows[row.id] || Object.values(rows).some(existing => existing.clientId === row.clientId && existing.plan.candidateId === row.plan.candidateId && ["draft", "sharing", "discussion_uncertain"].includes(existing.state))) return false;
      // Checked again here, under the lock, so two overlapping posts of the same
      // Full schedule option can't both pass postScheduleOption's earlier check.
      if (row.plan.sourceRef && Object.values(rows).some(existing => existing.clientId === row.clientId && existing.plan.sourceRef === row.plan.sourceRef && blocksRepost(existing))) return false;
      rows[row.id] = row; return true;
    }),
    replace: async (id, revision, next) => mutate(rows => {
      if (next.id !== id || next.revision !== revision + 1) throw new Error("Invalid revision");
      if (!rows[id] || rows[id].revision !== revision) return false;
      rows[id] = next; return true;
    }),
  };
}
module.exports = { createStore, blocksRepost };
