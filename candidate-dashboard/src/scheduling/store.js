"use strict";
const fs = require("fs");
const path = require("path");
// Revision-checked transitions follow the work-trial scheduling shell's store
// contract. Reload under a filesystem lock so overlapping workers cannot claim
// the same delivery. A crash leaving the lock requires operator reconciliation.
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
      rows[row.id] = row; return true;
    }),
    replace: async (id, revision, next) => mutate(rows => {
      if (next.id !== id || next.revision !== revision + 1) throw new Error("Invalid revision");
      if (!rows[id] || rows[id].revision !== revision) return false;
      rows[id] = next; return true;
    }),
  };
}
module.exports = { createStore };
