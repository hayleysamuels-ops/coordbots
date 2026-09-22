"use strict";
const P = require("./proposal");
const INV = require("../assignment-inventory");

function list(value) { return Array.isArray(value) ? value : value?.results || []; }
function same(a, b) { return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase(); }
function idOf(value) { return value?.id || value?.jobId || value?.interviewStageId; }
function roleOf(candidate) { const value = candidate.values?.position || candidate.values?.role || candidate.position || candidate.role || ""; return /^sales$/i.test(value) ? "Sales" : value; }
function assigned(candidate,key,suggestion) {
  const value=candidate.values?.[key];
  return suggestion || (value ? {ok:true,value,display:value,reason:"Already assigned in tracker.",confirmed:true} : null);
}
function partnerEmail(partner) {
  const person=partner&&INV.personFor(partner.value);
  return person&&INV.PEOPLE[person]&&INV.PEOPLE[person].emails[0];
}
function at(day, time, timezone) {
  const [hour, minute] = time.split(":").map(Number);
  const probe = new Date(day + "T12:00:00Z");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour12:false, year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit" }).formatToParts(probe).filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));
  const represented = Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute);
  const offset = represented - probe.getTime();
  return new Date(Date.UTC(...day.split("-").map((n,i)=>i===1?+n-1:+n),hour,minute)-offset).toISOString();
}
function activities(plan) {
  const out=[]; const seen=new Set();
  (function walk(value){
    if(!value||typeof value!=="object"||seen.has(value))return;seen.add(value);
    if(value.interviewId && (value.title||value.name)) out.push(value);
    for(const child of Object.values(value)) if(child&&typeof child==="object") walk(child);
  })(plan); return out;
}
function stages(plan) {
  const out=[]; const seen=new Set();
  (function walk(value){if(!value||typeof value!=="object"||seen.has(value))return;seen.add(value);
    if((value.interviewStageId||value.stageId||value.id)&&/work trial/i.test(value.title||value.name||""))out.push(value);
    for(const child of Object.values(value))if(child&&typeof child==="object")walk(child);
  })(plan); return out;
}

function createAshbyProvider({ api, trials = async()=>[], assignments = async()=>({}) }) {
  async function source(candidate, request, resources) {
    const person=await api.candidate(candidate.values.ashbyCandidateId);
    const applications=await Promise.all(list(person.applicationIds).map(id=>api.application(typeof id==="string"?id:id.id)));
    const application=applications.find(a=>same(a.status,"Active")&&/work trial/i.test(a.currentInterviewStage?.title||a.interviewStage?.title||"")) || applications.find(a=>same(a.status,"Active"));
    if(!application)throw Object.assign(new Error("No active Ashby application was found"),{status:422});
    const jobId=idOf(application.job)||application.jobId;
    const plan=await api.interviewPlan(jobId);
    const stageId=idOf(application.currentInterviewStage||application.interviewStage);
    const stage=stages(plan).find(s=>idOf(s)===stageId)||stages(plan)[0]||plan;
    const full=same(request.sessionTitle,"Full Work Trial");
    const sessions=full ? list(stage.activities).flatMap(a=>list(a.interviews)).filter(a=>!same(a.title||a.name,"Agent Shadowing")) : [activities(stage).find(a=>same(a.title||a.name,request.sessionTitle))].filter(Boolean);
    if(!sessions.length)throw Object.assign(new Error("That session is not in the active Ashby Work Trial plan"),{status:422});
    const email=partnerEmail(resources.partner);
    if(!email)throw Object.assign(new Error("The suggested main partner has no verified Ashby email"),{status:422});
    const users=list(await api.users(email));
    const interviewer=users.find(u=>same(u.email,email)&&u.enabled!==false&&u.isEnabled!==false);
    if(!interviewer)throw Object.assign(new Error("The suggested main partner is not an enabled Ashby user"),{status:422});
    return {person,application,plan,sessions,interviewer};
  }
  async function resources(candidate,request={}) {
    const suggestions=await assignments(candidate,request);
    return {
      partner:assigned(candidate,"driName",suggestions.partner),
      desk:assigned(candidate,"desk",suggestions.desk),
      laptop:assigned(candidate,"computer",suggestions.laptop),
    };
  }
  return {
    readiness:async()=>({ready:true,blockers:[],method:"Proposal only",proposalOnly:true}),
    resources,
    async suggest(candidate,request){
      const resourceSet=await resources(candidate,request),s=await source(candidate,request,resourceSet);let cursor=at(request.startDate,request.startTime,request.timezone);
      const events=s.sessions.map((session,index)=>{const duration=Number(session.interviewDurationMinutes||session.durationMinutes||session.duration||45),start=cursor,end=new Date(Date.parse(start)+duration*60000).toISOString();cursor=end;return {key:"ashby:"+session.interviewId+":"+index,title:session.title||session.name,interviewId:session.interviewId,start,end,interviewers:[{userId:s.interviewer.id,email:s.interviewer.email,name:s.interviewer.name}],conferencing:{provider:"ashby",accountId:"interview-plan"},notify:[s.person.primaryEmailAddress?.value||s.person.email].filter(Boolean)};});
      const pilot=/^Test\b/i.test(candidate.name||"");
      const plan={kind:request.kind,candidateId:candidate.values.ashbyCandidateId,applicationId:s.application.id,templateRevision:"ashby-work-trial-api-v1",timezone:request.timezone,role:roleOf(candidate),startDate:request.startDate,endDate:request.endDate,pilot,blockers:[],events};
      plan.blockers=pilot?[]:P.capacityIssues(plan,await trials());
      plan.trackerSuggestions=resourceSet;
      plan.sourceFingerprint=api.fingerprint({applicationId:plan.applicationId,stageId:idOf(s.application.currentInterviewStage||s.application.interviewStage),interviewIds:s.sessions.map(x=>x.interviewId),interviewerId:s.interviewer.id});
      return plan;
    },
    async revalidate(plan){
      const candidate={values:{ashbyCandidateId:plan.candidateId},role:plan.role};
      const request={sessionTitle:plan.events.length>1?"Full Work Trial":plan.events[0].title};
      const resources={partner:{value:INV.displayName(INV.personForEmail(plan.events[0].interviewers[0].email))||plan.events[0].interviewers[0].email}};
      const s=await source(candidate,request,resources);
      const sourceFingerprint=api.fingerprint({applicationId:s.application.id,stageId:idOf(s.application.currentInterviewStage||s.application.interviewStage),interviewIds:s.sessions.map(x=>x.interviewId),interviewerId:s.interviewer.id});
      return {ready:sourceFingerprint===plan.sourceFingerprint,digest:P.digest(plan)};
    }
  };
}
module.exports={createAshbyProvider,at};
