"use strict";

const config = require("./config");
const store = require("./db");
const { businessHoursBetween } = require("./business-hours");

const { db } = store;

/**
 * Metrics are computed once per sync and cached, not recomputed per
 * request. The underlying data only changes when a sync runs, and a full
 * pass over a busy client's 12 months is ~18,000 events — cheap once an
 * hour, wasteful on every page poll.
 */
const cache = new Map();

// --- Time zone bucketing ---------------------------------------------------

// SQLite has no IANA time zone support, so day/week bucketing happens here
// in JS instead. Each client's tab buckets in that client's own zone, so
// "interviews on Tuesday" means the Tuesday their coordinator worked.
const formatterCache = new Map();

function partsIn(timeZone, date) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    });
    formatterCache.set(timeZone, formatter);
  }

  const parts = {};
  for (const { type, value } of formatter.formatToParts(date)) parts[type] = value;
  return parts;
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localBuckets(isoString, timeZone) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;

  const p = partsIn(timeZone, date);
  const day = `${p.year}-${p.month}-${p.day}`;
  // Hour 24 is how Intl reports midnight under hour12:false in some
  // runtimes; normalise it so the heatmap never grows a 25th row.
  const hour = parseInt(p.hour, 10) % 24;
  const dow = WEEKDAY_INDEX[p.weekday] ?? 0;

  // ISO-ish week key: the Monday of that local week. Built from the local
  // calendar date rather than the UTC instant so a Sunday-evening US
  // interview doesn't land in the following week.
  const [y, m, d] = day.split("-").map(Number);
  const noonUTC = Date.UTC(y, m - 1, d, 12);
  const weekdayFromMonday = (new Date(noonUTC).getUTCDay() + 6) % 7;
  const monday = new Date(noonUTC - weekdayFromMonday * 86400000);
  const week = monday.toISOString().slice(0, 10);

  return { day, week, month: day.slice(0, 7), hour, dow };
}

/**
 * The period options, defined ONCE.
 *
 * They were previously written out in three places — the per-client
 * period loop, the overview period loop, and the button list in
 * public/app.js — and the three drifted. Adding a "12 months" option to
 * the UI and defaulting to it, while two of the three backends still
 * produced only week/month/quarter, took the dashboard down twice:
 * `payload.periods[state.period]` was undefined and every stat tile threw
 * "Cannot read properties of undefined (reading 'current')".
 *
 * The server now serves this list via /api/config and app.js builds its
 * control from it, so the UI cannot offer a period the server does not
 * produce.
 *
 * The key is "full", NOT "all": `all` is already a SCOPE key
 * (`scopes.all` vs `scopes.coordinated`), and one word meaning two
 * different axes is what made the collision easy to miss both times.
 */
const PERIODS = [
  { key: "week", label: "7 days", description: "last 7 days", days: 7 },
  { key: "month", label: "30 days", description: "last 30 days", days: 30 },
  { key: "quarter", label: "90 days", description: "last 90 days", days: 90 },
  { key: "full", label: "12 months", description: "last 12 months", days: null },
];

// `days: null` means the whole history window.
function periodDays(period) {
  return period.days == null ? config.historyMonths * 30 : period.days;
}

const PERIOD_KEYS = PERIODS.map((p) => p.key);
const DEFAULT_PERIOD = "full";

/**
 * The window a client's figures are drawn from.
 *
 * An active client gets the rolling 12 months. An ENDED one gets its own
 * fixed engagement range instead: a rolling window would quietly erase
 * finished work as it aged out — Profound's engagement ends in August
 * 2026, so by September 2027 a rolling view would show none of it, with
 * nothing on screen to say why.
 */
function clientWindow(client) {
  if (client.isEnded) {
    return {
      from: new Date(`${client.engagementStart}T00:00:00.000Z`).toISOString(),
      to: new Date(`${client.engagementEnd}T23:59:59.999Z`).toISOString(),
      fixed: true,
    };
  }
  return {
    from: new Date(Date.now() - config.historyMonths * 30 * 86400000).toISOString(),
    to: new Date(Date.now() + 365 * 86400000).toISOString(),
    fixed: false,
  };
}

// --- Counting rules --------------------------------------------------------

/**
 * What counts as a unit of scheduling volume (agreed 14 October 2026):
 *
 *   counted   = candidate-facing interview events AND debriefs
 *   excluded  = holds, logistics and internal blocks
 *
 * Debriefs are identified by Ashby's own structured `isDebrief` flag on the
 * interview definition — not guessed from a title. Holds are NOT structured
 * anywhere in Ashby, so they're matched on interview title keywords, which
 * are per-client config. Forus's live interview.list contains "External
 * Hold", "[Forus] Arrival + Set Up", "... Work Time" and "Dinner with
 * Forus" sitting alongside real interviews, which is why this rule exists
 * at all. Verify a new client's titles with scripts/check-client.js before
 * trusting the defaults.
 */
// Compiled once per keyword. Whitespace in a keyword matches any run of
// whitespace, so "work time" still catches "Work  Time".
const keywordPatternCache = new Map();

function keywordPattern(keyword) {
  let pattern = keywordPatternCache.get(keyword);
  if (!pattern) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    pattern = new RegExp(`\\b${escaped}\\b`, "i");
    keywordPatternCache.set(keyword, pattern);
  }
  return pattern;
}

/**
 * Whether an interview title is a hold or logistics block.
 *
 * Matches on WHOLE WORDS, not substrings. This started as a plain
 * `includes()` and quietly excluded 297 real interviews across three
 * clients, because the keywords appear inside unrelated longer words:
 *
 *   "hold"  matched "[Forus] Stakeholder Conversation"  (241 events)
 *   "lunch" matched "Lunchtime Chat"                    ( 44 events)
 *   "break" matched "Breakfast with Kesava"             ( 12 events)
 *
 * None of those are holds. The failure was invisible from the page — the
 * interviews simply weren't there — which is why the excluded titles are
 * now listed in the UI rather than only counted.
 */
function isExcludedTitle(title, keywords) {
  if (!title) return false;
  return keywords.some((keyword) => keywordPattern(keyword).test(title));
}

/**
 * Whether a JOB is scaffolding rather than a real req.
 *
 * Deliberately an exact match on the trimmed, lowercased title — not a
 * substring like the interview-title rule above. A substring rule on
 * "test" would silently swallow a real "Test Engineer" role, and the
 * dashboard would show a smaller number with nothing indicating why.
 */
function isExcludedJob(title, excludedTitles) {
  // Defaulted rather than assumed: config always supplies this, but a
  // client object missing it should mean "exclude nothing", not throw and
  // take down the whole metrics rebuild for every client.
  if (!title || !Array.isArray(excludedTitles)) return false;
  return excludedTitles.includes(title.trim().toLowerCase());
}

/**
 * Ashby job titles carry stray trailing whitespace surprisingly often —
 * 5 of Luminai's 22 live titles, 3 of Forus's 85. Grouping is by job id so
 * this never affects a count, but it does affect what the title looks like
 * next to another one, and whether two rows read as the same role.
 */
function cleanTitle(title) {
  return (title || "").trim() || "Unknown role";
}

/**
 * Two job records can share a title: Luminai has two "Deployment
 * Strategist" reqs, one closed in August 2025 and one opened in April
 * 2026. Grouping is by job id, so they are correctly two rows — but
 * rendered they would be two identical lines with nothing to tell them
 * apart, which reads as a rendering bug rather than as two reqs.
 *
 * So same-titled rows get " (1)" / " (2)" appended, ordered oldest-opened
 * first for stability across refreshes. This mirrors what
 * candidate-dashboard already does for duplicate department names.
 *
 * Note this never MERGES them. "Forward Deployed Engineer",
 * "Forward Deployed Engineer, Team Lead" and "Forward Deployed Engineer -
 * New Grad" are three different roles at three different levels and stay
 * three rows; only exactly-equal titles are disambiguated.
 */
