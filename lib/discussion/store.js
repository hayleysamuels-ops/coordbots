"use strict";

const fs = require("fs");
const path = require("path");
const copy = (value) => JSON.parse(JSON.stringify(value));

// Every transition compares a revision. Two workers cannot claim the same
// approved record, and a stale browser approval cannot replace a newer draft.
function createSchedulingStore({ databaseUrl, dir, pool: suppliedPool }) {
  if (databaseUrl || suppliedPool) {
    const pool = suppliedPool || new (require("pg").Pool)({
      connectionString: databaseUrl, max: 2,
      ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(databaseUrl) ? false : { rejectUnauthorized: true },
    });
    const ready = pool.query("CREATE TABLE IF NOT EXISTS discussion_proposals (" +
      "id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, data JSONB NOT NULL)").then(() =>
      pool.query("CREATE UNIQUE INDEX IF NOT EXISTS discussion_one_active_candidate ON discussion_proposals " +
        "((data->'plan'->>'candidateId')) WHERE state IN ('draft','approved','running','needs_review','sharing','discussion_uncertain')")).then(() =>
      pool.query("CREATE UNIQUE INDEX IF NOT EXISTS discussion_one_execution ON discussion_proposals ((1)) WHERE state='running' OR (state='needs_review' AND data->>'issue'='booking_uncertain')"));
    ready.catch(() => {}); // Requests still await ready and surface database failure.
    return {
      async list() { await ready; return (await pool.query("SELECT data FROM discussion_proposals ORDER BY id")).rows.map((r) => r.data); },
      async get(id) { await ready; return (await pool.query("SELECT data FROM discussion_proposals WHERE id=$1", [id])).rows[0]?.data || null; },
      async insert(proposal) {
        await ready;
        return (await pool.query("INSERT INTO discussion_proposals(id,revision,state,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [proposal.id, proposal.revision, proposal.state, proposal])).rowCount === 1;
      },
      async replace(id, revision, next) {
        checkReplacement(id, revision, next); await ready;
        try {
          return (await pool.query("UPDATE discussion_proposals SET revision=$3,state=$4,data=$5 WHERE id=$1 AND revision=$2",
            [id, revision, next.revision, next.state, next])).rowCount === 1;
        } catch (error) {
          if (error.code === "23505") return false;
          throw error;
        }
      },
      async close() { if (!suppliedPool) await pool.end(); },
    };
  }
  // File mode is for a single local process only. Railway workers require PG.
  const file = path.join(dir, "discussion.json");
  let rows = {};
  try { rows = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  function persist(next) {
    const temp = file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(temp, file); rows = next;
  }
  return {
    async list() { return copy(Object.values(rows)); },
    async get(id) { return rows[id] ? copy(rows[id]) : null; },
    async insert(proposal) {
      if (rows[proposal.id] || Object.values(rows).some(row =>
        ["draft", "approved", "running", "needs_review", "sharing", "discussion_uncertain"].includes(row.state) &&
        row.plan.candidateId === proposal.plan.candidateId)) return false;
      persist({ ...rows, [proposal.id]: copy(proposal) }); return true;
    },
    async replace(id, revision, next) {
      checkReplacement(id, revision, next);
      if (!rows[id] || rows[id].revision !== revision) return false;
      if (next.state === "running" && Object.values(rows).some(row => row.id !== id && (row.state === "running" || (row.state === "needs_review" && row.issue === "booking_uncertain")))) return false;
      persist({ ...rows, [id]: copy(next) }); return true;
    },
    async close() {},
  };
}
function checkReplacement(id, revision, next) {
  if (next.id !== id || next.revision !== revision + 1) throw new Error("Invalid proposal revision");
}
module.exports = { createSchedulingStore };
