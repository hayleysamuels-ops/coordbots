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

// Comma-separated substrings, lowercased/trimmed — used for keyword-matching
// against free-text Ashby fields (source type titles, interview stage
// titles) that vary by org and aren't a fixed enum. `fallback` is an array
// of already-lowercase keywords. Pass an explicitly empty env var
// (`FOO=`) to disable a keyword-matched feature entirely, rather than
// falling back to the default.
function list(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

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

  // How far back to pull interviewSchedule.list for the schedule-driven
  // sections (Feedback Overdue, Needs Scheduling, Availability Submitted,
  // Interviewer Weekly Limits, Onsite Interviews Today). Org-specific
  // interview volume/velocity determines the right tradeoff between
  // catching old stragglers and refresh-cycle speed — see README § Scope.
  scheduleLookbackDays: number("SCHEDULE_LOOKBACK_DAYS", 30),

  // "Rescheduled Interviews" section: flag once an interview event's
  // tracked reschedule count exceeds this many (default 2, i.e. "more than
  // 2 times" = 3rd reschedule onward). Ashby has no reschedule history of
  // its own — see src/rescheduleTracking.js — so this only counts
  // reschedules that happen from whenever this app first started tracking
  // a given event onward, not any that happened before.
  rescheduleCountThreshold: number("RESCHEDULE_COUNT_THRESHOLD", 2),

  // "Recently Sourced" / source classification: which `source.sourceType.title`
  // substrings count as a referral or an agency. Every Ashby org names these
  // differently — verify against this client's actual source.list before
  // relying on the defaults (see scripts/check-ashby-compatibility.js).
  sourceReferralKeywords: list("SOURCE_REFERRAL_KEYWORDS", ["referr"]),
  sourceAgencyKeywords: list("SOURCE_AGENCY_KEYWORDS", ["agenc"]),

  // "Onsite Interviews Today": Ashby has no structured onsite/location field
  // anywhere, so this matches on interview STAGE title substrings instead —
  // entirely dependent on this client's own stage-naming convention. Empty
  // list (`ONSITE_STAGE_KEYWORDS=`) disables the section rather than
  // matching nothing silently. Verify against this client's real stage
  // titles first (see scripts/check-ashby-compatibility.js) — "panel"/
  // "final" was January's convention, not a real Ashby default.
  onsiteStageKeywords: list("ONSITE_STAGE_KEYWORDS", ["panel", "final"]),

  // Cosmetic, but client-specific: shown in the browser tab and page header.
  dashboardTitle: process.env.DASHBOARD_TITLE || "Candidate Dashboard",

  // Link target for the "View Active Referrals report in Ashby" button.
  // Every Ashby org's saved reports have their own URLs — this is never
  // portable between clients. Button is hidden entirely if unset.
  activeReferralsReportUrl: process.env.ACTIVE_REFERRALS_REPORT_URL || "",

  // Recruiter/Coordinator filter: exact hiringTeam[].role name to match
  // (not a substring/keyword list like source/stage above — Ashby's
  // hiringTeamRole.list is a small controlled per-org list, not free text,
  // but still org-specific naming; this org's roles are "Hiring Manager",
  // "Recruiter", "Recruiting Coordinator", "Sourcer"). Verify a new
  // client's real hiringTeamRole.list before trusting the defaults.
  recruiterRoleName: process.env.RECRUITER_ROLE_NAME || "Recruiter",
  coordinatorRoleName: process.env.COORDINATOR_ROLE_NAME || "Recruiting Coordinator",
};

module.exports = config;
