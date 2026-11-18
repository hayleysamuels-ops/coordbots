"use strict";

const config = require("./config");
const { mapWithConcurrency } = require("./concurrency");
const rescheduleTracking = require("./rescheduleTracking");
const interviewerSettingsCache = require("./interviewerSettingsCache");
const applicationInfoCache = require("./applicationInfoCache");
const interviewTitleCache = require("./training/interviewTitleCache");
const { countInterviewLoad, createScheduleSync, weekKey } = require("./interviewer-load");
const { createFeedbackSync } = require("./feedback-sync");
const { createSyncStateFile } = require("./syncStateFile");
const { buildLeaderboard } = require("./feedback-leaderboard");

function authHeader() {
  return `Basic ${Buffer.from(`${config.ashbyApiKey}:`).toString("base64")}`;
}

// Counts every actual HTTP request made to Ashby, including retries (each
// one is a real request Ashby saw, so it counts) — issues.js logs the delta
// across one refresh cycle so the interviewer-settings/application-info
// caches' effect on total call volume is directly visible in deploy logs,
// not just inferred from wall-clock time. Broken down by endpoint too, not
// just a total — a raw total conflates retry noise from a flaky org (a
// spell of transient failures inflates every endpoint's count, cache or no
// cache) with the actual per-endpoint call volume the caches are meant to
// reduce, and application.info/user.interviewerSettings are what those two
// caches specifically target.
let apiCallCount = 0;
const apiCallCountByEndpoint = {};
function getApiCallCount() {
  return apiCallCount;
}
function getApiCallCountByEndpoint() {
  return { ...apiCallCountByEndpoint };
}

// A single retryable request (whether it's one page of a multi-page
// pagination walk, or a one-off lookup like user.interviewerSettings)
// retries with exponential backoff instead of throwing immediately — without
// this, a 429/500/502/503/504 mid-pagination would abort the entire
// fetchAllPages() walk (and therefore the whole refresh cycle) rather than
// just slowing down. 500/502/503/504 are Ashby-side upstream/gateway errors,
// same as a 429 in that they're transient and unrelated to the request
// itself — a request that fails with one now almost always succeeds a
// moment later, so treating them as fatal killed the whole refresh over
// what's usually a blip (confirmed live against a real org: repeated bare
// 500s from application.list mid-pagination, alongside 502/503/504 — 500
// was originally left out of this set and needed adding). Honors a
// Retry-After header when Ashby sends one (rare for 5xx, but checked
// regardless in case it's present); otherwise doubles the delay each
// attempt. Gives up once *cumulative* waiting would exceed
// RETRYABLE_MAX_TOTAL_BACKOFF_MS, at which point it throws like before and
// the caller's own error handling takes over (fetchApplicationsById/
// listInterviewerLimits already skip a single failed item; fetchAllPages
// still propagates, same as a non-retryable failure always has).
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_MAX_TOTAL_BACKOFF_MS = 4 * 60 * 1000;
const RETRYABLE_INITIAL_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ashbyPost(endpoint, body) {
  let attempt = 0;
  let totalWaitedMs = 0;

  for (;;) {
    apiCallCount += 1;
    apiCallCountByEndpoint[endpoint] = (apiCallCountByEndpoint[endpoint] || 0) + 1;
    const res = await fetch(`https://api.ashbyhq.com/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: authHeader() },
      body: JSON.stringify(body),
    });

    if (RETRYABLE_STATUS_CODES.has(res.status)) {
      const retryAfterSeconds = parseInt(res.headers.get("retry-after"), 10);
      const backoffMs =
        !Number.isNaN(retryAfterSeconds) && retryAfterSeconds >= 0
          ? Math.max(retryAfterSeconds * 1000, 250)
          : RETRYABLE_INITIAL_DELAY_MS * 2 ** attempt;

      if (totalWaitedMs + backoffMs > RETRYABLE_MAX_TOTAL_BACKOFF_MS) {
        throw new Error(`${endpoint} -> HTTP ${res.status} (gave up after ${Math.round(totalWaitedMs / 1000)}s of retries)`);
      }

      attempt += 1;
      totalWaitedMs += backoffMs;
      const reason = res.status === 429 ? "rate-limited (429)" : `upstream error (${res.status})`;
      console.warn(`[ashby] ${endpoint} ${reason}, waiting ${Math.round(backoffMs / 1000)}s before retry ${attempt}`);
      await sleep(backoffMs);
      continue;
    }

    if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status}`);
    const json = await res.json();
    if (json.success === false) throw new Error(`${endpoint} -> ${JSON.stringify(json.errors || json)}`);
    return json;
  }
}

// Ashby responses are { success, results, moreDataAvailable, nextCursor }.
// This walks every page and concatenates `results`.
async function fetchAllPages(endpoint, baseBody) {
  const all = [];
  let cursor;
  for (;;) {
    const json = await ashbyPost(endpoint, cursor ? { ...baseBody, cursor } : baseBody);
    const results = json.results || [];
    all.push(...results);
    if (!json.moreDataAvailable || !json.nextCursor) break;
    cursor = json.nextCursor;
  }
  return all;
}

// Ashby's candidate-feed URL needs both the candidate id and the application
// id, plus a pipeline-view segment ("active" here). Every caller of this
// function today is guaranteed Active status by the filter in
// summarizeApplications below, so "active" is always correct in
// practice — this hasn't been verified for Hired/Archived/Lead candidates,
// which this dashboard never links to.
function profileUrl(candidateId, applicationId) {
  if (!candidateId || !applicationId) return undefined;
  return (
    `${config.ashbyAppBaseUrl}/candidates/pipeline/active/right-side` +
    `/candidates/${candidateId}/applications/${applicationId}/feed`
  );
}

// A candidate's own profile page — candidate.info's real `profileUrl` field,
// confirmed status-independent via a live sample (both an Active and an
// Archived candidate resolve the same `/candidate-searches/new/right-side/
// candidates/<id>` shape; "new" is a literal path segment, not a per-search
// value). Unlike profileUrl() above (pipeline-view-scoped, verified Active-
// only), this needs no applicationId and isn't tied to any particular
// pipeline stage, so it's safe for Offers — where a candidate is frequently
// already Hired or Archived by the time this app sees them. Constructed
// directly (no extra API call) since the path only depends on candidateId.
function candidateProfileUrl(candidateId) {
  if (!candidateId) return undefined;
  return `${config.ashbyAppBaseUrl}/candidate-searches/new/right-side/candidates/${candidateId}`;
}

// Application-review-stage applications haven't been engaged with yet — no
// interview has happened, no email back-and-forth is expected. Excluded per
// product decision: this dashboard is for candidates actively moving through
// the pipeline, not the top-of-funnel application backlog (which, in this
// org, is the overwhelming majority of "Active" applications).
function isPreInterview(app) {
  return (app.currentInterviewStage || {}).type === "PreInterviewScreen";
}

// Finds the hiringTeam member with the given role (an exact match against
// Ashby's hiringTeamRole.list values, e.g. "Recruiter"/"Recruiting
// Coordinator") — already present on every application.list/info result, no
// extra lookup needed. Returns null if no one holds that role on this
// application (common — hiring teams aren't always fully staffed).
function hiringTeamMember(app, roleName) {
  const member = (app.hiringTeam || []).find((m) => m.role === roleName);
  if (!member) return null;
  return { id: member.userId, name: `${member.firstName || ""} ${member.lastName || ""}`.trim() || member.email };
}

// Fetches application.info for each id, bounded concurrency, skipping (not
// throwing on) any single lookup that fails — shared by summarizeApplications/
// jobsByApplication and fetchOfferApplications below, which differ only in
// which apps they keep.
//
// `signatures` (Map<applicationId, string>) is the caller's best FREE signal
// for "has anything changed here since last time" — a schedule's own
// updatedAt for the schedule-driven caller, an offer's own
// status/version/decidedAt for the offer-driven one (see applicationInfoCache.js
// for why there's no cheaper way to check an application specifically).
// application.info is by far the most expensive part of a refresh — one
// call per unique id, and this org alone confirmed live at 523s for the
// whole schedule-driven batch — so a cache hit here (signature unchanged,
// still within MAX_AGE_MS) skips the network call entirely.
async function fetchApplicationsById(applicationIds, signatures) {
  const results = await mapWithConcurrency(applicationIds, 8, async (id) => {
    const signature = signatures.get(id) || "";
    const cached = applicationInfoCache.get(id, signature);
    if (cached) return cached;
    try {
      const json = await ashbyPost("application.info", { applicationId: id });
      applicationInfoCache.set(id, signature, json.results);
      return json.results;
    } catch (err) {
      console.warn(`[ashby] application.info failed for ${id}:`, err.message);
      return null;
    }
  });
  applicationInfoCache.flush();
  return results;
}

