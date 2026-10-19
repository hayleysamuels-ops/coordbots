"use strict";

const fs = require("fs");
const path = require("path");
// Node's own SQLite, not better-sqlite3: this app needs no native build
// step, so a Railway deploy can never fail on node-gyp or a blocked
// install script. Stable from Node 24; package.json pins >=22.5.
const { DatabaseSync } = require("node:sqlite");
const config = require("./config");

const FILE = path.join(config.dataDir, "metrics.sqlite");

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new DatabaseSync(FILE);

// WAL so the hourly sync's writes never block a dashboard read mid-refresh.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA foreign_keys = ON");

/**
 * node:sqlite has no `db.transaction(fn)` helper, so this is the
 * equivalent: run `fn` inside BEGIN/COMMIT, rolling back if it throws.
 * Used per page of sync results — 200-odd pages each committing once is
 * far faster than row-by-row autocommit, and a crash mid-sync leaves
 * whole pages behind rather than half a schedule.
 */
function transaction(fn) {
  return (...args) => {
    db.exec("BEGIN");
    try {
      const result = fn(...args);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackErr) {
        console.error("[db] rollback failed:", rollbackErr.message);
      }
      throw err;
    }
  };
}

/**
 * Every table is keyed on (client_id, id) rather than id alone. Ashby ids
 * are per-org UUIDs with no cross-org uniqueness guarantee, and this
 * process holds five orgs in one file — a bare id primary key would be a
 * silent collision waiting to happen.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS schedules (
  client_id           TEXT NOT NULL,
  id                  TEXT NOT NULL,
  status              TEXT,
  application_id      TEXT,
  interview_stage_id  TEXT,
  -- Ashby returns scheduledBy as a user OBJECT, not a string: the person
  -- who actually booked the slot. Stored split so it can be read without
  -- parsing JSON back out.
  scheduled_by_id     TEXT,
  scheduled_by_name   TEXT,
  -- Stored so a roster name resolving to two different user ids can be
  -- flagged as a collision rather than silently merging two people, and
  -- so a mid-window rename is visible (same id, different name).
  scheduled_by_email  TEXT,
  created_at          TEXT,
  updated_at          TEXT,
  PRIMARY KEY (client_id, id)
);
CREATE INDEX IF NOT EXISTS idx_schedules_client_created ON schedules (client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_schedules_application   ON schedules (client_id, application_id);
CREATE INDEX IF NOT EXISTS idx_schedules_status        ON schedules (client_id, status);

CREATE TABLE IF NOT EXISTS events (
  client_id           TEXT NOT NULL,
  id                  TEXT NOT NULL,
  schedule_id         TEXT,
  interview_id        TEXT,
  start_time          TEXT,
  end_time            TEXT,
  created_at          TEXT,
  updated_at          TEXT,
  interviewer_count   INTEGER DEFAULT 0,
  interviewer_ids     TEXT,
  has_feedback        INTEGER DEFAULT 0,
  PRIMARY KEY (client_id, id)
);
CREATE INDEX IF NOT EXISTS idx_events_client_start ON events (client_id, start_time);
CREATE INDEX IF NOT EXISTS idx_events_schedule     ON events (client_id, schedule_id);
CREATE INDEX IF NOT EXISTS idx_events_interview    ON events (client_id, interview_id);

-- Observed reschedules: one row each time an event's startTime is seen to
-- have CHANGED between syncs. Ashby keeps no reschedule history of its own
-- (checked across schedule fields, event fields, application.listHistory
-- and extraData on a live sample), so this is the only precise source —
-- and it necessarily starts from the first sync, never earlier. The
-- derived historical estimate in metrics.js covers the period before that.
CREATE TABLE IF NOT EXISTS reschedules (
  client_id       TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  previous_start  TEXT,
  new_start       TEXT,
  PRIMARY KEY (client_id, event_id, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_reschedules_observed ON reschedules (client_id, observed_at);

CREATE TABLE IF NOT EXISTS interviews (
  client_id   TEXT NOT NULL,
  id          TEXT NOT NULL,
  title       TEXT,
  is_debrief  INTEGER DEFAULT 0,
  PRIMARY KEY (client_id, id)
);

CREATE TABLE IF NOT EXISTS jobs (
  client_id      TEXT NOT NULL,
  id             TEXT NOT NULL,
  title          TEXT,
  status         TEXT,
  department_id  TEXT,
  opened_at      TEXT,
  closed_at      TEXT,
  PRIMARY KEY (client_id, id)
);

CREATE TABLE IF NOT EXISTS departments (
  client_id  TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT,
  PRIMARY KEY (client_id, id)
);

CREATE TABLE IF NOT EXISTS stages (
  client_id  TEXT NOT NULL,
  id         TEXT NOT NULL,
  title      TEXT,
  type       TEXT,
  PRIMARY KEY (client_id, id)
);

CREATE TABLE IF NOT EXISTS applications (
  client_id       TEXT NOT NULL,
  id              TEXT NOT NULL,
  candidate_id    TEXT,
  candidate_name  TEXT,
  job_id          TEXT,
  status          TEXT,
  stage_id        TEXT,
  stage_title     TEXT,
  archive_reason  TEXT,
  archived_at     TEXT,
  created_at      TEXT,
  updated_at      TEXT,
  coordinator     TEXT,
  recruiter       TEXT,
  PRIMARY KEY (client_id, id)
);
CREATE INDEX IF NOT EXISTS idx_applications_job ON applications (client_id, job_id);

-- Small key/value side table for facts about the sync itself that aren't
-- rows of Ashby data — currently just when interview definitions were last
-- resolved, which the dashboard shows so this can't silently go stale.
-- One row per stage an application has occupied, from application.info's
-- embedded applicationHistory[]. This is the only way to know when a
-- candidate became schedulable for a given round: Ashby records no
-- timestamp for a schedule entering NeedsScheduling, and a schedule's own
-- createdAt is the moment the coordinator started work, not the moment
-- the work became available. Verified present with a matching stageId on
-- 100% of sampled schedules across all six clients.
CREATE TABLE IF NOT EXISTS application_stages (
  client_id       TEXT NOT NULL,
  application_id  TEXT NOT NULL,
  stage_id        TEXT NOT NULL,
  title           TEXT,
  stage_number    INTEGER,
  entered_at      TEXT,
  left_at         TEXT,
  PRIMARY KEY (client_id, application_id, stage_id)
);
CREATE INDEX IF NOT EXISTS idx_appstages_lookup ON application_stages (client_id, application_id, stage_id);

CREATE TABLE IF NOT EXISTS sync_meta (
  client_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT,
  PRIMARY KEY (client_id, key)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  client_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  ok           INTEGER,
  detail       TEXT,
  PRIMARY KEY (client_id, kind, started_at)
);
`);

// Added after the table shipped, so existing volumes need it backfilled
// rather than recreated — the 12-month history and the observed-reschedule
// log both live in this file and neither is cheap to rebuild.
try {
  const columns = db.prepare(`PRAGMA table_info(schedules)`).all().map((c) => c.name);
  if (!columns.includes("scheduled_by_email")) {
    db.exec(`ALTER TABLE schedules ADD COLUMN scheduled_by_email TEXT`);
    console.log("[db] added schedules.scheduled_by_email");
  }
} catch (err) {
  console.warn("[db] could not check/add scheduled_by_email:", err.message);
}

// --- Writes ----------------------------------------------------------------

const upsertSchedule = db.prepare(`
  INSERT INTO schedules (client_id, id, status, application_id, interview_stage_id, scheduled_by_id, scheduled_by_name, scheduled_by_email, created_at, updated_at)
  VALUES (@client_id, @id, @status, @application_id, @interview_stage_id, @scheduled_by_id, @scheduled_by_name, @scheduled_by_email, @created_at, @updated_at)
  ON CONFLICT (client_id, id) DO UPDATE SET
    status = excluded.status,
    application_id = excluded.application_id,
    interview_stage_id = excluded.interview_stage_id,
    scheduled_by_id = excluded.scheduled_by_id,
    scheduled_by_name = excluded.scheduled_by_name,
    scheduled_by_email = excluded.scheduled_by_email,
    updated_at = excluded.updated_at
`);

const selectEventStart = db.prepare(`SELECT start_time FROM events WHERE client_id = ? AND id = ?`);

const upsertEvent = db.prepare(`
  INSERT INTO events (client_id, id, schedule_id, interview_id, start_time, end_time, created_at, updated_at, interviewer_count, interviewer_ids, has_feedback)
  VALUES (@client_id, @id, @schedule_id, @interview_id, @start_time, @end_time, @created_at, @updated_at, @interviewer_count, @interviewer_ids, @has_feedback)
  ON CONFLICT (client_id, id) DO UPDATE SET
    schedule_id = excluded.schedule_id,
    interview_id = excluded.interview_id,
    start_time = excluded.start_time,
    end_time = excluded.end_time,
    updated_at = excluded.updated_at,
    interviewer_count = excluded.interviewer_count,
    interviewer_ids = excluded.interviewer_ids,
    has_feedback = excluded.has_feedback
`);

const insertReschedule = db.prepare(`
  INSERT OR IGNORE INTO reschedules (client_id, event_id, observed_at, previous_start, new_start)
  VALUES (?, ?, ?, ?, ?)
`);

const upsertInterview = db.prepare(`
  INSERT INTO interviews (client_id, id, title, is_debrief) VALUES (?, ?, ?, ?)
  ON CONFLICT (client_id, id) DO UPDATE SET title = excluded.title, is_debrief = excluded.is_debrief
`);

const upsertJob = db.prepare(`
  INSERT INTO jobs (client_id, id, title, status, department_id, opened_at, closed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (client_id, id) DO UPDATE SET
    title = excluded.title, status = excluded.status, department_id = excluded.department_id,
    opened_at = excluded.opened_at, closed_at = excluded.closed_at
`);

const upsertDepartment = db.prepare(`
  INSERT INTO departments (client_id, id, name) VALUES (?, ?, ?)
  ON CONFLICT (client_id, id) DO UPDATE SET name = excluded.name
`);

const upsertStage = db.prepare(`
  INSERT INTO stages (client_id, id, title, type) VALUES (?, ?, ?, ?)
  ON CONFLICT (client_id, id) DO UPDATE SET title = excluded.title, type = excluded.type
`);

const upsertApplication = db.prepare(`
  INSERT INTO applications (client_id, id, candidate_id, candidate_name, job_id, status, stage_id, stage_title,
                            archive_reason, archived_at, created_at, updated_at, coordinator, recruiter)
  VALUES (@client_id, @id, @candidate_id, @candidate_name, @job_id, @status, @stage_id, @stage_title,
          @archive_reason, @archived_at, @created_at, @updated_at, @coordinator, @recruiter)
  ON CONFLICT (client_id, id) DO UPDATE SET
    candidate_id = excluded.candidate_id, candidate_name = excluded.candidate_name, job_id = excluded.job_id,
    status = excluded.status, stage_id = excluded.stage_id, stage_title = excluded.stage_title,
    archive_reason = excluded.archive_reason, archived_at = excluded.archived_at,
    updated_at = excluded.updated_at, coordinator = excluded.coordinator, recruiter = excluded.recruiter
`);

/**
 * Writes one page of schedules and their inlined events, detecting
 * reschedules as it goes. Wrapped in a transaction per page: 200-odd pages
 * each committing once is dramatically faster than row-by-row autocommit,
 * and a crash mid-sync leaves whole pages, never half a schedule.
 */
