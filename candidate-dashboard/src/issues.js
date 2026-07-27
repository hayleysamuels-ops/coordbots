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
};

let snapshot = {
  feedbackOverdue: [],
  needsScheduling: [],
  staleCandidates: [],
  interviewerLimits: [],
  recentSourced: [],
  thresholds,
};
let lastUpdated = null;
let lastError = null;

async function computeIssues() {
  const [issues, recentSourced] = await Promise.all([ashby.listIssues(), ashby.listRecentSourced()]);
  const { feedbackOverdue, needsScheduling, staleCandidates, interviewerLimits } = issues;
  return { feedbackOverdue, needsScheduling, staleCandidates, interviewerLimits, recentSourced, thresholds };
}

async function refresh() {
  try {
    snapshot = await computeIssues();
    lastUpdated = new Date();
    lastError = null;
    console.log(
      `[issues] refreshed: ${snapshot.feedbackOverdue.length} feedback overdue, ` +
        `${snapshot.needsScheduling.length} needs scheduling, ` +
        `${snapshot.staleCandidates.length} stale, ` +
        `${snapshot.interviewerLimits.length} nearing interview limit, ` +
        `${snapshot.recentSourced.length} recently sourced`
    );
  } catch (err) {
    lastError = err.message;
    console.warn("[issues] refresh failed, serving stale snapshot:", err.message);
  }
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
    interviewerLimits: snap.interviewerLimits.filter(keepInterviewer),
  };
}

function getSnapshot() {
  return { ...applyDismissals(snapshot), lastUpdated, lastError };
}

module.exports = { start, getSnapshot, refresh };
