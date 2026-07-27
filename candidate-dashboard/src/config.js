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
};

module.exports = config;
