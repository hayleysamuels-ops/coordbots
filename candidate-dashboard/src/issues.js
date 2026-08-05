"use strict";

const config = require("./config");
const ashby = require("./ashby");
const dismissals = require("./dismissals");

const thresholds = {
  feedbackOverdueHours: config.feedbackOverdueHours,
  needsSchedulingAlertHours: config.needsSchedulingAlertHours,
  staleFeedbackHours: config.staleFeedbackHours,
  staleSchedulingHours: config.staleSchedulingHours,
  interviewerLimitBuffer: config.interviewerLimitBuffer,
  sourcedLookbackDays: config.sourcedLookbackDays,
  availabilitySubmittedAlertHours: config.availabilitySubmittedAlertHours,
  rescheduleCountThreshold: config.rescheduleCountThreshold,
  offersSignedLookbackDays: config.offersSignedLookbackDays,
};

// Static, client-specific display config — never changes at runtime, so it's
// set once here rather than recomputed on every refresh. The frontend reads
// this to set the page title, header accent color, and a few section
// descriptions that would otherwise hardcode this client's specific
// keyword/threshold choices (see § Section descriptions in README) instead
// of deriving them from config, the way every other client-specific value
// in this app already does.
const appConfig = {
  dashboardTitle: config.dashboardTitle,
  clientAccentColor: config.clientAccentColor,
  disabledSections: config.disabledSections,
  onsiteStageKeywords: config.onsiteStageKeywords,
  sourceReferralKeywords: config.sourceReferralKeywords,
  sourceAgencyKeywords: config.sourceAgencyKeywords,
  displayTimeZone: config.displayTimeZone,
};

let snapshot = {
  feedbackOverdue: [],
  needsScheduling: [],
  staleCandidates: [],
  interviewerLimits: [],
  recentSourced: [],
  availabilitySubmitted: [],
  onsiteToday: [],
  rescheduledInterviews: [],
  interviewerTraining: [],
  offersNotYetSent: [],
  offersAwaitingAcceptance: [],
  offersSigned: [],
  departments: [],
  thresholds,
  appConfig,
};
let lastUpdated = null;
let lastError = null;

// Wraps a promise with duration logging so slow calls are visible per-call
// rather than conflated with the others they run alongside in Promise.allSettled.
async function timed(label, promise) {
  const start = Date.now();
  const result = await promise;
  console.log(`[issues] ${label} took ${Math.round((Date.now() - start) / 1000)}s`);
  return result;
}

// Each group is fetched and can fail independently — a broken
// application.list call inside listRecentSourced() (say) no longer takes
// down listIssues()'s result with it just because they used to be awaited
// together in one Promise.all. Grouped by which underlying `ashby.js` call
// produces them, since that's the real unit of failure: listIssues()
// itself computes feedbackOverdue/needsScheduling/staleCandidates/
// interviewerLimits/availabilitySubmitted/onsiteToday/rescheduledInterviews
// from one shared `interviewSchedule.list` fetch, so those seven sink or
// swim together (splitting them further isn't meaningful — they share a
// root cause), same for offersNotYetSent/offersAwaitingAcceptance/
// offersSigned under listOffers(). recentSourced/departments/
// interviewerTraining each get their own group since each is one
// independent Ashby call.
const SECTION_GROUPS = [
  {
    label: "Schedule-driven sections",
    keys: ["feedbackOverdue", "needsScheduling", "staleCandidates", "interviewerLimits", "availabilitySubmitted", "onsiteToday", "rescheduledInterviews"],
    fetch: () => timed("listIssues", ashby.listIssues()),
    assign: (snap, result) => Object.assign(snap, result),
  },
  {
    label: "Recently Sourced",
    keys: ["recentSourced"],
    fetch: () => timed("listRecentSourced", ashby.listRecentSourced()),
    assign: (snap, result) => {
      snap.recentSourced = result;
    },
  },
  {
    label: "Departments",
    keys: ["departments"],
    fetch: () => timed("listDepartments", ashby.listDepartments()),
    assign: (snap, result) => {
      snap.departments = result;
    },
  },
  {
    label: "Interviewer Training",
    keys: ["interviewerTraining"],
    fetch: () => timed("listInterviewerTraining", ashby.listInterviewerTraining()),
    assign: (snap, result) => {
      snap.interviewerTraining = result;
    },
  },
  {
    label: "Offers",
    keys: ["offersNotYetSent", "offersAwaitingAcceptance", "offersSigned"],
    fetch: () => timed("listOffers", ashby.listOffers()),
    assign: (snap, result) => Object.assign(snap, result),
  },
];

// Per-section-key { lastUpdated, lastError } — every key in a given
// SECTION_GROUPS entry always shares the same value (they refresh
// together), but this is keyed by the individual frontend-facing section
// key rather than by group so getSnapshot()/app.js don't need to know the
// grouping, just "what's this key's own status." A group that fails keeps
// its keys' previous lastUpdated (last known-good data stays visible,
// stamped with when it was actually last fetched, not the failed attempt's
// time) and records the new lastError; a group that succeeds stamps both.
const sectionStatus = {};
for (const group of SECTION_GROUPS) {
  for (const key of group.keys) sectionStatus[key] = { lastUpdated: null, lastError: null };
}

