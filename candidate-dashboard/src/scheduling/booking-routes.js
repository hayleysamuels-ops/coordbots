"use strict";
const express = require("express");
function bookingRoutes({ engine, store, clientId, discussion = null, rules = null, facts, inspectDraft, inspectCalendar, inspectPlan, inspectFullCalendar, availability, googleCalendar, googleFreeBusy, capabilities = async () => ({ available: false, reason: "Ashby calendar and booking automation are not connected yet." }) }) {
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
  async function fullPlan(req){
    if(!facts||!availability||!inspectPlan)throw Object.assign(Error('Full interview plan reading is not connected.'),{status:503});
    const plan=await facts.application(req.body.applicationId);
    const pending=await availability.requests(plan.applicationId);
    const request=pending.requests.find(r=>r.scheduleId===req.body.scheduleId);
    if(!request||pending.stageId!==plan.stageId)throw Object.assign(Error('Choose a current pending schedule for this stage.'),{status:409});
    const observed=await inspectPlan({...plan,scheduleId:request.scheduleId});
    if(observed.applicationId!==plan.applicationId||observed.candidateId!==plan.candidateId||observed.scheduleId!==request.scheduleId)throw Object.assign(Error('The interview plan belongs to another request.'),{status:409});
    const expected=plan.activities.flatMap(a=>a.sessions);
    if(!Array.isArray(observed.sessions)||observed.sessions.length!==expected.length||observed.sessions.some((s,i)=>s.sessionId!==expected[i].sessionId||s.interviewId!==expected[i].interviewId||s.durationMinutes!==expected[i].durationMinutes))throw Object.assign(Error('The template interviews no longer match the published plan.'),{status:409});
    const latest=await availability.requests(plan.applicationId);
    if(latest.stageId!==plan.stageId||!latest.requests.some(r=>r.scheduleId===request.scheduleId&&r.updatedAt===request.updatedAt))throw Object.assign(Error('The pending schedule changed. Reload its plan.'),{status:409});
    const after=await facts.application(plan.applicationId);
    if(after.templateRevision!==plan.templateRevision)throw Object.assign(Error('The interview plan changed. Reload it.'),{status:409});
    // Before anything uses the plan: drop listed interviewers Ashby no longer
    // counts as eligible (deactivated accounts), holding the exact count.
    const sessions=facts.excludeDeactivated?await facts.excludeDeactivated(observed.sessions):observed.sessions;
    return {...plan,scheduleId:request.scheduleId,sessions,checkedAt:observed.checkedAt,bookingEnabled:false};
  }
  router.post('/full-plan',handle(fullPlan));
  router.post('/calendar-availability',handle(async req=>{
    if(!googleCalendar?.status().connected||!googleFreeBusy)throw Object.assign(Error('Connect read-only Google Calendar availability first.'),{status:409});
    const plan=await fullPlan(req),resolved=await facts.resolveInterviewers(plan.sessions);
    const submission=await availability.load({applicationId:plan.applicationId,scheduleId:plan.scheduleId});
    if(submission.stageId!==plan.stageId||!submission.windows.length)throw Object.assign(Error('Reload the candidate’s current submitted availability.'),{status:409});
    const windows=require('./booking-planner').windowsToInstants(submission.localWindows,submission.timezone);
    const rows=await googleFreeBusy.read({calendarIds:resolved.interviewers.map(p=>p.email),timeMin:new Date(Math.min(...windows.map(w=>w.start))).toISOString(),timeMax:new Date(Math.max(...windows.map(w=>w.end))).toISOString()});
    const pendingAfter=await availability.requests(plan.applicationId);
    if(pendingAfter.stageId!==plan.stageId||!pendingAfter.requests.some(r=>r.scheduleId===plan.scheduleId&&r.updatedAt===submission.requestUpdatedAt))throw Object.assign(Error('Candidate availability changed during the calendar check. Read it again.'),{status:409});
    const after=await facts.application(plan.applicationId);
    if(after.stageId!==plan.stageId||after.templateRevision!==plan.templateRevision)throw Object.assign(Error('The interview plan changed during the calendar check.'),{status:409});
    return {applicationId:plan.applicationId,scheduleId:plan.scheduleId,timezone:submission.timezone,source:'google-calendar-freebusy',bookingEnabled:false,availabilityVerified:false,
      reason:'Primary-calendar busy times were read from Google. Additional blocking calendars, Ashby meeting hours and interview limits must also be verified before a complete agenda can be marked available.',
      calendars:resolved.interviewers.map(p=>({...p,...rows.find(r=>r.calendarId===p.email)}))};
  }));
  router.post('/inspect-full-calendar',handle(async req=>{
    if(!inspectFullCalendar)throw Object.assign(Error('Full calendar inspection is not connected.'),{status:503});
    const plan=await fullPlan(req);
    const result=await inspectFullCalendar({...plan,draftId:req.body.draftId});
    if(result.applicationId!==plan.applicationId||result.candidateId!==plan.candidateId||result.draftId!==req.body.draftId)throw Object.assign(Error('The calendar assessment belongs to another draft.'),{status:409});
    return result;
  }));
  // Each option carries a digest of itself, so posting one can prove the
  // server rebuilt exactly the option the coordinator saw.
  const optionDigest=p=>require('./service').digest(p);
  async function suggestFull(req){
    const plan=await fullPlan(req);
    let windows=req.body.windows,timezone=req.body.timezone;
    if(req.body.availabilitySource==='ashby'){
      const submission=await availability.load({applicationId:plan.applicationId,scheduleId:plan.scheduleId});
      if(submission.stageId!==plan.stageId)throw Object.assign(Error('The candidate stage changed. Reload the plan.'),{status:409});
      windows=submission.localWindows;timezone=submission.timezone;
    }else if(req.body.availabilitySource!=='manual')throw Object.assign(Error('Choose an availability source.'),{status:422});
    const result=req.body.calendarCheck===true?await calendarChecked(plan,windows,timezone):unchecked(plan,windows,timezone);
    return {plan,result:{...result,proposals:result.proposals.map(p=>({...p,optionDigest:optionDigest(p)})),candidateName:plan.candidateName,checkedAt:plan.checkedAt}};
  }
  // Without calendar checks: back-to-back agendas with this client's start
  // windows applied (never silently skipped, so rules must be loaded), and the
  // result names what isn't checked.
  function unchecked(plan,windows,timezone){
    if(!rules)throw Object.assign(Error('Scheduling rules are not loaded.'),{status:503});
    const clientRules=rules.get();
    const sessions=plan.sessions.map(s=>{const w=clientRules.placementFor(s.title);return w.length?{...s,placementWindows:w}:s;});
    return require('./full-schedule').proposeFullSchedule({sessions,windows,timezone});
  }
  // Calendar-constrained options: interviewers' primary Google calendars as a
  // hard constraint, meeting hours assumed from client rules, zero limits
  // excluded (calendar-inputs.js). Anyone excluded is listed with the result.
  async function calendarChecked(plan,windows,timezone){
    if(!googleCalendar?.status().connected||!googleFreeBusy)throw Object.assign(Error('Connect read-only Google Calendar availability first.'),{status:409});
    if(!rules)throw Object.assign(Error('Scheduling rules are not loaded.'),{status:503});
    const inputs=await require('./calendar-inputs').buildCalendarInputs({plan,windows,timezone,rules:rules.get(),facts,freeBusy:googleFreeBusy});
    const startWindowsApplied=(inputs.sessions||[]).flatMap(s=>(s.placementWindows||[]).map(w=>({title:s.title,earliestStart:w.earliestStart,latestStart:w.latestStart,timezone:w.timezone})));
    const context={calendarCheck:{excluded:inputs.excluded,meetingHours:inputs.meetingHours,limitsPolicy:inputs.limitsPolicy,busySource:inputs.busySource,rulesRevision:inputs.rulesRevision,startWindowsApplied}};
    if(inputs.blocked){const totalMinutes=plan.sessions.reduce((n,s)=>n+s.durationMinutes,0);return {status:'no_calendar_fit',bookingEnabled:false,availabilityVerified:false,meetingHoursAssumed:true,totalMinutes,timezone,proposals:[],reason:inputs.blocked,...context};}
    const result=require('./full-calendar-schedule').proposeCalendarSchedule({sessions:inputs.sessions,windows,timezone,calendars:inputs.calendars,...inputs.agenda});
    // One line per no-fit, reason counts only (no names): the running evidence
    // for how often busy time, rather than hours or limits, is what binds.
    if(result.diagnosis){const d=result.diagnosis,c=d.conflicts;console.log(`[calendar-check] no fit: placed ${d.furthest.placed}/${d.furthest.of}; unblock=${d.unblock.map(u=>u.kind==='combination'?u.changes.map(x=>x.kind).join('+'):u.kind==='hours'?`hours-${u.changes[0].hoursSource}`:u.kind==='placement'?`placement-breaks${u.changes[0].currentBreaks.count}x${u.changes[0].currentBreaks.maxMinutes}-fits${u.changes[0].fitsWithBreaks?`${u.changes[0].fitsWithBreaks.count}x${u.changes[0].fitsWithBreaks.maxMinutes}`:'none'}`:u.kind).join(',')||'none'}; rejected busy=${c.busy} hours-default=${c.hours.default} hours-override=${c.hours.override} hours-verified=${c.hours.verified} limits=${c.limits} placement=${c.placement}`);}
    return {...result,...context};
  }
  router.post('/suggest-full-schedule',handle(async req=>(await suggestFull(req)).result));
  // Posts one option to this client's configured Slack channel for discussion.
  // The option is rebuilt here from the current Ashby plan and availability;
  // only its index and digest come from the browser, and the channel never does.
  router.post('/post-full-schedule-option',handle(async req=>{
    if(!discussion)throw Object.assign(Error('Slack discussion posting is not connected.'),{status:503});
    const index=req.body.optionIndex;
    if(!Number.isInteger(index)||index<0||typeof req.body.optionDigest!=='string')throw Object.assign(Error('Choose a schedule option.'),{status:422});
    const {plan,result}=await suggestFull(req),option=result.proposals[index];
    if(!option||option.optionDigest!==req.body.optionDigest)throw Object.assign(Error('The schedule options changed. Suggest the full schedule again.'),{status:409});
    const {optionDigest:ref,...chosen}=option;
    // Attendance comes from this client's rules; names are resolved to Ashby
    // emails only when the rules list overrides (rules.js).
    if(!rules)throw Object.assign(Error('Scheduling rules are not loaded, so interviewer attendance can\'t be confirmed.'),{status:503});
    const clientRules=rules.get(),attendance=await require('./rules').attendanceForEvents(clientRules,chosen.events,facts?.resolveInterviewers);
    return discussion.postScheduleOption({applicationId:plan.applicationId,candidateId:plan.candidateId,timezone:result.timezone,option:chosen,optionNumber:index+1,
      sourceRef:`full-schedule:${plan.scheduleId}:${ref}`,availabilitySource:req.body.availabilitySource,attendance,rulesRevision:clientRules.rulesRevision,
      calendarCheck:result.status==='calendar_checked'?{checkedAt:result.calendarCheckedAt,meetingHoursAssumed:result.meetingHoursAssumed===true}:null},req.schedulingUser);
  }));
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
