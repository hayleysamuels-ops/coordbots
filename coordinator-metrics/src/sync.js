"use strict";

const config = require("./config");
const ashby = require("./ashby");
const store = require("./db");

// Only one sync may be in flight at a time. The nightly full sync takes
// roughly half an hour across five clients, which comfortably overlaps the
// hourly top-up — without this guard the two would interleave writes to
// the same rows and double-count reschedules against each other.
let running = null;
const progress = { kind: null, startedAt: null, client: null, done: 0, total: 0 };

function getSyncProgress() {
  return { running: Boolean(running), ...progress };
}

function monthsAgo(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.getTime();
}

function daysAgo(days) {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = [];
  let index = 0;

  async function run() {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/**
 * Brings the applications table in line with the schedules table.
 *
 * This deliberately does NOT sweep `application.list`. That endpoint
 * returns every application the org has ever received — 242,611 on Forus
 * and 236,896 on January as of the first backfill — of which only about
 * 8,000 per client ever reached a scheduled interview. Paginating all of
 * them took 27 minutes of the first full sync, stored a quarter of a
 * gigabyte nobody queries, and gets strictly worse every year the client
 * keeps hiring.
 *
 * What the metrics actually need is the application behind each schedule:
 * its candidate, its job, and whether it was later archived. So this
 * resolves exactly those, by id:
 *
 *   missing — referenced by a stored schedule but not in the database.
 *             On a first run that's the full ~8,000; afterwards it's the
 *             handful of genuinely new candidates since the last sync.
 *   stale   — on a full sync only, applications still marked Active.
 *             Those are the ones whose status can have changed underneath
 *             us (archived, hired), which the drop-off metric depends on.
 *             Already-archived rows are terminal and never re-read.
 *
 * Concurrency 8 is the limit candidate-dashboard already runs
 * `application.info` at against a single org without being rate-limited.
 */
const APPLICATION_CONCURRENCY = 8;

function applicationIdsToResolve(clientId, kind) {
  const missing = store.db
    .prepare(
      `SELECT DISTINCT s.application_id AS id
       FROM schedules s
       LEFT JOIN applications a ON a.client_id = s.client_id AND a.id = s.application_id
       WHERE s.client_id = ? AND s.application_id IS NOT NULL AND a.id IS NULL`
    )
    .all(clientId)
    .map((row) => row.id);

  if (kind !== "full") return missing;

  const stale = store.db
    .prepare(
      `SELECT DISTINCT a.id
       FROM applications a
       JOIN schedules s ON s.client_id = a.client_id AND s.application_id = a.id
       WHERE a.client_id = ? AND (a.status IS NULL OR a.status NOT IN ('Archived', 'Hired'))`
    )
    .all(clientId)
    .map((row) => row.id);

  return [...new Set([...missing, ...stale])];
}

async function syncApplications(client, kind) {
  const ids = applicationIdsToResolve(client.id, kind);
  if (ids.length === 0) return 0;

  let written = 0;
  let failed = 0;

  await mapWithConcurrency(ids, APPLICATION_CONCURRENCY, async (id) => {
    try {
      const json = await ashby.ashbyPost(client, "application.info", { applicationId: id });
      if (json.results) {
        store.writeApplicationPage(client.id, [json.results]);
        written += 1;
      }
    } catch (err) {
      // One unreadable application costs that application's events their
      // role, not the whole sync. It stays missing and is retried next time.
      failed += 1;
      if (failed <= 3) console.warn(`[sync:${client.id}] application.info failed for ${id}: ${err.message}`);
    }
  });

  if (failed > 3) console.warn(`[sync:${client.id}] ${failed} application.info calls failed in total`);
  return written;
}

/**
 * Resolves interview definitions that `interview.list` does not return.
 *
 * `interview.list` is not a complete list of an org's interview
 * definitions, and there is no flag that makes it one — `includeArchived`
 * changes nothing (tested live). Luminai's events reference 118 ids the
 * list endpoint omits; Forus's reference 785, covering 88% of its events.
 * The omitted ones are not archived either: the most-used missing Luminai
 * definition resolves through `interview.info` reporting
 * `isArchived: false`.
 *
 * The cost of leaving them unresolved is silent and one-directional: an
 * event with no title cannot be tested against the hold-exclusion
 * keywords, so holds are counted as interviews, and its `isDebrief` flag
 * is unknown, so debriefs are undercounted.
 *
 * Resolving them is a one-off per definition — 1,266 ids across all five
 * clients at first run, then only genuinely new ones — so this uses the
 * same targeted by-id fetch at concurrency 8 that syncApplications() does.
 */
async function syncInterviewDefinitions(client) {
  const ids = store.unresolvedInterviewIds(client.id);
  if (ids.length === 0) {
    store.setMeta(client.id, "interview_definitions_resolved_at", new Date().toISOString());
    return 0;
  }

  let written = 0;
  let failed = 0;

  await mapWithConcurrency(ids, APPLICATION_CONCURRENCY, async (id) => {
    try {
      const json = await ashby.ashbyPost(client, "interview.info", { id });
      const def = json.results;
      if (def && def.id) {
        store.writeReference(client.id, { interviews: [def] });
        written += 1;
      }
    } catch (err) {
      failed += 1;
      if (failed <= 3) console.warn(`[sync:${client.id}] interview.info failed for ${id}: ${err.message}`);
    }
  });

  if (failed > 3) console.warn(`[sync:${client.id}] ${failed} interview.info calls failed in total`);
  store.setMeta(client.id, "interview_definitions_resolved_at", new Date().toISOString());
  return written;
}

/**
 * Pulls one client. `kind` is "full" (12 months of history, plus the
 * reference tables and every application) or "incremental" (a rolling
 * recent window only).
 *
 * The incremental window exists because Ashby's interviewSchedule.list
 * filters on createdAfter and offers no updatedAfter: a schedule created
 * four months ago that is cancelled today has an old createdAt, so only a
 * wide enough window — or the nightly full sync — will see the change.
 */
async function syncClient(client, kind) {
  const startedAt = new Date().toISOString();
  const observedAt = startedAt;
  const t0 = Date.now();
  const createdAfter = kind === "full" ? monthsAgo(config.historyMonths) : daysAgo(config.incrementalDays);

  let schedulePages = 0;
  let scheduleCount = 0;
  let eventCount = 0;
  let rescheduleCount = 0;
  let applicationCount = 0;
  let definitionCount = 0;

  try {
    // Reference data first: an event's interview title and debrief flag,
    // and a schedule's job and stage, are all resolved against these. A
    // full sync always refreshes them; the hourly top-up refreshes them
    // too since they're small and a new job appearing mid-day is exactly
    // the kind of thing that would otherwise read as "Unknown role".
    const [interviews, jobs, departments, stages] = await Promise.all([
      ashby.listInterviews(client),
      ashby.listJobs(client),
      ashby.listDepartments(client),
      ashby.listInterviewStages(client),
    ]);
    store.writeReference(client.id, { interviews, jobs, departments, stages });

    await ashby.listInterviewSchedules(
      client,
      (page, pageNumber) => {
        rescheduleCount += store.writeSchedulePage(client.id, page, observedAt);
        schedulePages = pageNumber;
        scheduleCount += page.length;
        eventCount += page.reduce((n, s) => n + (s.interviewEvents || []).length, 0);
        progress.done = scheduleCount;
      },
      createdAfter
    );

    // Applications are resolved AFTER schedules, and from them: the set
    // worth fetching is defined by which schedules exist. An event whose
    // application is missing joins to nothing and renders as "Unknown
    // role" — confirmed live at 132 of Runlayer's 730 events before this
    // step existed.
    applicationCount = await syncApplications(client, kind);

    // After schedules, because the set of definitions worth resolving is
    // defined by the events that reference them — same ordering logic as
    // applications above.
    definitionCount = await syncInterviewDefinitions(client);

    const detail =
      `${scheduleCount} schedules, ${eventCount} events, ${applicationCount} applications resolved, ` +
      `${definitionCount} interview definitions resolved, ` +
      `${rescheduleCount} reschedules observed, ${schedulePages} pages in ${Math.round((Date.now() - t0) / 1000)}s`;
    store.recordSyncRun(client.id, kind, startedAt, true, detail);
    console.log(`[sync:${client.id}] ${kind} ok — ${detail}`);
    return { clientId: client.id, ok: true, detail };
  } catch (err) {
    store.recordSyncRun(client.id, kind, startedAt, false, err.message);
    console.error(`[sync:${client.id}] ${kind} FAILED — ${err.message}`);
    return { clientId: client.id, ok: false, detail: err.message };
  }
}

/**
 * Syncs every configured client. One client's failure never stops the
 * others: each returns its own result and the run as a whole still
 * finishes, the same independent-commit principle candidate-dashboard
 * learned the hard way with its section groups.
 */
async function syncAll(kind) {
  if (running) {
    console.log(`[sync] ${kind} skipped — a ${progress.kind} sync is already running`);
    return running;
  }

  const clients = config.clients.filter((c) => c.apiKey);
  if (clients.length === 0) {
    console.warn("[sync] no clients with an API key configured — nothing to sync");
    return [];
  }

  progress.kind = kind;
  progress.startedAt = new Date().toISOString();
  progress.total = clients.length;
  progress.done = 0;

  const t0 = Date.now();
  console.log(`[sync] ${kind} starting for ${clients.map((c) => c.id).join(", ")}`);

  running = mapWithConcurrency(clients, config.clientConcurrency, async (client) => {
    progress.client = client.id;
    return syncClient(client, kind);
  }).finally(() => {
    running = null;
    progress.kind = null;
    progress.client = null;
  });

  const results = await running;
  const failed = results.filter((r) => !r.ok);
  console.log(
    `[sync] ${kind} finished in ${Math.round((Date.now() - t0) / 1000)}s — ` +
      `${results.length - failed.length}/${results.length} clients ok` +
      (failed.length ? `; failed: ${failed.map((f) => f.clientId).join(", ")}` : "")
  );

  // Required here rather than at module load: metrics reads the same
  // database this module writes, and recomputing is the only thing that
  // makes a finished sync visible to the dashboard. Every caller used to
  // have to remember this — one of them (the scheduler) didn't.
  require("./metrics").rebuild();

  return results;
}

/**
 * Starts the background schedule: a full sync overnight and a top-up every
 * hour. Deliberately plain timers rather than a cron dependency — the
 * schedule is two rules, and a dependency that parses crontab syntax would
 * be more moving parts than the thing it replaces.
 */
function startScheduler() {
  const everyMinute = 60 * 1000;
  let lastFullSyncDay = null;

  setInterval(() => {
    const now = new Date();
    const today = now.toDateString();
    if (now.getHours() === config.fullSyncHour && lastFullSyncDay !== today) {
      lastFullSyncDay = today;
      syncAll("full").catch((err) => console.error("[sync] full sync threw:", err.message));
    }
  }, everyMinute);

  setInterval(() => {
    syncAll("incremental").catch((err) => console.error("[sync] incremental sync threw:", err.message));
  }, config.incrementalMinutes * 60 * 1000);

  console.log(
    `[sync] scheduler started — full sync at ${config.fullSyncHour}:00 server time, ` +
      `top-up every ${config.incrementalMinutes} minutes`
  );
}

module.exports = { syncAll, syncClient, startScheduler, getSyncProgress };
