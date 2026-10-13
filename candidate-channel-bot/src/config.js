"use strict";

require("dotenv").config();

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    console.warn(`[config] Warning: ${name} is not set. See .env.example.`);
  }
  return value || "";
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim().toLowerCase() === "true";
}

// Which terminal outcomes close a channel. "archived" = the application was
// archived (rejected, withdrew, and so on). "hired" = the candidate was hired.
function parseArchiveOn(raw) {
  const allowed = new Set(["archived", "hired"]);
  const parsed = (raw || "archived,hired")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => allowed.has(s));
  return new Set(parsed.length ? parsed : ["archived", "hired"]);
}

// Slack channel names are lowercase, 80 chars max, and allow letters, digits,
// hyphens and underscores only. Anything we build has to fit that.
function normalisePrefix(raw) {
  return (raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

// Channel names that carry the prefix but are not candidate channels, and must
// never be archived. Luminai has #hiring-nyc-event, a recruiting event channel
// sitting in the same namespace as the candidate channels.
function parseDenylist(raw) {
  const names = (raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^#/, ""))
    .filter(Boolean);
  return new Set(names);
}

const config = {
  port: parseInt(process.env.PORT || "3000", 10),

  ashbyWebhookSecret: required("ASHBY_WEBHOOK_SECRET"),
  ashbyApiKey: process.env.ASHBY_API_KEY || "",
  ashbyAppBaseUrl: (process.env.ASHBY_APP_BASE_URL || "https://app.ashbyhq.com").replace(/\/+$/, ""),

  slackBotToken: required("SLACK_BOT_TOKEN"),

  // The safety guard. The bot only ever touches channels whose name starts with
  // this prefix, and it refuses to archive anything at all when it is unset.
  channelPrefix: normalisePrefix(required("CANDIDATE_CHANNEL_PREFIX")),

  archiveOn: parseArchiveOn(process.env.ARCHIVE_ON),

  channelDenylist: parseDenylist(process.env.CHANNEL_DENYLIST),

  // Default on, so a first deploy reports what it would close without closing
  // anything. Flip to false once the logs look right.
  dryRun: bool("DRY_RUN", true),

  postClosingNotice: bool("POST_CLOSING_NOTICE", true),

  // A candidate can be in flight for a second role. When true, the bot checks
  // the candidate's other applications and leaves the channel open while any of
  // them is still live. Needs ASHBY_API_KEY.
  requireAllApplicationsClosed: bool("REQUIRE_ALL_APPLICATIONS_CLOSED", true),

  // Public channels the bot is not in have to be joined before it can post.
  autoJoinPublic: bool("AUTO_JOIN_PUBLIC", true),

  channelCacheTtlMinutes: parseInt(process.env.CHANNEL_CACHE_TTL_MINUTES || "10", 10),

  fallbackSlackChannel: process.env.FALLBACK_SLACK_CHANNEL || "",
  debugPayloads: bool("DEBUG_PAYLOADS", false),
};

module.exports = config;
