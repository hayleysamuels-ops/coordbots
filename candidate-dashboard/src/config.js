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

// Same shape as `list` above, but case-preserving — for comma-separated
// values that are matched exactly (e.g. section keys, which are camelCase
// JS property names) rather than lowercased free-text keyword matching.
function exactList(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Single source of truth for valid DISABLED_SECTIONS entries — the same
// keys each section's `data-key` attribute (index.html) and snapshot field
// (issues.js/app.js) use. Keep in sync with both when a section is added,
// renamed, or removed.
const SECTION_KEYS = [
  "feedbackOverdue",
  "needsScheduling",
  "availabilitySubmitted",
  "staleCandidates",
  "interviewerLimits",
  "recentSourced",
  "onsiteToday",
  "rescheduledInterviews",
  "interviewerTraining",
];

const config = {
  port: parseInt(process.env.PORT || "3000", 10),

  // Every persisted file lives under here. Resolution order:
  // RAILWAY_VOLUME_MOUNT_PATH (set automatically by Railway when a volume is
  // attached — no manual config needed on that platform) -> DATA_DIR (for
  // any other host with its own mounted-volume path) -> ./data (local dev).
  // Point this at a mounted volume on any cloud host so dismissals and the
  // self-tracked history files survive redeploys.
  dataDir: process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, "..", "data"),

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
  // titles first (see scripts/check-ashby-compatibility.js) — "final"/
  // "exec" (matching this org's real "Final Round"/"Final Round (series)"
  // and "Executive Interview" stage titles) was January's convention, not
  // a real Ashby default. Previously also matched "panel" ("Panel Round");
  // narrowed per product decision to final-round and executive interviews
  // only.
  onsiteStageKeywords: list("ONSITE_STAGE_KEYWORDS", ["final", "exec"]),

  // The client this deployment is for — single source of truth for the page
  // header and browser tab title (client name first: "<name> Coordination
  // Dashboard"). Empty by default so an unbranded deployment falls back to
  // the plain generic title below.
  clientName: process.env.CLIENT_NAME || "",

  // Cosmetic, but client-specific: shown in the browser tab and page header.
  // DASHBOARD_TITLE, if set, wins outright over the CLIENT_NAME-derived
  // title above — an escape hatch for a title that doesn't fit the
  // "<name> Coordination Dashboard" shape.
  dashboardTitle:
    process.env.DASHBOARD_TITLE ||
    (process.env.CLIENT_NAME ? `${process.env.CLIENT_NAME} Coordination Dashboard` : "Candidate Dashboard"),

  // Overrides the header accent color (topbar border + title text, default
  // Carrara ember — see --header-accent in style.css) so each client
  // deployment is visually distinguishable at a glance. Any valid CSS color
  // value. Empty means "use the default token," not "no accent."
  clientAccentColor: process.env.CLIENT_ACCENT_COLOR || "",

  // Recruiter/Coordinator filter: exact hiringTeam[].role name to match
  // (not a substring/keyword list like source/stage above — Ashby's
  // hiringTeamRole.list is a small controlled per-org list, not free text,
  // but still org-specific naming; this org's roles are "Hiring Manager",
  // "Recruiter", "Recruiting Coordinator", "Sourcer"). Verify a new
  // client's real hiringTeamRole.list before trusting the defaults.
  recruiterRoleName: process.env.RECRUITER_ROLE_NAME || "Recruiter",
  coordinatorRoleName: process.env.COORDINATOR_ROLE_NAME || "Recruiting Coordinator",

  // Per-deployment section toggle: exact, case-sensitive section keys (see
  // SECTION_KEYS above and README § Section keys) to hide from this client's
  // dashboard entirely, e.g. a client that doesn't configure Ashby
  // weeklyLimits has no use for Interviewer Weekly Limits. Generic on
  // purpose — add a client-specific flag per section instead of extending
  // this list.
  disabledSections: exactList("DISABLED_SECTIONS", []),

  knownSectionKeys: SECTION_KEYS,
};

console.log(`[config] Recognized section keys: ${SECTION_KEYS.join(", ")}`);

// A typo in DISABLED_SECTIONS (e.g. "interviewerWeeklyLimits" instead of
// "interviewerLimits") would otherwise silently do nothing — the section
// stays visible and nothing indicates why the toggle "didn't work."
for (const key of config.disabledSections) {
  if (!SECTION_KEYS.includes(key)) {
    console.warn(
      `[config] Warning: DISABLED_SECTIONS entry "${key}" doesn't match any known section key. ` +
        `Recognized keys: ${SECTION_KEYS.join(", ")}.`
    );
  }
}

module.exports = config;
