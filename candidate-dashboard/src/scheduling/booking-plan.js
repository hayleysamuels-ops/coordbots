'use strict';
// Turns one option from the calendar-checked preview (booking-routes.js,
// /suggest-full-schedule) into the plan the booking robot composes in Ashby
// (worker/booking-composer.js; its shape is in worker/booking-check.js).
//
// The option supplies the sessions: interview, title, exact times and the
// solver's interviewer, with Ashby user ID, name and email. Everything else
// comes from the application, never from the browser.
//
// Two different time zones: the preview's `timezone` is the candidate's
// availability zone. `accountTimeZone` is the zone Ashby displays for the
// account doing the booking (Anna's in production), which the robot types
// times in. They are separate inputs and are never inferred from each other.
const fail=message=>{throw Object.assign(Error(message),{status:422});};
const isUuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
const isInstant=v=>typeof v==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v));

function bookingPlanFromOption({option,application,accountTimeZone}){
  const a=application||{};
  for(const k of ['jobId','candidateId','applicationId','interviewScheduleId'])if(!isUuid(a[k]))fail(`The application is missing its ${k}.`);
  for(const [k,v] of [['candidate name',a.candidate?.name],['candidate email',a.candidate?.email],['job title',a.job?.title],['stage title',a.stage?.title],['scheduling activity',a.activityTitle]])
    if(typeof v!=='string'||!v.trim())fail(`The application is missing its ${k}.`);
  try{new Intl.DateTimeFormat('en-US',{timeZone:accountTimeZone});}catch(_){fail('The booking account\'s time zone isn\'t a valid IANA zone.');}
  if(typeof accountTimeZone!=='string'||!accountTimeZone.includes('/'))fail('The booking account\'s time zone must be an IANA zone such as America/Los_Angeles.');
  const events=option?.events;
  if(!Array.isArray(events)||!events.length)fail('The option has no sessions.');
  const sessions=events.map((e,i)=>{
    const p=e.interviewer,label=`Session ${i+1}`;
    if(!isUuid(e.interviewId)||typeof e.title!=='string'||!e.title)fail(`${label} has no interview.`);
    if(!isInstant(e.start)||!isInstant(e.end)||Date.parse(e.end)<=Date.parse(e.start))fail(`${label} ("${e.title}") doesn't have exact start and end times.`);
    if(!p||!isUuid(p.userId)||typeof p.name!=='string'||!/^\S+@\S+\.\S+$/.test(p.email||''))fail(`${label} ("${e.title}") has no fully identified interviewer.`);
    return {title:e.title,interviewId:e.interviewId,start:new Date(e.start).toISOString(),end:new Date(e.end).toISOString(),
      interviewers:[{userId:p.userId,name:p.name,email:p.email.toLowerCase()}]};
  });
  for(let i=1;i<sessions.length;i++)if(Date.parse(sessions[i].start)<Date.parse(sessions[i-1].end))fail(`Sessions ${i} and ${i+1} overlap.`);
  return {jobId:a.jobId,candidateId:a.candidateId,applicationId:a.applicationId,interviewScheduleId:a.interviewScheduleId,timeZone:accountTimeZone,
    candidate:{name:a.candidate.name,email:a.candidate.email.toLowerCase()},job:{title:a.job.title},stage:{title:a.stage.title},activityTitle:a.activityTitle,sessions};
}

// The plan for an option being posted to Slack, from the dashboard's verified
// full plan (booking-routes.js fullPlan: facts.application plus the pending
// schedule). The scheduling activity is the one stage activity holding every
// session's interview; its title is the card heading Ashby shows.
//
// The zone the robot types times in is the candidate's availability zone,
// not Anna's account zone: in Anna's session (October 14, 2026) TEST's
// composer showed America/Denver, TEST's availability zone, and the Denver
// plan passed every check. Still unconfirmed for other candidates; a wrong
// zone refuses at the composer before any save.
//
// Returns {plan} or {plan:null,reason}; a post never fails for want of one.
function bookingPlanForPost({fullPlan,option,timezone}){
  try{
    const ids=(option?.events||[]).map(e=>e.interviewId);
    const holding=(fullPlan?.activities||[]).filter(a=>ids.length&&ids.every(id=>a.sessions.some(s=>s.interviewId===id)));
    if(holding.length!==1)return {plan:null,reason:holding.length?'More than one scheduling activity holds these interviews.':'No scheduling activity holds every interview.'};
    return {plan:bookingPlanFromOption({option,accountTimeZone:timezone,application:{jobId:fullPlan.jobId,candidateId:fullPlan.candidateId,applicationId:fullPlan.applicationId,
      interviewScheduleId:fullPlan.scheduleId,candidate:{name:fullPlan.candidateName,email:fullPlan.candidateEmail},job:{title:fullPlan.jobTitle},stage:{title:fullPlan.stageTitle},activityTitle:holding[0].title}})};
  }catch(e){return {plan:null,reason:e.message};}
}

module.exports={bookingPlanFromOption,bookingPlanForPost};
