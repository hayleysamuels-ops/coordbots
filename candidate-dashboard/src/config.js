"use strict";

require("dotenv").config();

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    console.warn(`[config] Warning: ${name} is not set. See .env.example.`);
  }
  return value || "";
}

function hours(name, fallback) {
  const parsed = parseFloat(process.env[name]);
  return !Number.isNaN(parsed) && parsed >= 0 ? parsed : fallback;
}
// Same generic parser as `hours`, aliased for non-hour numeric settings.
const number = hours;

const config = {
  port: parseInt(process.env.PORT || "3000", 10),

  ashbyApiKey: required("ASHBY_API_KEY"),
  ashbyAppBaseUrl: (process.env.ASHBY_APP_BASE_URL || "https://app.ashbyhq.com").replace(/\/+$/, ""),

  feedbackOverdueHours: hours("FEEDBACK_OVERDUE_HOURS", 24),
  needsSchedulingAlertHours: hours("NEEDS_SCHEDULING_ALERT_HOURS", 48),
  refreshIntervalMinutes: hours("REFRESH_INTERVAL_MINUTES", 5),

  // Candidates this far past the normal thresholds get pulled into their own
  // "Stale Candidates" section instead of sitting in the regular columns.
  staleFeedbackHours: hours("STALE_FEEDBACK_HOURS", 350),
  staleSchedulingHours: hours("STALE_SCHEDULING_HOURS", 7 * 24),

  // An interviewer is flagged once their remaining weekly capacity
  // (their Ashby-configured weeklyLimit minus interviews already on their
  // calendar this week) drops to this many slots or fewer. Only interviewers
  // with a weeklyLimit set in Ashby are considered at all.
  interviewerLimitBuffer: number("INTERVIEWER_LIMIT_BUFFER", 1),

  // "Recently Sourced" section: applications created within this many days
  // whose source is a referral or an agency.
  sourcedLookbackDays: number("SOURCED_LOOKBACK_DAYS", 3),

  // "Availability Submitted" section: severity threshold (for color-coding
  // only, not filtering — every currently-submitted candidate is shown) for
  // how long a candidate's submitted availability has sat unbooked.
  availabilitySubmittedAlertHours: hours("AVAILABILITY_SUBMITTED_ALERT_HOURS", 24),

  // Active Referrals refreshes on its own independent timer (see
  // referralCache.js) so its full-scan cost (~12 minutes measured on this
  // org) never blocks the other six sections. Safe to run more often than
  // that once the initial full scan completes, since subsequent refreshes
  // are incremental (syncToken-based) and typically fast.
  activeReferralsRefreshIntervalMinutes: number("ACTIVE_REFERRALS_REFRESH_INTERVAL_MINUTES", 5),

  // Bounds the Active Referrals FULL scan (not the incremental syncs after
  // it) to applications created within this many days. Trades completeness
  // for speed: a referral candidate who's been sitting active for longer
  // than this and hasn't triggered any other page fetch won't appear. See
  // README for the measured page-count impact of this bound.
  referralLookbackDays: number("REFERRAL_LOOKBACK_DAYS", 90),
};

module.exports = config;
