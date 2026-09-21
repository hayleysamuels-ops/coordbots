"use strict";
const express = require("express");
function bookingRoutes({ engine, store, clientId, facts, inspectDraft, inspectCalendar, availability, capabilities = async () => ({ available: false, reason: "Ashby calendar and booking automation are not connected yet." }) }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!req.schedulingUser?.canApprove) return res.status(403).json({ error: "Sign in with your coordinator account to review and approve bookings." });
    if (req.method !== "GET") {
      if (!req.is("application/json") || req.get("X-Scheduling-Request") !== "1" || req.get("Sec-Fetch-Site") === "cross-site") return res.status(403).json({ error: "Invalid booking request" });
      try { if (req.get("Origin") && new URL(req.get("Origin")).host !== req.get("host")) throw Error(); }
      catch (_) { return res.status(403).json({ error: "Cross-site booking request refused" }); }
    }
    next();
  });
  const handle = fn => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) { res.status(e.status || 503).json({ error: e.status ? e.message : "Could not confirm booking status. Refresh before taking further action." }); }
  };
  async function freshFacts(req){
    let input=req.body,submission;
    if(input.availabilitySource==='ashby'){
      if(!availability)throw Object.assign(Error('Submitted availability is not connected.'),{status:503});
      submission=await availability.load({applicationId:input.applicationId,scheduleId:input.scheduleId});
      if(!submission.windows.length)throw Object.assign(Error('No future submitted availability was found in the checked range. Request new times or enter a coordinator override.'),{status:409});
      input={...input,windows:submission.localWindows,timezone:submission.timezone};
    }
    const verified=await facts.load(input);
    if(submission){
      if(verified.stageId!==submission.stageId)throw Object.assign(Error('The candidate stage changed. Reload availability.'),{status:409});
      verified.candidateAvailability={source:submission.source,scheduleId:submission.scheduleId,revision:submission.revision,checkedAt:submission.checkedAt};
      verified.sourceFingerprint=require('./service').digest({facts:verified.sourceFingerprint,availability:{source:submission.source,scheduleId:submission.scheduleId,revision:submission.revision}});
    }
    return verified;
  }
  router.get("/", handle(async req => ({ clientId, coordinator: req.schedulingUser.id, capabilities: await capabilities(), drafts: (await store.list()).filter(r => r.clientId === clientId) })));
  router.post("/availability-requests", handle(req => {if(!availability)throw Object.assign(Error('Submitted availability is not connected.'),{status:503});return availability.requests(req.body.applicationId);}));
  router.post("/availability", handle(req => {if(!availability)throw Object.assign(Error('Submitted availability is not connected.'),{status:503});return availability.load({applicationId:req.body.applicationId,scheduleId:req.body.scheduleId});}));
  router.post("/application", handle(req => {
    if(!facts)throw Object.assign(new Error('Ashby details are not connected.'),{status:503});
    return facts.application(req.body.applicationId);
  }));
  router.post("/inspect-draft", handle(async req => {
    if (!facts || !inspectDraft) throw Object.assign(new Error("Ashby draft inspection is not connected."), {status:503});
    const verified=await freshFacts(req);
    return inspectDraft({draftId:req.body.draftId,applicationId:verified.applicationId,candidateId:verified.candidateId,candidateName:verified.candidateName});
  }));
  router.post("/inspect-calendar", handle(async req => {
    if(!facts||!inspectCalendar)throw Object.assign(Error('Calendar inspection is not connected.'),{status:503});
    const verified=await freshFacts(req);
    const override=require('./working-hours').workingHoursOverride(req.body.workingHoursOverride,req.schedulingUser);
    const calendar=await inspectCalendar({draftId:req.body.draftId,applicationId:verified.applicationId,candidateId:verified.candidateId,candidateName:verified.candidateName,interviewer:verified.interviewer,windows:verified.windows,timezone:verified.timezone});
    return {...calendar,workingHoursOverride:override,suggestions:require('./calendar-suggestions').tentativeSuggestions({facts:verified,calendar,override})};
  }));
  router.post("/details", handle(req => {
    if (!facts) throw Object.assign(new Error("Ashby interview details are not connected."), { status: 503 });
    return freshFacts(req);
  }));
  router.post("/drafts", handle(req => engine.draft(req.body, req.schedulingUser)));
  router.post("/:id/reject", handle(req => engine.reject(req.params.id, req.body, req.schedulingUser)));
  router.post("/:id/approve", handle(async req => {
    // Approval and dispatch occur in a single request. The durable engine claims
    // the operation before any external write; a lost response cannot retry it.
    const approved = await engine.approve(req.params.id, req.body, req.schedulingUser);
    await engine.execute(approved.id);
    return store.get(approved.id);
  }));
  return router;
}
module.exports = { bookingRoutes };