// node:sqlite binds only null, number, string, bigint and buffers — an
// object or a boolean throws "cannot be bound to SQLite parameter N"
// rather than coercing silently, which is how scheduledBy's real shape
// (a user object, not a string) surfaced in the first place.
function personId(value) {
  if (!value || typeof value !== "object") return typeof value === "string" ? value : null;
  return value.id || value.userId || null;
}

function personName(value) {
  if (!value || typeof value !== "object") return null;
  const name = [value.firstName, value.lastName].filter(Boolean).join(" ");
  return name || value.email || null;
}

const writeSchedulePage = transaction((clientId, schedules, observedAt) => {
  let rescheduleCount = 0;

  for (const schedule of schedules) {
    upsertSchedule.run({
      client_id: clientId,
      id: schedule.id,
      status: schedule.status || null,
      application_id: schedule.applicationId || null,
      interview_stage_id: schedule.interviewStageId || null,
      scheduled_by_id: personId(schedule.scheduledBy),
      scheduled_by_name: personName(schedule.scheduledBy),
      scheduled_by_email: schedule.scheduledBy && typeof schedule.scheduledBy === "object" ? schedule.scheduledBy.email || null : null,
      created_at: schedule.createdAt || null,
      updated_at: schedule.updatedAt || null,
    });

    for (const event of schedule.interviewEvents || []) {
      const previous = selectEventStart.get(clientId, event.id);

      // A start time that moved between two syncs is a reschedule. A brand
      // new event is not — it has no previous value to differ from, which
      // is exactly why this can only ever count forward from first sight.
      if (previous && previous.start_time && event.startTime && previous.start_time !== event.startTime) {
        insertReschedule.run(clientId, event.id, observedAt, previous.start_time, event.startTime);
        rescheduleCount += 1;
      }

      const interviewerIds = Array.isArray(event.interviewerUserIds) ? event.interviewerUserIds : [];

      upsertEvent.run({
        client_id: clientId,
        id: event.id,
        schedule_id: event.interviewScheduleId || schedule.id,
        interview_id: event.interviewId || null,
        start_time: event.startTime || null,
        end_time: event.endTime || null,
        created_at: event.createdAt || null,
        updated_at: event.updatedAt || null,
        interviewer_count: interviewerIds.length,
        interviewer_ids: JSON.stringify(interviewerIds),
        has_feedback: event.hasSubmittedFeedback ? 1 : 0,
      });
    }
  }

  return rescheduleCount;
});

