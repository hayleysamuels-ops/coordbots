'use strict';
// The last checks before the robot's one Send click (booking-composer.js,
// through booking-compose.js), made after the draft has been re-read and
// found equal to the approval. Each answers with why the robot mustn't send,
// or null. A reason never refuses the check: the draft stays composed for a
// person to send, as with any other skipped send.
//
// 1. A fresh read of Ashby's public API (ASHBY_READ_API_KEY, a read-only key
//    used for nothing else), so the plan is compared with Ashby rather than
//    trusted: the application is active, on the plan's job, for the plan's
//    candidate, whose primary email is the plan's; the scheduling activity is
//    the application's, in its current stage (the plan's stage, by title),
//    and has never been booked; the application has no other schedule booked
//    for the future; and every interviewer is an enabled Ashby user whose
//    email is the plan's and on the client's interviewer domains
//    (BOOKING_INTERVIEWER_DOMAINS).
// 2. The daily cap (BOOKING_SEND_DAILY_CAP): at most that many Send clicks in
//    any 24 hours, counted in a file beside the saved session. A click is
//    counted before it's made, so one whose outcome is unknown still counts.
const fs=require('fs'),path=require('path');
const {sendBlocked}=require('./booking-locks');

const API='https://api.ashbyhq.com/';
const DAY_MS=24*3600*1000;
// A schedule in one of these has been booked at some point (Cancelled
// included: a re-used activity composes as "Rescheduling").
const BOOKED_STATUSES=new Set(['Scheduled','WaitingOnFeedback','Complete','Cancelled']);
const lower=v=>String(v||'').trim().toLowerCase();
const domainOf=email=>lower(email).split('@').pop();

// The interviewer domains, from a comma-separated variable; [] when unset.
function interviewerDomains(env){
  return String(env?.BOOKING_INTERVIEWER_DOMAINS||'').split(',').map(lower).filter(Boolean);
}
// The cap as a positive whole number, or null when unset or unreadable.
function dailyCap(env){
  const v=String(env?.BOOKING_SEND_DAILY_CAP??'').trim();
  return /^[1-9]\d{0,3}$/.test(v)?Number(v):null;
}

// What the robot's send needs configured, before anything is read: the read
// key, the domains and the cap. null when all three are set.
function configProblem(env){
  if(!String(env?.ASHBY_READ_API_KEY||'').trim())return 'The scheduling worker has no Ashby read key (ASHBY_READ_API_KEY), so Ashby couldn\'t be read again before sending.';
  if(!interviewerDomains(env).length)return 'The scheduling worker has no interviewer domains (BOOKING_INTERVIEWER_DOMAINS).';
  if(dailyCap(env)===null)return 'The scheduling worker has no daily send cap (BOOKING_SEND_DAILY_CAP).';
  return null;
}

// Ashby's answers for this plan: the application, its schedules and each
// interviewer's user record. Throws when any can't be read in full.
function reader(key,request){
  return async function read(endpoint,body){
    let r,d;
    try{
      r=await request(API+endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
        headers:{Authorization:'Basic '+Buffer.from(key+':').toString('base64'),'Content-Type':'application/json'},body:JSON.stringify(body)});
      d=await r.json();
    }catch(e){throw Error(`Ashby's ${endpoint} couldn't be read (${String(e.message||'no answer').slice(0,120)})`);}
    if(!r.ok||d?.success!==true)throw Error(`Ashby's ${endpoint} couldn't be read (HTTP ${r.status}${d?.errors?.length?`: ${String(d.errors[0]).slice(0,120)}`:''})`);
    return d;
  };
}
async function readSendFacts({key,plan,request=fetch}){
  const read=reader(key,request);
  const application=(await read('application.info',{applicationId:plan.applicationId})).results;
  const schedules=[];let cursor;const cursors=new Set();
  do{
    const d=await read('interviewSchedule.list',{applicationId:plan.applicationId,limit:100,...(cursor?{cursor}:{})});
    if(!Array.isArray(d.results))throw Error('Ashby\'s interviewSchedule.list gave no list');
    schedules.push(...d.results);
    cursor=d.moreDataAvailable?d.nextCursor:null;
    if(d.moreDataAvailable&&(!cursor||cursors.has(cursor)))throw Error('Ashby\'s interviewSchedule.list was incomplete');
    cursors.add(cursor);if(cursors.size>20)throw Error('Ashby\'s interviewSchedule.list was too long');
  }while(cursor);
  const ids=[...new Set((plan.sessions||[]).flatMap(s=>(s.interviewers||[]).map(x=>x.userId)))];
  const users={};
  for(const userId of ids)users[userId]=(await read('user.info',{userId})).results;
  return {application,schedules,users};
}

