'use strict';
// What the booking robot may touch, shared by the dry run (booking-dry-run.js)
// and the Slack-approved check (booking-compose.js): the opted-in jobs, and
// the plan checks made before a session is read or a browser starts.
const NOTICE_MINUTES=15;

// Which jobs the robot may compose for, and which it may also send for: the
// worker's BOOKING_COMPOSE_JOBS and BOOKING_SEND_JOBS (Hayley, 2026-10-27:
// per job, set in the worker's variables, so opting a job in or out needs no
// commit; Railway access is the gate). Each is JSON naming job IDs, with
// "all" or the stage titles allowed:
//   {"837cc1e9-15ed-4f07-8755-51ee29f4ea39":"all"}
//   {"837cc1e9-15ed-4f07-8755-51ee29f4ea39":["Initial Screen"]}
// One worker serves one client, so the lists are that client's. Every send
// job (and stage) must also be a compose job (and stage); a list that can't
// be read, or a send list wider than the compose list, opens nothing. Before
// October 27 these were per-schedule lists in this file, which took a commit
// and a deploy to change; the send gate (send-gate.js) now reads Ashby again
// before every Send instead.
function jobList(env,name){
  const raw=String(env?.[name]??'').trim();
  if(!raw)return {jobs:{}};
  let v;try{v=JSON.parse(raw);}catch(_){return {problem:`${name} isn't valid JSON.`};}
  if(!v||typeof v!=='object'||Array.isArray(v))return {problem:`${name} must be a JSON object of job IDs.`};
  const jobs={};
  for(const [jobId,stages] of Object.entries(v)){
    if(!isUuid(jobId))return {problem:`${name} has a key that isn't a job ID (${String(jobId).slice(0,40)}).`};
    if(stages==='all'){jobs[jobId.toLowerCase()]='all';continue;}
    if(!Array.isArray(stages)||!stages.length||!stages.every(isText))return {problem:`${name} must give each job "all" or a list of stage titles.`};
    jobs[jobId.toLowerCase()]=stages.map(t=>t.trim().toLowerCase());
  }
  return {jobs};
}
// Whether a list allows this job and stage.
function jobAllows(jobs,jobId,stageTitle){
  const stages=jobs[String(jobId||'').toLowerCase()];
  return stages==='all'||(Array.isArray(stages)&&stages.includes(String(stageTitle||'').trim().toLowerCase()));
}
// Why the plan's job and stage aren't on a list, or null.
function jobBlocked(plan,env,name,what){
  const list=jobList(env,name);
  if(list.problem)return `${list.problem} Nothing is ${what} until it's fixed.`;
  if(!jobAllows(list.jobs,plan?.jobId,plan?.stage?.title))
    return `This job${list.jobs[String(plan?.jobId||'').toLowerCase()]?`'s ${String(plan?.stage?.title||'').slice(0,60)} stage`:''} isn't opted in (${name}).`;
  return null;
}
// A send list must sit inside the compose list, job by job and stage by stage.
function sendListProblem(env){
  const send=jobList(env,'BOOKING_SEND_JOBS'),compose=jobList(env,'BOOKING_COMPOSE_JOBS');
  if(send.problem||compose.problem)return send.problem||compose.problem;
  for(const [jobId,stages] of Object.entries(send.jobs)){
    const c=compose.jobs[jobId];
    if(c==='all')continue;
    if(!c||stages==='all'||!stages.every(t=>c.includes(t)))return `BOOKING_SEND_JOBS opts in job ${jobId}${stages==='all'?'':` (${stages.join(', ')})`} beyond what BOOKING_COMPOSE_JOBS allows.`;
  }
  return null;
}

// Why a robot Send may not happen for this plan and environment, or null when
// every lock is open: BOOKING_SEND exactly "on" (separate from
// BOOKING_COMPOSE), and the plan's job and stage on BOOKING_SEND_JOBS, which
// sits inside BOOKING_COMPOSE_JOBS. Who the invitations reach is the send
// gate's (send-gate.js): the candidate's email as Ashby has it, and
// interviewers on the client's domains. The plan's own `send: true`
// (announced at posting) is checked by the caller.
function sendBlocked(plan,env){
  if(env?.BOOKING_SEND!=='on')return 'Send is switched off on the scheduling worker (BOOKING_SEND).';
  const wider=sendListProblem(env);
  if(wider)return `${wider} Nothing is sent until it's fixed.`;
  return jobBlocked(plan,env,'BOOKING_SEND_JOBS','sent');
}

class Stop extends Error{constructor(message,code=2){super(message);this.code=code;}}
const stop=(message,code)=>{throw new Stop(message,code);};
const isUuid=v=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const isText=v=>typeof v==='string'&&v.trim().length>0;
const isInstant=v=>typeof v==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v));

// The plan must be complete, for a job and stage on BOOKING_COMPOSE_JOBS, and
// in the future. That the application, job, candidate and email belong
// together is Ashby's to say: read again before composing and before Send
// (send-gate.js).
function checkPlan(plan,{now=Date.now(),env}={}){
  if(!plan||typeof plan!=='object'||Array.isArray(plan))stop('The plan isn\'t a JSON object.');
  for(const [what,v] of [['application',plan.applicationId],['job',plan.jobId],['candidate',plan.candidateId],['scheduling activity',plan.interviewScheduleId]])
    if(!isUuid(v))stop(`The plan has no ${what} ID.`);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(plan.candidate?.email||'')))stop('The plan has no candidate email.');
  for(const [what,v] of [['candidate name',plan.candidate?.name],['job title',plan.job?.title],['stage title',plan.stage?.title],['scheduling activity',plan.activityTitle]])
    if(!isText(v))stop(`The plan has no ${what}.`);
  const blocked=jobBlocked(plan,env,'BOOKING_COMPOSE_JOBS','composed');
  if(blocked)stop(blocked);
  try{new Intl.DateTimeFormat('en-US',{timeZone:plan.timeZone});}catch(_){stop('The plan\'s time zone isn\'t a valid IANA zone.');}
  if(typeof plan.timeZone!=='string'||!plan.timeZone.includes('/'))stop('The plan\'s time zone must be an IANA zone such as America/Denver.');
  if(!Array.isArray(plan.sessions)||!plan.sessions.length)stop('The plan has no sessions.');
  plan.sessions.forEach((s,i)=>{
    const label=`Session ${i+1}`;
    if(!isText(s?.title)||!isUuid(s.interviewId))stop(`${label} has no interview.`);
    if(!isInstant(s.start)||!isInstant(s.end)||Date.parse(s.end)<=Date.parse(s.start))stop(`${label} doesn't have exact start and end times.`);
    if(Date.parse(s.start)<now+NOTICE_MINUTES*60000)stop(`${label} starts less than ${NOTICE_MINUTES} minutes from now.`);
    if(i&&Date.parse(s.start)<Date.parse(plan.sessions[i-1].end))stop(`Sessions ${i} and ${i+1} overlap.`);
    if(!Array.isArray(s.interviewers)||!s.interviewers.length||!s.interviewers.every(x=>isUuid(x?.userId)&&isText(x.name)&&/^\S+@\S+\.\S+$/.test(x.email||'')))
      stop(`${label} has no fully identified interviewers.`);
  });
  return plan;
}

module.exports={jobList,jobAllows,sendListProblem,sendBlocked,checkPlan,Stop,stop,NOTICE_MINUTES};
