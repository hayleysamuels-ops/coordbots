"use strict";
/**
 * READ-ONLY Ashby client.
 *
 * This module cannot write to Ashby. That is not a policy or a runtime check
 * that could be bypassed — it is the shape of the module:
 *
 *   - ALLOWED_ENDPOINTS below is the complete set of endpoints reachable from
 *     here. Anything else throws before a request is sent.
 *   - Every entry on that list is a read.
 *   - No exported function takes an endpoint name from its caller, so no caller
 *     can reach an endpoint that is not on the list.
 *   - There is no create/update/archive/reject/advance method to call.
 *
 * If you ever add an endpoint here, that is a deliberate act and should be
 * reviewed as one. Nothing in this repository may archive, reject, or advance
 * a candidate.
 *
 * Ashby's API is POST-for-everything with HTTP Basic auth: the API key is the
 * username and the password is empty.
 */
const { postJson } = require("./http");

const BASE = "https://api.ashbyhq.com/";

const ALLOWED_ENDPOINTS = Object.freeze([
  // bot 6 — pool health
  "interviewerPool.list",     // which pools exist
  "interviewerPool.info",     // members of a pool, and their per-pool paused state
  "user.interviewerSettings", // an interviewer's daily/weekly load limits
  // bot 1 — live panel
  "candidate.search",         // find a candidate by name, to suggest a link
  "candidate.info",           // a candidate and their applicationIds
  "application.info",         // job title and current stage for one application
  "interviewSchedule.list",   // schedules for one application (filters on applicationId)
  "applicationFeedback.list", // whether feedback was submitted, for EBS status
  "interview.info",           // an interview's title. NOTE: interview.list is
                              // incomplete — it omits most interviews actually
                              // used on schedules — so titles must be resolved
                              // one id at a time through .info.
  "interviewStage.info",      // a stage's title, e.g. "Work Trial"
  // suggestions — who is at Work Trial and not yet in the tracker.
  // application.list honours status:"Active" but ignores interviewStageId, so
  // the stage filter is applied on our side.
  "application.list",
]);
const ALLOWED = new Set(ALLOWED_ENDPOINTS);

function createAshbyClient(apiKey) {
  if (!apiKey) throw new Error("ASHBY_READ_KEY is not set");
  const auth = "Basic " + Buffer.from(apiKey + ":").toString("base64");

  async function call(endpoint, body) {
    if (!ALLOWED.has(endpoint)) {
      throw new Error("Blocked: '" + endpoint + "' is not a read endpoint on this client");
    }
    const json = await postJson(BASE + endpoint, {
      headers: { Authorization: auth },
      body: body || {},
      label: "ashby " + endpoint,
    });
    if (json && json.success === false) {
      // Ashby answers 200 with success:false and a code. Keep the code on the
      // error: "candidate_not_found" is a definite answer (the record was
      // merged or deleted), which is not the same as the API being unreachable.
      const code = (json.errorInfo && json.errorInfo.code) || (json.errors && json.errors[0]) || "unknown";
      const err = new Error("ashby " + endpoint + ": " + code);
      err.ashbyCode = code;
      throw err;
    }
    return json;
  }

  // Ashby paginates with moreDataAvailable + nextCursor.
  async function callAll(endpoint, body) {
    const out = [];
    let cursor;
    for (let page = 0; page < 50; page++) {
      const json = await call(endpoint, { ...(body || {}), limit: 100, ...(cursor ? { cursor } : {}) });
      const results = json.results || [];
      out.push(...(Array.isArray(results) ? results : []));
      if (!json.moreDataAvailable || !json.nextCursor) break;
      cursor = json.nextCursor;
    }
    return out;
  }

  return {
    listInterviewerPools: () => callAll("interviewerPool.list", {}),
    getInterviewerPool: (interviewerPoolId) =>
      call("interviewerPool.info", { interviewerPoolId }).then((j) => j.results),
    getInterviewerSettings: (userId) =>
      call("user.interviewerSettings", { userId }).then((j) => j.results),

    /* ---- bot 1 ---- */
    searchCandidates: (name) => call("candidate.search", { name }).then((j) => j.results || []),
    getCandidate: (id) => call("candidate.info", { id }).then((j) => j.results),
    getApplication: (applicationId) =>
      call("application.info", { applicationId }).then((j) => j.results),
    listSchedulesForApplication: (applicationId) =>
      callAll("interviewSchedule.list", { applicationId }),
    listFeedbackForApplication: (applicationId) =>
      callAll("applicationFeedback.list", { applicationId }),
    listActiveApplications: () => callAll("application.list", { status: "Active" }),
    getInterview: (id) => call("interview.info", { id }).then((j) => j.results),
    // Note the parameter name: this endpoint wants interviewStageId, not id.
    getInterviewStage: (interviewStageId) =>
      call("interviewStage.info", { interviewStageId }).then((j) => j.results),
  };
}

module.exports = { createAshbyClient, ALLOWED_ENDPOINTS };
