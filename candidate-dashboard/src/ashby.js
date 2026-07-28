"use strict";

const config = require("./config");
const { mapWithConcurrency } = require("./concurrency");

function authHeader() {
  return `Basic ${Buffer.from(`${config.ashbyApiKey}:`).toString("base64")}`;
}

// A single rate-limited request (whether it's one page of a multi-page
// pagination walk, or a one-off lookup like user.interviewerSettings)
// retries with exponential backoff instead of throwing immediately — without
// this, a 429 mid-pagination would abort the entire fetchAllPages() walk
// (and therefore the whole refresh cycle) rather than just slowing down.
// Honors a Retry-After header when Ashby sends one; otherwise doubles the
// delay each attempt. Gives up once *cumulative* waiting would exceed
// RATE_LIMIT_MAX_TOTAL_BACKOFF_MS, at which point it throws like before and
// the caller's own error handling takes over (fetchApplicationSummaries/
// listInterviewerLimits already skip a single failed item; fetchAllPages
// still propagates, same as a non-429 failure always has).
const RATE_LIMIT_MAX_TOTAL_BACKOFF_MS = 4 * 60 * 1000;
const RATE_LIMIT_INITIAL_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ashbyPost(endpoint, body) {
  let attempt = 0;
  let totalWaitedMs = 0;

  for (;;) {
    const res = await fetch(`https://api.ashbyhq.com/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: authHeader() },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      const retryAfterSeconds = parseInt(res.headers.get("retry-after"), 10);
      const backoffMs =
        !Number.isNaN(retryAfterSeconds) && retryAfterSeconds >= 0
          ? Math.max(retryAfterSeconds * 1000, 250)
          : RATE_LIMIT_INITIAL_DELAY_MS * 2 ** attempt;

      if (totalWaitedMs + backoffMs > RATE_LIMIT_MAX_TOTAL_BACKOFF_MS) {
        throw new Error(`${endpoint} -> HTTP 429 (gave up after ${Math.round(totalWaitedMs / 1000)}s of retries)`);
      }

      attempt += 1;
      totalWaitedMs += backoffMs;
      console.warn(`[ashby] ${endpoint} rate-limited (429), waiting ${Math.round(backoffMs / 1000)}s before retry ${attempt}`);
      await sleep(backoffMs);
      continue;
    }

    if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status}`);
    const json = await res.json();
    if (json.success === false) throw new Error(`${endpoint} -> ${JSON.stringify(json.errors || json)}`);
    return json;
  }
}

// Ashby responses are { success, results, moreDataAvailable, nextCursor }, and
// once pagination reaches the last page also { syncToken } — a checkpoint you
// can pass back in a later call to fetch only what's changed since. This
// walks every page and concatenates `results`. Optional `stats` object
// collects { pages, networkMs, syncToken } for callers that want a timing
// breakdown and/or the final syncToken. Optional `onPage(pageResults,
// nextCursor)` runs after each page — used by referralCache.js to checkpoint
// progress to disk as it goes, so a long scan can resume rather than restart
// from page 1 after a crash/restart.
//
// To RESUME a walk from a previously-saved cursor, just include `cursor` in
// `baseBody` yourself — the loop's own `cursor` (below) starts undefined, so
// the first request is sent as `baseBody` verbatim (cursor and all), and every
// request after that overwrites it with the freshly-received one.
async function fetchAllPages(endpoint, baseBody, stats, onPage) {
  const all = [];
  let cursor;
  for (;;) {
    const pageStart = Date.now();
    const json = await ashbyPost(endpoint, cursor ? { ...baseBody, cursor } : baseBody);
    if (stats) {
      stats.pages = (stats.pages || 0) + 1;
      stats.networkMs = (stats.networkMs || 0) + (Date.now() - pageStart);
      if (json.syncToken) stats.syncToken = json.syncToken;
    }
    const results = json.results || [];
    all.push(...results);
    if (onPage) await onPage(results, json.nextCursor || null);
    if (!json.moreDataAvailable || !json.nextCursor) break;
    cursor = json.nextCursor;
  }
  return all;
}

// Ashby's candidate-feed URL needs both the candidate id and the application
// id, plus a pipeline-view segment ("active" here). Every caller of this
// function today is guaranteed Active status by the filter in
// fetchApplicationSummaries below, so "active" is always correct in
// practice — this hasn't been verified for Hired/Archived/Lead candidates,
// which this dashboard never links to.
function profileUrl(candidateId, applicationId) {
  if (!candidateId || !applicationId) return undefined;
  return (
    `${config.ashbyAppBaseUrl}/candidates/pipeline/active/right-side` +
    `/candidates/${candidateId}/applications/${applicationId}/feed`
  );
}