function disambiguateTitles(roles) {
  const byTitle = new Map();
  for (const role of roles) {
    const key = role.title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(role);
  }

  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    group
      .slice()
      .sort((a, b) => String(a.openedAt || "9999").localeCompare(String(b.openedAt || "9999")))
      .forEach((role, index) => {
        role.title = `${role.title} (${index + 1})`;
      });
  }

  return roles;
}

/**
 * Meals are COUNTED as interviews (see config.js), but they are also worth
 * naming: 481 of Forus's 17,358 interviews are lunches, and someone asked
 * how we get to that number should find the composition on the page, not
 * by reading this file.
 *
 * This is a label, not a filter — nothing is excluded on the strength of
 * it.
 */
const MEAL_TITLE_KEYWORDS = ["lunch", "dinner", "breakfast", "coffee"];

function isMealTitle(title) {
  if (!title) return false;
  return MEAL_TITLE_KEYWORDS.some((keyword) => keywordPattern(keyword).test(title));
}

// --- Queries ---------------------------------------------------------------

const selectEvents = db.prepare(`
  SELECT e.id, e.start_time, e.end_time, e.created_at AS event_created_at,
         e.interviewer_count, e.interview_id, e.has_feedback,
         i.title AS interview_title, i.is_debrief,
         s.id AS schedule_id, s.status AS schedule_status, s.created_at AS schedule_created_at,
         s.application_id, s.interview_stage_id,
         s.scheduled_by_name, s.scheduled_by_id, s.scheduled_by_email,
         st.title AS stage_title,
         a.candidate_id, a.job_id,
         j.title AS job_title, j.status AS job_status, j.opened_at AS job_opened_at,
         d.name AS department_name
  FROM events e
  LEFT JOIN interviews   i  ON i.client_id  = e.client_id AND i.id  = e.interview_id
  LEFT JOIN schedules    s  ON s.client_id  = e.client_id AND s.id  = e.schedule_id
  LEFT JOIN stages       st ON st.client_id = e.client_id AND st.id = s.interview_stage_id
  LEFT JOIN applications a  ON a.client_id  = e.client_id AND a.id  = s.application_id
  LEFT JOIN jobs         j  ON j.client_id  = e.client_id AND j.id  = a.job_id
  LEFT JOIN departments  d  ON d.client_id  = e.client_id AND d.id  = j.department_id
  WHERE e.client_id = ? AND e.start_time IS NOT NULL AND e.start_time >= ?
`);

/**
 * Cancellations, split into the two things a Cancelled schedule actually
 * means.
 *
 * Ashby records no cancellation reason anywhere — a Cancelled schedule is
 * indistinguishable from a reschedule by its own fields. But a cancelled
 * schedule whose application and interview stage get a NEW schedule
 * afterwards is, in practice, a reschedule: the same round of the same
 * candidate's process, re-booked. One with no successor is a real
 * cancellation or drop-out.
 *
 * This is a derivation, not a fact Ashby reports, and it's the only source
 * of reschedule data for the period before this app started running. The
 * observed-reschedule table is precise but only counts forward from first
 * sync; the UI shows both, labelled.
 */
/**
 * Who a cancelled schedule is attributed to.
 *
 * Ashby leaves `scheduledBy` empty on most cancelled schedules — 92% of
 * Luminai's, 24-33% elsewhere. Filtering the coordinated scope on that
 * field alone therefore DROPPED cancellations rather than filtering
 * them: Luminai read 0 reschedules and 2 cancellations against 214 and
 * 220 for all activity, while retaining 91% of its interviews.
 *
 * So attribution falls back, in order:
 *   1. the cancelled schedule's own scheduler
 *   2. whoever created the replacement schedule — for a reschedule, the
 *      person who re-booked it did the work
 *   3. whoever scheduled anything else on the same application — a
 *      cancellation on a candidate your coordinator was running is your
 *      coordinator's cancellation
 */
const ATTRIBUTED_SCHEDULER = `
  COALESCE(
    c.scheduled_by_name,
    (SELECT succ.scheduled_by_name FROM schedules succ
      WHERE succ.client_id = c.client_id AND succ.application_id = c.application_id
        AND succ.interview_stage_id = c.interview_stage_id AND succ.id != c.id
        AND succ.created_at > c.created_at AND succ.scheduled_by_name IS NOT NULL
      ORDER BY succ.created_at LIMIT 1),
    (SELECT sib.scheduled_by_name FROM schedules sib
      WHERE sib.client_id = c.client_id AND sib.application_id = c.application_id
        AND sib.scheduled_by_name IS NOT NULL
      ORDER BY sib.created_at LIMIT 1)
  )`;

const selectCancellations = db.prepare(`
  SELECT c.id, c.created_at, c.updated_at, c.application_id, c.interview_stage_id,
         ${ATTRIBUTED_SCHEDULER} AS scheduled_by_name,
         EXISTS (
           SELECT 1 FROM schedules later
           WHERE later.client_id = c.client_id
             AND later.application_id = c.application_id
             AND later.interview_stage_id = c.interview_stage_id
             AND later.id != c.id
             AND later.created_at > c.created_at
         ) AS rebooked
  FROM schedules c
  WHERE c.client_id = ? AND c.status = 'Cancelled' AND c.updated_at >= ?
`);

const selectObservedReschedules = db.prepare(`
  SELECT r.observed_at, r.previous_start, r.new_start, s.scheduled_by_name
  FROM reschedules r
  LEFT JOIN events e    ON e.client_id = r.client_id AND e.id = r.event_id
  LEFT JOIN schedules s ON s.client_id = e.client_id AND s.id = e.schedule_id
  WHERE r.client_id = ? AND r.observed_at >= ?
`);

// A candidate drop-off: an application archived after it had already
// reached a scheduled interview. Measures candidate-side loss from an
// active process, not generic resume rejections at application review.
// Drop-offs are attributed through whoever scheduled on that
// application — without it they were identical in both scopes, which
// made the coordinated number plainly wrong.
const selectDropOffs = db.prepare(`
  SELECT a.id, a.archived_at, a.archive_reason, a.job_id, j.title AS job_title,
         (SELECT s.scheduled_by_name FROM schedules s
           WHERE s.client_id = a.client_id AND s.application_id = a.id AND s.scheduled_by_name IS NOT NULL
           ORDER BY s.created_at LIMIT 1) AS scheduled_by_name
  FROM applications a
  LEFT JOIN jobs j ON j.client_id = a.client_id AND j.id = a.job_id
  WHERE a.client_id = ? AND a.status = 'Archived' AND a.archived_at IS NOT NULL AND a.archived_at >= ?
    AND EXISTS (SELECT 1 FROM schedules s WHERE s.client_id = a.client_id AND s.application_id = a.id)
`);

// Time to schedule: from the schedule being created to its first event
// being booked. Both timestamps are real Ashby fields, so this needs no
// inference.
const selectTimeToSchedule = db.prepare(`
  SELECT s.created_at AS requested_at, s.scheduled_by_name, MIN(e.created_at) AS booked_at
  FROM schedules s
  JOIN events e ON e.client_id = s.client_id AND e.schedule_id = s.id
  WHERE s.client_id = ? AND s.created_at >= ? AND e.created_at IS NOT NULL
  GROUP BY s.id
`);

