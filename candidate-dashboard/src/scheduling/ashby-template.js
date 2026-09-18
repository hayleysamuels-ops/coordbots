"use strict";
// Only documented read endpoints. The read key is never used for booking.
function createTemplateReader(key, request = fetch) {
  async function read(endpoint, body) {
    if (!key) throw Object.assign(new Error("Ashby read connection is not configured"), { status: 503 });
    const response = await request("https://api.ashbyhq.com/" + endpoint, { method: "POST", signal: AbortSignal.timeout(20000),
      headers: { Authorization: "Basic " + Buffer.from(key + ":").toString("base64"), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok || data.success !== true) throw Object.assign(new Error("The current Ashby application or interview plan could not be read."), { status: 503 });
    return data.results;
  }
  return async applicationId => {
    const application = await read("application.info", { applicationId });
    if (application.status !== "Active") throw Object.assign(new Error("This application is no longer active."), { status: 409 });
    const plan = await read("jobInterviewPlan.info", { jobId: application.job?.id || application.jobId });
    const stageId = application.currentInterviewStage?.id;
    const stage = (plan.stages || []).find(s => s.id === stageId);
    if (!stage) throw Object.assign(new Error("The active stage is missing from the published interview plan."), { status: 422 });
    return { applicationId, candidateId: application.candidate?.id, stageId, stageTitle: stage.title,
      activities: (stage.activities || []).map(a => ({ id: a.id, title: a.title, sessions: (a.interviews || []).filter(i => i.isSchedulable === true).map(i => ({ interviewId: i.interviewId, title: i.title, durationMinutes: i.interviewDurationMinutes })) })).filter(a => a.sessions.length),
      availabilityVerified: false };
  };
}
module.exports = { createTemplateReader };
