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

const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  ashbyWebhookSecret: required("ASHBY_WEBHOOK_SECRET"),
  ashbyApiKey: process.env.ASHBY_API_KEY || "",
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