/**
 * Booking turnaround: when a round became schedulable, and when it was
 * first confirmed on a calendar.
 *
 * "Became schedulable" is the application entering the schedule's own
 * interview stage, from application_stages. Ashby records no timestamp
 * for a schedule entering NeedsScheduling, and the schedule's createdAt
 * is when the coordinator started rather than when the work arrived —
 * measuring from it gave a median of 0.2 hours, because a direct booking
 * creates the schedule and the event in the same instant.
 */
const selectTurnaround = db.prepare(`
  SELECT s.id, s.scheduled_by_name, st.entered_at, MIN(e.created_at) AS booked_at
  FROM schedules s
  JOIN events e ON e.client_id = s.client_id AND e.schedule_id = s.id
  JOIN application_stages st
    ON st.client_id = s.client_id AND st.application_id = s.application_id AND st.stage_id = s.interview_stage_id
  WHERE s.client_id = ? AND e.created_at IS NOT NULL AND st.entered_at IS NOT NULL
  GROUP BY s.id
`);

// Stage-to-stage timing, anchored on interviews actually held rather
// than on history entries. History transitions are useless for this: a
// bulk stage advance moves an application through several stages in
// milliseconds, which made the median transition ~0 days.
const selectStageSpans = db.prepare(`
  SELECT s.application_id, s.interview_stage_id, s.scheduled_by_name,
         COALESCE(st.title, 'Unknown stage') AS stage,
         MIN(e.start_time) AS first_start, MAX(e.end_time) AS last_end
  FROM events e
  JOIN schedules s ON s.client_id = e.client_id AND s.id = e.schedule_id
  LEFT JOIN stages st ON st.client_id = s.client_id AND st.id = s.interview_stage_id
  WHERE e.client_id = ? AND e.start_time IS NOT NULL
    AND s.application_id IS NOT NULL AND s.interview_stage_id IS NOT NULL
  GROUP BY s.application_id, s.interview_stage_id
`);

// Reschedule rate is schedule-level: a booked round that moved at least
// once, over all booked rounds.
const selectBookedSchedules = db.prepare(`
  SELECT s.id, s.status, s.scheduled_by_name, s.application_id, s.interview_stage_id,
         MIN(e.start_time) AS first_start,
         EXISTS (SELECT 1 FROM reschedules r
                 JOIN events e2 ON e2.client_id = r.client_id AND e2.id = r.event_id
                 WHERE r.client_id = s.client_id AND e2.schedule_id = s.id) AS observed_moved
  FROM schedules s
  JOIN events e ON e.client_id = s.client_id AND e.schedule_id = s.id
  WHERE s.client_id = ? AND e.start_time IS NOT NULL
  GROUP BY s.id
`);

/**
 * "Areas to work on": cancellations that were never re-booked, grouped
 * by role and by stage.
 *
 * Returns the individual schedule ids per group as well as the counts.
 * Ashby has no URL that expresses a filtered list view — the only link
 * shapes that work are a candidate's application feed, a candidate
 * profile, and /schedules/{id} — so a group cannot be linked to a
 * filtered Ashby page. Carrying the ids lets a row expand to the actual
 * records instead.
 */
const selectCancellationDetail = db.prepare(`
  SELECT c.id, c.updated_at, c.created_at,
         -- The SAME attribution fallback the cancellation rate uses.
         -- Filtering on c.scheduled_by_name alone drops the 92% of
         -- Luminai's cancelled schedules Ashby leaves unattributed, which
         -- collapsed this panel to a single row.
         ${ATTRIBUTED_SCHEDULER} AS scheduled_by_name,
         COALESCE(j.title, 'Unknown role') AS role,
         COALESCE(st.title, 'Unknown stage') AS stage,
         a.candidate_name, a.candidate_id, c.application_id,
         EXISTS (
           SELECT 1 FROM schedules l
           WHERE l.client_id = c.client_id AND l.application_id = c.application_id
             AND l.interview_stage_id = c.interview_stage_id AND l.id != c.id
             AND l.created_at > c.created_at
         ) AS rebooked
  FROM schedules c
  LEFT JOIN applications a ON a.client_id = c.client_id AND a.id = c.application_id
  LEFT JOIN jobs j ON j.client_id = a.client_id AND j.id = a.job_id
  LEFT JOIN stages st ON st.client_id = c.client_id AND st.id = c.interview_stage_id
  WHERE c.client_id = ? AND c.status = 'Cancelled'
`);

// A group below this many cancellations is coincidence, not a pattern:
// Forus's 37 recent cancellations spread over 15 roles would otherwise
// produce a list of ones and twos.
const MIN_GROUP_SIZE = 5;

function buildAreasToWorkOn(client, keep, inWindow, appBaseUrl) {
  const graceCutoff = new Date(Date.now() - REBOOK_GRACE_DAYS * 86400000).toISOString();
  const rows = selectCancellationDetail.all(client.id).filter((r) => {
    const at = r.updated_at || r.created_at;
    return keep(r.scheduled_by_name) && inWindow(at) && at < graceCutoff;
  });

  if (rows.length === 0) return { clientAverage: null, byRole: [], byStage: [], sample: 0 };

  const neverRebooked = rows.filter((r) => !r.rebooked).length;
  const clientAverage = Math.round((neverRebooked / rows.length) * 1000) / 10;

  const group = (field) => {
    const buckets = new Map();
    for (const r of rows) {
      const key = r[field];
      if (!buckets.has(key)) buckets.set(key, { name: key, total: 0, neverRebooked: 0, examples: [] });
      const b = buckets.get(key);
      b.total += 1;
      if (!r.rebooked) {
        b.neverRebooked += 1;
        if (b.examples.length < 8) {
          b.examples.push({
            scheduleId: r.id,
            candidate: r.candidate_name || null,
            at: r.updated_at || r.created_at,
            scheduleUrl: `${appBaseUrl}/schedules/${r.id}`,
            candidateUrl:
              r.candidate_id && r.application_id
                ? `${appBaseUrl}/candidates/pipeline/active/right-side/candidates/${r.candidate_id}` +
                  `/applications/${r.application_id}/feed`
                : null,
          });
        }
      }
    }
    return [...buckets.values()]
      .filter((b) => b.total >= MIN_GROUP_SIZE)
      .map((b) => ({ ...b, share: Math.round((b.neverRebooked / b.total) * 1000) / 10 }))
      // Only groups doing worse than this client's own average are worth
      // surfacing — an absolute standard would flag every group at a
      // client that cancels a lot, and none at one that does not.
      .filter((b) => b.share > clientAverage)
      .sort((a, b) => b.share - a.share || b.total - a.total);
  };

  return { clientAverage, minGroupSize: MIN_GROUP_SIZE, sample: rows.length, byRole: group("role"), byStage: group("stage") };
}

// --- Aggregation -----------------------------------------------------------

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function emptyBucket() {
  return { events: 0, hours: 0, debriefs: 0, candidates: new Set(), cancellations: 0, reschedules: 0 };
}

function bump(map, key, patch) {
  if (!key) return;
  if (!map.has(key)) map.set(key, emptyBucket());
  const bucket = map.get(key);
  bucket.events += patch.events || 0;
  bucket.hours += patch.hours || 0;
  bucket.debriefs += patch.debriefs || 0;
  bucket.cancellations += patch.cancellations || 0;
  bucket.reschedules += patch.reschedules || 0;
  if (patch.candidateId) bucket.candidates.add(patch.candidateId);
}

