"use strict";
const crypto = require("crypto");
const { postJson } = require("../http");
const BASE = "https://api.ashbyhq.com/";

function createAshbySchedulingApi(apiKey, request = postJson) {
  if (!apiKey) throw new Error("ASHBY_SCHEDULING_KEY is not set");
  const auth = "Basic " + Buffer.from(apiKey + ":").toString("base64");
  async function call(endpoint, body) {
    const json = await request(BASE + endpoint, { headers: { Authorization: auth }, body: body || {}, label: "ashby scheduling " + endpoint });
    if (!json || json.success === false) {
      const code = json?.errorInfo?.code || json?.errors?.[0] || "unknown";
      throw Object.assign(new Error("Ashby rejected " + endpoint + ": " + code), { ashbyCode: code });
    }
    return json.results;
  }
  return {
    candidate: id => call("candidate.info", { id }),
    application: applicationId => call("application.info", { applicationId }),
    interviewPlan: jobId => call("jobInterviewPlan.info", { jobId }),
    users: email => call("user.search", { email }),
    schedules: applicationId => call("interviewSchedule.list", { applicationId, limit: 100 }),
    createSchedule: input => call("interviewSchedule.create", input),
    updateSchedule: input => call("interviewSchedule.update", input),
    fingerprint(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); },
  };
}
module.exports = { createAshbySchedulingApi };