// What in Ashby's answers stops the send, or null. `now` decides which other
// bookings are still to come.
// What about the application itself doesn't match the plan: [] when it does.
function applicationMismatch(plan,app){
  const why=[];
  if(app.status!=='Active')why.push(`the application is ${app.status||'not active'}`);
  if(app.job?.id!==plan.jobId)why.push('the application is on a different job');
  if(app.candidate?.id!==plan.candidateId)why.push('the application is for a different candidate');
  const email=lower(app.candidate?.primaryEmailAddress?.value);
  if(email!==lower(plan.candidate?.email))why.push(email?`the candidate's primary email in Ashby is ${email}, not ${lower(plan.candidate?.email)}`:'the candidate has no primary email in Ashby');
  return why;
}
function factsProblem(plan,{application:app,schedules,users},{domains,now=Date.now()}){
  if(app?.id!==plan.applicationId)return 'Ashby didn\'t return this application.';
  const why=applicationMismatch(plan,app);
  const schedule=schedules.find(s=>s?.id===plan.interviewScheduleId);
  if(!schedule)why.push('the scheduling activity isn\'t among the application\'s schedules');
  else{
    if(schedule.applicationId&&schedule.applicationId!==plan.applicationId)why.push('the scheduling activity belongs to another application');
    if(!app.currentInterviewStage?.id||schedule.interviewStageId!==app.currentInterviewStage.id)why.push('the scheduling activity isn\'t in the application\'s current stage');
    else if(lower(app.currentInterviewStage.title)!==lower(plan.stage?.title))why.push(`the application's current stage is ${app.currentInterviewStage.title||'untitled'}, not ${plan.stage?.title}`);
    if(BOOKED_STATUSES.has(schedule.status)||(schedule.interviewEvents||[]).length)why.push(`the scheduling activity has been booked before (Ashby shows it ${schedule.status}${(schedule.interviewEvents||[]).length?`, with ${schedule.interviewEvents.length} interview${schedule.interviewEvents.length===1?'':'s'}`:''})`);
  }
  const ahead=schedules.filter(s=>s?.id!==plan.interviewScheduleId&&s?.status==='Scheduled'&&(s.interviewEvents||[]).some(e=>Date.parse(e.endTime)>now));
  if(ahead.length)why.push(`the application already has ${ahead.length===1?'another schedule':`${ahead.length} other schedules`} booked for the future`);
  const seen=new Set();
  for(const x of (plan.sessions||[]).flatMap(s=>s.interviewers||[])){
    if(seen.has(x.userId))continue;seen.add(x.userId);
    const u=users[x.userId],want=lower(x.email);
    if(u?.id!==x.userId){why.push(`${x.name} isn't an Ashby user`);continue;}
    if(u.isEnabled===false)why.push(`${x.name}'s Ashby account is disabled`);
    if(lower(u.email)!==want)why.push(`${x.name}'s email in Ashby is ${lower(u.email)||'missing'}, not ${want}`);
    if(!domains.includes(domainOf(want)))why.push(`${want} isn't on an interviewer domain (${domains.join(', ')})`);
  }
  return why.length?`Ashby, read again just before sending, doesn't match the approval: ${why.join('; ')}.`:null;
}

// Before composing (booking-compose.js): the application as Ashby has it now
// must be the plan's: active, on its job, for its candidate and email. Needs
// only the read key; null when it matches, otherwise why not.
async function applicationProblem({env,plan,request=fetch}){
  const key=String(env?.ASHBY_READ_API_KEY||'').trim();
  if(!key)return 'The scheduling worker has no Ashby read key (ASHBY_READ_API_KEY), so the application couldn\'t be checked in Ashby.';
  let app;
  try{app=(await reader(key,request)('application.info',{applicationId:plan.applicationId})).results;}
  catch(e){return `The application couldn't be checked in Ashby: ${e.message}.`;}
  if(app?.id!==plan.applicationId)return 'Ashby didn\'t return this application.';
  const why=applicationMismatch(plan,app);
  return why.length?`The application in Ashby doesn't match the plan: ${why.join('; ')}.`:null;
}