function serialiseSeries(map) {
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, b]) => ({
      key,
      events: b.events,
      // Full precision on purpose. These rows are summed into the period
      // totals, and rounding each of ~360 daily buckets to 0.1h before
      // summing drifted the 12-month figure 11 hours away from the
      // headline total it is supposed to equal. The UI rounds for
      // display instead.
      hours: b.hours,
      debriefs: b.debriefs,
      candidates: b.candidates.size,
      cancellations: b.cancellations,
      reschedules: b.reschedules,
    }));
}

/**
 * Sums a half-open window of day buckets: fromKey inclusive, toKey
 * exclusive.
 *
 * The exclusive upper bound is not a detail. Interviews are booked ahead,
 * so the daily series legitimately contains future dates — a "last 7 days"
 * sum with no upper bound silently swept in everything already on the
 * calendar for next month and reported it as work done this week.
 */
function sumWindow(series, fromKey, toKey) {
  return series
    .filter((row) => row.key >= fromKey && row.key < toKey)
    .reduce(
      (acc, row) => ({
        events: acc.events + row.events,
        hours: acc.hours + row.hours,
        candidates: acc.candidates + row.candidates,
        cancellations: acc.cancellations + row.cancellations,
        reschedules: acc.reschedules + row.reschedules,
      }),
      { events: 0, hours: 0, candidates: 0, cancellations: 0, reschedules: 0 }
    );
}