// Application-review-stage applications haven't been engaged with yet — no
// interview has happened, no email back-and-forth is expected. Excluded per
// product decision: this dashboard is for candidates actively moving through
// the pipeline, not the top-of-funnel application backlog (which, in this
// org, is the overwhelming majority of "Active" applications).
function isPreInterview(app) {
  return (app.currentInterviewStage || {}).type === "PreInterviewScreen";
}

/**
 * Looks up full application details (candidate, job, status, stage) only for
 * the given applicationIds — not a scan of every active application. Filters
 * out anything no longer Active or still sitting in Application Review.
 */
async function fetchApplicationSummaries(applicationIds) {
  const fetched = await mapWithConcurrency(applicationIds, 8, async (id) => {
    try {
      const json = await ashbyPost("application.info", { applicationId: id });
      return json.results;
    } catch (err) {
      console.warn(`[ashby] application.info failed for ${id}:`, err.message);
      return null;
    }
  });

  const byId = new Map();
  for (const app of fetched) {
    if (!app || app.status !== "Active" || isPreInterview(app)) continue;
    const candidate = app.candidate || {};
    byId.set(app.id, {
      applicationId: app.id,
      candidateId: candidate.id,
      candidateName: candidate.name,
      candidateEmail: candidate.primaryEmailAddress && candidate.primaryEmailAddress.value,
      jobTitle: (app.job && app.job.title) || "Unknown role",
      jobId: (app.job && app.job.id) || null,
      departmentId: (app.job && app.job.departmentId) || null,
      ashbyProfileUrl: profileUrl(candidate.id, app.id),
    });
  }
  return byId;
}

// Interview schedules created more than this long ago and still unresolved
// are treated as stale pipeline debris rather than live coordinator work.
// Bound chosen to keep each refresh cycle fast on orgs with heavy interview
// volume — see README for the tradeoff.
const SCHEDULE_LOOKBACK_DAYS = 30;

// Monday 00:00 UTC of the week containing `date`.
function startOfWeekUTC(date) {
  const daysSinceMonday = (date.getUTCDay() + 6) % 7; // getUTCDay: 0=Sun..6=Sat
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday));
}

/**
 * Counts interviews per interviewer for the current calendar week (Mon–Sun
 * UTC), from the same `schedules` already fetched for listIssues() — no
 * extra Ashby call. Cancelled schedules don't count toward load. Note this
 * inherits the same SCHEDULE_LOOKBACK_DAYS bound: an interview booked more
 * than 30 days ago for a slot this week wouldn't be counted.
 */