const upsertApplicationStage = db.prepare(`
  INSERT INTO application_stages (client_id, application_id, stage_id, title, stage_number, entered_at, left_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (client_id, application_id, stage_id) DO UPDATE SET
    title = excluded.title, stage_number = excluded.stage_number,
    entered_at = excluded.entered_at, left_at = excluded.left_at
`);

const writeApplicationPage = transaction((clientId, applications) => {
  for (const app of applications) {
    const team = Array.isArray(app.hiringTeam) ? app.hiringTeam : [];
    const named = (role) => {
      const member = team.find((m) => m && m.role === role);
      return member ? [member.firstName, member.lastName].filter(Boolean).join(" ") || member.email || null : null;
    };

    upsertApplication.run({
      client_id: clientId,
      id: app.id,
      candidate_id: app.candidate ? app.candidate.id : null,
      candidate_name: app.candidate ? app.candidate.name : null,
      job_id: app.job ? app.job.id : null,
      status: app.status || null,
      stage_id: app.currentInterviewStage ? app.currentInterviewStage.id : null,
      stage_title: app.currentInterviewStage ? app.currentInterviewStage.title : null,
      archive_reason: app.archiveReason ? app.archiveReason.text || app.archiveReason.reasonType || null : null,
      archived_at: app.archivedAt || null,
      created_at: app.createdAt || null,
      updated_at: app.updatedAt || null,
      // Captured but not surfaced: the product decision is to attribute by
      // client, not to split coordinators within one. Stored so a per-
      // coordinator breakdown is a query away if that changes.
      coordinator: named("Recruiting Coordinator"),
      recruiter: named("Recruiter"),
    });

    // Only application.info carries applicationHistory; application.list
    // does not. Absent on a row means that application has not been
    // re-fetched since this table existed, which syncApplications treats
    // as a reason to refetch.
    for (const entry of app.applicationHistory || []) {
      if (!entry || !entry.stageId) continue;
      upsertApplicationStage.run(
        clientId,
        app.id,
        entry.stageId,
        entry.title || null,
        Number.isFinite(entry.stageNumber) ? entry.stageNumber : null,
        entry.enteredStageAt || null,
        entry.leftStageAt || null
      );
    }
  }
});

