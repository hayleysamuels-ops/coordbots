"use strict";

const config = require("./config");
const { mapWithConcurrency } = require("./concurrency");
const rescheduleTracking = require("./rescheduleTracking");

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
    const recruiter = hiringTeamMember(app, config.recruiterRoleName);
    const coordinator = hiringTeamMember(app, config.coordinatorRoleName);
    byId.set(app.id, {
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
      ashbyProfileUrl: profileUrl(candidate.id, app.id),
    });
  }
  return byId;
}

// Monday 00:00 UTC of the week containing `date`.
function startOfWeekUTC(date) {
  const daysSinceMonday = (date.getUTCDay() + 6) % 7; // getUTCDay: 0=Sun..6=Sat
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday));
}

/**
 * Counts interviews per interviewer for the current calendar week (Mon–Sun
 * UTC), from the same `schedules` already fetched for listIssues() — no
 * extra Ashby call. Cancelled schedules don't count toward load. Note this
 * inherits the same `config.scheduleLookbackDays` bound: an interview booked
 * further back than that for a slot this week wouldn't be counted.
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
 * - rescheduledInterviews: interview events whose tracked reschedule count
 *   exceeds RESCHEDULE_COUNT_THRESHOLD (default 2). Ashby has no reschedule
 *   history of its own — see rescheduleTracking.js — so counting only
 *   starts from whenever this app first saw a given event; it can't detect
 *   reschedules that already happened before that.
 *
 * A candidate appears in at most ONE of feedbackOverdue/needsScheduling/
 * availabilitySubmitted/onsiteToday/staleCandidates, never several at once —
 * see keepMostRecentPerCandidate below. Without this, a candidate could
 * legitimately show up in both, e.g., Feedback Overdue (an old interview's
 * feedback still isn't in) AND Onsite Interviews Today (they've since moved
 * on to a new round) — confusing, since the old feedback item is stale
 * information once a newer round exists. Only the single most recent event
 * per candidate is kept; everything else for that candidate is dropped
 * entirely (not moved to Stale Candidates either, unless that most-recent
 * event is itself the stale one). rescheduledInterviews is deliberately NOT
 * part of that pool — it's an orthogonal fact about a specific event's
 * history, not a mutually-exclusive candidate state, so a candidate can be
 * in Rescheduled Interviews AND one of the others at the same time.
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
// first (see scripts/check-ashby-compatibility.js); "panel"/"final" is
// January's convention, not a real Ashby default. An empty keyword list
// disables the section entirely rather than silently matching nothing.
// "Today" is a UTC calendar day, the same tradeoff countInterviewsThisWeek
// already makes for "this week" (see above) — display times still render in
// the browser's local zone client-side, only the day boundary is computed
// in UTC here.
function matchesOnsiteStage(title) {
  if (!title) return false;
  const lower = title.toLowerCase();
  return config.onsiteStageKeywords.some((k) => lower.includes(k));
}

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
  if (!config.onsiteStageKeywords.length) return []; // section disabled for this client

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
    if (!matchesOnsiteStage(stageTitle)) continue;

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
  const createdAfter = Date.now() - config.scheduleLookbackDays * 24 * 60 * 60 * 1000;
  const schedules = await fetchAllPages("interviewSchedule.list", { limit: 100, createdAfter });

  // Reschedule tracking is a property of the event itself, not the
  // candidate — run it over every event in the lookback window regardless
  // of application status, before the Active-only filtering below.
  const allEvents = schedules.flatMap((s) => (s.interviewEvents || []).map((e) => ({ id: e.id, startTime: e.startTime })));
  const rescheduleCounts = rescheduleTracking.trackAndGetCounts(allEvents);

  const applicationIds = [...new Set(schedules.map((s) => s.applicationId).filter(Boolean))];
  const [applications, interviewerLimits] = await Promise.all([
    fetchApplicationSummaries(applicationIds),
    listInterviewerLimits(schedules),
  ]);
  // Depends on `applications` (to know which schedules are for still-Active
  // candidates), so it can't join the Promise.all above.
  let onsiteToday = await listOnsiteToday(schedules, applications);

  const now = Date.now();
  let feedbackEntries = [];
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
  rescheduledInterviews.sort((a, b) => b.rescheduleCount - a.rescheduleCount);

  return {
    feedbackOverdue,
    needsScheduling,
    staleCandidates,
    interviewerLimits,
    availabilitySubmitted,
    onsiteToday,
    rescheduledInterviews,
  };
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

module.exports = {
  listIssues,
  listRecentSourced,
  listDepartments,
  listInterviewerTraining,
};
