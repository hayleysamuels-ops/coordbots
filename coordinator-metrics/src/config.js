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
// NOTE "work time" is deliberately absent too. A candidate working alone
// on a case is still a slot a coordinator blocked out and arranged —
// same reasoning as meals. Removing it counts ~376 more events at Forus
// (24 "Work Time" variants) and 4 at Profound.

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

// The Carrara coordinators whose scheduling counts as our work.
//
// Matched against the scheduler name Ashby stores ON THE SCHEDULE, which
// is why this is a name list and not user ids: `user.list` is incomplete
// (it omits 1,789 of January's schedulers' accounts, 1,323 of Forus's),
// but the name is present on every schedule regardless.
//
// Matching is EXACT on the normalised full name, never a substring —
// "Anna Jones" as a substring also hits "Giovanna Borgiotti" and "Hanna
// Rocks", both of whom are other people.
//
// Includes coordinators who have left: their work still counts. Aliases
// go in as separate entries (Ashby shows "Tess Wicks" while the account
// is theresa.wicks@..., so a future rename is already covered).
const DEFAULT_COORDINATORS = [
  // Ashby's display name is "Tess Wicks" even though the account is
  // theresa.wicks@january.com. The "Theresa Wicks" alias was removed: it
  // matched nothing and produced a permanent false alarm, and a genuine
  // rename is already caught by the renames report (same user id, new
  // name) rather than needing to be guessed in advance.
  "Tess Wicks",
  "Kelley Lantigua",
  // Sadiqeh Agah is deliberately absent: she matched no scheduled work
  // at any of the six clients here, because she works on one of the four
  // that have no dashboard yet — Polymarket, OpenAI Foundation, Source
  // Foundry, Modal. Listing her only produced a standing "no matching
  // work anywhere" warning.
  //
  // RE-ADD HER when any of those four is onboarded, or her work there
  // will be counted as someone else's client activity rather than ours.
  "Anna Jones",
  "Hayley Samuels",
  "Meredith Faria",
  "Maggie Stout",
];

// Case/whitespace-insensitive, so a stray double space or a capitalisation
// change in Ashby doesn't silently drop someone's work.
function normalizeName(name) {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Case-preserving list, since these are displayed back as names.
function nameList(key, fallback) {
  const raw = process.env[key];
  if (raw == null) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const clientIds = (process.env.CLIENTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

if (clientIds.length === 0) {
  console.warn("[config] CLIENTS is empty — the dashboard will start with no tabs. See .env.example.");
}

const globalCoordinators = nameList("CARRARA_COORDINATORS", DEFAULT_COORDINATORS);

const clients = clientIds.map((id) => {
  const apiKey = perClient(id, "ASHBY_API_KEY", "");
  if (!apiKey) {
    console.warn(`[config] Client "${id}" has no ASHBY_API_KEY_${envSuffix(id)} — its tab will show a configuration error rather than silently empty data.`);
  }
  // Two independent axes, and both gate the roll-up.
  //
  //   engagement — who does the scheduling. A share-of-activity figure
  //     is only meaningful inside one of these groups: at a
  //     client-scheduled account most interviews were never ours, so
  //     mixing them into one percentage understates the work everywhere
  //     else.
  //   status — whether the engagement is still running. An ended
  //     engagement must never reach a current-period number, or a
  //     finished client quietly drags every "this week" on the page
  //     toward zero.
  const engagement = perClient(id, "CLIENT_ENGAGEMENT", "carrara-scheduled");
  if (!["carrara-scheduled", "client-scheduled"].includes(engagement)) {
    throw new Error(`CLIENT_ENGAGEMENT_${envSuffix(id)} must be carrara-scheduled or client-scheduled, got "${engagement}"`);
  }

  const status = perClient(id, "CLIENT_STATUS", "active");
  if (!["active", "ended"].includes(status)) {
    throw new Error(`CLIENT_STATUS_${envSuffix(id)} must be active or ended, got "${status}"`);
  }

  // An ended engagement reads its own fixed date range instead of the
  // rolling 12 months. Without that the work would silently age out of
  // the dashboard — Profound's ends in August 2026, so a rolling window
  // erases all of it by September 2027.
  const engagementStart = perClient(id, "CLIENT_ENGAGEMENT_START", "");
  const engagementEnd = perClient(id, "CLIENT_ENGAGEMENT_END", "");
  if (status === "ended" && (!engagementStart || !engagementEnd)) {
    throw new Error(
      `Client "${id}" is ended, so CLIENT_ENGAGEMENT_START_${envSuffix(id)} and ` +
        `CLIENT_ENGAGEMENT_END_${envSuffix(id)} are required (YYYY-MM-DD) — otherwise its window is undefined.`
    );
  }

  return {
    id,
    name: perClient(id, "CLIENT_NAME", id.charAt(0).toUpperCase() + id.slice(1)),
    engagement,
    status,
    isEnded: status === "ended",
    engagementStart: engagementStart || null,
    engagementEnd: engagementEnd || null,
    apiKey,
    // Each tab renders in its own client's zone, so "interviews on Tuesday"
    // matches the week that client's coordinator actually worked. The
    // overview tab buckets everything in OVERVIEW_TIMEZONE instead.
    timeZone: validateTimeZone(perClient(id, "CLIENT_TIMEZONE", ""), "America/New_York", `Client "${id}"`),
    accentColor: perClient(id, "CLIENT_ACCENT_COLOR", ""),
    appBaseUrl: (perClient(id, "ASHBY_APP_BASE_URL", "https://app.ashbyhq.com")).replace(/\/+$/, ""),
    excludedTitleKeywords: list(`EXCLUDED_TITLE_KEYWORDS_${envSuffix(id)}`, DEFAULT_EXCLUDED_TITLE_KEYWORDS),
    excludedJobTitles: list(`EXCLUDED_JOB_TITLES_${envSuffix(id)}`, DEFAULT_EXCLUDED_JOB_TITLES),
    // Per-client override of the roster; defaults to the shared list so a
    // coordinator moving between accounts needs no config change.
    coordinators: nameList(`CARRARA_COORDINATORS_${envSuffix(id)}`, globalCoordinators),
    // True only when this client has its own explicit roster. The
    // "no events here for X" warning is only meaningful when someone has
    // actually said X works this client — against the shared default it
    // just lists everyone assigned elsewhere, which buries the signal.
    hasOwnRoster: process.env[`CARRARA_COORDINATORS_${envSuffix(id)}`] != null,
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

  // The commit this build was made from. Railway injects
  // RAILWAY_GIT_COMMIT_SHA for repo-connected services; the others are
  // fallbacks for any other host, and null means "this deployment cannot
  // say what it is", which CI reports rather than silently skipping.
  commitSha:
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.SOURCE_COMMIT ||
    process.env.COMMIT_SHA ||
    null,

  // A booked slot this close to its start counts as short-notice — a
  // firefighting signal that a raw volume count hides completely.
  shortNoticeHours: number("SHORT_NOTICE_HOURS", 24),

  // Local business hours used for the out-of-hours metric, in each client's
  // own zone. An event starting outside these counts as out-of-hours.
  businessHourStart: number("BUSINESS_HOUR_START", 8),
  businessHourEnd: number("BUSINESS_HOUR_END", 18),
};

module.exports = config;
module.exports.normalizeName = normalizeName;