// The send log: the time of each Send click, newest last, and when the cap
// was last reported reached. Unreadable is treated as full, not empty.
function readLog(file){
  try{const d=JSON.parse(fs.readFileSync(file,'utf8'));if(Array.isArray(d?.sends))return d;}
  catch(e){if(e.code==='ENOENT')return {sends:[]};}
  return null;
}
function writeLog(file,log){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(log),{mode:0o600});
  fs.renameSync(tmp,file);
}
// The cap's state now: sends in the last 24 hours, and when the oldest of
// them drops out. null when the log can't be read.
function capState(file,cap,now){
  const log=readLog(file);
  if(!log)return null;
  const recent=log.sends.filter(s=>Number.isFinite(Date.parse(s.at))&&Date.parse(s.at)>now-DAY_MS).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const reached=recent.length>=cap;
  return {log,recent,reached,resetsAt:reached?new Date(Date.parse(recent[recent.length-cap].at)+DAY_MS).toISOString():null};
}
const NO_LOG='The scheduling worker has nowhere to keep its send log, so the daily send cap couldn\'t be checked.';
// A time for a Slack reader, in UTC: "Oct 28, 14:05 UTC".
const utc=iso=>`${new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(Date.parse(iso))} UTC`;
const capReason=(cap,s)=>`The daily send cap is reached (${s.recent.length} sends in the last 24 hours; the cap is ${cap}). The next send is allowed after ${utc(s.resetsAt)}.`;

// Whether the cap allows a send now, without recording one: for posting.
function capBlocked({file,env,now=Date.now()}){
  const cap=dailyCap(env);
  if(cap===null)return configProblem(env);
  if(!file)return NO_LOG;
  const s=capState(file,cap,now);
  if(!s)return 'The send log couldn\'t be read, so the daily send cap couldn\'t be checked.';
  return s.reached?capReason(cap,s):null;
}

// Counts one send against the cap, when the cap allows it. Returns
// {reason, firstAtCap} when it doesn't (firstAtCap: the first time this
// stretch at the cap is reported, for one notice in the channel), or null
// once the send is recorded.
function takeSend({file,env,interviewScheduleId,now=Date.now()}){
  const cap=dailyCap(env);
  if(cap===null)return {reason:configProblem(env)};
  const s=capState(file,cap,now);
  if(!s)return {reason:'The send log couldn\'t be read, so the daily send cap couldn\'t be checked.'};
  if(s.reached){
    const firstAtCap=s.log.capNoticeFor!==s.resetsAt;
    if(firstAtCap)try{writeLog(file,{...s.log,capNoticeFor:s.resetsAt});}catch(_){/* the notice may repeat */}
    return {reason:capReason(cap,s),firstAtCap,count:s.recent.length,cap,resetsAt:s.resetsAt,resetsAtText:utc(s.resetsAt)};
  }
  try{writeLog(file,{...s.log,sends:[...s.recent,{at:new Date(now).toISOString(),interviewScheduleId}]});}
  catch(e){return {reason:`The send couldn't be counted against the daily cap (${String(e.message).slice(0,120)}), so it wasn't made.`};}
  return null;
}

// The send log beside the saved session, unless BOOKING_SEND_LOG_FILE says
// otherwise.
function sendLogFile(env){
  if(env?.BOOKING_SEND_LOG_FILE)return env.BOOKING_SEND_LOG_FILE;
  return env?.ASHBY_SESSION_FILE?path.join(path.dirname(env.ASHBY_SESSION_FILE),'send-log.json'):null;
}

// The gate booking-compose.js hands the composer: the send locks again
// (booking-locks.js), then the fresh read, then the cap (only a send that passes the read is counted). Returns null when
// the send may go ahead, now counted; otherwise {reason, cap?}.
function createSendGate({env,request=fetch,now=()=>Date.now()}){
  return async function beforeSend(plan){
    const locked=sendBlocked(plan,env);
    if(locked)return {reason:locked};
    const config=configProblem(env);
    if(config)return {reason:config};
    const file=sendLogFile(env);
    if(!file)return {reason:NO_LOG};
    let facts;
    try{facts=await readSendFacts({key:String(env.ASHBY_READ_API_KEY).trim(),plan,request});}
    catch(e){return {reason:`Ashby couldn't be read again just before sending: ${e.message}.`};}
    const problem=factsProblem(plan,facts,{domains:interviewerDomains(env),now:now()});
    if(problem)return {reason:problem};
    const taken=takeSend({file,env,interviewScheduleId:plan.interviewScheduleId,now:now()});
    if(!taken)return null;
    return {reason:taken.reason,...(taken.cap?{cap:{firstAtCap:taken.firstAtCap,count:taken.count,cap:taken.cap,resetsAt:taken.resetsAt,resetsAtText:taken.resetsAtText}}:{})};
  };
}

module.exports={createSendGate,applicationProblem,readSendFacts,factsProblem,configProblem,capBlocked,takeSend,sendLogFile,interviewerDomains,dailyCap,BOOKED_STATUSES};
