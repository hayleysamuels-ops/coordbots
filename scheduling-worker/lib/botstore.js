"use strict";
/**
 * Storage for the bots: run log, per-bot config, and weekly snapshots.
 *
 * Follows the same pattern as the tracker's own storage — Postgres when
 * DATABASE_URL is set, otherwise a local bots.json file so you can run a bot on
 * your laptop without a database. It uses its own small connection pool and its
 * own tables; it does not touch `candidates` or `users`.
 */
const path = require("path");

function createBotStore({ databaseUrl, dir }) {
  return databaseUrl ? pgStore(databaseUrl) : fileStore(dir);
}

/* ---------------- Postgres ---------------- */
function pgStore(databaseUrl) {
  const { Pool } = require("pg");
  const needSSL = !/localhost|127\.0\.0\.1|\.railway\.internal/.test(databaseUrl);
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: needSSL ? { rejectUnauthorized: false } : false,
    max: 3,
  });

  const ready = pool
    .query(
      "CREATE TABLE IF NOT EXISTS run_log (" +
        "id SERIAL PRIMARY KEY," +
        "job_name TEXT NOT NULL," +
        // Identifies the scheduled slot, e.g. 2026-08-31T07:00. Manual runs get
        // a unique key. The UNIQUE below is what stops two instances, or a
        // restart, posting the same report twice.
        "slot_key TEXT NOT NULL," +
        "trigger TEXT NOT NULL," +
        "started_at TIMESTAMPTZ NOT NULL DEFAULT now()," +
        "finished_at TIMESTAMPTZ," +
        "outcome TEXT," +
        "summary JSONB," +
        "message JSONB," +
        "error TEXT," +
        "UNIQUE (job_name, slot_key))"
    )
    .then(() =>
      pool.query(
        "CREATE TABLE IF NOT EXISTS bot_config (" +
          "job_name TEXT PRIMARY KEY," +
          "enabled BOOLEAN NOT NULL DEFAULT true," +
          "dry_run BOOLEAN NOT NULL DEFAULT true," +
          "updated_at TIMESTAMPTZ NOT NULL DEFAULT now()," +
          "updated_by TEXT)"
      )
    )
    .then(() =>
      pool.query(
        // Keyed on (pool_id, user_id) — the same person can be paused in one
        // pool and active in another, so user_id alone is never a key here.
        "CREATE TABLE IF NOT EXISTS pool_snapshot (" +
          "run_id INTEGER NOT NULL," +
          "pool_id TEXT NOT NULL," +
          "pool_title TEXT," +
          "user_id TEXT NOT NULL," +
          "user_name TEXT," +
          "is_paused BOOLEAN," +
          "is_enabled BOOLEAN," +
          "weekly_limit INTEGER," +
          "daily_limit INTEGER," +
          "PRIMARY KEY (run_id, pool_id, user_id))"
      )
    )
    .then(() =>
      // Bot 1's panel cache. Disposable and rebuildable: it holds only data
      // fetched from Ashby, never the candidate-to-Ashby link (that is stored on
      // the tracker row, because a person confirmed it and it must survive).
      pool.query(
        "CREATE TABLE IF NOT EXISTS ashby_panel_cache (" +
          "ashby_candidate_id TEXT PRIMARY KEY," +
          "payload JSONB NOT NULL," +
          "fetched_at TIMESTAMPTZ NOT NULL DEFAULT now())"
      )
    )
    .then(() =>
      // Slow-changing lookups: interview titles and stage titles by id.
      pool.query(
        "CREATE TABLE IF NOT EXISTS lookup_cache (" +
          "kind TEXT NOT NULL," +
          "key TEXT NOT NULL," +
          "value JSONB NOT NULL," +
          "fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()," +
          "PRIMARY KEY (kind, key))"
      )
    )
    .then(() =>
      // Not a cache: a dismissal is a decision and must survive a redeploy.
      pool.query(
        "CREATE TABLE IF NOT EXISTS suggestion_dismissals (" +
          "ashby_candidate_id TEXT PRIMARY KEY," +
          "name TEXT," +
          "dismissed_by TEXT," +
          "dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now())"
      )
    )
    .then(() =>
      // One row per candidate per milestone, holding slack_ts so a later run
      // edits the existing message instead of posting a second one.
      //
      // KEYED ON (candidate_id, milestone) — NOT on trial_start.
      // It used to include trial_start, on the reasoning that a rescheduled
      // trial should legitimately start over. In practice the derived start
      // moved whenever ANY event moved, and on 2 Sept 2026 Sid Panjwani's agent
      // shadowing was rescheduled three times in an afternoon. Each move
      // produced a new key, noticesFor() came back empty, nothing looked
      // handled, and the sweep posted afresh: three posts, with the milestones
      // reading backwards in the channel (T-24, then T-72, then T-24).
      //
      // A timestamp cannot be a de-duplication key when the timestamp is the
      // thing that moves. trial_start stays as a recorded value — the sweep
      // uses it to notice a reschedule and say so — but it is not identity.
      pool.query(
        "CREATE TABLE IF NOT EXISTS readiness_notice (" +
          "candidate_id TEXT NOT NULL," +
          "trial_start TEXT," +
          "milestone TEXT NOT NULL," +
          "slack_ts TEXT," +
          "red_count INTEGER," +
          "posted_at TIMESTAMPTZ NOT NULL DEFAULT now()," +
          "PRIMARY KEY (candidate_id, milestone))"
      )
    )
    .then(() =>
      // Migrate a table created under the old three-column key. Idempotent:
      // it inspects the live primary key and does nothing once migrated.
      // Collapsing duplicates keeps the most recently posted row per
      // (candidate_id, milestone), so the slack_ts that survives is the message
      // a later run should edit.
      pool.query(
        "DO $$\n" +
        "DECLARE pk text;\n" +
        "BEGIN\n" +
        "  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO pk\n" +
        "    FROM pg_constraint c\n" +
        "    JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, ord) ON true\n" +
        "    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum\n" +
        "   WHERE c.conrelid = 'readiness_notice'::regclass AND c.contype = 'p';\n" +
        "  IF pk IS DISTINCT FROM 'candidate_id,milestone' THEN\n" +
        "    DELETE FROM readiness_notice WHERE ctid NOT IN (\n" +
        "      SELECT DISTINCT ON (candidate_id, milestone) ctid FROM readiness_notice\n" +
        "       ORDER BY candidate_id, milestone, posted_at DESC, ctid DESC);\n" +
        "    ALTER TABLE readiness_notice DROP CONSTRAINT IF EXISTS readiness_notice_pkey;\n" +
        "    ALTER TABLE readiness_notice ALTER COLUMN trial_start DROP NOT NULL;\n" +
        "    ALTER TABLE readiness_notice ADD PRIMARY KEY (candidate_id, milestone);\n" +
        "  END IF;\n" +
        "END $$;"
      )
    );

  return {
    kind: "postgres",
    async claimRun(jobName, slotKey, trigger) {
      await ready;
      const r = await pool.query(
        "INSERT INTO run_log(job_name,slot_key,trigger) VALUES($1,$2,$3) " +
          "ON CONFLICT (job_name,slot_key) DO NOTHING RETURNING id",
        [jobName, slotKey, trigger]
      );
      return r.rows[0] ? r.rows[0].id : null; // null = someone else has this slot
    },
    async finishRun(runId, { outcome, summary, message, error }) {
      await ready;
      await pool.query(
        "UPDATE run_log SET finished_at=now(), outcome=$2, summary=$3, message=$4, error=$5 WHERE id=$1",
        [runId, outcome, summary || null, message || null, error || null]
      );
    },
    /**
     * Trim the run log by age. Deliberately age-based and not outcome-based:
     * quiet ticks are the alive signal, and "the bot quietly did nothing" is
     * exactly the failure this table exists to catch.
     */
    async pruneRunLog(days) {
      await ready;
      const r = await pool.query(
        "DELETE FROM run_log WHERE started_at < now() - ($1 || ' days')::interval",
        [String(days)]
      );
      return r.rowCount || 0;
    },
    async recentRuns(jobName, limit = 10) {
      await ready;
      const r = await pool.query(
        "SELECT id,job_name,slot_key,trigger,started_at,finished_at,outcome,summary,message,error " +
          "FROM run_log WHERE job_name=$1 ORDER BY id DESC LIMIT $2",
        [jobName, limit]
      );
      return r.rows;
    },
    async saveSnapshot(runId, rows) {
      await ready;
      for (const s of rows) {
        await pool.query(
          "INSERT INTO pool_snapshot(run_id,pool_id,pool_title,user_id,user_name,is_paused,is_enabled,weekly_limit,daily_limit) " +
            "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
          [runId, s.poolId, s.poolTitle, s.userId, s.userName, s.isPaused, s.isEnabled, s.weeklyLimit, s.dailyLimit]
        );
      }
    },
    async previousSnapshot(jobName, beforeRunId) {
      await ready;
      const r = await pool.query(
        "SELECT s.* FROM pool_snapshot s JOIN run_log r ON r.id=s.run_id " +
          "WHERE r.job_name=$1 AND s.run_id < $2 AND s.run_id = " +
          "(SELECT MAX(s2.run_id) FROM pool_snapshot s2 JOIN run_log r2 ON r2.id=s2.run_id " +
          " WHERE r2.job_name=$1 AND s2.run_id < $2)",
        [jobName, beforeRunId]
      );
      return r.rows.map(rowToSnapshot);
    },
    async getConfig(jobName, defaults) {
      await ready;
      const r = await pool.query("SELECT * FROM bot_config WHERE job_name=$1", [jobName]);
      if (r.rows[0]) return { enabled: r.rows[0].enabled, dryRun: r.rows[0].dry_run };
      await pool.query(
        "INSERT INTO bot_config(job_name,enabled,dry_run) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [jobName, defaults.enabled, defaults.dryRun]
      );
      return { ...defaults };
    },
    async panelGet(ashbyCandidateId) {
      await ready;
      const r = await pool.query(
        "SELECT payload, fetched_at FROM ashby_panel_cache WHERE ashby_candidate_id=$1",
        [ashbyCandidateId]
      );
      return r.rows[0] ? { payload: r.rows[0].payload, fetchedAt: r.rows[0].fetched_at } : null;
    },
    async panelPut(ashbyCandidateId, payload) {
      await ready;
      await pool.query(
        "INSERT INTO ashby_panel_cache(ashby_candidate_id,payload,fetched_at) VALUES($1,$2,now()) " +
          "ON CONFLICT (ashby_candidate_id) DO UPDATE SET payload=$2, fetched_at=now()",
        [ashbyCandidateId, payload]
      );
    },
    async lookupGet(kind, key) {
      await ready;
      const r = await pool.query("SELECT value FROM lookup_cache WHERE kind=$1 AND key=$2", [kind, key]);
      return r.rows[0] ? r.rows[0].value : null;
    },
    async lookupPut(kind, key, value) {
      await ready;
      await pool.query(
        "INSERT INTO lookup_cache(kind,key,value,fetched_at) VALUES($1,$2,$3,now()) " +
          "ON CONFLICT (kind,key) DO UPDATE SET value=$3, fetched_at=now()",
        [kind, key, value]
      );
    },
    /** Every milestone already handled for this candidate, whatever the date. */
    async noticesFor(candidateId) {
      await ready;
      const r = await pool.query(
        "SELECT milestone, trial_start, slack_ts, red_count, posted_at FROM readiness_notice " +
          "WHERE candidate_id=$1 ORDER BY posted_at",
        [candidateId]
      );
      return r.rows.map((x) => ({ milestone: x.milestone, trialStart: x.trial_start,
        slackTs: x.slack_ts, redCount: x.red_count, postedAt: x.posted_at }));
    },
    async recordNotice(candidateId, milestone, trialStart, slackTs, redCount) {
      await ready;
      await pool.query(
        "INSERT INTO readiness_notice(candidate_id,milestone,trial_start,slack_ts,red_count) " +
          "VALUES($1,$2,$3,$4,$5) ON CONFLICT (candidate_id,milestone) " +
          "DO UPDATE SET trial_start=$3, slack_ts=COALESCE($4, readiness_notice.slack_ts), red_count=$5",
        [candidateId, milestone, trialStart || null, slackTs || null, redCount == null ? null : redCount]
      );
    },
    async listDismissals() {
      await ready;
      const r = await pool.query("SELECT * FROM suggestion_dismissals ORDER BY dismissed_at DESC");
      return r.rows.map((x) => ({
        ashbyCandidateId: x.ashby_candidate_id, name: x.name,
        dismissedBy: x.dismissed_by, dismissedAt: x.dismissed_at,
      }));
    },
    async dismiss(ashbyCandidateId, name, by) {
      await ready;
      await pool.query(
        "INSERT INTO suggestion_dismissals(ashby_candidate_id,name,dismissed_by) VALUES($1,$2,$3) " +
          "ON CONFLICT (ashby_candidate_id) DO UPDATE SET name=$2, dismissed_by=$3, dismissed_at=now()",
        [ashbyCandidateId, name || null, by || null]
      );
    },
    async undismiss(ashbyCandidateId) {
      await ready;
      await pool.query("DELETE FROM suggestion_dismissals WHERE ashby_candidate_id=$1", [ashbyCandidateId]);
    },
    async setConfig(jobName, patch, updatedBy) {
      await ready;
      const current = await this.getConfig(jobName, { enabled: true, dryRun: true });
      const next = { ...current, ...patch };
      await pool.query(
        "INSERT INTO bot_config(job_name,enabled,dry_run,updated_at,updated_by) VALUES($1,$2,$3,now(),$4) " +
          "ON CONFLICT (job_name) DO UPDATE SET enabled=$2, dry_run=$3, updated_at=now(), updated_by=$4",
        [jobName, next.enabled, next.dryRun, updatedBy || null]
      );
      return next;
    },
  };
}

