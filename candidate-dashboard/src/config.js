"use strict";

const path = require("path");

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

  // Every persisted file lives under here. Point it at a mounted volume on
  // a cloud host so dismissals survive redeploys.
  dataDir: process.env.DATA_DIR || path.join(__dirname, "..", "data"),

  // HTTP Basic Auth, checked in front of every route (see src/auth.js).
  dashboardUser: required("DASHBOARD_USER"),
  dashboardPassword: required("DASHBOARD_PASSWORD"),

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
};

module.exports = config;
