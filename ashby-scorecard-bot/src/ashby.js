"use strict";

const config = require("./config");

/**
 * Ashby does NOT emit an "interview ended" webhook. The interview-related
 * events are `interviewScheduleCreate` and `interviewScheduleUpdate`, which
 * fire when a schedule is created or changed. Each carries the schedule and
 * its interview events, and every event has a scheduled `endTime`.
 *
 * So the strategy is: when one of these webhooks arrives, read every interview
 * event, and schedule a reminder to fire at each event's end time. The
 * scheduler (see reminders.js) is what actually "waits" until the interview
 * ends.
 *
 * This parser is deliberately defensive about field names. Ashby's payload
 * uses camelCase and nests the schedule under `data`, but exact keys can vary
 * across event versions. Run once with DEBUG_PAYLOADS=true and confirm against
 * a real payload; adjust the pick() calls below if anything is named
 * differently in your workspace.
 */

// Grab the first present, non-empty value among a list of candidate keys.
function pick(obj, keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function getSchedule(payload) {
  const data = payload.data || payload;
  return (
    data.interviewSchedule ||
    data.interview_schedule ||
    data.schedule ||
    null
  );
}

function getInterviewEvents(schedule) {
  if (!schedule) return [];
  const events =
    schedule.interviewEvents ||
    schedule.interview_events ||
    schedule.events ||
    [];
  return Array.isArray(events) ? events : [];
}

function getInterviewers(event) {
  const list = event.interviewers || event.interviewerUsers || [];
  if (!Array.isArray(list)) return [];
  return list
    .map((i) => {
      const email = pick(i, ["email", "userEmail", "emailAddress"]);
      const first = pick(i, ["firstName", "first_name"]) || "";
      const last = pick(i, ["lastName", "last_name"]) || "";
      const name =
        pick(i, ["name", "fullName"]) || `${first} ${last}`.trim() || email;
      // Ashby gives each interviewer a direct link to submit their scorecard.
      const feedbackLink = pick(i, [
        "feedbackLink",
        "feedbackFormUrl",
        "submitFeedbackLink",
      ]);
      const userId = pick(i, ["userId", "id", "interviewerId"]);
      return { email, name, feedbackLink, userId };
    })
    .filter((i) => i.email); // can't DM without an email to look up
}

function isCancelled(event) {
  const status = (pick(event, ["status", "state"]) || "").toString().toLowerCase();
  return status.includes("cancel");
}

/**
 * Turn a webhook payload into a flat list of per-interview-event reminders.
 * Returns { action, scheduleId, reminders: [...] }.
 */
function parseWebhook(payload) {
  const action = pick(payload, ["action", "event", "type"]) || "unknown";
  const schedule = getSchedule(payload);
  const scheduleId = schedule
    ? pick(schedule, ["id", "interviewScheduleId"])
    : undefined;
  const applicationId = schedule
    ? pick(schedule, ["applicationId", "application_id"])
    : undefined;

  const events = getInterviewEvents(schedule);
  const reminders = [];

  for (const event of events) {
    const eventId = pick(event, ["id", "interviewEventId"]);
    const endTime = pick(event, ["endTime", "end_time", "scheduledEndTime"]);
    if (!eventId || !endTime) continue;

    reminders.push({
      interviewEventId: eventId,
      scheduleId,
      applicationId,
      endTime, // ISO 8601 string
      cancelled: isCancelled(event),
      interviewName:
        pick(event, ["title", "name", "interviewTitle"]) || "your interview",
      interviewers: getInterviewers(event),
    });
  }

  return { action, scheduleId, applicationId, reminders };
}

/**
 * Optional enrichment: fetch candidate name + job title from the Ashby API
 * using the applicationId, when the webhook didn't include them. No-op unless
 * ASHBY_API_KEY is set. Failures are swallowed — enrichment is best-effort.
 */
async function enrichApplication(applicationId) {
  if (!applicationId || !config.ashbyApiKey) return {};
  try {
    const auth = Buffer.from(`${config.ashbyApiKey}:`).toString("base64");
    const res = await fetch("https://api.ashbyhq.com/application.info", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ applicationId }),
    });
    if (!res.ok) return {};
    const json = await res.json();
    const results = json.results || {};
    const candidate = results.candidate || {};
    const job = results.job || {};
    const candidateId = pick(candidate, ["id"]);
    return {
      candidateName: candidate.name,
      jobTitle: job.title,
      // Deep link to the candidate's profile in the Ashby web app. Base URL is
      // configurable (ASHBY_APP_BASE_URL) for orgs on a custom domain.
      candidateProfileUrl: candidateId
        ? `${config.ashbyAppBaseUrl}/candidates/${candidateId}`
        : undefined,
    };
  } catch (err) {
    console.warn("[ashby] enrichment failed:", err.message);
    return {};
  }
}

function ashbyAuthHeader() {
  const auth = Buffer.from(`${config.ashbyApiKey}:`).toString("base64");
  return `Basic ${auth}`;
}

/**
 * List feedback/scorecards already submitted for an application.
 *
 * Returns an array of { submitterEmail, submitterUserId, interviewEventId }
 * for each submission, or `null` when we can't check (no API key, or the call
 * failed). `null` is meaningful: the caller treats "can't verify" as "go ahead
 * and remind" so we never suppress a reminder we aren't sure about.
 *
 * Requires an ASHBY_API_KEY with the `candidatesRead` permission.
 */
async function listSubmittedFeedback(applicationId) {
  if (!applicationId || !config.ashbyApiKey) return null;
  try {
    const res = await fetch("https://api.ashbyhq.com/applicationFeedback.list", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: ashbyAuthHeader(),
      },
      body: JSON.stringify({ applicationId }),
    });
    if (!res.ok) {
      console.warn(`[ashby] applicationFeedback.list -> HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    if (json.success === false) return null;
    const results = json.results || [];
    return results.map((f) => {
      const user = f.submittedByUser || f.user || {};
      const event = f.interviewEvent || {};
      return {
        submitterEmail: pick(user, ["email", "emailAddress"]) || pick(f, ["userEmail"]) || null,
        submitterUserId:
          pick(user, ["id", "userId"]) ||
          pick(f, ["submittedByUserId", "userId"]) ||
          null,
        interviewEventId:
          pick(f, ["interviewEventId", "interviewEventID"]) ||
          pick(event, ["id"]) ||
          null,
      };
    });
  } catch (err) {
    console.warn("[ashby] applicationFeedback.list failed:", err.message);
    return null;
  }
}

module.exports = { parseWebhook, enrichApplication, listSubmittedFeedback };