function rowToSnapshot(r) {
  return {
    poolId: r.pool_id,
    poolTitle: r.pool_title,
    userId: r.user_id,
    userName: r.user_name,
    isPaused: r.is_paused,
    isEnabled: r.is_enabled,
    weeklyLimit: r.weekly_limit,
    dailyLimit: r.daily_limit,
  };
}

/* ---------------- local file ---------------- */
function fileStore(dir) {
  const fs = require("fs");
  const file = path.join(dir, "bots.json");
  let db = { runs: [], config: {}, snapshots: {}, nextId: 1, panels: {}, lookups: {}, dismissals: {}, notices: {} };
  try {
    db = { ...db, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (e) {
    /* first run */
  }
  const flush = () => {
    try {
      fs.writeFileSync(file, JSON.stringify(db, null, 2));
    } catch (e) {
      console.error("[botstore] write failed", e);
    }
  };

  /* One-time forward migration of notices written under the old
     candidateId|trialStart|milestone key, mirroring the Postgres migration.
     Keeps the most recently posted entry per (candidate, milestone), so the
     slack_ts that survives is the message a later run should edit — collapsing
     on read instead would drop it on the next write and buy one duplicate post
     per candidate, which is the bug this whole change is about. Idempotent. */
  (function migrateNotices() {
    const out = {};
    let changed = false;
    Object.keys(db.notices || {}).forEach(function (k) {
      const n = db.notices[k];
      if (!n || !n.candidateId || !n.milestone) return;
      const nk = n.candidateId + "|" + n.milestone;
      if (nk !== k) changed = true;
      const prev = out[nk];
      if (!prev || String(n.postedAt || "") >= String(prev.postedAt || "")) out[nk] = n;
    });
    if (changed || Object.keys(out).length !== Object.keys(db.notices || {}).length) {
      db.notices = out;
      flush();
    }
  })();

  return {
    kind: "file",
    async claimRun(jobName, slotKey, trigger) {
      if (db.runs.some((r) => r.job_name === jobName && r.slot_key === slotKey)) return null;
      const id = db.nextId++;
      db.runs.unshift({
        id,
        job_name: jobName,
        slot_key: slotKey,
        trigger,
        started_at: new Date().toISOString(),
      });
      db.runs = db.runs.slice(0, 50);
      flush();
      return id;
    },
    async finishRun(runId, { outcome, summary, message, error }) {
      const run = db.runs.find((r) => r.id === runId);
      if (!run) return;
      Object.assign(run, {
        finished_at: new Date().toISOString(),
        outcome,
        summary: summary || null,
        message: message || null,
        error: error || null,
      });
      flush();
    },
    async pruneRunLog(days) {
      const cutoff = Date.now() - days * 86400000;
      const before = db.runs.length;
      db.runs = db.runs.filter((r) => new Date(r.started_at).getTime() >= cutoff);
      const removed = before - db.runs.length;
      if (removed) flush();
      return removed;
    },
    async recentRuns(jobName, limit = 10) {
      return db.runs.filter((r) => r.job_name === jobName).slice(0, limit);
    },
    async saveSnapshot(runId, rows) {
      db.snapshots[runId] = rows;
      const keep = db.runs.map((r) => String(r.id));
      Object.keys(db.snapshots).forEach((k) => {
        if (!keep.includes(k)) delete db.snapshots[k];
      });
      flush();
    },
    async previousSnapshot(jobName, beforeRunId) {
      const prior = db.runs
        .filter((r) => r.job_name === jobName && r.id < beforeRunId && db.snapshots[r.id])
        .sort((a, b) => b.id - a.id)[0];
      return prior ? db.snapshots[prior.id] : [];
    },
    async getConfig(jobName, defaults) {
      if (!db.config[jobName]) {
        db.config[jobName] = { ...defaults };
        flush();
      }
      return { ...db.config[jobName] };
    },
    async panelGet(ashbyCandidateId) {
      const p = db.panels[ashbyCandidateId];
      return p ? { payload: p.payload, fetchedAt: p.fetchedAt } : null;
    },
    async panelPut(ashbyCandidateId, payload) {
      db.panels[ashbyCandidateId] = { payload, fetchedAt: new Date().toISOString() };
      flush();
    },
    async lookupGet(kind, key) {
      const v = db.lookups[kind + "|" + key];
      return v === undefined ? null : v;
    },
    async lookupPut(kind, key, value) {
      db.lookups[kind + "|" + key] = value;
      flush();
    },
    /* Keyed on candidate + milestone, never the timestamp — see the Postgres
       table comment for the three-posts-in-one-afternoon this fixes. Old-format
       keys were migrated when this store was opened, so there is one entry per
       milestone here by construction. */
    async noticesFor(candidateId) {
      return Object.values(db.notices).filter(function(n){ return n.candidateId===candidateId; });
    },
    async recordNotice(candidateId, milestone, trialStart, slackTs, redCount) {
      var k=candidateId+"|"+milestone;
      var prev=db.notices[k]||{};
      db.notices[k]={ candidateId, milestone, trialStart: trialStart || null,
        slackTs: slackTs || prev.slackTs || null, redCount,
        postedAt: prev.postedAt || new Date().toISOString() };
      flush();
    },
    async listDismissals() {
      return Object.values(db.dismissals).sort((a,b)=> (b.dismissedAt||"").localeCompare(a.dismissedAt||""));
    },
    async dismiss(ashbyCandidateId, name, by) {
      db.dismissals[ashbyCandidateId]={ ashbyCandidateId, name:name||null, dismissedBy:by||null,
        dismissedAt:new Date().toISOString() };
      flush();
    },
    async undismiss(ashbyCandidateId) {
      delete db.dismissals[ashbyCandidateId]; flush();
    },
    async setConfig(jobName, patch, updatedBy) {
      db.config[jobName] = { ...(db.config[jobName] || {}), ...patch, updatedBy, updatedAt: new Date().toISOString() };
      flush();
      return { enabled: db.config[jobName].enabled, dryRun: db.config[jobName].dryRun };
    },
  };
}

module.exports = { createBotStore };