// application.info embeds applicationHistory[] for free (same data as the
// separate application.listHistory endpoint) — one entry per stage the
// application has occupied, each with enteredStageAt/leftStageAt. The
// currently active stage is the one entry with no leftStageAt yet; that
// entry's enteredStageAt is when the application entered ITS CURRENT stage.
// Confirmed structural (not org-configured naming) against both Profound and
// January live samples. Falls back to the last entry if every entry somehow
// has a leftStageAt (shouldn't happen for an Active application, but the
// array could in principle be empty or all-closed on bad data).
function currentStageEnteredAt(app) {
  const history = app.applicationHistory || [];
  const current = history.find((h) => !h.leftStageAt) || history[history.length - 1];
  return current ? current.enteredStageAt : null;
}

// Shared candidate/job/hiring-team shape every candidate-linked section
// builds from a raw application.info result. ashbyProfileUrl is only set for
// Active applications — the profile URL hardcodes the "active" pipeline
// segment, unverified for Hired/Archived/Lead (see profileUrl above).
function buildApplicationRecord(app) {
  const candidate = app.candidate || {};
  const recruiter = hiringTeamMember(app, config.recruiterRoleName);
  const coordinator = hiringTeamMember(app, config.coordinatorRoleName);
  return {
    applicationId: app.id,
    candidateId: candidate.id,
    candidateName: candidate.name,
    candidateEmail: candidate.primaryEmailAddress && candidate.primaryEmailAddress.value,
    jobTitle: (app.job && app.job.title) || "Unknown role",
    jobId: (app.job && app.job.id) || null,
    departmentId: (app.job && app.job.departmentId) || null,
    recruiterId: recruiter && recruiter.id,
    recruiterName: recruiter && recruiter.name,
    coordinatorId: coordinator && coordinator.id,
    coordinatorName: coordinator && coordinator.name,
    status: app.status,
    currentStageId: (app.currentInterviewStage && app.currentInterviewStage.id) || null,
    currentStageEnteredAt: currentStageEnteredAt(app),
    ashbyProfileUrl: app.status === "Active" ? profileUrl(candidate.id, app.id) : undefined,
  };
}

/**
 * Looks up full application details (candidate, job, status, stage) only for
 * the given applicationIds — not a scan of every active application. Filters
 * out anything no longer Active or still sitting in Application Review.
 */
// Candidate-facing sections only: still Active, and past Application Review.
function summarizeApplications(fetched) {
  const byId = new Map();
  for (const app of fetched) {
    if (!app || app.status !== "Active" || isPreInterview(app)) continue;
    byId.set(app.id, buildApplicationRecord(app));
  }
  return byId;
}

// Job per application, deliberately UNFILTERED by candidate status. The
// training tracker keys a path on interview title + job (see
// training/progress.js for why neither alone is unique), and a training
// session counts regardless of what happened to the candidate afterwards —
// same reasoning as Interviewer Weekly Limits, which isn't candidate-driven
// either. Filtering these to Active would silently stop counting a shadow
// the moment its candidate was rejected.
function jobsByApplication(fetched) {
  const byId = new Map();
  for (const app of fetched) {
    if (!app || !app.job || !app.job.id) continue;
    byId.set(app.id, { jobId: app.job.id, jobTitle: app.job.title || "" });
  }
  return byId;
}

/**
 * Like summarizeApplications, but for Offers: keeps every application
 * status, not just Active. A signed offer's candidate has usually already
 * moved to "Hired" by the time this app sees it — the Active-only filter
 * above would wrongly hide them. isPreInterview is irrelevant here too; an
 * offer is never extended that early in the pipeline. Also overrides
 * ashbyProfileUrl with candidateProfileUrl() instead of
 * buildApplicationRecord()'s Active-only pipeline link — Offers candidates
 * are frequently Hired/Archived, exactly the statuses that link is
 * unverified for.
 */
async function fetchOfferApplications(applicationIds, signatures) {
  const fetched = await fetchApplicationsById(applicationIds, signatures);
  const byId = new Map();
  for (const app of fetched) {
    if (!app) continue;
    const record = buildApplicationRecord(app);
    record.ashbyProfileUrl = candidateProfileUrl(record.candidateId);
    byId.set(app.id, record);
  }
  return byId;
}

// Every interview schedule, not just the SCHEDULE_LOOKBACK_DAYS window
// listIssues() reads: an interview booked long ago for this week still counts
// toward it. Kept current with Ashby's syncToken (interviewer-load.js), so
// after the first full read each refresh costs one call when nothing changed.
// Holds schedules for the feedback leaderboard's window plus two days (it
// used to keep 8 days, enough for the weekly limits alone).
const scheduleSync = createScheduleSync({
  fetchPage: (body) => ashbyPost("interviewSchedule.list", body),
  keepDays: Math.max(8, config.feedbackLeaderboardDays + 2),
  // Kept on the volume so a redeploy doesn't re-read every schedule ever.
  store: createSyncStateFile("schedule-sync.json"),
});

// Every scorecard in the same window, org-wide (feedback-sync.js).
const feedbackSync = createFeedbackSync({
  fetchPage: (body) => ashbyPost("applicationFeedback.list", body),
  keepDays: config.feedbackLeaderboardDays + 2,
  store: createSyncStateFile("feedback-sync.json"),
});

/**
 * Counts interviews per interviewer for the current calendar week, Monday to
 * Sunday in config.displayTimeZone (Luminai: Pacific), over every schedule
 * (scheduleSync above). Cancelled schedules don't count toward load. Every
 * interviewer on an event counts, as Ashby's own weekly limit would.
 */
function countInterviewsThisWeek(schedules, now = Date.now()) {
  const week = weekKey(now, config.displayTimeZone);
  const byInterviewer = new Map();
  for (const [userId, row] of countInterviewLoad(schedules, { timeZone: config.displayTimeZone })) {
    const scheduledCount = row.weeks.get(week) || 0;
    if (scheduledCount) byInterviewer.set(userId, { userId, name: row.name, email: row.email, scheduledCount });
  }
  return byInterviewer;
}

/**
 * Interviewers whose remaining weekly capacity (Ashby's configured
 * weeklyLimit minus interviews already on the calendar this week) has
 * dropped to INTERVIEWER_LIMIT_BUFFER slots or fewer. Interviewers with no
 * weeklyLimit set in Ashby are never flagged — there's nothing to be near.
 */
async function listInterviewerLimits(schedules) {
  const counts = countInterviewsThisWeek(schedules);
  if (!counts.size) return [];

  // weeklyLimit almost never changes, so this is cached (interviewerSettingsCache.js,
  // refreshed at most daily) rather than re-fetched for every interviewer on
  // every refresh — one call per unique interviewer in this week's
  // schedules, previously, every single cycle.
  const settingsById = new Map(
    (
      await mapWithConcurrency([...counts.keys()], 8, async (userId) => {
        const cached = interviewerSettingsCache.get(userId);
        if (cached) return [userId, cached];
        try {
          const json = await ashbyPost("user.interviewerSettings", { userId });
          interviewerSettingsCache.set(userId, json.results);
          return [userId, json.results];
        } catch (err) {
          console.warn(`[ashby] user.interviewerSettings failed for ${userId}:`, err.message);
          return null;
        }
      })
    ).filter(Boolean)
  );
  interviewerSettingsCache.flush();

  const nearingLimit = [];
  for (const [userId, info] of counts) {
    const settings = settingsById.get(userId);
    if (!settings || settings.weeklyLimit == null) continue;

    const remaining = settings.weeklyLimit - info.scheduledCount;
    if (remaining <= config.interviewerLimitBuffer) {
      nearingLimit.push({ ...info, weeklyLimit: settings.weeklyLimit, remaining });
    }
  }

  nearingLimit.sort((a, b) => a.remaining - b.remaining);
  return nearingLimit;
}

