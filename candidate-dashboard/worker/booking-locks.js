'use strict';
// What the booking robot may touch, shared by the dry run (booking-dry-run.js)
// and the Slack-approved check (booking-compose.js): the allowlisted
// applications, and the plan checks made before a session is read or a
// browser starts.
const NOTICE_MINUTES=15;

// The TEST candidate on the TEST job: its Initial Screen, First Round and
// Onsite Interview scheduling activities (Onsite added October 14, 2026, for
// the first Slack-approved check).
const ALLOWED_APPLICATIONS={
  '8dfd8f14-83c4-41f8-aaf1-416b75cb0892':{
    jobId:'837cc1e9-15ed-4f07-8755-51ee29f4ea39',
    candidateId:'fc88f24e-d59b-4e58-aa51-f0e94b1a32da',
    candidateEmail:'hayleysamuels511@gmail.com',
    interviewScheduleIds:['69ffae5a-240c-4d06-8b45-f9826dbf5623','18599066-1d55-493a-8c2f-1e970b04f86c','d98941b3-5900-4ecc-a5cb-c57ed6729702'],
  },
};

// Who a robot Send may reach (Hayley, 2026-10-19): the candidate and every
// interviewer must be on this list. Send isn't built yet; until it is, the
// check only reports whether a composed schedule would pass. TEST's Onsite
// interviewers include colleagues (Joe, Mary, Anna), so a TEST-only Send
// still needs this to keep real invites off their calendars.
const SEND_RECIPIENTS=new Set(['hayleysamuels511@gmail.com','hayley@luminai.com']);
// The plan's recipients outside SEND_RECIPIENTS, [] when all are on it.
function sendRecipientsOutside(plan){
  const all=[plan?.candidate?.email,...(plan?.sessions||[]).flatMap(s=>(s.interviewers||[]).map(x=>x.email))].map(e=>String(e||'').toLowerCase());
  return [...new Set(all)].filter(e=>!SEND_RECIPIENTS.has(e)).sort();
}

class Stop extends Error{constructor(message,code=2){super(message);this.code=code;}}
const stop=(message,code)=>{throw new Stop(message,code);};
const isUuid=v=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const isText=v=>typeof v==='string'&&v.trim().length>0;
const isInstant=v=>typeof v==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v));

// The plan must be complete, for an allowed application, and in the future.
function checkPlan(plan,{now=Date.now()}={}){
  if(!plan||typeof plan!=='object'||Array.isArray(plan))stop('The plan isn\'t a JSON object.');
  const allowed=ALLOWED_APPLICATIONS[plan.applicationId];
  if(!allowed)stop(`Application ${String(plan.applicationId).slice(0,40)} isn't one the booking robot may use.`);
  if(plan.jobId!==allowed.jobId||plan.candidateId!==allowed.candidateId||String(plan.candidate?.email||'').toLowerCase()!==allowed.candidateEmail)
    stop('The plan\'s job, candidate or candidate email doesn\'t match its application.');
  if(!allowed.interviewScheduleIds.includes(plan.interviewScheduleId))stop('The plan\'s scheduling activity isn\'t one of its application\'s.');
  for(const [what,v] of [['candidate name',plan.candidate?.name],['job title',plan.job?.title],['stage title',plan.stage?.title],['scheduling activity',plan.activityTitle]])
    if(!isText(v))stop(`The plan has no ${what}.`);
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

module.exports={ALLOWED_APPLICATIONS,SEND_RECIPIENTS,sendRecipientsOutside,checkPlan,Stop,stop,NOTICE_MINUTES};
