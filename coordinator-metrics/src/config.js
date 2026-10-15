"use strict";

const path = require("path");

require("dotenv").config();

function number(name, fallback) {
  const parsed = parseFloat(process.env[name]);
  return !Number.isNaN(parsed) && parsed >= 0 ? parsed : fallback;
}

// Comma-separated, lowercased, trimmed. Used for keyword-matching against
// free-text Ashby interview titles, which vary per org and aren't an enum.
// An explicitly empty value (`FOO=`) disables the feature rather than
// falling back to the default — same convention as candidate-dashboard.
function list(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Same validation as candidate-dashboard/src/config.js: Node silently
// resolves "EST" to the fixed-offset America/Panama rather than rejecting
// it, so a fixed abbreviation reads an hour off real Eastern time for most
// of the year. Real IANA names always contain a "/" (bar "UTC" itself).
function validateTimeZone(value, fallback, label) {
  const tz = value || fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch (err) {
    console.warn(`[config] ${label}: "${tz}" is not a valid IANA time zone (${err.message}). Falling back to "${fallback}".`);
    return fallback;
  }
  if (tz !== "UTC" && !tz.includes("/")) {
    console.warn(
      `[config] ${label}: "${tz}" looks like a fixed abbreviation (EST/PST/CST), not an IANA name. These ignore ` +
        `daylight saving and will be an hour out for roughly half the year. Use e.g. "America/New_York".`
    );
  }
  return tz;
}

// Per-client settings are read from suffixed environment variables so each
// client's Ashby key stays a discrete Railway variable rather than being
// buried in one JSON blob: CLIENTS=forus,january then ASHBY_API_KEY_FORUS,
// CLIENT_NAME_FORUS, and so on. The suffix is the client id uppercased with
// non-alphanumerics replaced by underscores.
function envSuffix(clientId) {
  return clientId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function perClient(clientId, name, fallback) {
  const value = process.env[`${name}_${envSuffix(clientId)}`];
  return value == null || value === "" ? fallback : value;
}

// Interview titles that are holds, logistics or internal blocks rather than
// a candidate-facing interview. Confirmed present in real client data: Forus
// has "External Hold", "[Forus] Arrival + Set Up", "... Work Time" and
// "Dinner with Forus" sitting alongside real interviews in the same
// interview.list. Excluding them is a product decision (see README §
// Counting rules) — debriefs, by contrast, ARE counted, and are identified
// by Ashby's own structured `isDebrief` flag, not by title.
// NOTE: "lunch" and "dinner" are deliberately NOT here.
//
// A candidate meal is coordinated candidate time, not a logistics block.
// Checked against Forus's live data: all 469 of its meal events are
// attached to a named candidate's application, 463 of them sit in an
// Onsite stage, and the median has two interviewers blocked out — a
// coordinator finding a slot and booking two to six people around it.
// Poetic's are the same thing (FDE Work Trial Lunch / Dinner). Excluding
// them removed 706 real events across three clients.
//
// "break" stays, because a standalone "Break" is a genuine gap with
// nobody in it. Whole-word matching means it no longer eats "Breakfast".
const DEFAULT_EXCLUDED_TITLE_KEYWORDS = [
  "hold",
  "work time",
  "arrival",
  "set up",
  "setup",
  "break",
  "buffer",
  "placeholder",
];

// Job records that are scaffolding rather than real reqs. Matched against
// the job title TRIMMED AND LOWERCASED, IN FULL — an exact match, never a
// substring. That is the whole point: a substring rule on "test" would
// silently delete a genuine "Test Engineer" or "QA Test Lead" role, and
// nothing on the page would show that it had happened.
//
// Confirmed real: Luminai has three job records titled "TEST" (one of them
// open), and Runlayer has a "TEST PIPELINE" req that had collected two
// interview events before this existed.
const DEFAULT_EXCLUDED_JOB_TITLES = ["test", "test pipeline", "testing", "do not use"];

const clientIds = (process.env.CLIENTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

if (clientIds.length === 0) {
  console.warn("[config] CLIENTS is empty — the dashboard will start with no tabs. See .env.example.");
}

const clients = clientIds.map((id) => {
  const apiKey = perClient(id, "ASHBY_API_KEY", "");
  if (!apiKey) {
    console.warn(`[config] Client "${id}" has no ASHBY_API_KEY_${envSuffix(id)} — its tab will show a configuration error rather than silently empty data.`);
  }
  return {
    id,
    name: perClient(id, "CLIENT_NAME", id.charAt(0).toUpperCase() + id.slice(1)),
    apiKey,
    // Each tab renders in its own client's zone, so "interviews on Tuesday"
    // matches the week that client's coordinator actually worked. The
    // overview tab buckets everything in OVERVIEW_TIMEZONE instead.
    timeZone: validateTimeZone(perClient(id, "CLIENT_TIMEZONE", ""), "America/New_York", `Client "${id}"`),
    accentColor: perClient(id, "CLIENT_ACCENT_COLOR", ""),
    appBaseUrl: (perClient(id, "ASHBY_APP_BASE_URL", "https://app.ashbyhq.com")).replace(/\/+$/, ""),
    excludedTitleKeywords: list(`EXCLUDED_TITLE_KEYWORDS_${envSuffix(id)}`, DEFAULT_EXCLUDED_TITLE_KEYWORDS),
    excludedJobTitles: list(`EXCLUDED_JOB_TITLES_${envSuffix(id)}`, DEFAULT_EXCLUDED_JOB_TITLES),
  };
});

const config = {
  port: parseInt(process.env.PORT || "3000", 10),

  // Resolution order matches candidate-dashboard: Railway sets
  // RAILWAY_VOLUME_MOUNT_PATH automatically when a volume is attached.
  // The SQLite file MUST live on a volume — without one the whole 12-month
  // backfill is lost on every redeploy.
  dataDir: process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, "..", "data"),

  dashboardUser: process.env.DASHBOARD_USER || "",
  dashboardPassword: process.env.DASHBOARD_PASSWORD || "",

  clients,
  clientIds,

  // Zone the cross-client overview tab buckets days and weeks in. Per-client
  // tabs ignore this and use their own zone.
  overviewTimeZone: validateTimeZone(process.env.OVERVIEW_TIMEZONE, "America/New_York", "Overview"),

  // How much history the nightly full sync pulls. 12 months of Forus is
  // ~21,000 schedules / ~18,000 events and takes about three minutes of
  // Ashby pagination, so this is a real cost — don't raise it casually.
  historyMonths: number("HISTORY_MONTHS", 12),

  // The hourly top-up re-pulls only schedules CREATED inside this window.
  // Ashby's interviewSchedule.list filters on createdAfter and has no
  // updatedAfter, so a schedule created before this window that changes
  // today (cancelled, rescheduled, completed) is only picked up by the next
  // nightly full sync. Widen this if that lag matters more than sync speed.
  incrementalDays: number("INCREMENTAL_DAYS", 60),

  // Cron-ish scheduling, in local server time. The full sync is heavy
  // (roughly 30 minutes across five clients) so it runs overnight.
  fullSyncHour: number("FULL_SYNC_HOUR", 3),
  incrementalMinutes: number("INCREMENTAL_MINUTES", 60),

  // Run a sync as soon as the process starts. On by default so a fresh
  // deployment populates itself without anyone clicking anything.
  syncOnBoot: process.env.SYNC_ON_BOOT !== "false",

  // How many clients sync concurrently. Each client is a separate Ashby org
  // with its own rate limit, so parallelism across clients is safe; it's
  // parallelism *within* one org that gets throttled.
  clientConcurrency: number("CLIENT_CONCURRENCY", 2),

  dashboardTitle: process.env.DASHBOARD_TITLE || "Coordinator Metrics",

  // A booked slot this close to its start counts as short-notice — a
  // firefighting signal that a raw volume count hides completely.
  shortNoticeHours: number("SHORT_NOTICE_HOURS", 24),

  // Local business hours used for the out-of-hours metric, in each client's
  // own zone. An event starting outside these counts as out-of-hours.
  businessHourStart: number("BUSINESS_HOUR_START", 8),
  businessHourEnd: number("BUSINESS_HOUR_END", 18),
};

module.exports = config;
