"use strict";

require("dotenv").config();

// Parse "0,24,48" into a sorted, de-duplicated list of hour offsets.
// Falls back to [0, 24, 48] if unset, and to [0] if the value is unusable.
// Default: nudge at interview end, follow up at 24h, final reminder at the 48h
// SLA deadline. Anyone who has submitted is skipped at each stage.
// Interview-name substrings that should NOT get scorecard reminders (e.g.
// debriefs, which are discussions, not scored interviews). Matched
// case-insensitively. Unset -> ["debrief"]. Set to "" -> [] (disable name
// matching). Comma-separated, e.g. "debrief,panel sync".
function parsePatterns(raw) {
  if (raw === undefined) return ["debrief"];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function parseSchedule(raw) {
  const parsed = (raw || "0,24,48")
    .split(",")
    .map((s) => parseFloat(s.trim()))
    .filter((n) => !Number.isNaN(n) && n >= 0);
  const unique = [...new Set(parsed)].sort((a, b) => a - b);
  return unique.length ? unique : [0];
}

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    console.warn(`[config] Warning: ${name} is not set. See .env.example.`);
  }
  return value || "";
}

// AUTOMATIC_REMINDERS=on turns on the original behaviour: Ashby's schedule
// webhooks queue reminders that fire at REMINDER_SCHEDULE_HOURS after each
// interview. Off (the default) the bot sends nothing on its own: no webhook
// route, no 30s loop. It only sends when the dashboard asks (POST /remind).
// Pace runs it off: nobody there asked for automatic messages.
const automaticReminders = /^(on|true|1|yes)$/i.test((process.env.AUTOMATIC_REMINDERS || "").trim());

const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  automaticReminders,
  ashbyWebhookSecret: automaticReminders ? required("ASHBY_WEBHOOK_SECRET") : process.env.ASHBY_WEBHOOK_SECRET || "",
  // Shared with the dashboard, which sends it as a Bearer token on
  // POST /remind. Unset, that route doesn't exist.
  remindSecret: process.env.REMIND_SECRET || "",
  // One dashboard reminder per interviewer per interview within this many
  // hours. Kept on the volume, so a restart doesn't reset it.
  manualCooldownHours: Math.max(0, parseFloat(process.env.MANUAL_REMINDER_COOLDOWN_HOURS || "4") || 0),
  dataDir: process.env.DATA_DIR ? require("path").resolve(process.env.DATA_DIR) : require("path").join(__dirname, "..", "data"),
  ashbyApiKey: process.env.ASHBY_API_KEY || "",
  // Base URL of the Ashby web app, used to build scorecard + interview briefing
  // links from the interview event id. Only change for a custom Ashby domain.
  ashbyAppBaseUrl: (process.env.ASHBY_APP_BASE_URL || "https://app.ashbyhq.com").replace(/\/+$/, ""),
  slackBotToken: required("SLACK_BOT_TOKEN"),
  reminderDelayMinutes: parseInt(process.env.REMINDER_DELAY_MINUTES || "0", 10),
  // Hours after the interview end time to send each reminder. Default: at the
  // end, a follow-up at 24h, and a final reminder at the 48h SLA deadline.
  // Anyone who has submitted is skipped at each stage.
  reminderScheduleHours: parseSchedule(process.env.REMINDER_SCHEDULE_HOURS),
  // Interview names to skip (no scorecard reminders). Default: debriefs.
  excludeInterviewPatterns: parsePatterns(process.env.EXCLUDE_INTERVIEW_NAME_PATTERNS),
  fallbackSlackChannel: process.env.FALLBACK_SLACK_CHANNEL || "",
  debugPayloads: (process.env.DEBUG_PAYLOADS || "false").toLowerCase() === "true",
};

module.exports = config;