const writeReference = transaction((clientId, { interviews, jobs, departments, stages }) => {
  for (const i of interviews || []) upsertInterview.run(clientId, i.id, i.title || null, i.isDebrief ? 1 : 0);
  for (const j of jobs || []) {
    upsertJob.run(clientId, j.id, j.title || null, j.status || null, j.departmentId || null, j.openedAt || null, j.closedAt || null);
  }
  for (const d of departments || []) upsertDepartment.run(clientId, d.id, d.name || null);
  for (const s of stages || []) upsertStage.run(clientId, s.id, s.title || null, s.type || null);
});

function setMeta(clientId, key, value) {
  db.prepare(
    `INSERT INTO sync_meta (client_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (client_id, key) DO UPDATE SET value = excluded.value`
  ).run(clientId, key, value);
}

function getMeta(clientId, key) {
  const row = db.prepare(`SELECT value FROM sync_meta WHERE client_id = ? AND key = ?`).get(clientId, key);
  return row ? row.value : null;
}

/**
 * Interview ids referenced by stored events that have no matching row in
 * `interviews`.
 *
 * `interview.list` does not return every definition an org has ever used —
 * confirmed live: it returns 83 for Luminai while its events reference 118
 * more, and passing `includeArchived` changes nothing. The missing ones are
 * not even archived (the most-used one resolves via `interview.info` with
 * `isArchived: false`). Without resolving them, an event has no title, so
 * the hold-exclusion rule cannot be applied to it and its debrief flag is
 * unknown — which silently affected 88% of Forus's events.
 */
