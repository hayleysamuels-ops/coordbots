"use strict";

const config = require("./config");

/**
 * Ashby fires `applicationUpdate` whenever an application changes, and the
 * payload carries the application's `status`, one of Active, Hired, Archived or
 * Lead. That single event covers both outcomes we care about: an archive sets
 * status to Archived, and a hire sets it to Hired.
 *
 * `candidateHire` fires alongside a hire and is accepted too, so the bot still
 * works if only that webhook is wired up. Ashby stamps related events with the
 * same webhookActionId, and the dedupe store keys on application + outcome, so
 * receiving both produces one archive, not two.
 *
 * Payload shape (confirmed against developers.ashbyhq.com):
 *   { action, data: { application: { id, status, candidate: { id, name },
 *     job: { id, title }, archiveReason: { text, reasonType }, archivedAt } } }
 */

function pick(obj, keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function getApplication(payload) {
  const data = payload.data || payload;
  return data.application || data.candidateApplication || null;
}

/**
 * Read a webhook payload into the facts the handler needs.
 * `outcome` is "hired", "archived", or null when the event is not terminal.
 */
function parseWebhook(payload) {
  const action = pick(payload, ["action", "event", "type"]) || "unknown";
  const application = getApplication(payload);
  if (!application) return { action, outcome: null };

  const candidate = application.candidate || {};
  const job = application.job || {};
  const status = (pick(application, ["status"]) || "").toString();
  const archiveReason = application.archiveReason || {};

  let outcome = null;
  if (status.toLowerCase() === "hired" || action === "candidateHire") {
    outcome = "hired";
  } else if (status.toLowerCase() === "archived") {
    outcome = "archived";
  }

  const candidateId = pick(candidate, ["id"]);

  return {
    action,
    outcome,
    status,
    applicationId: pick(application, ["id", "applicationId"]),
    candidateId,
    candidateName: pick(candidate, ["name", "fullName"]) || "",
    jobTitle: pick(job, ["title", "name"]) || "",
    archiveReasonText: pick(archiveReason, ["text"]) || "",
    candidateProfileUrl: candidateId
      ? `${config.ashbyAppBaseUrl}/candidates/${candidateId}`
      : "",
  };
}

function ashbyAuthHeader() {
  const auth = Buffer.from(`${config.ashbyApiKey}:`).toString("base64");
  return `Basic ${auth}`;
}

async function ashbyPost(endpoint, body) {
  const res = await fetch(`https://api.ashbyhq.com/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: ashbyAuthHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status}`);
  const json = await res.json();
  if (json.success === false) throw new Error(`${endpoint} -> ${json.errors || "unsuccessful"}`);
  return json.results || {};
}

/**
 * Does this candidate still have a live application somewhere else?
 *
 * Returns true when at least one OTHER application is Active or Lead, false
 * when every other application is closed, and null when we could not check (no
 * API key, or the lookup failed). The handler treats null as "go ahead", the
 * same best-effort stance the scorecard bot takes, so a lookup blip never
 * strands a channel open forever.
 *
 * Needs an API key with candidatesRead.
 */
async function hasOtherLiveApplication(candidateId, currentApplicationId) {
  if (!candidateId || !config.ashbyApiKey) return null;
  try {
    const candidate = await ashbyPost("candidate.info", { id: candidateId });
    const ids = (candidate.applicationIds || []).filter((id) => id !== currentApplicationId);
    if (ids.length === 0) return false;

    for (const id of ids) {
      const application = await ashbyPost("application.info", { applicationId: id });
      const status = (application.status || "").toLowerCase();
      if (status === "active" || status === "lead") return true;
    }
    return false;
  } catch (err) {
    console.warn(`[ashby] Could not check other applications for ${candidateId}: ${err.message}`);
    return null;
  }
}

module.exports = { parseWebhook, hasOtherLiveApplication };