// Guards against overlapping refreshes — a refresh triggered while one is
// already in flight (interval tick, or the manual "Refresh now" button)
// just attaches to the one already running instead of starting a duplicate.
let refreshPromise = null;

async function refresh() {
  if (refreshPromise) {
    console.log("[issues] refresh already in progress, skipping duplicate trigger");
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const now = new Date();
      const results = await Promise.allSettled(SECTION_GROUPS.map((group) => group.fetch()));

      const succeeded = [];
      const failed = [];
      results.forEach((result, i) => {
        const group = SECTION_GROUPS[i];
        if (result.status === "fulfilled") {
          group.assign(snapshot, result.value);
          for (const key of group.keys) sectionStatus[key] = { lastUpdated: now, lastError: null };
          succeeded.push(group.label);
        } else {
          const message = (result.reason && result.reason.message) || String(result.reason);
          console.warn(`[issues] ${group.label} refresh failed, serving stale data:`, message);
          for (const key of group.keys) {
            sectionStatus[key] = { lastUpdated: sectionStatus[key].lastUpdated, lastError: message };
          }
          failed.push(group.label);
        }
      });

      // Top-level lastUpdated/lastError are a coarse, whole-refresh summary
      // for the header only — per-section freshness/errors live in
      // sectionStatus above and are what actually drives each section's own
      // timestamp display. Any partial success still advances the header's
      // "Updated" time (a full-blackout refresh is the only case that
      // doesn't); lastError names which groups failed (by their short
      // `label`, not the full `keys` list — the listIssues group alone
      // covers seven section keys, too long for a one-line header) rather
      // than repeating one message, since more than one can fail
      // independently now.
      if (succeeded.length) lastUpdated = now;
      lastError = failed.length ? `${failed.length} of ${SECTION_GROUPS.length} refresh group(s) failed: ${failed.join(", ")}` : null;

      console.log(
        `[issues] refreshed: ${snapshot.feedbackOverdue.length} feedback overdue, ` +
          `${snapshot.needsScheduling.length} needs scheduling, ` +
          `${snapshot.staleCandidates.length} stale, ` +
          `${snapshot.interviewerLimits.length} nearing interview limit, ` +
          `${snapshot.recentSourced.length} recently sourced, ` +
          `${snapshot.availabilitySubmitted.length} availability submitted, ` +
          `${snapshot.onsiteToday.length} onsite today, ` +
          `${snapshot.rescheduledInterviews.length} rescheduled interviews, ` +
          `${snapshot.interviewerTraining.length} interviewer training entries, ` +
          `${snapshot.offersNotYetSent.length} offers not yet sent, ` +
          `${snapshot.offersAwaitingAcceptance.length} offers awaiting acceptance, ` +
          `${snapshot.offersSigned.length} offers signed` +
          (failed.length ? ` (failed: ${failed.join(", ")})` : "")
      );
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

function start() {
  refresh();
  setInterval(refresh, config.refreshIntervalMinutes * 60 * 1000);
}

// Apply dismissals at serve time (not refresh time) so a dismiss takes effect
// on the very next poll, without waiting for the background refresh. Candidate
// sections filter on candidateId; the interviewer section on userId.
function applyDismissals(snap) {
  const keepCandidate = (x) => !dismissals.isDismissed(`candidate:${x.candidateId}`);
  const keepInterviewer = (x) => !dismissals.isDismissed(`interviewer:${x.userId}`);
  return {
    ...snap,
    feedbackOverdue: snap.feedbackOverdue.filter(keepCandidate),
    needsScheduling: snap.needsScheduling.filter(keepCandidate),
    staleCandidates: snap.staleCandidates.filter(keepCandidate),
    recentSourced: snap.recentSourced.filter(keepCandidate),
    availabilitySubmitted: snap.availabilitySubmitted.filter(keepCandidate),
    onsiteToday: snap.onsiteToday.filter(keepCandidate),
    rescheduledInterviews: snap.rescheduledInterviews.filter(keepCandidate),
    interviewerLimits: snap.interviewerLimits.filter(keepInterviewer),
    interviewerTraining: snap.interviewerTraining.filter(keepInterviewer),
    offersNotYetSent: snap.offersNotYetSent.filter(keepCandidate),
    offersAwaitingAcceptance: snap.offersAwaitingAcceptance.filter(keepCandidate),
    offersSigned: snap.offersSigned.filter(keepCandidate),
  };
}

function getSnapshot() {
  return {
    ...applyDismissals(snapshot),
    lastUpdated,
    lastError,
    sectionStatus,
  };
}

module.exports = { start, getSnapshot, refresh };
