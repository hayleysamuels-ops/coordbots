'use strict';
const {windowsToInstants}=require('./booking-planner');
const fail=message=>{throw Object.assign(Error(message),{status:422});};
const MAX_AGE=60000,STEP=5*60000;
function intervals(rows){
  if(!Array.isArray(rows))fail('Complete calendar intervals are required.');
  return rows.map(r=>{const start=Date.parse(r.start),end=Date.parse(r.end);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)fail('Invalid calendar interval.');return {start,end};});
}
const contains=(rows,start,end)=>rows.some(r=>r.start<=start&&r.end>=end);
function dateIn(ms,timezone){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(ms).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
// Input comes exclusively from a server-side calendar provider. Browser-supplied
// calendars must never be passed here. Coverage, hours and capacity are separate
// attestations; seeing a few rendered events does not attest any of them.
function proposeCalendarSchedule({sessions,windows,timezone,calendars,now=Date.now(),limit=5}){
  if(!Array.isArray(sessions)||!sessions.length||sessions.length>30)fail('Load a complete interview plan first.');
  if(!Number.isInteger(limit)||limit<1||limit>5)fail('Invalid proposal limit.');
  const candidate=windowsToInstants(windows,timezone,now);
  const ids=new Set();
  for(const s of sessions){
    if(!s.sessionId||ids.has(s.sessionId)||!Number.isInteger(s.durationMinutes)||s.durationMinutes<5||s.durationMinutes>480||s.assignmentVerified!==true||s.requiredCount!==1||!Array.isArray(s.eligibleInterviewers)||!s.eligibleInterviewers.length||s.eligibleInterviewers.some(i=>!i.userId||!i.name))fail('Every interview needs a verified duration and resolved eligible interviewer identities.');
    ids.add(s.sessionId);
  }
  const people=new Map();
  for(const s of sessions)for(const person of s.eligibleInterviewers){
    if(people.has(person.userId))continue;
    const matches=Array.isArray(calendars)?calendars.filter(c=>c.userId===person.userId):[];
    const c=matches[0];
    if(matches.length!==1||c.verified!==true||c.coverageVerified!==true||c.workingHoursVerified!==true||!Number.isFinite(c.checkedAt)||c.checkedAt>now||now-c.checkedAt>MAX_AGE)fail(`A current, complete calendar and working hours are required for ${person.name}.`);
    const coverage=intervals(c.coverage),busy=intervals(c.busy);
    if(candidate.some(w=>!contains(coverage,w.start,w.end)))fail(`Calendar coverage is incomplete for ${person.name}.`);
    // Hours are scoped to each interview because Ashby activity meeting hours
    // may further restrict personal/company hours.
    const hours=new Map();
    for(const session of sessions.filter(s=>s.eligibleInterviewers.some(i=>i.userId===person.userId))){
      const rows=c.sessionWorkingWindows?.[session.sessionId];
      if(!rows)fail(`Meeting hours for ${person.name} are missing for ${session.title}.`);
      hours.set(session.sessionId,intervals(rows));
    }
    const limits=c.limits,load=c.interviewLoad;
    if(!limits||!['dailyLimit','weeklyLimit'].every(k=>Object.hasOwn(limits,k)&&(limits[k]===null||(Number.isInteger(limits[k])&&limits[k]>=0))))fail(`Verified interview limits are required for ${person.name}.`);
    const limited=limits.dailyLimit!==null||limits.weeklyLimit!==null;
    let weeks=[];
    if(limited){
      if(!load||load.verified!==true||!Number.isFinite(load.checkedAt)||load.checkedAt>now||now-load.checkedAt>MAX_AGE||!load.timezone)fail(`Current interview counts are required for ${person.name}.`);
      try{dateIn(now,load.timezone);}catch(_){fail('The interviewer time zone is invalid.');}
      if(limits.weeklyLimit!==null){
        if(!Array.isArray(load.weeks))fail('Verified weekly count periods are required.');
        weeks=load.weeks.map(w=>({...intervals([w])[0],count:w.count}));
        if(weeks.some(w=>!Number.isInteger(w.count)||w.count<0))fail('Invalid weekly interview count.');
      }
    }
    people.set(person.userId,{busy,hours,limits,load,weeks,limited});
  }
  function available(person,session,start,end,events){
    const p=people.get(person.userId);
    if(!contains(p.hours.get(session.sessionId),start,end)||p.busy.some(b=>b.start<end&&b.end>start))return false;
    const assigned=events.filter(e=>e.interviewer.userId===person.userId);
    if(!p.limited)return true;
    const day=dateIn(start,p.load.timezone);
    if(day!==dateIn(end-1,p.load.timezone))return false;
    if(p.limits.dailyLimit!==null){
      const count=p.load.days?.[day];
      if(!Number.isInteger(count)||count<0)fail('Interview counts do not cover the proposed day.');
      if(count+assigned.filter(e=>dateIn(Date.parse(e.start),p.load.timezone)===day).length>=p.limits.dailyLimit)return false;
    }
    if(p.limits.weeklyLimit!==null){
      const weeks=p.weeks.filter(w=>w.start<=start&&w.end>=end);
      if(weeks.length!==1)fail('Interview counts do not uniquely cover the proposed week.');
      const week=weeks[0];
      if(week.count+assigned.filter(e=>Date.parse(e.start)>=week.start&&Date.parse(e.start)<week.end).length>=p.limits.weeklyLimit)return false;
    }
    return true;
  }
  const totalMinutes=sessions.reduce((sum,s)=>sum+s.durationMinutes,0),proposals=[],seen=new Set();
  let examined=0;
  // Preserve the plan order and contiguous single-day agenda. Backtracking
  // matters: an early flexible assignment must not consume a later fixed
  // interviewer's remaining daily or weekly capacity.
  function assign(index,cursor,events){
    if(++examined>100000)fail('Calendar search exceeded its limit. Narrow the availability range.');
    if(index===sessions.length)return events;
    const s=sessions[index],end=cursor+s.durationMinutes*60000;
    const eligible=s.eligibleInterviewers.slice().sort((a,b)=>events.filter(e=>e.interviewer.userId===a.userId).length-events.filter(e=>e.interviewer.userId===b.userId).length);
    for(const person of eligible){
      if(!available(person,s,cursor,end,events))continue;
      const found=assign(index+1,end,[...events,{sessionId:s.sessionId,interviewId:s.interviewId,title:s.title,durationMinutes:s.durationMinutes,start:new Date(cursor).toISOString(),end:new Date(end).toISOString(),interviewer:person,eligibleInterviewers:s.eligibleInterviewers}]);
      if(found)return found;
    }
    return null;
  }
  for(const window of candidate){
    for(let start=Math.ceil(window.start/STEP)*STEP;start+totalMinutes*60000<=window.end;start+=STEP){
      if(seen.has(start))continue;seen.add(start);
      // windowsToInstants permits <=24h windows; this solver intentionally
      // requires the complete agenda to stay on one candidate-local date.
      if(dateIn(start,timezone)!==dateIn(start+totalMinutes*60000-1,timezone))continue;
      const events=assign(0,start,[]);if(!events)continue;
      proposals.push({start:events[0].start,end:events.at(-1).end,events});
      if(proposals.length>=limit)break;
    }
    if(proposals.length>=limit)break;
  }
  return {status:proposals.length?'calendar_checked':'no_calendar_fit',bookingEnabled:false,availabilityVerified:true,calendarCheckedAt:Math.min(...[...people.keys()].map(id=>calendars.find(c=>c.userId===id).checkedAt)),totalMinutes,timezone,proposals,reason:proposals.length?'These agendas fit candidate availability, interviewer calendars, meeting hours and interview limits. Review remaining client rules before approval.':'No contiguous agenda in template order fits the verified calendars, meeting hours and interview limits. Review rules or request more availability.'};
}
module.exports={proposeCalendarSchedule};