function change(current, previous) {
  if (!previous) return current ? null : 0; // no baseline to compare against
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function dayKeyOffset(days, timeZone) {
  const d = new Date(Date.now() - days * 86400000);
  return localBuckets(d.toISOString(), timeZone).day;
}

/**
 * Computes the whole payload for one client. One pass over the event rows
 * feeds every series and breakdown rather than re-querying per metric.
 */
// Below this many events in the PRIOR period, a change is noise and no
// delta is shown at all. Agreed threshold.
const MIN_PRIOR_EVENTS_FOR_DELTA = 30;

// A cancellation inside this window may still be re-booked, so it is
// excluded from both halves of the without-rebook rate. Measured across
// 9,173 real rebooks: median 0 days, p90 exactly 14.0 days, so this
// captures ~90% — the ~10% that re-book later are counted as
// never-rebooked and silently corrected once they are.
const REBOOK_GRACE_DAYS = 14;

function sliceByWindow(samples, fromIso, toIso) {
  return samples.filter((s) => s.at >= fromIso && s.at < toIso);
}

/**
 * One Results block for a window. `null` for a metric means "not enough
 * data to say", which the UI renders as a dash rather than a zero.
 */
function resultsForWindow(samples, cancellations, events, fromIso, toIso) {
  const turnaround = sliceByWindow(samples.turnaround, fromIso, toIso).map((s) => s.value);
  const gaps = sliceByWindow(samples.stageGaps, fromIso, toIso);
  const rounds = sliceByWindow(samples.reschedules, fromIso, toIso);

  const graceCutoff = new Date(Date.now() - REBOOK_GRACE_DAYS * 86400000).toISOString();
  const settled = cancellations.filter((c) => {
    const at = c.updated_at || c.created_at;
    return at >= fromIso && at < toIso && at < graceCutoff;
  });
  const neverRebooked = settled.filter((c) => !c.rebooked).length;

  // Slowest transition by name, with a floor so a single unlucky pair
  // cannot be named as the worst.
  const byLabel = new Map();
  for (const g of gaps) {
    if (!byLabel.has(g.label)) byLabel.set(g.label, []);
    byLabel.get(g.label).push(g.value);
  }
  let slowest = null;
  for (const [label, values] of byLabel) {
    if (values.length < 5) continue;
    const m = median(values);
    if (!slowest || m > slowest.medianDays) slowest = { label, medianDays: Math.round(m * 10) / 10, count: values.length };
  }

  const shortNoticeCount = events.filter((e) => e.shortNotice && e.at >= fromIso && e.at < toIso).length;
  const eventCount = events.filter((e) => e.at >= fromIso && e.at < toIso).length;

  return {
    events: eventCount,
    bookingTurnaround: {
      medianHours: turnaround.length ? Math.round(median(turnaround) * 10) / 10 : null,
      p90Hours: turnaround.length ? Math.round(percentile(turnaround, 90) * 10) / 10 : null,
      sample: turnaround.length,
    },
    stageGap: {
      medianDays: gaps.length ? Math.round(median(gaps.map((g) => g.value)) * 10) / 10 : null,
      slowest,
      sample: gaps.length,
    },
    shortNotice: {
      share: eventCount ? Math.round((shortNoticeCount / eventCount) * 1000) / 10 : null,
      count: shortNoticeCount,
      sample: eventCount,
    },
    cancellationWithoutRebook: {
      share: settled.length ? Math.round((neverRebooked / settled.length) * 1000) / 10 : null,
      count: neverRebooked,
      sample: settled.length,
    },
    rescheduleRate: {
      share: rounds.length ? Math.round((rounds.filter((r) => r.moved).length / rounds.length) * 1000) / 10 : null,
      count: rounds.filter((r) => r.moved).length,
      sample: rounds.length,
    },
  };
}

/**
 * The five Results metrics, as samples timestamped so any window can be
 * sliced out of them.
 *
 * Each sample is computed ONCE here and filtered per period afterwards.
 * Booking turnaround in particular walks hour by hour through a business
 * calendar; recomputing it for four periods times two scopes times a
 * prior period would be sixteen passes over every schedule.
 */
function buildResultSamples(client, keep, inWindow) {
  const tz = client.timeZone;
  const hours = { start: config.businessHourStart, end: config.businessHourEnd };

  const turnaround = [];
  for (const row of selectTurnaround.all(client.id)) {
    if (!keep(row.scheduled_by_name) || !inWindow(row.booked_at)) continue;
    const value = businessHoursBetween(row.entered_at, row.booked_at, tz, hours);
    if (value == null) continue;
    turnaround.push({ at: row.booked_at, value });
  }

  // Stage gaps: order each application's interviewed stages by their own
  // first interview, then measure the end of one to the start of the
  // next. No stage-order metadata is needed, and stages the application
  // passed through without an interview are correctly absent.
  const byApplication = new Map();
  for (const row of selectStageSpans.all(client.id)) {
    if (!keep(row.scheduled_by_name)) continue;
    if (!byApplication.has(row.application_id)) byApplication.set(row.application_id, []);
    byApplication.get(row.application_id).push(row);
  }
  const stageGaps = [];
  for (const spans of byApplication.values()) {
    if (spans.length < 2) continue;
    spans.sort((a, b) => (a.first_start < b.first_start ? -1 : 1));
    for (let i = 1; i < spans.length; i++) {
      const previous = spans[i - 1];
      const next = spans[i];
      if (!previous.last_end || !next.first_start) continue;
      if (!inWindow(next.first_start)) continue;
      const days = (new Date(next.first_start) - new Date(previous.last_end)) / 86400000;
      if (days < 0 || days > 365) continue;
      stageGaps.push({ at: next.first_start, value: days, label: `${previous.stage} → ${next.stage}` });
    }
  }

  // Reschedule rate is measured per ROUND (application + stage), not per
  // schedule. A round that was cancelled and re-booked appears as two
  // schedules; counting schedules would record the same round twice and
  // call one of them untouched. A round counts as moved if it has more
  // than one schedule, or if an event's start time was directly observed
  // changing — the observed signal is exact but only exists from the
  // first sync onward, so the derived one carries the history.
  const rounds = new Map();
  for (const row of selectBookedSchedules.all(client.id)) {
    if (!keep(row.scheduled_by_name) || !row.first_start) continue;
    const key = `${row.application_id}|${row.interview_stage_id}`;
    const existing = rounds.get(key);
    if (!existing) {
      rounds.set(key, { at: row.first_start, schedules: 1, moved: row.observed_moved === 1 });
    } else {
      existing.schedules += 1;
      existing.moved = existing.moved || row.observed_moved === 1;
      if (row.first_start < existing.at) existing.at = row.first_start;
    }
  }
  const reschedules = [...rounds.values()]
    .filter((r) => inWindow(r.at))
    .map((r) => ({ at: r.at, moved: r.moved || r.schedules > 1 }));

  return { turnaround, stageGaps, reschedules };
}

/**
 * Builds one scope's worth of metrics. `keepScheduler` decides which rows
 * belong to it: everything, or only schedules created by a rostered
 * Carrara coordinator.
 *
 * Candidate drop-offs are the one figure that cannot be scoped — they are
 * a property of the application, not of whoever booked a slot on it — so
 * both scopes report the same number and the page says so.
 */
function computeScope(client, keepScheduler) {
  const timeZone = client.timeZone;
  const window = clientWindow(client);
  const since = window.from;

  const keep = (name) => keepScheduler(name);
  const inWindow = (iso) => !window.fixed || (iso >= window.from && iso <= window.to);
  const rows = selectEvents
    .all(client.id, since)
    .filter((r) => keep(r.scheduled_by_name) && inWindow(r.start_time));
  const cancellations = selectCancellations
    .all(client.id, since)
    .filter((r) => keep(r.scheduled_by_name) && inWindow(r.updated_at || r.created_at));
  const observed = selectObservedReschedules.all(client.id, since).filter((r) => keep(r.scheduled_by_name));
  const dropOffs = selectDropOffs
    .all(client.id, since)
    .filter((r) => keep(r.scheduled_by_name) && inWindow(r.archived_at));
  const scheduleTimes = selectTimeToSchedule.all(client.id, since).filter((r) => keep(r.scheduled_by_name));

  const daily = new Map();
  const weekly = new Map();
  const monthly = new Map();

  // The by-role, by-stage and heatmap breakdowns are computed once PER
  // PERIOD rather than once over the whole window, so the 7/30/90-day
  // toggle drives them instead of only moving the stat tiles above them.
  //
  // They're precomputed server-side and shipped in one payload: switching
  // period is then an object lookup with no refetch. The alternative —
  // sending a per-role daily matrix for the client to re-aggregate — is
  // ~18,000 sparse entries on Forus, which costs more to transfer than
  // all four precomputed variants put together.
  const scopes = {};
  for (const key of PERIOD_KEYS) {
    scopes[key] = { byRole: new Map(), byStage: new Map(), heatmap: new Map() };
  }

  const candidates = new Set();
  const interviewers = new Set();
  const roles = new Set();

  let events = 0;
  let debriefs = 0;
  let meals = 0;
  let bookedAhead = 0;
  let bookedAheadHours = 0;
  // Counted events, kept for the Results metrics so they slice by the
  // same population the Volume tiles count.
  const countedEvents = [];
  let hours = 0;
  let interviewerSlots = 0;
  let shortNotice = 0;
  let outOfHours = 0;
  let excluded = 0;
  let excludedJobEvents = 0;
  let unresolvedTitleEvents = 0;
  const excludedTitleCounts = new Map();
  let feedbackOutstanding = 0;

  // Breakdowns count work up to and including today. Interviews booked
  // ahead stay in the time series (drawn faded) but are not folded into
  // "by role, last 90 days" — that would mix work done with work pending.
  const tomorrowKey = dayKeyOffset(-1, timeZone);
  const periodStart = Object.fromEntries(
    PERIODS.map((period) => [period.key, period.days == null ? "" : dayKeyOffset(period.days, timeZone)])
  );

  for (const row of rows) {
    // An event with no resolvable definition cannot be tested against the
    // hold keywords at all. Counted separately so the page can say so
    // rather than quietly treating "untestable" as "not a hold".
    if (!row.interview_title) unresolvedTitleEvents += 1;

    if (isExcludedTitle(row.interview_title, client.excludedTitleKeywords)) {
      excluded += 1;
      const title = row.interview_title.trim();
      excludedTitleCounts.set(title, (excludedTitleCounts.get(title) || 0) + 1);
      continue;
    }

    if (isExcludedJob(row.job_title, client.excludedJobTitles)) {
      excludedJobEvents += 1;
      continue;
    }

    const buckets = localBuckets(row.start_time, timeZone);
    if (!buckets) continue;

    const durationHours =
      row.end_time && row.start_time
        ? Math.max(0, (new Date(row.end_time) - new Date(row.start_time)) / 3600000)
        : 0;

    const isDebrief = row.is_debrief === 1;
    const patch = {
      events: 1,
      hours: durationHours,
      debriefs: isDebrief ? 1 : 0,
      candidateId: row.candidate_id,
    };

    // Everything below counts work DONE, so it stops at today. Interviews
    // already booked for future dates are counted separately as
    // `bookedAhead` and still appear in the time series (drawn faded).
    //
    // They used to be in `totals` but not in `periods`, which made the
    // hero tile and the period tile disagree by 410 events and 274 hours
    // while being labelled almost identically.
    const isBookedAhead = buckets.day >= tomorrowKey;
    if (isBookedAhead) {
      bookedAhead += 1;
      bookedAheadHours += durationHours;
      bump(daily, buckets.day, patch);
      bump(weekly, buckets.week, patch);
      bump(monthly, buckets.month, patch);
      continue;
    }

    events += 1;
    if (isDebrief) debriefs += 1;
    if (isMealTitle(row.interview_title)) meals += 1;
    hours += durationHours;
    interviewerSlots += row.interviewer_count || 0;
    if (row.candidate_id) candidates.add(row.candidate_id);
    if (row.job_id) roles.add(row.job_id);
    if (row.has_feedback === 0 && new Date(row.start_time) < new Date()) feedbackOutstanding += 1;

    // Short notice: booked less than SHORT_NOTICE_HOURS before it starts.
    // Pure firefighting, and completely invisible in a raw total.
    let isShortNotice = false;
    if (row.event_created_at) {
      const noticeHours = (new Date(row.start_time) - new Date(row.event_created_at)) / 3600000;
      if (noticeHours >= 0 && noticeHours < config.shortNoticeHours) {
        shortNotice += 1;
        isShortNotice = true;
      }
    }
    countedEvents.push({ start_time: row.start_time, shortNotice: isShortNotice });

    if (buckets.hour < config.businessHourStart || buckets.hour >= config.businessHourEnd) outOfHours += 1;

    bump(daily, buckets.day, patch);
    bump(weekly, buckets.week, patch);
    bump(monthly, buckets.month, patch);

    {
      const roleKey = row.job_id || "unknown";
      const stageKey = row.stage_title || "Unknown stage";
      const heatKey = `${buckets.dow}:${buckets.hour}`;

      for (const periodKey of PERIOD_KEYS) {
        if (buckets.day < periodStart[periodKey]) continue;
        const scope = scopes[periodKey];

        bump(scope.byStage, stageKey, patch);

        if (!scope.byRole.has(roleKey)) {
          scope.byRole.set(roleKey, {
            ...emptyBucket(),
            jobId: row.job_id,
            title: cleanTitle(row.job_title),
            openedAt: row.job_opened_at || null,
            department: row.department_name || null,
            jobStatus: row.job_status || null,
          });
        }
        const role = scope.byRole.get(roleKey);
        role.events += 1;
        role.hours += durationHours;
        role.debriefs += isDebrief ? 1 : 0;
        if (row.candidate_id) role.candidates.add(row.candidate_id);

        scope.heatmap.set(heatKey, (scope.heatmap.get(heatKey) || 0) + 1);
      }
    }
  }

  // Cancellations split into the two meanings a Cancelled schedule carries.
  let trueCancellations = 0;
  let derivedReschedules = 0;
  for (const row of cancellations) {
    const buckets = localBuckets(row.updated_at || row.created_at, timeZone);
    if (!buckets) continue;
    if (row.rebooked) {
      derivedReschedules += 1;
      bump(daily, buckets.day, { reschedules: 1 });
      bump(weekly, buckets.week, { reschedules: 1 });
      bump(monthly, buckets.month, { reschedules: 1 });
    } else {
      trueCancellations += 1;
      bump(daily, buckets.day, { cancellations: 1 });
      bump(weekly, buckets.week, { cancellations: 1 });
      bump(monthly, buckets.month, { cancellations: 1 });
    }
  }

  const dailySeries = serialiseSeries(daily);
  const weeklySeries = serialiseSeries(weekly);
  const monthlySeries = serialiseSeries(monthly);

  // Turnaround from a schedule being requested to its first slot being
  // booked — but only for schedules that genuinely waited.
  //
  // When a coordinator books directly, Ashby creates the schedule and its
  // event in the same instant, so the gap is zero. Those dominate the
  // sample: including them put the median at 0h against a 90th percentile
  // of 23.4h, which says nothing about how fast anything gets scheduled.
  // Anything under a minute is a direct booking, not a turnaround, so it
  // is excluded and the surviving sample size is shown alongside.
  const MIN_TURNAROUND_HOURS = 1 / 60;
  const allGaps = scheduleTimes
    .map((r) => (new Date(r.booked_at) - new Date(r.requested_at)) / 3600000)
    .filter((h) => Number.isFinite(h) && h >= 0);
  const noticeValues = allGaps.filter((h) => h >= MIN_TURNAROUND_HOURS);
  const directBookings = allGaps.length - noticeValues.length;

  const busiest = dailySeries.reduce((best, row) => (!best || row.events > best.events ? row : best), null);

  // Period-over-period: the agreed benchmark model. No invented quota,
  // just this period against the one before it.
  // Tomorrow's local day key, used as the exclusive upper bound so today
  // counts in full but nothing already booked for next week does.
  const tomorrow = dayKeyOffset(-1, timeZone);

  // "all" is the full history window. Its previous period has no data to
  // compare against (nothing is stored before the window), so change()
  // reports "no baseline" rather than inventing a percentage.
  //
  // It is not optional: the period control offers "12 months" and
  // defaults to it, so a missing periods.all makes every stat tile throw
  // and the whole tab render as an error.
  const periods = {};
  for (const period of PERIODS) {
    const name = period.key;
    // For an ended client "full" means the engagement itself, not the
    // last N days — that is the window its tab defaults to, and the only
    // one with anything in it.
    if (period.days == null && window.fixed) {
      const whole = sumWindow(dailySeries, "", "9999-99-99");
      periods[name] = {
        current: whole,
        previous: { events: 0, hours: 0, candidates: 0, cancellations: 0, reschedules: 0 },
        change: { events: null, hours: null, cancellations: null, reschedules: null },
      };
      continue;
    }
    const days = periodDays(period);
    const currentFrom = dayKeyOffset(days, timeZone);
    const previousFrom = dayKeyOffset(days * 2, timeZone);
    const current = sumWindow(dailySeries, currentFrom, tomorrow);
    const previous = sumWindow(dailySeries, previousFrom, currentFrom);
    periods[name] = {
      current,
      previous,
      change: {
        events: change(current.events, previous.events),
        hours: change(current.hours, previous.hours),
        cancellations: change(current.cancellations, previous.cancellations),
        reschedules: change(current.reschedules, previous.reschedules),
      },
    };
  }

  // --- Results, per period, each against its own prior period ---------
  //
  // Direction says which way is an improvement, so the UI can colour by
  // improvement rather than by sign: turnaround falling is good, and a
  // down arrow must not read as red on a metric where down is the goal.
  const RESULT_DIRECTION = {
    bookingTurnaround: "lower",
    stageGap: "lower",
    shortNotice: "lower",
    cancellationWithoutRebook: "lower",
    rescheduleRate: "lower",
  };

  const eventSamples = countedEvents.map((e) => ({ at: e.start_time, shortNotice: e.shortNotice }));
  const resultSamples = buildResultSamples(client, keep, inWindow);

  const results = {};
  for (const period of PERIODS) {
    const days = period.days == null ? null : period.days;
    let currentFrom;
    let currentTo;
    let priorFrom;

    if (days == null) {
      // The full window is the baseline; it has no prior period to
      // compare against, by design — targets come later, from watching
      // these, not from unexamined history.
      currentFrom = window.fixed ? window.from : new Date(Date.now() - config.historyMonths * 30 * 86400000).toISOString();
      currentTo = new Date(Date.now() + 86400000).toISOString();
      priorFrom = null;
    } else {
      currentTo = new Date(Date.now() + 86400000).toISOString();
      currentFrom = new Date(Date.now() - days * 86400000).toISOString();
      priorFrom = new Date(Date.now() - days * 2 * 86400000).toISOString();
    }

    const current = resultsForWindow(resultSamples, cancellations, eventSamples, currentFrom, currentTo);
    const prior = priorFrom ? resultsForWindow(resultSamples, cancellations, eventSamples, priorFrom, currentFrom) : null;

    results[period.key] = {
      isBaseline: days == null,
      current,
      prior,
      // Suppressed entirely below the threshold: a percentage off a
      // handful of events is noise wearing a signal's clothing.
      deltaSuppressed: !prior || prior.events < MIN_PRIOR_EVENTS_FOR_DELTA,
      priorEvents: prior ? prior.events : null,
      minPriorEvents: MIN_PRIOR_EVENTS_FOR_DELTA,
      direction: RESULT_DIRECTION,
    };
  }

  return {
    results,
    areasToWorkOn: buildAreasToWorkOn(client, keep, inWindow, client.appBaseUrl || "https://app.ashbyhq.com"),
    totals: {
      // Derived from the full-period figure rather than counted
      // separately, so the hero tile and the "last 12 months" tile are
      // the same number by construction. Counting them independently
      // left them 410 events apart, and after that was fixed a
      // day-boundary edge still split the hours by one.
      events: periods.full.current.events,
      hours: Math.round(periods.full.current.hours),
      debriefs,
      meals,
      bookedAhead,
      bookedAheadHours: Math.round(bookedAheadHours),
      candidates: candidates.size,
      roles: roles.size,
      interviewerSlots,
      averagePanelSize: events ? Math.round((interviewerSlots / events) * 100) / 100 : 0,
      shortNotice,
      outOfHours,
      feedbackOutstanding,
      cancellations: trueCancellations,
      reschedulesDerived: derivedReschedules,
      reschedulesObserved: observed.length,
      dropOffs: dropOffs.length,
      excludedEvents: excluded,
      excludedJobEvents,
      unresolvedTitleEvents,
    },

    periods,

    series: { daily: dailySeries, weekly: weeklySeries, monthly: monthlySeries },

    // Keyed by period, so the toggle switches breakdowns instantly with
    // no refetch. "all" is the full 12 months.
    byRole: Object.fromEntries(
      PERIOD_KEYS.map((key) => [
        key,
        disambiguateTitles([...scopes[key].byRole.values()])
          .map((r) => ({
            jobId: r.jobId,
            title: r.title,
            department: r.department,
            jobStatus: r.jobStatus,
            events: r.events,
            hours: Math.round(r.hours),
            debriefs: r.debriefs,
            candidates: r.candidates.size,
          }))
          .sort((a, b) => b.events - a.events),
      ])
    ),

    byStage: Object.fromEntries(
      PERIOD_KEYS.map((key) => [
        key,
        [...scopes[key].byStage.entries()]
          .map(([title, b]) => ({ title, events: b.events, hours: Math.round(b.hours), candidates: b.candidates.size }))
          .sort((a, b) => b.events - a.events),
      ])
    ),

    heatmap: Object.fromEntries(
      PERIOD_KEYS.map((key) => [
        key,
        [...scopes[key].heatmap.entries()].map(([heatKey, count]) => {
          const [dow, hour] = heatKey.split(":").map(Number);
          return { dow, hour, events: count };
        }),
      ])
    ),

    timeToSchedule: {
      medianHours: median(noticeValues) === null ? null : Math.round(median(noticeValues) * 10) / 10,
      p90Hours: percentile(noticeValues, 90) === null ? null : Math.round(percentile(noticeValues, 90) * 10) / 10,
      sample: noticeValues.length,
      directBookings,
    },

    records: busiest ? { busiestDay: { date: busiest.key, events: busiest.events } } : null,

    excludedTitleBreakdown: [...excludedTitleCounts.entries()]
      .map(([title, count]) => ({ title, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * Who actually scheduled, and how the roster lines up against them.
 *
 * Every part of this is reported rather than assumed, because name
 * matching has two silent failure modes and the data has already shown
 * both are live risks:
 *
 *   - a roster name that matches nothing (Sadiqeh Agah and Meredith Faria
 *     match zero events across all five clients — most likely they work
 *     on a client that has no dashboard yet)
 *   - one name resolving to two different Ashby user ids, which would
 *     merge two people into one row with nothing on screen to show it
 *
 * The opposite case — one id appearing under two names — is a mid-window
 * rename, and is reported too so the roster can be given both spellings.
 */
function buildRosterReport(client) {
  const roster = client.coordinators || [];
  const rosterSet = new Set(roster.map(config.normalizeName));

  const schedulers = db
    .prepare(
      `SELECT s.scheduled_by_name AS name, s.scheduled_by_id AS id, s.scheduled_by_email AS email, COUNT(*) AS events
       FROM events e JOIN schedules s ON s.client_id = e.client_id AND s.id = e.schedule_id
       WHERE e.client_id = ? AND e.start_time IS NOT NULL AND s.scheduled_by_name IS NOT NULL
       GROUP BY s.scheduled_by_id, s.scheduled_by_name`
    )
    .all(client.id);

  const matched = [];
  const idsByName = new Map();
  const namesById = new Map();

  for (const row of schedulers) {
    const key = config.normalizeName(row.name);
    if (!idsByName.has(key)) idsByName.set(key, new Set());
    idsByName.get(key).add(row.id);
    if (!namesById.has(row.id)) namesById.set(row.id, new Set());
    namesById.get(row.id).add(row.name);
    if (rosterSet.has(key)) matched.push({ name: row.name, email: row.email, events: row.events });
  }

  const matchedNames = new Set(matched.map((m) => config.normalizeName(m.name)));

  return {
    configured: roster,
    matched: matched.sort((a, b) => b.events - a.events),
    // A rostered name with no events HERE.
    //
    // Only reported when this client has an explicit roster of its own.
    // Against the shared default every coordinator assigned to another
    // client would appear here — six of seven on Luminai — which drowns
    // the case worth seeing. Names matching nothing at ANY client are
    // reported separately on the overview regardless.
    unmatched: roster.filter((name) => !matchedNames.has(config.normalizeName(name))),
    reportUnmatched: Boolean(client.hasOwnRoster),
    collisions: [...idsByName.entries()]
      .filter(([key, ids]) => ids.size > 1 && rosterSet.has(key))
      .map(([key, ids]) => ({ name: key, userIds: [...ids] })),
    renames: [...namesById.entries()]
      .filter(([, names]) => names.size > 1)
      .map(([id, names]) => ({ userId: id, names: [...names] })),
  };
}

/**
 * Both scopes over one set of queries, plus the fields that describe the
 * client rather than a scope.
 */
function computeClient(client) {
  const rosterSet = new Set((client.coordinators || []).map(config.normalizeName));
  const timeZone = client.timeZone;

  return {
    clientId: client.id,
    clientName: client.name,
    timeZone,
    accentColor: client.accentColor || null,
    engagement: client.engagement,
    status: client.status,
    engagementStart: client.engagementStart,
    engagementEnd: client.engagementEnd,
    window: clientWindow(client),
    generatedAt: new Date().toISOString(),
    historyFrom: new Date(Date.now() - config.historyMonths * 30 * 86400000).toISOString(),
    today: dayKeyOffset(0, timeZone),
    currentWeek: localBuckets(new Date().toISOString(), timeZone).week,

    scopes: {
      all: computeScope(client, () => true),
      coordinated: computeScope(client, (name) => rosterSet.has(config.normalizeName(name))),
    },

    roster: buildRosterReport(client),

    dataQuality: {
      rescheduleTrackingSince: store.rescheduleTrackingSince(client.id),
      excludedTitleKeywords: client.excludedTitleKeywords,
      excludedJobTitles: client.excludedJobTitles,
      definitionsResolvedAt: store.getMeta(client.id, "interview_definitions_resolved_at"),
    },
  };
}

/**
 * The cross-client overview. Per-client day buckets use each client's own
 * zone, so the roll-up re-buckets from scratch in OVERVIEW_TIMEZONE rather
 * than summing day keys that mean slightly different things.
 */
/**
 * Which clients may be summed together.
 *
 * Two axes gate every roll-up:
 *   - engagement: a share-of-activity percentage only means something
 *     inside one engagement type. Forus is client-scheduled, so most of
 *     its interviews were never ours; folding it into one percentage
 *     drags the figure down everywhere else and describes nothing.
 *   - status: an ended engagement must never reach a current-period
 *     number or the weekly trend, or a finished client pulls every
 *     "this week" toward zero and the chart ends in a cliff that reads
 *     as collapsing output.
 */
function groupOf(payload) {
  if (payload.status === "ended") return "ended";
  // Anything not explicitly client-scheduled is treated as ours, so a
  // missing flag over-reports our share rather than silently dropping a
  // client out of the roll-up entirely.
  return payload.engagement === "client-scheduled" ? "clientScheduled" : "core";
}

// Current-period figures and the trend chart: active clients only.
function isCurrent(payload) {
  return payload.status !== "ended";
}

function computeOverview(clientPayloads, scopeKey) {
  const scopeOf = (p) => p.scopes[scopeKey];
  const totals = clientPayloads.reduce(
    (acc, p) => ({
      events: acc.events + scopeOf(p).totals.events,
      hours: acc.hours + scopeOf(p).totals.hours,
      candidates: acc.candidates + scopeOf(p).totals.candidates,
      roles: acc.roles + scopeOf(p).totals.roles,
      interviewerSlots: acc.interviewerSlots + scopeOf(p).totals.interviewerSlots,
      shortNotice: acc.shortNotice + scopeOf(p).totals.shortNotice,
      outOfHours: acc.outOfHours + scopeOf(p).totals.outOfHours,
      cancellations: acc.cancellations + scopeOf(p).totals.cancellations,
      reschedulesDerived: acc.reschedulesDerived + scopeOf(p).totals.reschedulesDerived,
      reschedulesObserved: acc.reschedulesObserved + scopeOf(p).totals.reschedulesObserved,
      dropOffs: acc.dropOffs + scopeOf(p).totals.dropOffs,
      debriefs: acc.debriefs + scopeOf(p).totals.debriefs,
      meals: acc.meals + scopeOf(p).totals.meals,
      bookedAhead: acc.bookedAhead + scopeOf(p).totals.bookedAhead,
      bookedAheadHours: acc.bookedAheadHours + scopeOf(p).totals.bookedAheadHours,
    }),
    {
      events: 0, hours: 0, candidates: 0, roles: 0, interviewerSlots: 0, shortNotice: 0,
      outOfHours: 0, cancellations: 0, reschedulesDerived: 0, reschedulesObserved: 0, dropOffs: 0, debriefs: 0, meals: 0,
      bookedAhead: 0, bookedAheadHours: 0,
    }
  );

  // Weekly series summed across clients by week key. Week keys are Monday
  // dates, which differ by at most a day across these zones — close enough
  // to align, unlike raw day keys.
  // Ended engagements are excluded: their series stops dead at the
  // engagement end and would render as a collapse in output.
  const weekly = new Map();
  for (const payload of clientPayloads.filter(isCurrent)) {
    for (const row of scopeOf(payload).series.weekly) {
      if (!weekly.has(row.key)) weekly.set(row.key, { key: row.key, events: 0, hours: 0, cancellations: 0, reschedules: 0 });
      const bucket = weekly.get(row.key);
      bucket.events += row.events;
      bucket.hours += row.hours;
      bucket.cancellations += row.cancellations;
      bucket.reschedules += row.reschedules;
    }
  }

  const periods = {};
  for (const name of PERIOD_KEYS) {
    periods[name] = clientPayloads.filter(isCurrent).reduce(
      (acc, p) => {
        acc.current.events += scopeOf(p).periods[name].current.events;
        // Unrounded: rounding each client's contribution as it is added
        // is what left the overview's headline and full-period hours one
        // apart while every individual client agreed.
        acc.current.hours += scopeOf(p).periods[name].current.hours;
        acc.previous.events += scopeOf(p).periods[name].previous.events;
        acc.previous.hours += scopeOf(p).periods[name].previous.hours;
        return acc;
      },
      { current: { events: 0, hours: 0 }, previous: { events: 0, hours: 0 } }
    );
    periods[name].change = {
      events: change(periods[name].current.events, periods[name].previous.events),
      hours: change(periods[name].current.hours, periods[name].previous.hours),
    };
  }

  return {
    // Volume totals span every client, ended ones included — that work
    // happened and it counts. Only the CURRENT-period figures and the
    // trend above exclude them.
    //
    // Note these cannot be reconciled with periods.full the way a client
    // payload is: periods excludes ended engagements and totals does
    // not, so they are deliberately different numbers measuring
    // different populations.
    totals,
    periods,
    series: { weekly: [...weekly.values()].sort((a, b) => (a.key < b.key ? -1 : 1)) },
    // Per-group summaries. A share-of-activity percentage is computed
    // ONLY within a group, never across one — see groupOf().
    groups: ["core", "clientScheduled", "ended"].reduce((acc, key) => {
      const members = clientPayloads.filter((p) => groupOf(p) === key);
      const sum = (scope, field) => members.reduce((n, p) => n + p.scopes[scope].totals[field], 0);
      const coordinated = sum("coordinated", "events");
      const all = sum("all", "events");
      acc[key] = {
        clientIds: members.map((p) => p.clientId),
        clientNames: members.map((p) => p.clientName),
        coordinated,
        all,
        sharePct: all ? Math.round((coordinated / all) * 100) : null,
        hours: sum("coordinated", "hours"),
        candidates: sum("coordinated", "candidates"),
        roles: sum("coordinated", "roles"),
        interviewerSlots: sum("coordinated", "interviewerSlots"),
      };
      return acc;
    }, {}),

    byClient: clientPayloads.map((p) => ({
      clientId: p.clientId,
      clientName: p.clientName,
      accentColor: p.accentColor,
      engagement: p.engagement,
      status: p.status,
      group: groupOf(p),
      engagementStart: p.engagementStart,
      engagementEnd: p.engagementEnd,
      events: scopeOf(p).totals.events,
      hours: scopeOf(p).totals.hours,
      candidates: scopeOf(p).totals.candidates,
      roles: scopeOf(p).totals.roles,
      cancellations: scopeOf(p).totals.cancellations,
      reschedules: scopeOf(p).totals.reschedulesDerived,
      shortNotice: scopeOf(p).totals.shortNotice,
      thisWeek: scopeOf(p).periods.week.current.events,
      // Absolute week-on-week change is rendered from these two, rather
      // than a percentage: on a base of two interviews a percentage
      // swings wildly and describes nothing.
      lastWeek: scopeOf(p).periods.week.previous.events,
      weekChange: scopeOf(p).periods.week.change.events,
      // Both scopes on every row, so the by-client table can show what
      // share of a client's activity was ours without a second request.
      allEvents: p.scopes.all.totals.events,
      coordinatedEvents: p.scopes.coordinated.totals.events,
    })).sort((a, b) => b.events - a.events),
  };
}

function rebuild() {
  const t0 = Date.now();
  const payloads = [];

  for (const client of config.clients) {
    try {
      const payload = computeClient(client);
      cache.set(client.id, payload);
      payloads.push(payload);
    } catch (err) {
      console.error(`[metrics:${client.id}] compute failed: ${err.message}`);
    }
  }

  const now = new Date().toISOString();
  cache.set("__overview__", {
    generatedAt: now,
    timeZone: config.overviewTimeZone,
    today: localBuckets(now, config.overviewTimeZone).day,
    currentWeek: localBuckets(now, config.overviewTimeZone).week,
    scopes: {
      all: computeOverview(payloads, "all"),
      coordinated: computeOverview(payloads, "coordinated"),
    },
    // Rostered names that matched nothing at any client they are
    // rostered FOR.
    //
    // The earlier version asked whether a name was unmatched at every
    // client, which quietly stopped reporting anyone once a client had
    // its own narrower roster: adding Profound (rostered to three
    // people) made Sadiqeh Agah's warning vanish, because she is not on
    // Profound's roster and so was not in its unmatched list either.
    // A name must now be judged only against the clients that actually
    // claim her.
    rosterUnmatchedEverywhere: [...new Set(config.clients.flatMap((c) => c.coordinators || []))].filter((name) => {
      const key = config.normalizeName(name);
      const rosteredAt = payloads.filter((p) =>
        (config.clients.find((c) => c.id === p.clientId)?.coordinators || []).some((n) => config.normalizeName(n) === key)
      );
      if (rosteredAt.length === 0) return false;
      return rosteredAt.every((p) => p.roster.unmatched.some((u) => config.normalizeName(u) === key));
    }),
  });
  console.log(`[metrics] rebuilt ${payloads.length} client payloads in ${Date.now() - t0}ms`);
}

function getClient(clientId) {
  return cache.get(clientId) || null;
}

function getOverview() {
  return cache.get("__overview__") || null;
}

module.exports = {
  rebuild,
  getClient,
  getOverview,
  localBuckets,
  isExcludedTitle,
  computeClient,
  PERIODS,
  PERIOD_KEYS,
  DEFAULT_PERIOD,
};