/**
 * A "debrief" is an internal wrap-up meeting among interviewers, not a
 * candidate-facing round with a scorecard due back — it should never count
 * toward Feedback Overdue. This is a real, structural Ashby field
 * (`interview.list`'s `isDebrief` boolean, per interview *definition*, not
 * per event — cross-referenced against each event's `interviewId`), not an
 * org-configured naming convention, so it's safe for any client. Interview
 * definitions are a small, org-wide, largely-static catalog (not
 * per-candidate), same shape as listDepartments() — fetched once per
 * refresh via the same fetchAllPages() pagination every other list endpoint
 * uses. Falls back to an empty set (nothing excluded — the old behavior) if
 * this fails for any reason, e.g. an API key without interviews:read, so a
 * misconfigured or lower-permission client degrades gracefully instead of
 * losing Feedback Overdue entirely.
 */
async function fetchDebriefInterviewIds() {
  try {
    const interviews = await fetchAllPages("interview.list", { limit: 100 });
    return new Set(interviews.filter((i) => i.isDebrief).map((i) => i.id));
  } catch (err) {
    console.warn("[ashby] interview.list failed, debriefs won't be excluded from Feedback Overdue:", err.message);
    return new Set();
  }
}

/**
 * Everything is driven off recent interview schedules rather than a full
 * active-application scan (this org has 1,600+ active applications, almost
 * all sitting untouched in Application Review — paginating all of them took
 * minutes and mostly produced records this dashboard doesn't care about).
 *
 * Returns:
 * - feedbackOverdue: interview events that ended > FEEDBACK_OVERDUE_HOURS ago
 *   with no submitted feedback. Debrief events (Ashby's real `isDebrief` flag
 *   on the interview definition, see fetchDebriefInterviewIds()) are excluded
 *   — a debrief has no scorecard due back, so it can never be "overdue."
 * - needsScheduling: schedules stuck in Ashby's "NeedsScheduling" status,
 *   aged past NEEDS_SCHEDULING_ALERT_HOURS — nothing has been sent to the
 *   candidate yet. Distinct from availabilitySubmitted below; see README.
 * - availabilitySubmitted: schedules in Ashby's "CandidateAvailabilitySubmitted"
 *   status — the candidate replied with their times, waiting on someone to
 *   book it. Shown regardless of age (not threshold-gated like the other
 *   lists); AVAILABILITY_SUBMITTED_ALERT_HOURS only drives severity coloring.
 * - Stale rows: an entry in feedbackOverdue/needsScheduling past
 *   STALE_FEEDBACK_HOURS / STALE_SCHEDULING_HOURS carries isStale: true and
 *   stays in its list (the Action queue labels it). There is no separate
 *   staleCandidates list any more (folded in 2026-11-17).
 * - interviewsToday: every interview that started today, with each person
 *   who owes a scorecard marked in / not in — see todaysStartedEvents().
 * - interviewerLimits: interviewers at or nearing their Ashby-configured
 *   weekly interview limit for the current calendar week — see
 *   listInterviewerLimits above. Independent of application status; an
 *   interviewer's load counts regardless of whether their candidates are
 *   Active, Hired, or Archived.
 * - onsiteToday: today's final-round/executive interview events — see
 *   listOnsiteToday above for how "onsite" is approximated (Ashby has no
 *   real signal for it in this org).
 * - rescheduledInterviews: interview events whose tracked reschedule count
 *   exceeds RESCHEDULE_COUNT_THRESHOLD (default 2). Ashby has no reschedule
 *   history of its own — see rescheduleTracking.js — so counting only
 *   starts from whenever this app first saw a given event; it can't detect
 *   reschedules that already happened before that.
 *
 * A candidate appears in at most ONE of feedbackOverdue/needsScheduling/
 * availabilitySubmitted/onsiteToday, never several at once —
 * see keepMostRecentPerCandidate below. Without this, a candidate could
 * legitimately show up in both, e.g., Feedback Overdue (an old interview's
 * feedback still isn't in) AND Onsite Interviews Today (they've since moved
 * on to a new round) — confusing, since the old feedback item is stale
 * information once a newer round exists. Only the single most recent event
 * per candidate is kept; everything else for that candidate is dropped
 * entirely. rescheduledInterviews and interviewsToday are deliberately NOT
 * part of that pool — it's an orthogonal fact about a specific event's
 * history, not a mutually-exclusive candidate state, so a candidate can be
 * in Rescheduled Interviews (or Interviews today) AND one of the others.
 */
// Collapses a pool of candidate-linked entries (tagged with `eventTime`, a
// millisecond timestamp, and `__section`) down to one entry per candidateId
// — whichever has the latest eventTime. Entries with no candidateId (should
// never happen in practice; every Ashby candidate has one) pass through
// untouched rather than being silently dropped.
function keepMostRecentPerCandidate(taggedEntries) {
  const bestByCandidate = new Map();
  const passthrough = [];
  for (const entry of taggedEntries) {
    if (!entry.candidateId) {
      passthrough.push(entry);
      continue;
    }
    const existing = bestByCandidate.get(entry.candidateId);
    if (!existing || entry.eventTime > existing.eventTime) {
      bestByCandidate.set(entry.candidateId, entry);
    }
  }
  return [...bestByCandidate.values(), ...passthrough];
}
// A recruiting coordinator's day-of prep list. Ashby has no per-interview
// "onsite" flag anywhere — checked interviewEvents, interview.info,
// interviewStage.info, and (on this org) all 38 org custom fields; none
// carry a location/format signal in ANY Ashby org, structurally. "Onsite" is
// therefore approximated per-client via config.onsiteStageKeywords, matched
// against interview STAGE titles (case-insensitive substrings) — this only
// works if verified against that client's actual stage-naming convention
// first (see scripts/check-ashby-compatibility.js); "final"/"exec" is
// January's convention (final-round and executive interviews only — this
// used to also match "panel" until narrowed per product decision), not a
// real Ashby default. An empty keyword list
// disables the section entirely rather than silently matching nothing.
// "Today" is a calendar day in config.displayTimeZone (default
// America/New_York), NOT the server container's UTC day — display times
// also render in that same zone client-side (see appConfig.displayTimeZone
// in app.js), so both agree on what "today" means. This used to be a raw
// UTC day, which rolls over at 8pm Eastern during EDT (4am UTC) rather than
// local midnight — an evening onsite interview would silently drop off this
// section hours before the day actually changed for anyone in the org.
// countInterviewsThisWeek's Monday-Sunday week (above) uses the same zone.
function matchesOnsiteStage(title) {
  if (!title) return false;
  const lower = title.toLowerCase();
  return config.onsiteStageKeywords.some((k) => lower.includes(k));
}

