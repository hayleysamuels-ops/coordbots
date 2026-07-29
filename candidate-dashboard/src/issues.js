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
};

// Static, client-specific display config — never changes at runtime, so it's
// set once here rather than recomputed on every refresh. The frontend reads
// these to set the page title and the Active Referrals report link (hidden
// if activeReferralsReportUrl is unset).
const appConfig = {
  dashboardTitle: config.dashboardTitle,
  activeReferralsReportUrl: config.activeReferralsReportUrl,
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
  departments: [],
  thresholds,
  appConfig,
};
let lastUpdated = null;
let lastError = null;

// Wraps a promise with duration logging so slow calls are visible per-call
// rather than conflated with the others they run alongside in Promise.all.
async function timed(label, promise) {
  const start = Date.now();
  const result = await promise;
  console.log(`[issues] ${label} took ${Math.round((Date.now() - start) / 1000)}s`);
  return result;
}

async function computeIssues() {
  const [issues, recentSourced, departments, interviewerTraining] = await Promise.all([
    timed("listIssues", ashby.listIssues()),
    timed("listRecentSourced", ashby.listRecentSourced()),
    timed("listDepartments", ashby.listDepartments()),
    timed("listInterviewerTraining", ashby.listInterviewerTraining()),
  ]);

  const {
    feedbackOverdue,
    needsScheduling,
    staleCandidates,
    interviewerLimits,
    availabilitySubmitted,
    onsiteToday,
    rescheduledInterviews,
  } = issues;
  return {
    feedbackOverdue,
    needsScheduling,
    staleCandidates,
    interviewerLimits,
    recentSourced,
    availabilitySubmitted,
    onsiteToday,
    rescheduledInterviews,
    interviewerTraining,
    departments,
    thresholds,
    appConfig,
  };
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
      snapshot = await computeIssues();
      lastUpdated = new Date();
      lastError = null;
      console.log(
        `[issues] refreshed: ${snapshot.feedbackOverdue.length} feedback overdue, ` +
          `${snapshot.needsScheduling.length} needs scheduling, ` +
          `${snapshot.staleCandidates.length} stale, ` +
          `${snapshot.interviewerLimits.length} nearing interview limit, ` +
          `${snapshot.recentSourced.length} recently sourced, ` +
          `${snapshot.availabilitySubmitted.length} availability submitted, ` +
          `${snapshot.onsiteToday.length} onsite today, ` +
          `${snapshot.rescheduledInterviews.length} rescheduled interviews, ` +
          `${snapshot.interviewerTraining.length} interviewer training entries`
      );
    } catch (err) {
      lastError = err.message;
      console.warn("[issues] refresh failed, serving stale snapshot:", err.message);
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
  };
}

function getSnapshot() {
  return {
    ...applyDismissals(snapshot),
    lastUpdated,
    lastError,
  };
}

module.exports = { start, getSnapshot, refresh };
