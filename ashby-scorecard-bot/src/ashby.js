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

// Note: in Ashby's payload, `isFeedbackRequired` and `feedbackLink` live on each
// interviewer, not on the event. We also drop interviewers explicitly marked as
// not required to give feedback (e.g. shadowers) so they aren't nagged.
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
      const userId = pick(i, ["userId", "id", "interviewerId"]);
      const feedbackRequired = pick(i, ["isFeedbackRequired"]);
      return { email, name, userId, feedbackRequired };
    })
    .filter((i) => i.email && i.feedbackRequired !== false);
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
      // The interview's name and debrief status aren't in the webhook — only
      // this reference. We look them up via interview.info when deciding
      // whether to schedule (see interviewExclusionReason).
      interviewId: pick(event, ["interviewId", "interview_id"]),
      scheduleId,
      applicationId,
      endTime, // ISO 8601 string
      cancelled: isCancelled(event),
      // Event-level (not per-interviewer) link to submit feedback; used to build
      // the scorecard + interview briefing links. May be absent — we can also
      // build both from the event id (see interviewLinks).
      feedbackLink: pick(event, ["feedbackLink", "feedbackFormUrl", "submitFeedbackLink"]),
      interviewName: "your interview", // filled from interview.info if available
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
    return {
      candidateName: candidate.name,
      jobTitle: job.title,
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

// Cache interview.info lookups (interviews rarely change) so a schedule with
// several events, or repeated webhooks, doesn't re-fetch the same interview.
const interviewInfoCache = new Map();

/**
 * Fetch an interview's metadata by id. Returns
 * { title, isDebrief, isFeedbackRequired } or null if we can't determine it
 * (no API key, or the call failed). Requires the `interviewsRead` permission.
 */
async function getInterviewInfo(interviewId) {
  if (!interviewId || !config.ashbyApiKey) return null;
  if (interviewInfoCache.has(interviewId)) return interviewInfoCache.get(interviewId);
  try {
    const res = await fetch("https://api.ashbyhq.com/interview.info", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: ashbyAuthHeader(),
      },
      body: JSON.stringify({ id: interviewId }),
    });
    if (!res.ok) {
      console.warn(`[ashby] interview.info -> HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    if (json.success === false) return null;
    const r = json.results || {};
    const info = {
      title: r.title,
      isDebrief: r.isDebrief === true,
      isFeedbackRequired: r.isFeedbackRequired,
    };
    interviewInfoCache.set(interviewId, info);
    return info;
  } catch (err) {
    console.warn("[ashby] interview.info failed:", err.message);
    return null;
  }
}

/**
 * Given interview.info, decide whether it should be skipped for scorecard
 * reminders. Returns a reason string, or null to proceed. When info is null
 * (couldn't look it up) we return null — better to remind than to silently drop.
 */
function interviewExclusionReason(info) {
  if (!info) return null;
  if (info.isDebrief) return "debrief";
  if (info.isFeedbackRequired === false) return "no scorecard required";
  const name = (info.title || "").toLowerCase();
  const hit = config.excludeInterviewPatterns.find((p) => name.includes(p));
  if (hit) return `interview name matches "${hit}"`;
  return null;
}

/**
 * Resolve the interviewId for a given event within a schedule — used to
 * classify reminders persisted before we started recording interviewId.
 * Returns the interviewId string or null.
 */
async function interviewIdForEvent(scheduleId, eventId) {
  if (!scheduleId || !eventId || !config.ashbyApiKey) return null;
  try {
    const res = await fetch("https://api.ashbyhq.com/interviewEvent.list", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: ashbyAuthHeader(),
      },
      body: JSON.stringify({ interviewScheduleId: scheduleId }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const events = json.results || [];
    const match = events.find((e) => pick(e, ["id", "interviewEventId"]) === eventId);
    return match ? pick(match, ["interviewId", "interview_id"]) : null;
  } catch (err) {
    console.warn("[ashby] interviewEvent.list failed:", err.message);
    return null;
  }
}

/**
 * Build the scorecard + interview briefing links for an event. Ashby's URL
 * pattern is `<base>/interview-briefings/<eventId>` for the brief and
 * `.../feedback` for the scorecard form. We prefer the real event feedbackLink
 * when present (it carries the correct base, e.g. a custom domain), and
 * otherwise construct both from the event id so they're ALWAYS present.
 */
function interviewLinks(eventId, eventFeedbackLink) {
  let scorecardUrl = null;
  let briefingUrl = null;
  if (eventFeedbackLink) {
    scorecardUrl = eventFeedbackLink;
    const stripped = eventFeedbackLink.replace(/\/feedback\/?$/i, "");
    if (stripped && stripped !== eventFeedbackLink) briefingUrl = stripped;
  }
  if (eventId) {
    const base = `${config.ashbyAppBaseUrl}/interview-briefings/${eventId}`;
    if (!briefingUrl) briefingUrl = base;
    if (!scorecardUrl) scorecardUrl = `${base}/feedback`;
  }
  return { scorecardUrl, briefingUrl };
}

module.exports = {
  parseWebhook,
  enrichApplication,
  listSubmittedFeedback,
  getInterviewInfo,
  interviewExclusionReason,
  interviewIdForEvent,
  interviewLinks,
};
