"use strict";

const config = require("./config");
const store = require("./db");

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
function isExcludedTitle(title, keywords) {
  if (!title) return false;
  const lower = title.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
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

// --- Queries ---------------------------------------------------------------

const selectEvents = db.prepare(`
  SELECT e.id, e.start_time, e.end_time, e.created_at AS event_created_at,
         e.interviewer_count, e.interview_id, e.has_feedback,
         i.title AS interview_title, i.is_debrief,
         s.id AS schedule_id, s.status AS schedule_status, s.created_at AS schedule_created_at,
         s.application_id, s.interview_stage_id,
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
const selectCancellations = db.prepare(`
  SELECT c.id, c.created_at, c.updated_at, c.application_id, c.interview_stage_id,
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
  SELECT observed_at, previous_start, new_start FROM reschedules
  WHERE client_id = ? AND observed_at >= ?
`);

// A candidate drop-off: an application archived after it had already
// reached a scheduled interview. Measures candidate-side loss from an
// active process, not generic resume rejections at application review.
const selectDropOffs = db.prepare(`
  SELECT a.id, a.archived_at, a.archive_reason, a.job_id, j.title AS job_title
  FROM applications a
  LEFT JOIN jobs j ON j.client_id = a.client_id AND j.id = a.job_id
  WHERE a.client_id = ? AND a.status = 'Archived' AND a.archived_at IS NOT NULL AND a.archived_at >= ?
    AND EXISTS (SELECT 1 FROM schedules s WHERE s.client_id = a.client_id AND s.application_id = a.id)
`);

// Time to schedule: from the schedule being created to its first event
// being booked. Both timestamps are real Ashby fields, so this needs no
// inference.
const selectTimeToSchedule = db.prepare(`
  SELECT s.created_at AS requested_at, MIN(e.created_at) AS booked_at
  FROM schedules s
  JOIN events e ON e.client_id = s.client_id AND e.schedule_id = s.id
  WHERE s.client_id = ? AND s.created_at >= ? AND e.created_at IS NOT NULL
  GROUP BY s.id
`);

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
      hours: Math.round(b.hours * 10) / 10,
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
        hours: Math.round((acc.hours + row.hours) * 10) / 10,
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
function computeClient(client) {
  const timeZone = client.timeZone;
  const since = new Date(Date.now() - config.historyMonths * 30 * 86400000).toISOString();

  const rows = selectEvents.all(client.id, since);
  const cancellations = selectCancellations.all(client.id, since);
  const observed = selectObservedReschedules.all(client.id, since);
  const dropOffs = selectDropOffs.all(client.id, since);
  const scheduleTimes = selectTimeToSchedule.all(client.id, since);

  const daily = new Map();
  const weekly = new Map();
  const monthly = new Map();
  const byRole = new Map();
  const byStage = new Map();
  const heatmap = new Map();

  const candidates = new Set();
  const interviewers = new Set();
  const roles = new Set();

  let events = 0;
  let debriefs = 0;
  let hours = 0;
  let interviewerSlots = 0;
  let shortNotice = 0;
  let outOfHours = 0;
  let excluded = 0;
  let excludedJobEvents = 0;
  let feedbackOutstanding = 0;

  for (const row of rows) {
    if (isExcludedTitle(row.interview_title, client.excludedTitleKeywords)) {
      excluded += 1;
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

    events += 1;
    if (isDebrief) debriefs += 1;
    hours += durationHours;
    interviewerSlots += row.interviewer_count || 0;
    if (row.candidate_id) candidates.add(row.candidate_id);
    if (row.job_id) roles.add(row.job_id);
    if (row.has_feedback === 0 && new Date(row.start_time) < new Date()) feedbackOutstanding += 1;

    // Short notice: booked less than SHORT_NOTICE_HOURS before it starts.
    // Pure firefighting, and completely invisible in a raw total.
    if (row.event_created_at) {
      const noticeHours = (new Date(row.start_time) - new Date(row.event_created_at)) / 3600000;
      if (noticeHours >= 0 && noticeHours < config.shortNoticeHours) shortNotice += 1;
    }

    if (buckets.hour < config.businessHourStart || buckets.hour >= config.businessHourEnd) outOfHours += 1;

    bump(daily, buckets.day, patch);
    bump(weekly, buckets.week, patch);
    bump(monthly, buckets.month, patch);
    bump(byStage, row.stage_title || "Unknown stage", patch);

    const roleKey = row.job_id || "unknown";
    if (!byRole.has(roleKey)) {
      byRole.set(roleKey, {
        ...emptyBucket(),
        jobId: row.job_id,
        title: cleanTitle(row.job_title),
        openedAt: row.job_opened_at || null,
        department: row.department_name || null,
        jobStatus: row.job_status || null,
        interviewers: new Set(),
      });
    }
    const role = byRole.get(roleKey);
    role.events += 1;
    role.hours += durationHours;
    role.debriefs += isDebrief ? 1 : 0;
    if (row.candidate_id) role.candidates.add(row.candidate_id);

    const heatKey = `${buckets.dow}:${buckets.hour}`;
    heatmap.set(heatKey, (heatmap.get(heatKey) || 0) + 1);
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

  const periods = {};
  for (const [name, days] of [["week", 7], ["month", 30], ["quarter", 90]]) {
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

  return {
    clientId: client.id,
    clientName: client.name,
    timeZone,
    accentColor: client.accentColor || null,
    generatedAt: new Date().toISOString(),
    historyFrom: since,
    // The client's local today, so charts can mark where observed volume
    // ends and already-booked future volume begins. currentWeek is the
    // same idea for weekly bars: the in-progress week is only partly
    // elapsed, so drawing it solid makes every chart end in a cliff that
    // looks like a collapse in volume rather than a Tuesday.
    today: dayKeyOffset(0, timeZone),
    currentWeek: localBuckets(new Date().toISOString(), timeZone).week,

    totals: {
      events,
      debriefs,
      hours: Math.round(hours),
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
    },

    periods,

    series: { daily: dailySeries, weekly: weeklySeries, monthly: monthlySeries },

    byRole: disambiguateTitles([...byRole.values()])
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

    byStage: [...byStage.entries()]
      .map(([title, b]) => ({ title, events: b.events, hours: Math.round(b.hours), candidates: b.candidates.size }))
      .sort((a, b) => b.events - a.events),

    heatmap: [...heatmap.entries()].map(([key, count]) => {
      const [dow, hour] = key.split(":").map(Number);
      return { dow, hour, events: count };
    }),

    timeToSchedule: {
      medianHours: median(noticeValues) === null ? null : Math.round(median(noticeValues) * 10) / 10,
      p90Hours: percentile(noticeValues, 90) === null ? null : Math.round(percentile(noticeValues, 90) * 10) / 10,
      sample: noticeValues.length,
      directBookings,
    },

    records: busiest ? { busiestDay: { date: busiest.key, events: busiest.events } } : null,

    dataQuality: {
      // The honest line under the reschedule number. Observed reschedules
      // are exact but only exist from the first successful sync onward;
      // the derived figure covers the whole window but is an inference
      // from cancelled-then-rebooked schedules, since Ashby records no
      // reschedule history at all.
      rescheduleTrackingSince: store.rescheduleTrackingSince(client.id),
      excludedTitleKeywords: client.excludedTitleKeywords,
      excludedJobTitles: client.excludedJobTitles,
    },
  };
}

/**
 * The cross-client overview. Per-client day buckets use each client's own
 * zone, so the roll-up re-buckets from scratch in OVERVIEW_TIMEZONE rather
 * than summing day keys that mean slightly different things.
 */
function computeOverview(clientPayloads) {
  const totals = clientPayloads.reduce(
    (acc, p) => ({
      events: acc.events + p.totals.events,
      hours: acc.hours + p.totals.hours,
      candidates: acc.candidates + p.totals.candidates,
      roles: acc.roles + p.totals.roles,
      interviewerSlots: acc.interviewerSlots + p.totals.interviewerSlots,
      shortNotice: acc.shortNotice + p.totals.shortNotice,
      outOfHours: acc.outOfHours + p.totals.outOfHours,
      cancellations: acc.cancellations + p.totals.cancellations,
      reschedulesDerived: acc.reschedulesDerived + p.totals.reschedulesDerived,
      reschedulesObserved: acc.reschedulesObserved + p.totals.reschedulesObserved,
      dropOffs: acc.dropOffs + p.totals.dropOffs,
      debriefs: acc.debriefs + p.totals.debriefs,
    }),
    {
      events: 0, hours: 0, candidates: 0, roles: 0, interviewerSlots: 0, shortNotice: 0,
      outOfHours: 0, cancellations: 0, reschedulesDerived: 0, reschedulesObserved: 0, dropOffs: 0, debriefs: 0,
    }
  );

  // Weekly series summed across clients by week key. Week keys are Monday
  // dates, which differ by at most a day across these zones — close enough
  // to align, unlike raw day keys.
  const weekly = new Map();
  for (const payload of clientPayloads) {
    for (const row of payload.series.weekly) {
      if (!weekly.has(row.key)) weekly.set(row.key, { key: row.key, events: 0, hours: 0, cancellations: 0, reschedules: 0 });
      const bucket = weekly.get(row.key);
      bucket.events += row.events;
      bucket.hours += row.hours;
      bucket.cancellations += row.cancellations;
      bucket.reschedules += row.reschedules;
    }
  }

  const periods = {};
  for (const name of ["week", "month", "quarter"]) {
    periods[name] = clientPayloads.reduce(
      (acc, p) => {
        acc.current.events += p.periods[name].current.events;
        acc.current.hours = Math.round((acc.current.hours + p.periods[name].current.hours) * 10) / 10;
        acc.previous.events += p.periods[name].previous.events;
        acc.previous.hours = Math.round((acc.previous.hours + p.periods[name].previous.hours) * 10) / 10;
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
    generatedAt: new Date().toISOString(),
    timeZone: config.overviewTimeZone,
    today: localBuckets(new Date().toISOString(), config.overviewTimeZone).day,
    currentWeek: localBuckets(new Date().toISOString(), config.overviewTimeZone).week,
    totals,
    periods,
    series: { weekly: [...weekly.values()].sort((a, b) => (a.key < b.key ? -1 : 1)) },
    byClient: clientPayloads.map((p) => ({
      clientId: p.clientId,
      clientName: p.clientName,
      accentColor: p.accentColor,
      events: p.totals.events,
      hours: p.totals.hours,
      candidates: p.totals.candidates,
      roles: p.totals.roles,
      cancellations: p.totals.cancellations,
      reschedules: p.totals.reschedulesDerived,
      shortNotice: p.totals.shortNotice,
      thisWeek: p.periods.week.current.events,
      weekChange: p.periods.week.change.events,
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

  cache.set("__overview__", computeOverview(payloads));
  console.log(`[metrics] rebuilt ${payloads.length} client payloads in ${Date.now() - t0}ms`);
}

function getClient(clientId) {
  return cache.get(clientId) || null;
}

function getOverview() {
  return cache.get("__overview__") || null;
}

module.exports = { rebuild, getClient, getOverview, localBuckets, isExcludedTitle, computeClient };