function countInterviewsThisWeek(schedules) {
  const now = new Date();
  const weekStart = startOfWeekUTC(now).getTime();
  const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;

  const byInterviewer = new Map();

  for (const schedule of schedules) {
    if (schedule.status === "Cancelled") continue;

    for (const event of schedule.interviewEvents || []) {
      if (!event.startTime) continue;
      const start = new Date(event.startTime).getTime();
      if (start < weekStart || start >= weekEnd) continue;

      for (const interviewer of event.interviewers || []) {
        if (!interviewer.id) continue;
        const existing = byInterviewer.get(interviewer.id) || {
          userId: interviewer.id,
          name: `${interviewer.firstName || ""} ${interviewer.lastName || ""}`.trim() || interviewer.email,
          email: interviewer.email,
          scheduledCount: 0,
        };
        existing.scheduledCount += 1;
        byInterviewer.set(interviewer.id, existing);
      }
    }
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

  const settingsById = new Map(
    (
      await mapWithConcurrency([...counts.keys()], 8, async (userId) => {
        try {
          const json = await ashbyPost("user.interviewerSettings", { userId });
          return [userId, json.results];
        } catch (err) {
          console.warn(`[ashby] user.interviewerSettings failed for ${userId}:`, err.message);
          return null;
        }
      })
    ).filter(Boolean)
  );

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
 * Everything is driven off recent interview schedules rather than a full
 * active-application scan (this org has 1,600+ active applications, almost
 * all sitting untouched in Application Review — paginating all of them took
 * minutes and mostly produced records this dashboard doesn't care about).
 *
 * Returns:
 * - feedbackOverdue: interview events that ended > FEEDBACK_OVERDUE_HOURS ago
 *   with no submitted feedback.
 * - needsScheduling: schedules stuck in Ashby's "NeedsScheduling" status,
 *   aged past NEEDS_SCHEDULING_ALERT_HOURS — nothing has been sent to the
 *   candidate yet. Distinct from availabilitySubmitted below; see README.
 * - availabilitySubmitted: schedules in Ashby's "CandidateAvailabilitySubmitted"
 *   status — the candidate replied with their times, waiting on someone to
 *   book it. Shown regardless of age (not threshold-gated like the other
 *   lists); AVAILABILITY_SUBMITTED_ALERT_HOURS only drives severity coloring.
 * - staleCandidates: candidates far enough past either threshold
 *   (STALE_FEEDBACK_HOURS / STALE_SCHEDULING_HOURS) that they're pulled out
 *   of the two lists above into their own section — these have likely fallen
 *   through the cracks rather than just being freshly overdue. This is a
 *   candidate-level exclusion: if ANY of a candidate's schedules/events is
 *   stale, none of their entries appear in feedbackOverdue/needsScheduling,
 *   even a separate event for the same candidate that's below the stale bar.
 * - interviewerLimits: interviewers at or nearing their Ashby-configured
 *   weekly interview limit for the current calendar week — see
 *   listInterviewerLimits above. Independent of application status; an
 *   interviewer's load counts regardless of whether their candidates are
 *   Active, Hired, or Archived.
 * - onsiteToday: today's panel/final-round interview events — see
 *   listOnsiteToday above for how "onsite" is approximated (Ashby has no
 *   real signal for it in this org).
 */
// A recruiting coordinator's day-of prep list. Ashby has no per-interview
// "onsite" flag anywhere in this org — checked interviewEvents,
// interview.info, interviewStage.info, and all 38 org custom fields; none
// carry a location/format signal, and no stage/interview title says
// "onsite" either. Per explicit product decision, "onsite" is approximated
// by interview STAGE title containing "panel" or "final" (case-insensitive)
// — this org's actual onsite rounds, even though Ashby doesn't structurally
// say so. "Today" is a UTC calendar day, the same tradeoff
// countInterviewsThisWeek already makes for "this week" (see above) —
// display times still render in the browser's local zone client-side, only
// the day boundary is computed in UTC here.
const ONSITE_STAGE_TITLE_PATTERN = /panel|final/i;

function isTodayUTC(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

/**
 * Today's panel/final-round interview events for still-Active candidates.
 * Reuses the same `schedules`/`applications` listIssues() already computed
 * — no extra pagination call — except for resolving each involved
 * schedule's interviewStageId to a title, which interviewSchedule.list
 * doesn't include directly. Stage IDs are heavily reused across schedules
 * (most orgs have a handful of stages), so this is a small, cheap,
 * concurrency-limited, per-unique-stage-id lookup, not one per schedule.
 */
async function listOnsiteToday(schedules, applications) {
  const candidates = schedules.filter(
    (s) =>
      applications.has(s.applicationId) &&
      (s.interviewEvents || []).some((e) => e.startTime && isTodayUTC(e.startTime))
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
    if (!stageTitle || !ONSITE_STAGE_TITLE_PATTERN.test(stageTitle)) continue;

    const app = applications.get(schedule.applicationId);
    for (const event of schedule.interviewEvents || []) {
      if (!event.startTime || !isTodayUTC(event.startTime)) continue;
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

async function listIssues() {
  const createdAfter = Date.now() - SCHEDULE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const schedules = await fetchAllPages("interviewSchedule.list", { limit: 100, createdAfter });

  const applicationIds = [...new Set(schedules.map((s) => s.applicationId).filter(Boolean))];
  const [applications, interviewerLimits] = await Promise.all([
    fetchApplicationSummaries(applicationIds),
    listInterviewerLimits(schedules),
  ]);
  // Depends on `applications` (to know which schedules are for still-Active
  // candidates), so it can't join the Promise.all above.
  const onsiteToday = await listOnsiteToday(schedules, applications);

  const now = Date.now();
  const feedbackEntries = [];
  const schedulingEntries = [];
  const availabilitySubmitted = [];

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
      if (event.hasSubmittedFeedback || !event.endTime) continue;
      const hoursOverdue = (now - new Date(event.endTime).getTime()) / (1000 * 60 * 60);
      if (hoursOverdue < config.feedbackOverdueHours) continue;

      feedbackEntries.push({
        ...app,
        scheduleId: schedule.id,
        interviewEventId: event.id,
        endTime: event.endTime,
        hoursOverdue: Math.round(hoursOverdue),
        interviewers: (event.interviewers || []).map((i) => ({
          name: `${i.firstName || ""} ${i.lastName || ""}`.trim() || i.email,
          email: i.email,
        })),
        isStale: hoursOverdue >= config.staleFeedbackHours,
      });
    }
  }

  // Candidate-level: once any entry for an applicationId is stale, that
  // candidate is excluded entirely from the two regular lists below.
  const staleApplicationIds = new Set(
    [...feedbackEntries, ...schedulingEntries].filter((e) => e.isStale).map((e) => e.applicationId)
  );

  const staleCandidates = [
    ...feedbackEntries
      .filter((e) => e.isStale)
      .map(({ isStale, ...e }) => ({ ...e, reason: "feedbackOverdue", reasonLabel: "Feedback overdue", hoursStale: e.hoursOverdue })),
    ...schedulingEntries
      .filter((e) => e.isStale)
      .map(({ isStale, ...e }) => ({ ...e, reason: "needsScheduling", reasonLabel: "Needs scheduling", hoursStale: e.hoursPending })),
  ];

  const feedbackOverdue = feedbackEntries
    .filter((e) => !e.isStale && !staleApplicationIds.has(e.applicationId))
    .map(({ isStale, ...e }) => e);
  const needsScheduling = schedulingEntries
    .filter((e) => !e.isStale && !staleApplicationIds.has(e.applicationId))
    .map(({ isStale, ...e }) => e);

  feedbackOverdue.sort((a, b) => b.hoursOverdue - a.hoursOverdue);
  needsScheduling.sort((a, b) => b.hoursPending - a.hoursPending);
  staleCandidates.sort((a, b) => b.hoursStale - a.hoursStale);
  availabilitySubmitted.sort((a, b) => b.hoursWaiting - a.hoursWaiting);

  return { feedbackOverdue, needsScheduling, staleCandidates, interviewerLimits, availabilitySubmitted, onsiteToday };
}

// Classify an application's source into "Referral" / "Agency", or null if it's
// neither. Matches on the sourceType title rather than a hardcoded id, and
// uses substrings so slightly different wording ("Agencies" vs "Agency")
// still resolves. Source titles in this org: "Referral", "Agencies",
// "Sourced", "Inbound", "Internal", "Prospecting", "Third-party boards".
function classifySource(app) {
  const title = ((app.source || {}).sourceType || {}).title || "";
  const lower = title.toLowerCase();
  if (lower.includes("referr")) return "Referral";
  if (lower.includes("agenc")) return "Agency";
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
    results.push({
      applicationId: app.id,
      candidateId: candidate.id,
      candidateName: candidate.name,
      jobTitle: (app.job && app.job.title) || "Unknown role",
      jobId: (app.job && app.job.id) || null,
      departmentId: (app.job && app.job.departmentId) || null,
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

/**
 * All departments (including archived ones) as { id, name } — used to build
 * the department filter dropdown and to resolve each candidate record's
 * `departmentId` to a human name. Small, cheap, no pagination: this org has
 * 12 total (10 active + 2 archived). `includeArchived: true` matters —
 * without it, a job whose department was later archived would resolve to
 * nothing and show as blank in the filter.
 */
async function listDepartments() {
  const json = await ashbyPost("department.list", { includeArchived: true });
  return (json.results || []).map((d) => ({ id: d.id, name: d.name }));
}

// Active Referrals (every active referral candidate org-wide, by pipeline
// stage) used to be computed here via a listActiveReferrals() full scan.
// It's now owned entirely by referralCache.js, which does the same scan
// once (measured: 718s pagination, negligible client-side filtering — see
// README § Scope) but persists a syncToken so subsequent refreshes are
// incremental instead of repeating the full scan every time, and runs on
// its own timer so that cost never blocks the seven sections above. See
// referralCache.js for fullScan()/incrementalSync(); it reuses this file's
// fetchAllPages/classifySource/profileUrl, exported below.

module.exports = {
  listIssues,
  listRecentSourced,
  listDepartments,
  // Exported for referralCache.js, which needs these same low-level
  // primitives for its full-scan and incremental-sync logic.
  fetchAllPages,
  classifySource,
  profileUrl,
};