function unresolvedInterviewIds(clientId) {
  return db
    .prepare(
      `SELECT DISTINCT e.interview_id AS id
       FROM events e
       LEFT JOIN interviews i ON i.client_id = e.client_id AND i.id = e.interview_id
       WHERE e.client_id = ? AND e.interview_id IS NOT NULL AND i.id IS NULL`
    )
    .all(clientId)
    .map((row) => row.id);
}

/**
 * Job ids referenced by stored applications that have no row in `jobs`.
 *
 * Third endpoint with the same shape of gap: `job.list` does not return
 * Draft jobs even with `includeArchived: true` (confirmed live — Poetic's
 * "Business Operations - Compliance & Trust" is status Draft and absent
 * from the list). An event whose job is missing renders as "Unknown role".
 */
/**
 * Applications stored without any stage history.
 *
 * They were fetched before application_stages existed, so booking
 * turnaround cannot be computed for them. Re-fetching is the only way to
 * fill the gap; this is drained over successive full syncs rather than
 * all at once, since it is ~17,000 calls across the six clients.
 */
function applicationsMissingHistory(clientId, limit) {
  return db
    .prepare(
      `SELECT a.id FROM applications a
       WHERE a.client_id = ?
         AND EXISTS (SELECT 1 FROM schedules s WHERE s.client_id = a.client_id AND s.application_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM application_stages st WHERE st.client_id = a.client_id AND st.application_id = a.id)
       LIMIT ?`
    )
    .all(clientId, limit)
    .map((r) => r.id);
}

// Whether any stage history has been captured for a client at all.
// An ended engagement is normally synced once and never again, but that
// rule was written before application_stages existed — Profound was
// marked complete and then skipped forever, leaving it the one client
// with no booking turnaround.
function hasStageHistory(clientId) {
  const row = db.prepare(`SELECT 1 AS present FROM application_stages WHERE client_id = ? LIMIT 1`).get(clientId);
  return Boolean(row);
}

function unresolvedJobIds(clientId) {
  return db
    .prepare(
      `SELECT DISTINCT a.job_id AS id
       FROM applications a
       LEFT JOIN jobs j ON j.client_id = a.client_id AND j.id = a.job_id
       WHERE a.client_id = ? AND a.job_id IS NOT NULL AND j.id IS NULL`
    )
    .all(clientId)
    .map((row) => row.id);
}

function recordSyncRun(clientId, kind, startedAt, ok, detail) {
  db.prepare(
    `INSERT OR REPLACE INTO sync_runs (client_id, kind, started_at, finished_at, ok, detail) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(clientId, kind, startedAt, new Date().toISOString(), ok ? 1 : 0, detail || null);
}

function lastSyncRuns() {
  return db
    .prepare(
      `SELECT client_id, kind, MAX(finished_at) AS finished_at, ok, detail
       FROM sync_runs WHERE finished_at IS NOT NULL GROUP BY client_id, kind`
    )
    .all();
}

// Earliest observed reschedule per client — the honest "precise reschedule
// data starts here" line the UI shows next to the derived estimate.
function rescheduleTrackingSince(clientId) {
  const row = db
    .prepare(`SELECT MIN(started_at) AS since FROM sync_runs WHERE client_id = ? AND ok = 1`)
    .get(clientId);
  return row ? row.since : null;
}

module.exports = {
  db,
  setMeta,
  getMeta,
  unresolvedInterviewIds,
  unresolvedJobIds,
  applicationsMissingHistory,
  hasStageHistory,
  writeSchedulePage,
  writeApplicationPage,
  writeReference,
  recordSyncRun,
  lastSyncRuns,
  rescheduleTrackingSince,
  FILE,
};