// YYYY-MM-DD for `date` as seen in `timeZone` — en-CA locale formats dates
// this way natively, giving a directly comparable string for same-day
// checks without a date-math library.
function calendarDateInTimeZone(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function isToday(dateStr) {
  if (!dateStr) return false;
  return calendarDateInTimeZone(new Date(dateStr), config.displayTimeZone) === calendarDateInTimeZone(new Date(), config.displayTimeZone);
}

/**
 * Today's final-round/executive interview events for still-Active candidates.
 * Reuses the same `schedules`/`applications` listIssues() already computed
 * — no extra pagination call — except for resolving each involved
 * schedule's interviewStageId to a title, which interviewSchedule.list
 * doesn't include directly. Stage IDs are heavily reused across schedules
 * (most orgs have a handful of stages), so this is a small, cheap,
 * concurrency-limited, per-unique-stage-id lookup, not one per schedule.
 */
async function listOnsiteToday(schedules, applications) {
  if (!config.onsiteStageKeywords.length) return []; // section disabled for this client

  const candidates = schedules.filter(
    (s) =>
      applications.has(s.applicationId) &&
      (s.interviewEvents || []).some((e) => e.startTime && isToday(e.startTime))
  );
  if (!candidates.length) return [];

  const stageIds = [...new Set(candidates.map((s) => s.interviewStageId).filter(Boolean))];
  const stageTitleById = new Map(
    (
      await mapWithConcurrency(stageIds, 8, async (interviewStageId) => {
        try {
          const json = await ashbyPost("interviewStage.info", { interviewStageId });
          return [interviewStageId, json.results.title];
        } catch (err) {
          console.warn(`[ashby] interviewStage.info failed for ${interviewStageId}:`, err.message);
          return null;
        }
      })
    ).filter(Boolean)
  );

  const entries = [];
  for (const schedule of candidates) {
    const stageTitle = stageTitleById.get(schedule.interviewStageId);
    if (!matchesOnsiteStage(stageTitle)) continue;

    const app = applications.get(schedule.applicationId);
    for (const event of schedule.interviewEvents || []) {
      if (!event.startTime || !isToday(event.startTime)) continue;
      entries.push({
        ...app,
        scheduleId: schedule.id,
        interviewEventId: event.id,
        stageTitle,
        startTime: event.startTime,
        endTime: event.endTime,
        interviewers: (event.interviewers || []).map((i) => ({
          name: `${i.firstName || ""} ${i.lastName || ""}`.trim() || i.email,
          email: i.email,
        })),
      });
    }
  }

  entries.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  return entries;
}

/**
 * Interviews today: every interview event that started today (a calendar day
 * in DISPLAY_TIMEZONE, same boundary as Onsite Interviews Today) and has
 * already started. Not filtered by candidate status — a rejected
 * candidate's scorecard is still owed — and not part of
 * keepMostRecentPerCandidate's one-row-per-candidate pool: like Rescheduled
 * Interviews, it's a fact about an event, not a candidate's state.
 * Cancelled schedules are skipped. Same SCHEDULE_LOOKBACK_DAYS window as
 * everything else in listIssues(), so a schedule created longer ago than that
 * doesn't appear (the same holds for Onsite Interviews Today).
 *
 * Two steps so the per-person feedback lookups can be shared with Feedback
 * Overdue: todaysStartedEvents() picks the events, buildInterviewsToday()
 * turns them into rows once applicationFeedback.list has been read.
 */
function todaysStartedEvents(schedules, now) {
  const picked = [];
  for (const schedule of schedules) {
    if (schedule.status === "Cancelled" || !schedule.applicationId) continue;
    for (const event of schedule.interviewEvents || []) {
      if (!event.startTime || !isToday(event.startTime)) continue;
      if (new Date(event.startTime).getTime() > now) continue; // not started yet
      picked.push({ schedule, event, ended: Boolean(event.endTime) && new Date(event.endTime).getTime() <= now });
    }
  }
  return picked;
}

function buildInterviewsToday(picked, rawApplicationsById, debriefInterviewIds, feedbackByApplication) {
  const rows = [];
  for (const { schedule, event, ended } of picked) {
    const raw = rawApplicationsById.get(schedule.applicationId);
    if (!raw) continue; // application.info failed; nothing to name the row by
    const app = buildApplicationRecord(raw);
    const owerIds = new Set(owersFor(event, debriefInterviewIds).map((i) => i.id));
    // Per person: true = scorecard in, false = not in yet, null = couldn't
    // check (lookup failed). Only for people who owe one, and only once the
    // interview has ended. A flag-false event needs no lookup: nobody's in.
    let missingIds = null;
    if (ended && owerIds.size) {
      if (!event.hasSubmittedFeedback) missingIds = owerIds;
      else {
        const fb = feedbackByApplication.get(schedule.applicationId);
        if (fb) missingIds = new Set(missingFeedbackOwers(event, fb).filter((i) => owerIds.has(i.id)).map((i) => i.id));
      }
    }
    rows.push({
      ...app,
      ashbyProfileUrl: app.ashbyProfileUrl || candidateProfileUrl(app.candidateId),
      scheduleId: schedule.id,
      interviewEventId: event.id,
      interviewTitle: interviewTitleCache.get(event.interviewId) || null,
      startTime: event.startTime,
      endTime: event.endTime,
      inProgress: !ended,
      people: (event.interviewers || []).map((i) => {
        const owes = owerIds.has(i.id);
        return {
          name: `${i.firstName || ""} ${i.lastName || ""}`.trim() || i.email,
          owes,
          submitted: !owes || !ended ? null : missingIds ? !missingIds.has(i.id) : null,
        };
      }),
    });
  }
  rows.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  return rows;
}

// Groups every interview event in the lookback window by applicationId,
// across ALL schedules regardless of that schedule's own status — no extra
// Ashby call, since `schedules` already covers this window. Used to detect
// when a feedback-overdue event has been superseded by later activity on
// the same application (see isSupersededByLaterActivity below).
function groupEventsByApplicationId(schedules) {
  const byApplicationId = new Map();
  for (const schedule of schedules) {
    if (!schedule.applicationId) continue;
    const list = byApplicationId.get(schedule.applicationId) || [];
    for (const event of schedule.interviewEvents || []) {
      list.push({ id: event.id, endTime: event.endTime, hasSubmittedFeedback: event.hasSubmittedFeedback });
    }
    byApplicationId.set(schedule.applicationId, list);
  }
  return byApplicationId;
}

/**
 * The interviewers who could still owe a scorecard for an event: everyone not
 * explicitly marked isFeedbackRequired false (a missing value counts as
 * required, so an org where the field is ever absent doesn't silently drop a
 * real panelist). An event where this is empty has no scorecard due at all —
 * e.g. a Welcome whose hosts are all feedback-not-required — and is never
 * Feedback Overdue, rather than shown with an empty interviewer list.
 */
function feedbackOwers(event) {
  return (event.interviewers || []).filter((i) => i.isFeedbackRequired !== false);
}

/**
 * Which of an event's owers have NOT yet submitted, from the per-scorecard
 * records of applicationFeedback.list for that event's application.
 *
 * Needed because hasSubmittedFeedback is one flag per EVENT that turns true
 * as soon as ANYONE on it submits. Confirmed live on Forus (2026-11-17): of 50
 * panels that ended 48h+ earlier, 12 had the flag true while at least one
 * required interviewer had never submitted. Most fall outside Feedback
 * Overdue's scope anyway (candidate not Active, superseded, or moved on); on
 * the day of the fix this added 3 rows at Pace and 1 at Poetic.
 *
 * A scorecard counts for whoever it is CREDITED to (creditedToUser), falling
 * back to submittedByUser only when there's no credit. Deliberate: a
 * coordinator or colleague sometimes submits on an interviewer's behalf (3
 * such scorecards in the same Forus sample), and that interviewer's feedback
 * IS in. Don't switch this to submittedByUser — it would mark the real
 * interviewer missing and credit someone who wasn't on the panel.
 * Only scorecards tied to this exact interview event count, so feedback for
 * a different round on the same application never stands in for this one.
 */
function missingFeedbackOwers(event, feedbackRows) {
  const inFor = new Set();
  for (const f of feedbackRows || []) {
    if (f.interviewEventId !== event.id) continue;
    const credited = (f.creditedToUser && f.creditedToUser.id) || (f.submittedByUser && f.submittedByUser.id);
    if (credited) inFor.add(credited);
  }
  return feedbackOwers(event).filter((i) => !inFor.has(i.id));
}

// applicationFeedback.list for each application, at most 8 at a time. A
// failed application maps to null rather than throwing: its events then keep
// the old event-level reading (flag true = not flagged), so one bad call
// degrades to the previous behaviour instead of taking down listIssues().
async function fetchFeedbackByApplication(applicationIds) {
  const entries = await mapWithConcurrency(applicationIds, 8, async (applicationId) => {
    try {
      return [applicationId, await fetchAllPages("applicationFeedback.list", { applicationId })];
    } catch (err) {
      console.warn(`[ashby] applicationFeedback.list failed for ${applicationId}; using the event-level flag for its interviews:`, err.message);
      return [applicationId, null];
    }
  });
  return new Map(entries);
}

// Titles for interview ids, cached on disk forever (training/
// interviewTitleCache.js). interview.list leaves out interviews defined inside
// a job's own interview plan (January: 38 of 65 in use; Forus: most), so each
// missing id is looked up with interview.info, 4 at a time, once ever. A
// failed lookup leaves the id unresolved, which counts as "owes feedback"
// (see isNoFeedbackInterview), so a lookup problem can't hide a missing
// scorecard.
async function resolveInterviewTitles(interviewIds) {
  const missing = interviewTitleCache.missing(interviewIds);
  if (!missing.length) return;
  await mapWithConcurrency(missing, 4, async (id) => {
    try {
      const json = await ashbyPost("interview.info", { id });
      interviewTitleCache.set(id, (json.results && json.results.title) || "");
    } catch (err) {
      console.warn(`[ashby] interview.info failed for ${id}; treating it as an interview that owes feedback:`, err.message);
    }
  });
  interviewTitleCache.flush();
}

// True when the event's interview is on this client's NO_FEEDBACK_INTERVIEWS
// list (matched by name, never by person). An unresolved title is false.
function isNoFeedbackInterview(interviewId) {
  if (!config.noFeedbackInterviews.length || !interviewTitleCache.has(interviewId)) return false;
  return config.noFeedbackInterviews.includes(config.normalizeInterviewName(interviewTitleCache.get(interviewId)));
}

/**
 * Who owes a scorecard for an event — the one rule Feedback Overdue and
 * Interviews today share: nobody on a debrief or on an interview named in
 * NO_FEEDBACK_INTERVIEWS (Luminai's Welcome hosts are marked
 * feedback-required in Ashby and still owe nothing); otherwise everyone not
 * explicitly marked isFeedbackRequired false (feedbackOwers above).
 */
function owersFor(event, debriefInterviewIds) {
  if (debriefInterviewIds.has(event.interviewId) || isNoFeedbackInterview(event.interviewId)) return [];
  return feedbackOwers(event);
}

/**
 * A candidate can have multiple schedules over the life of one application
 * (one per interview stage/round) — an earlier round's missing feedback can
 * keep showing as overdue long after the candidate has moved on to (or even
 * finished) a later round, even though that later round's schedule itself is
 * perfectly healthy (often "Complete"). Confirmed live: 17 of a 50-event
 * sample were events on an otherwise-legitimate "Complete" schedule whose
 * candidate already had a chronologically later event on the SAME
 * application that had already occurred.
 *
 * "Already occurred" is deliberately narrower than "a later schedule
 * exists" — a later round merely being booked doesn't retire the earlier
 * gap; someone still owes that scorecard until the later round has actually
 * happened (past its endTime) or someone has already acted on it
 * (hasSubmittedFeedback). Otherwise a coordinator who books an optimistic
 * next round would silently lose visibility into a real, still-open gap.
 */
function isSupersededByLaterActivity(event, applicationId, eventsByApplicationId) {
  const eventEndMs = new Date(event.endTime).getTime();
  const now = Date.now();
  const siblings = eventsByApplicationId.get(applicationId) || [];
  return siblings.some((other) => {
    if (other.id === event.id || !other.endTime) return false;
    const otherEndMs = new Date(other.endTime).getTime();
    if (otherEndMs <= eventEndMs) return false; // not later
    return other.hasSubmittedFeedback || otherEndMs <= now; // already occurred
  });
}

async function listIssues(options = {}) {
  const createdAfter = Date.now() - config.scheduleLookbackDays * 24 * 60 * 60 * 1000;
  const schedules = await fetchAllPages("interviewSchedule.list", { limit: 100, createdAfter });

  // Reschedule tracking is a property of the event itself, not the
  // candidate — run it over every event in the lookback window regardless
  // of application status, before the Active-only filtering below.
  const allEvents = schedules.flatMap((s) => (s.interviewEvents || []).map((e) => ({ id: e.id, startTime: e.startTime })));
  const rescheduleCounts = rescheduleTracking.trackAndGetCounts(allEvents);
  const eventsByApplicationId = groupEventsByApplicationId(schedules);

  const applicationIds = [...new Set(schedules.map((s) => s.applicationId).filter(Boolean))];
  // A schedule's own updatedAt as the change signal for application-info
  // caching below — the most recent one seen, if an applicationId has more
  // than one schedule (multiple interview rounds) in the lookback window.
  // See applicationInfoCache.js for why this (not the application's own
  // updatedAt, which Ashby doesn't expose anywhere cheaper than
  // application.info itself) is the signal used.
  const scheduleUpdatedAtByApplication = new Map();
  for (const s of schedules) {
    if (!s.applicationId) continue;
    const existing = scheduleUpdatedAtByApplication.get(s.applicationId);
    if (!existing || new Date(s.updatedAt) > new Date(existing)) {
      scheduleUpdatedAtByApplication.set(s.applicationId, s.updatedAt);
    }
  }

  const [fetchedApplications, interviewerLimits, debriefInterviewIds] = await Promise.all([
    fetchApplicationsById(applicationIds, scheduleUpdatedAtByApplication),
    // Every schedule, so a long-booked interview this week counts; the
    // lookback window's schedules if that read fails.
    scheduleSync.schedules().catch((err) => {
      console.warn("[ashby] reading every interview schedule failed; Interviewer Weekly Limits counts only the lookback window:", err.message);
      return schedules;
    }).then(listInterviewerLimits),
    fetchDebriefInterviewIds(),
  ]);
  const applications = summarizeApplications(fetchedApplications);
  const jobByApplicationId = jobsByApplication(fetchedApplications);
  // Depends on `applications` (to know which schedules are for still-Active
  // candidates), so it can't join the Promise.all above.
  let onsiteToday = await listOnsiteToday(schedules, applications);
  const readyToSchedule = require("./scheduling/ready-queue").readyQueue(schedules, applications);

  const now = Date.now();
  const todayPicked = todaysStartedEvents(schedules, now);
  // Titles are only needed to match NO_FEEDBACK_INTERVIEWS, and only for
  // events that could owe feedback; with the list empty this does nothing.
  if (config.noFeedbackInterviews.length) {
    await resolveInterviewTitles(
      schedules.flatMap((s) => (s.interviewEvents || []).filter((e) => e.endTime && feedbackOwers(e).length).map((e) => e.interviewId))
    );
  }
  let feedbackEntries = [];
  const feedbackCandidates = [];
  let schedulingEntries = [];
  let availabilitySubmitted = [];
  const rescheduledInterviews = [];

  for (const schedule of schedules) {
    const app = applications.get(schedule.applicationId);
    if (!app) continue; // not Active, or still in Application Review

    if (schedule.status === "NeedsScheduling") {
      const hoursPending = (now - new Date(schedule.createdAt).getTime()) / (1000 * 60 * 60);
      if (hoursPending >= config.needsSchedulingAlertHours) {
        schedulingEntries.push({
          ...app,
          scheduleId: schedule.id,
          createdAt: schedule.createdAt,
          hoursPending: Math.round(hoursPending),
          isStale: hoursPending >= config.staleSchedulingHours,
        });
      }
    } else if (schedule.status === "CandidateAvailabilitySubmitted") {
      // updatedAt is when the schedule last changed state — i.e. when the
      // candidate's submission landed, not when scheduling was first started.
      const hoursWaiting = (now - new Date(schedule.updatedAt).getTime()) / (1000 * 60 * 60);
      availabilitySubmitted.push({
        ...app,
        scheduleId: schedule.id,
        submittedAt: schedule.updatedAt,
        hoursWaiting: Math.round(hoursWaiting),
      });
    }

    for (const event of schedule.interviewEvents || []) {
      const rescheduleCount = rescheduleCounts.get(event.id) || 0;
      if (rescheduleCount > config.rescheduleCountThreshold) {
        rescheduledInterviews.push({
          ...app,
          scheduleId: schedule.id,
          interviewEventId: event.id,
          startTime: event.startTime,
          rescheduleCount,
          interviewers: (event.interviewers || []).map((i) => ({
            name: `${i.firstName || ""} ${i.lastName || ""}`.trim() || i.email,
            email: i.email,
          })),
        });
      }

      if (!event.endTime) continue;
      // Nobody owes a scorecard on a debrief, a NO_FEEDBACK_INTERVIEWS event,
      // or one whose people are all feedback-not-required (owersFor).
      const owers = owersFor(event, debriefInterviewIds);
      if (!owers.length) continue;
      if (isSupersededByLaterActivity(event, schedule.applicationId, eventsByApplicationId)) continue;
      // The application has already moved on to its current stage since this
      // interview ended — the scorecard gap is moot even though no later
      // interview EVENT has necessarily occurred yet (isSupersededByLaterActivity
      // above only catches that narrower case). Confirmed live: Profound's Tom
      // Gallagher had an outstanding Deep Dive (Jul 27) scorecard but entered
      // Onsite/Case Study on 2026-08-07, well after that event ended.
      // Guarded to schedule.interviewStageId !== app.currentStageId: an event
      // belonging to the application's CURRENT stage must never be suppressed
      // by this rule, even if currentStageEnteredAt is after the event's
      // endTime — otherwise a coordinator advancing the stage soon after an
      // interview (before its own feedback is in) would instantly hide that
      // interview's still-outstanding scorecard.
      if (
        schedule.interviewStageId !== app.currentStageId &&
        app.currentStageEnteredAt &&
        new Date(app.currentStageEnteredAt).getTime() > new Date(event.endTime).getTime()
      ) {
        continue;
      }
      const hoursOverdue = (now - new Date(event.endTime).getTime()) / (1000 * 60 * 60);
      if (hoursOverdue < config.feedbackOverdueHours) continue;

      // hasSubmittedFeedback is one flag for the whole EVENT and turns true
      // when anyone on it submits, so a flag-true event can still have a
      // required interviewer missing (see missingFeedbackOwers). Those are
      // held here and resolved per person below, after one
      // applicationFeedback.list per application involved. A flag-false
      // event needs no lookup: nobody has submitted, so every ower is missing.
      feedbackCandidates.push({ schedule, event, app, owers, hoursOverdue });
    }
  }

  // One applicationFeedback.list per application, shared by Feedback Overdue
  // and Interviews today: only where an event's flag says "in" (a flag-false
  // event has nobody in, so there's nothing to look up).
  const needsPerPersonCheck = [
    ...feedbackCandidates.filter((c) => c.event.hasSubmittedFeedback),
    ...todayPicked.filter((t) => t.ended && t.event.hasSubmittedFeedback && owersFor(t.event, debriefInterviewIds).length),
  ];
  const feedbackByApplication = await fetchFeedbackByApplication(
    [...new Set(needsPerPersonCheck.map((c) => c.schedule.applicationId))]
  );
  const rawApplicationsById = new Map(fetchedApplications.filter(Boolean).map((a) => [a.id, a]));
  const interviewsToday = buildInterviewsToday(todayPicked, rawApplicationsById, debriefInterviewIds, feedbackByApplication);
  for (const { schedule, event, app, owers, hoursOverdue } of feedbackCandidates) {
    let missing = owers;
    if (event.hasSubmittedFeedback) {
      const rows = feedbackByApplication.get(schedule.applicationId);
      if (!rows) continue; // couldn't check: keep the old reading (flag true = in)
      missing = missingFeedbackOwers(event, rows);
      if (!missing.length) continue;
    }
    // `interviewers` is exactly who still owes a scorecard: everyone not
    // marked isFeedbackRequired false (a missing value counts as required),
    // minus anyone credited with a scorecard for this event.
    feedbackEntries.push({
      ...app,
      scheduleId: schedule.id,
      interviewEventId: event.id,
      endTime: event.endTime,
      hoursOverdue: Math.round(hoursOverdue),
      interviewers: missing.map((i) => ({
        name: `${i.firstName || ""} ${i.lastName || ""}`.trim() || i.email,
        email: i.email,
      })),
      isStale: hoursOverdue >= config.staleFeedbackHours,
    });
  }

  // Collapse every candidate down to their single most recent event across
  // ALL FOUR lists (not just within one) — see the big comment on
  // listIssues() above. Everything else for that candidate this refresh is
  // dropped, not just hidden from one section.
  const winners = keepMostRecentPerCandidate([
    ...feedbackEntries.map((e) => ({ ...e, eventTime: new Date(e.endTime).getTime(), __section: "feedback" })),
    ...schedulingEntries.map((e) => ({ ...e, eventTime: new Date(e.createdAt).getTime(), __section: "scheduling" })),
    ...availabilitySubmitted.map((e) => ({ ...e, eventTime: new Date(e.submittedAt).getTime(), __section: "availability" })),
    ...onsiteToday.map((e) => ({ ...e, eventTime: new Date(e.startTime).getTime(), __section: "onsite" })),
  ]);
  const stripTag = ({ eventTime, __section, ...e }) => e;
  feedbackEntries = winners.filter((e) => e.__section === "feedback").map(stripTag);
  schedulingEntries = winners.filter((e) => e.__section === "scheduling").map(stripTag);
  availabilitySubmitted = winners.filter((e) => e.__section === "availability").map(stripTag);
  onsiteToday = winners.filter((e) => e.__section === "onsite").map(stripTag);

  // Stale rows stay in their own list, marked isStale (past
  // STALE_FEEDBACK_HOURS / STALE_SCHEDULING_HOURS). They used to be pulled
  // out into a separate Stale Candidates section, which kept them out of
  // the Action queue people actually work from; folded back in 2026-11-17.
  // After keepMostRecentPerCandidate there's one entry per candidate, so
  // nothing here can show a candidate twice.
  const feedbackOverdue = feedbackEntries;
  const needsScheduling = schedulingEntries;

  feedbackOverdue.sort((a, b) => b.hoursOverdue - a.hoursOverdue);
  needsScheduling.sort((a, b) => b.hoursPending - a.hoursPending);
  availabilitySubmitted.sort((a, b) => b.hoursWaiting - a.hoursWaiting);
  rescheduledInterviews.sort((a, b) => b.rescheduleCount - a.rescheduleCount);

  // Interviewer training tracker (TRAINING_TRACKER_CLIENT_ID only). Computed
  // here, inside listIssues, rather than as its own SECTION_GROUPS entry
  // specifically so it reuses the `schedules` and `jobByApplicationId` above
  // instead of paginating interviewSchedule.list a second time - that call is
  // the single most expensive thing in a refresh cycle (2,245 schedules over
  // 30 days at Forus).
  //
  // Wrapped in its own try/catch because this section is a passenger on a
  // fetch that eight other sections depend on. A bug in the training rules
  // must degrade to "no training data" rather than take the whole
  // schedule-driven group down with it.
  let training = {};
  if (config.trainingTrackerEnabled) {
    try {
      training = await require("./training/compute").build({
        schedules,
        jobByApplicationId,
        ashbyNativeTraining: options.ashbyNativeTraining,
        fetchInterview: async (id) => (await ashbyPost("interview.info", { id })).results,
        stalledAfterDays: config.trainingStalledAfterDays,
      });
    } catch (err) {
      console.warn("[training] compute failed, serving no training data this cycle:", err.message);
    }
  }

  return {
    readyToSchedule,
    feedbackOverdue,
    needsScheduling,
    interviewerLimits,
    availabilitySubmitted,
    onsiteToday,
    interviewsToday,
    rescheduledInterviews,
    ...training,
  };
}

/**
 * The feedback leaderboard (Feedback tab) — rules in feedback-leaderboard.js.
 * Its own SECTION_GROUPS entry in issues.js, so a failure here never touches
 * the Dashboard tab. Per refresh, after the first: one schedule sync call
 * (shared with Interviewer Weekly Limits), one scorecard sync call, a cached
 * user.list, one interview.list for debriefs, and interview.info only for
 * interviews never seen before (and only with NO_FEEDBACK_INTERVIEWS set).
 * The first refresh on a fresh volume reads every scorecard in the window
 * (Forus: about 60 pages, one at a time); after that the sync state is kept
 * on the volume (syncStateFile.js), so a redeploy doesn't repeat it.
 *
 * Who has left: listUsers() returns only enabled Ashby users, so anyone not
 * in it is excluded. If user.list fails this throws, and issues.js keeps the
 * last good leaderboard rather than showing one that might rank a leaver.
 */
async function listFeedbackLeaderboard() {
  const [schedules, scorecards, users, debriefInterviewIds] = await Promise.all([
    scheduleSync.schedules(),
    feedbackSync.scorecards(),
    listUsers(),
    fetchDebriefInterviewIds(),
  ]);
  const now = Date.now();
  const windowStart = now - config.feedbackLeaderboardDays * 24 * 60 * 60 * 1000;
  if (config.noFeedbackInterviews.length) {
    await resolveInterviewTitles(
      schedules.flatMap((s) => (s.interviewEvents || []).filter((e) => Date.parse(e.endTime) >= windowStart).map((e) => e.interviewId))
    );
  }
  return buildLeaderboard({
    schedules,
    scorecards,
    enabledUserIds: new Set(users.map((u) => u.id)),
    owersFor: (event) => owersFor(event, debriefInterviewIds),
    now,
    days: config.feedbackLeaderboardDays,
    minInterviews: config.feedbackLeaderboardMinInterviews,
    dueAfterHours: config.feedbackOverdueHours,
  });
}

// Classify an application's source into "Referral" / "Agency", or null if
// it's neither. Matches on the sourceType title rather than a hardcoded id,
// via config.sourceReferralKeywords/sourceAgencyKeywords substrings — every
// Ashby org names its source types differently (this org, for example, uses
// "Referral", "Agencies", "Sourced", "Inbound", "Internal", "Prospecting",
// "Third-party boards"); verify a new client's real source.list before
// trusting the defaults (see scripts/check-ashby-compatibility.js).
function classifySource(app) {
  const title = ((app.source || {}).sourceType || {}).title || "";
  const lower = title.toLowerCase();
  if (config.sourceReferralKeywords.some((k) => lower.includes(k))) return "Referral";
  if (config.sourceAgencyKeywords.some((k) => lower.includes(k))) return "Agency";
  return null;
}

/**
 * Applications CREATED in the last SOURCED_LOOKBACK_DAYS whose source is a
 * referral or an agency. Unlike the rest of the dashboard this is
 * application-creation-driven, not schedule-driven — a candidate referred or
 * agency-submitted three days ago almost certainly hasn't interviewed yet, so
 * the schedule-based path would never surface them. `application.list` already
 * carries the candidate, job, status, and source, so no per-application
 * lookup is needed. All statuses are included (Active/Archived/Hired/Lead) —
 * this section is purely about who came in via referral/agency recently, and
 * the status is shown on each card.
 */
async function listRecentSourced() {
  const createdAfter = Date.now() - config.sourcedLookbackDays * 24 * 60 * 60 * 1000;
  const apps = await fetchAllPages("application.list", { limit: 100, createdAfter });

  const results = [];
  for (const app of apps) {
    const sourceCategory = classifySource(app);
    if (!sourceCategory) continue;

    const candidate = app.candidate || {};
    const recruiter = hiringTeamMember(app, config.recruiterRoleName);
    const coordinator = hiringTeamMember(app, config.coordinatorRoleName);
    results.push({
      applicationId: app.id,
      candidateId: candidate.id,
      candidateName: candidate.name,
      jobTitle: (app.job && app.job.title) || "Unknown role",
      jobId: (app.job && app.job.id) || null,
      departmentId: (app.job && app.job.departmentId) || null,
      recruiterId: recruiter && recruiter.id,
      recruiterName: recruiter && recruiter.name,
      coordinatorId: coordinator && coordinator.id,
      coordinatorName: coordinator && coordinator.name,
      status: app.status,
      sourceCategory, // "Referral" | "Agency"
      sourceTitle: (app.source || {}).title, // e.g. "Candidate Labs", "Referral Link"
      createdAt: app.createdAt,
      // Only link Active applications: the profile URL hardcodes the "active"
      // pipeline segment, which is unverified for Archived/Hired/Lead. Better
      // to show those as plain text than ship a link we suspect 404s.
      ashbyProfileUrl: app.status === "Active" ? profileUrl(candidate.id, app.id) : undefined,
    });
  }

  results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return results;
}

// Ashby's real offerProcessStatus enum (confirmed via API docs — a
// structural field, not org-configured naming, so unlike source/onsite
// keywords this needs no per-client tuning). The three "WaitingOnApproval*"
// values all mean the offer has been CREATED but has never reached the
// candidate — it's still working through this org's internal approval chain
// (which may not even be configured, in which case WaitingOnApprovalDefinition
// is the one that shows). Confirmed no other offerStatus value could leak
// into this bucket: WaitingOnCandidateResponse/CandidateAccepted/
// CandidateRejected all mean the candidate has been sent something, and
// OfferCancelled (ambiguous — could be pre- or post-send) isn't included
// here at all, so it can't leak in either way. Also checked live for the
// revision-loop case (an offer edited/re-approved after already reaching the
// candidate looping back into one of these three) — an offer observed
// mid-build going WaitingOnApprovalDefinition -> WaitingOnOfferApproval
// across a new version kept `acceptanceStatus: "Created"` throughout (never
// "Pending", which is what Ashby uses once a candidate is actually awaiting
// a decision), consistent with these three states being strictly pre-send.
// Ashby's docs don't explicitly rule out a revert case, but there's no
// evidence of one and each state's own description precludes it.
// Kept as their own section (Offers Not Yet Sent) rather than folded into
// "awaiting acceptance," per product decision: an offer a candidate has
// never seen isn't something they could be "awaiting acceptance" on.
const OFFER_NOT_YET_SENT_STATUSES = ["WaitingOnApprovalStart", "WaitingOnOfferApproval", "WaitingOnApprovalDefinition"];

/**
 * Three offer-pipeline sections:
 * - offersNotYetSent: offerStatus is one of OFFER_NOT_YET_SENT_STATUSES
 *   above — the offer has been created but never reached the candidate
 *   (still working through internal approval, if this org uses that at all).
 * - offersAwaitingAcceptance: offerStatus === "WaitingOnCandidateResponse" —
 *   the offer has actually been extended; waiting on the candidate's decision.
 * - offersSigned: offerStatus === "CandidateAccepted" (Ashby's closest real
 *   signal to "signed" — there's no separate e-signature timestamp exposed;
 *   `fileHandles` on the offer version is where a signed PDF would appear,
 *   but carries no date of its own) with `decidedAt` (when that acceptance
 *   decision landed) within `config.offersSignedLookbackDays` days.
 *
 * Unlike application.list/interviewSchedule.list, offer.list has no
 * createdAfter filter, so every refresh walks every offer this org has ever
 * created. That's fine here even though the equivalent full scan is exactly
 * what was too slow for applications (see § Scope in README): offer.list
 * itself is cheap (no per-item lookup, same shape as departments/interview
 * definitions), and the expensive part — one application.info call per
 * applicationId — only runs for the applicationIds actually in one of the
 * three buckets above, which at any moment is a small, current-activity-sized
 * set regardless of how many historical offers the org has accumulated.
 */
async function listOffers() {
  const offers = await fetchAllPages("offer.list", { limit: 100 });

  const now = Date.now();
  const signedCutoffMs = now - config.offersSignedLookbackDays * 24 * 60 * 60 * 1000;

  const notYetSentOffers = offers.filter((o) => OFFER_NOT_YET_SENT_STATUSES.includes(o.offerStatus));
  const awaitingOffers = offers.filter((o) => o.offerStatus === "WaitingOnCandidateResponse");
  const signedOffers = offers.filter(
    (o) => o.offerStatus === "CandidateAccepted" && o.decidedAt && new Date(o.decidedAt).getTime() >= signedCutoffMs
  );

  const relevantOffers = [...notYetSentOffers, ...awaitingOffers, ...signedOffers];
  const applicationIds = [...new Set(relevantOffers.map((o) => o.applicationId).filter(Boolean))];
  // Change signal for application-info caching (see applicationInfoCache.js)
  // — offers have no updatedAt of their own, so this composes the fields
  // that actually change over an offer's life (status, latest version's
  // creation, and when/if it was decided). If more than one relevant offer
  // somehow references the same applicationId, the last one wins; vanishingly
  // rare and harmless either way (worst case: one extra application.info call).
  const offerSignatureByApplication = new Map();
  for (const o of relevantOffers) {
    if (!o.applicationId) continue;
    const version = o.latestVersion || {};
    offerSignatureByApplication.set(o.applicationId, `${o.offerStatus}|${version.createdAt || ""}|${o.decidedAt || ""}`);
  }
  const applications = await fetchOfferApplications(applicationIds, offerSignatureByApplication);

  const toEntry = (offer) => {
    const app = applications.get(offer.applicationId);
    if (!app) return null;
    const version = offer.latestVersion || {};
    return {
      ...app,
      offerId: offer.id,
      startDate: version.startDate,
      // Ashby has no sentAt/extendedAt/deliveredAt field anywhere on the
      // offer or its versions (confirmed against the full offer.info schema)
      // — this is purely when the current version was authored. For
      // offersAwaitingAcceptance/offersSigned this is a reasonable proxy for
      // "roughly when it went out" (versions are normally created right
      // before being sent). For offersNotYetSent it's honestly just
      // "created," not "sent" — nothing has gone out yet, which is the
      // whole point of that section.
      versionCreatedAt: version.createdAt,
      decidedAt: offer.decidedAt,
    };
  };

  const offersNotYetSent = notYetSentOffers.map(toEntry).filter(Boolean);
  // Ashby's offerStatus can lag the application's real outcome — an offer
  // can still read "WaitingOnCandidateResponse" after the application has
  // already been marked Hired (candidate accepted some other way, e.g. a
  // verbal/manual update) or Archived (candidate pulled out, offer
  // rescinded, etc.) without the offer object itself ever being updated to
  // match. Confirmed live: both statuses show up here in practice. Neither
  // is actually "awaiting" anything at that point, so exclude them.
  const offersAwaitingAcceptance = awaitingOffers
    .map(toEntry)
    .filter(Boolean)
    .filter((e) => e.status !== "Hired" && e.status !== "Archived");
  const offersSigned = signedOffers.map(toEntry).filter(Boolean);

  // Oldest-first for the two pending buckets (longest-waiting is most
  // urgent); most-recent-first for signed (a "recently signed" list reads
  // naturally newest-on-top).
  offersNotYetSent.sort((a, b) => new Date(a.versionCreatedAt).getTime() - new Date(b.versionCreatedAt).getTime());
  offersAwaitingAcceptance.sort((a, b) => new Date(a.versionCreatedAt).getTime() - new Date(b.versionCreatedAt).getTime());
  offersSigned.sort((a, b) => new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime());

  return { offersNotYetSent, offersAwaitingAcceptance, offersSigned };
}

/**
 * All departments (including archived ones) as { id, name, isArchived,
 * createdAt } — used as the id-to-name lookup for the department filter
 * (see collectDistinctDepartments() in public/app.js, which decides which
 * of these are actually offered as options) and to resolve each candidate
 * record's `departmentId` to a human name. Small, cheap, no pagination:
 * this org has 12 total (10 active + 2 archived). `includeArchived: true`
 * matters — without it, a job whose department was later archived would
 * resolve to nothing and show as blank in the filter.
 *
 * `isArchived`/`createdAt` exist because Ashby orgs can end up with two
 * departments sharing the same `name` (e.g. one archived and recreated, or
 * two genuinely distinct active departments that happen to be named the
 * same) — the frontend needs both fields to tell those apart in the
 * dropdown instead of silently merging distinct department IDs.
 */
async function listDepartments() {
  const json = await ashbyPost("department.list", { includeArchived: true });
  return (json.results || []).map((d) => ({
    id: d.id,
    name: d.name,
    isArchived: Boolean(d.isArchived),
    createdAt: d.createdAt,
  }));
}

/**
 * Current interviewer-training status: every trainee currently enrolled in
 * a pool's training path, their stage (Shadow/ReverseShadow — real Ashby
 * enum values via interviewerPool.trainingPath.trainingStages, not a
 * naming-convention guess like Onsite Interviews Today's stage-title
 * matching), and their progress (interviewsCompleted vs. that stage's
 * interviewsRequired). Not tied to any candidate/application — this is
 * purely about interviewer readiness.
 *
 * interviewerPool.list is cheap (paginated, but small — 22 pools on this
 * org). interviewerPool.info (one call per pool with an enabled
 * trainingPath) returns that pool's trainees directly, no per-trainee
 * lookup needed — bounded, concurrency-limited, same shape as
 * listInterviewerLimits' per-user calls.
 *
 */
async function listInterviewerTraining() {
  const pools = await fetchAllPages("interviewerPool.list", { limit: 100 });
  const trainablePools = pools.filter((p) => p.trainingPath && p.trainingPath.enabled);
  if (!trainablePools.length) return [];

  const poolDetails = (
    await mapWithConcurrency(trainablePools, 8, async (pool) => {
      try {
        const json = await ashbyPost("interviewerPool.info", { interviewerPoolId: pool.id });
        return json.results;
      } catch (err) {
        console.warn(`[ashby] interviewerPool.info failed for ${pool.id}:`, err.message);
        return null;
      }
    })
  ).filter(Boolean);

  const entries = [];
  for (const pool of poolDetails) {
    const stagesById = new Map(((pool.trainingPath || {}).trainingStages || []).map((s) => [s.id, s]));
    for (const trainee of pool.trainees || []) {
      const progress = trainee.currentProgress;
      if (!progress) continue;
      const stage = stagesById.get(progress.trainingPathStageId);
      if (!stage) continue;

      entries.push({
        userId: trainee.id,
        interviewerName: `${trainee.firstName || ""} ${trainee.lastName || ""}`.trim() || trainee.email,
        poolTitle: pool.title,
        stageRole: stage.interviewerRole, // "Shadow" | "ReverseShadow"
        interviewsCompleted: progress.interviewsCompleted || 0,
        interviewsRequired: stage.interviewsRequired,
        isPaused: Boolean(trainee.isPaused),
      });
    }
  }

  // Paused trainees (blocked, needs a nudge) surface first; otherwise
  // alphabetical by name so the list doesn't reshuffle on every refresh.
  entries.sort((a, b) => {
    if (a.isPaused !== b.isPaused) return a.isPaused ? -1 : 1;
    return a.interviewerName.localeCompare(b.interviewerName);
  });
  return entries;
}

// Active Ashby users, for the training tracker's enrolment picker. Cached
// in memory for an hour: the picker is opened by hand a handful of times a
// day, and an org's user list changes far more slowly than that. Not
// persisted like the interview-title cache - a restart re-fetching one
// paginated call is cheap, and a stale user list is more annoying than a
// stale interview title (a new joiner needs to be enrollable today).
let userListCache = { users: null, fetchedAt: 0 };
const USER_LIST_MAX_AGE_MS = 60 * 60 * 1000;

async function listUsers() {
  if (userListCache.users && Date.now() - userListCache.fetchedAt < USER_LIST_MAX_AGE_MS) {
    return userListCache.users;
  }
  const raw = await fetchAllPages("user.list", { limit: 100 });
  const users = raw
    .filter((u) => u && u.isEnabled !== false)
    .map((u) => ({
      id: u.id,
      name: `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email,
      email: u.email || "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  userListCache = { users, fetchedAt: Date.now() };
  return users;
}

/**
 * Interviewer load for the calendar-checked proposal (scheduling-rules
 * interviewerLoad, booking-routes.js): each person's interviews per week,
 * Monday to Sunday in `timeZone`, over every schedule that isn't cancelled
 * (scheduleSync), leaving out `excludeScheduleIds` (the schedule being
 * booked). Only places where the person gives feedback count, never a debrief,
 * and never a session whose title `countsTitle` refuses (Lunch).
 * `feedbackFor(interviewId, userId)`: whether that person gave feedback the
 * last time that interview was booked (null if it never was), for the
 * proposal's own sessions.
 */
async function interviewerLoad({ timeZone, countsTitle = () => true, excludeScheduleIds = [] }) {
  const [schedules, interviews] = await Promise.all([scheduleSync.schedules(), fetchAllPages("interview.list", { limit: 100 })]);
  const byId = new Map(interviews.map((i) => [i.id, i]));
  const rows = countInterviewLoad(schedules, {
    timeZone,
    excludeScheduleIds,
    counts: (event, interviewer) => {
      const interview = byId.get(event.interviewId);
      return interviewer.isFeedbackRequired !== false && !interview?.isDebrief && countsTitle(interview?.title ?? "");
    },
  });
  return {
    weeks: Object.fromEntries([...rows].map(([userId, row]) => [userId, Object.fromEntries(row.weeks)])),
    feedbackFor: (interviewId, userId) => scheduleSync.feedbackHistory(interviewId, userId),
  };
}

module.exports = {
  interviewerLoad,
  countInterviewsThisWeek,
  listIssues,
  listUsers,
  listRecentSourced,
  listDepartments,
  listInterviewerTraining,
  listOffers,
  listFeedbackLeaderboard,
  getApiCallCount,
  getApiCallCountByEndpoint,
  feedbackOwers,
  missingFeedbackOwers,
  owersFor,
  buildInterviewsToday,
};
