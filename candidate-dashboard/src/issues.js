"use strict";

const config = require("./config");
const ashby = require("./ashby");
const dismissals = require("./dismissals");
const referralCache = require("./referralCache");

const thresholds = {
  feedbackOverdueHours: config.feedbackOverdueHours,
  needsSchedulingAlertHours: config.needsSchedulingAlertHours,
  staleFeedbackHours: config.staleFeedbackHours,
  staleSchedulingHours: config.staleSchedulingHours,
  interviewerLimitBuffer: config.interviewerLimitBuffer,
  sourcedLookbackDays: config.sourcedLookbackDays,
  availabilitySubmittedAlertHours: config.availabilitySubmittedAlertHours,
};

// Active Referrals is NOT part of this snapshot — it refreshes on its own
// independent timer via referralCache.js (see start()/getSnapshot() below),
// specifically so its full-scan cost never delays these six sections.
let snapshot = {
  feedbackOverdue: [],
  needsScheduling: [],
  staleCandidates: [],
  interviewerLimits: [],
  recentSourced: [],
  availabilitySubmitted: [],
  departments: [],
  thresholds,
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
  const [issues, recentSourced, departments] = await Promise.all([
    timed("listIssues", ashby.listIssues()),
    timed("listRecentSourced", ashby.listRecentSourced()),
    timed("listDepartments", ashby.listDepartments()),
  ]);

  const { feedbackOverdue, needsScheduling, staleCandidates, interviewerLimits, availabilitySubmitted } = issues;
  return {
    feedbackOverdue,
    needsScheduling,
    staleCandidates,
    interviewerLimits,
    recentSourced,
    availabilitySubmitted,
    departments,
    thresholds,
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
          `${snapshot.availabilitySubmitted.length} availability submitted`
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
  referralCache.start(); // independent refresh cycle — see referralCache.js
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
    activeReferrals: snap.activeReferrals.filter(keepCandidate),
    interviewerLimits: snap.interviewerLimits.filter(keepInterviewer),
  };
}

function getSnapshot() {
  const referralSnap = referralCache.getSnapshot();
  const merged = { ...snapshot, activeReferrals: referralSnap.activeReferrals };
  return {
    ...applyDismissals(merged),
    lastUpdated,
    lastError,
    // Active Referrals' own timestamp/error, independent of the six above —
    // see § per-section timestamps in the frontend and referralCache.js.
    activeReferralsUpdated: referralSnap.lastUpdated,
    activeReferralsError: referralSnap.lastError,
  };
}

module.exports = { start, getSnapshot, refresh };
