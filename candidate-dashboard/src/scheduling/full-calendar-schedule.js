'use strict';
const {windowsToInstants}=require('./booking-planner');
const fail=message=>{throw Object.assign(Error(message),{status:422});};
const MAX_AGE=60000,STEP=5*60000,SEARCH_LIMIT=100000,RELAX_LIMIT=20000;
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
//
// minBreakMinutes/maxGapMinutes (scheduling-rules agenda) allow a gap between
// consecutive sessions. Both 0 (the default) is exactly the original
// back-to-back search; test/full-calendar-schedule-v1.test.js holds it to that.
function proposeCalendarSchedule({sessions,windows,timezone,calendars,now=Date.now(),limit=5,minBreakMinutes=0,maxGapMinutes=0}){
  if(!Array.isArray(sessions)||!sessions.length||sessions.length>30)fail('Load a complete interview plan first.');
  if(!Number.isInteger(limit)||limit<1||limit>5)fail('Invalid proposal limit.');
  if(![minBreakMinutes,maxGapMinutes].every(m=>Number.isInteger(m)&&m>=0&&m%5===0)||maxGapMinutes<minBreakMinutes||maxGapMinutes>480)fail('Breaks must be whole 5-minute steps, with the maximum gap at least the minimum break.');
  const candidate=windowsToInstants(windows,timezone,now);
  const ids=new Set();
  for(const s of sessions){
    if(!s.sessionId||ids.has(s.sessionId)||!Number.isInteger(s.durationMinutes)||s.durationMinutes<5||s.durationMinutes>480||s.assignmentVerified!==true||s.requiredCount!==1||!Array.isArray(s.eligibleInterviewers)||!s.eligibleInterviewers.length||s.eligibleInterviewers.some(i=>!i.userId||!i.name))fail('Every interview needs a verified duration and resolved eligible interviewer identities.');
    ids.add(s.sessionId);
  }
  // Meeting hours are either verified (workingHoursVerified) or explicitly
  // assumed from client rules (workingHoursSource "assumed"). Assumed hours are
  // allowed but reported: the result is then never availabilityVerified.
  // hoursSource says where assumed hours came from ("default" = the client's
  // placeholder, "override" = set for this person), so the no-fit report can
  // tell a data gap from a real conflict.
  const people=new Map();let hoursAssumed=false;
  for(const s of sessions)for(const person of s.eligibleInterviewers){
    if(people.has(person.userId))continue;
    const matches=Array.isArray(calendars)?calendars.filter(c=>c.userId===person.userId):[];
    const c=matches[0];
    const hoursOk=c?.workingHoursVerified===true||c?.workingHoursSource==='assumed';
    if(matches.length!==1||c.verified!==true||c.coverageVerified!==true||!hoursOk||!Number.isFinite(c.checkedAt)||c.checkedAt>now||now-c.checkedAt>MAX_AGE)fail(`A current, complete calendar and working hours are required for ${person.name}.`);
    if(c.workingHoursVerified!==true)hoursAssumed=true;
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
    const hoursSource=c.workingHoursVerified===true?'verified':(c.hoursSource==='default'||c.hoursSource==='override'?c.hoursSource:'assumed');
    people.set(person.userId,{name:person.name,busy,hours,limits,load,weeks,limited,hoursSource,hoursLabel:typeof c.hoursLabel==='string'?c.hoursLabel:null});
  }
  // Returns null when the person can take the session at [start,end), else why
  // not, checked in a fixed order: meeting hours, then busy time, then limits.
  // A slot outside someone's hours is never also counted as busy, so the busy
  // tally is only time they'd otherwise be free.
  function unavailable(person,session,start,end,events,relax){
    const p=people.get(person.userId);
    if(!relax.hours.has(person.userId)&&!contains(p.hours.get(session.sessionId),start,end))return 'hours';
    if(!relax.busy.has(person.userId)&&p.busy.some(b=>b.start<end&&b.end>start))return 'busy';
    if(!p.limited||relax.limits.has(person.userId))return null;
    const assigned=events.filter(e=>e.interviewer.userId===person.userId);
    const day=dateIn(start,p.load.timezone);
    if(day!==dateIn(end-1,p.load.timezone))return 'limits';
    if(p.limits.dailyLimit!==null){
      const count=p.load.days?.[day];
      if(!Number.isInteger(count)||count<0)fail('Interview counts do not cover the proposed day.');
      if(count+assigned.filter(e=>dateIn(Date.parse(e.start),p.load.timezone)===day).length>=p.limits.dailyLimit)return 'limits';
    }
    if(p.limits.weeklyLimit!==null){
      const weeks=p.weeks.filter(w=>w.start<=start&&w.end>=end);
      if(weeks.length!==1)fail('Interview counts do not uniquely cover the proposed week.');
      const week=weeks[0];
      if(week.count+assigned.filter(e=>Date.parse(e.start)>=week.start&&Date.parse(e.start)<week.end).length>=p.limits.weeklyLimit)return 'limits';
    }
    return null;
  }
  const totalMinutes=sessions.reduce((sum,s)=>sum+s.durationMinutes,0);
  const minSpan=(totalMinutes+minBreakMinutes*(sessions.length-1))*60000;
  const limitedIds=[...people.keys()].filter(id=>people.get(id).limited);
  const NONE={hours:new Set(),busy:new Set(),limits:new Set()};
  // Preserve the plan order and a single-day agenda inside one candidate window.
  // Backtracking matters: an early flexible assignment must not consume a later
  // fixed interviewer's remaining daily or weekly capacity. `dead` remembers
  // sub-problems already proven impossible; it only skips failures, so it never
  // changes which agenda is found first.
  function search({relax=NONE,max=limit,cap=SEARCH_LIMIT,tally=null}={}){
    const proposals=[],seen=new Set(),dead=new Set();let examined=0;const reach={placed:-1,events:[]};
    function assign(index,cursor,events,window,day){
      if(++examined>cap){if(cap===SEARCH_LIMIT)fail('Calendar search exceeded its limit. Narrow the availability range.');throw Object.assign(Error('relaxation search limit'),{relaxLimit:true});}
      if(index>reach.placed){reach.placed=index;reach.events=events;}
      if(index===sessions.length)return events;
      const key=`${index}|${cursor}|${window.end}|${day}|${limitedIds.map(id=>events.filter(e=>e.interviewer.userId===id).length).join(',')}`;
      if(dead.has(key))return null;
      const s=sessions[index],duration=s.durationMinutes*60000;
      const eligible=s.eligibleInterviewers.slice().sort((a,b)=>events.filter(e=>e.interviewer.userId===a.userId).length-events.filter(e=>e.interviewer.userId===b.userId).length);
      const first=index===0?cursor:cursor+minBreakMinutes*60000,latest=index===0?cursor:cursor+maxGapMinutes*60000;
      for(let start=first;start<=latest;start+=STEP){
        const end=start+duration;
        if(end>window.end||dateIn(end-1,timezone)!==day)break;
        for(const person of eligible){
          const why=unavailable(person,s,start,end,events,relax);
          if(why){if(tally)tally(s,person,why);continue;}
          const found=assign(index+1,end,[...events,{sessionId:s.sessionId,interviewId:s.interviewId,title:s.title,durationMinutes:s.durationMinutes,start:new Date(start).toISOString(),end:new Date(end).toISOString(),interviewer:person,eligibleInterviewers:s.eligibleInterviewers}],window,day);
          if(found)return found;
        }
      }
      dead.add(key);return null;
    }
    for(const window of candidate){
      for(let start=Math.ceil(window.start/STEP)*STEP;start+minSpan<=window.end;start+=STEP){
        if(seen.has(start))continue;seen.add(start);
        // windowsToInstants permits <=24h windows; this solver intentionally
        // requires the complete agenda to stay on one candidate-local date.
        if(dateIn(start,timezone)!==dateIn(start+minSpan-1,timezone))continue;
        const events=assign(0,start,[],window,dateIn(start,timezone));if(!events)continue;
        proposals.push({start:events[0].start,end:events.at(-1).end,events});
        if(proposals.length>=max)break;
      }
      if(proposals.length>=max)break;
    }
    return {proposals,reach};
  }
  // Rejections by session, interviewer and reason, kept only for the report.
  const rejections=new Map();
  const tally=(s,person,why)=>{const key=`${s.sessionId}|${person.userId}`,row=rejections.get(key)||{sessionId:s.sessionId,userId:person.userId,hours:0,busy:0,limits:0};row[why]++;rejections.set(key,row);};
  const {proposals,reach}=search({tally});
  const checkedAt=Math.min(...[...people.keys()].map(id=>calendars.find(c=>c.userId===id).checkedAt));
  const assumedNote=hoursAssumed?' Meeting hours are assumed from client rules, not verified.':'';
  const base={bookingEnabled:false,availabilityVerified:!hoursAssumed,meetingHoursAssumed:hoursAssumed,calendarCheckedAt:checkedAt,totalMinutes,timezone,minBreakMinutes,maxGapMinutes,proposals};
  if(proposals.length)return {...base,status:'calendar_checked',reason:'These agendas fit candidate availability, interviewer calendars, meeting hours and interview limits. Review remaining client rules before approval.'+assumedNote};
  const diagnosis=diagnose(reach);
  return {...base,status:'no_calendar_fit',diagnosis,reason:'No agenda in template order fits the calendars, meeting hours and interview limits.'+assumedNote};

  // What would unblock a no-fit, ranked, instead of every rejected slot.
  function diagnose(reach){
    const placed=Math.max(0,reach.placed),blocked=sessions[Math.min(placed,sessions.length-1)];
    const conflicts={busy:0,hours:{default:0,override:0,assumed:0,verified:0},limits:0};
    for(const r of rejections.values()){conflicts.busy+=r.busy;conflicts.limits+=r.limits;conflicts.hours[people.get(r.userId).hoursSource]+=r.hours;}
    const person=id=>{const p=people.get(id);return {userId:id,name:p.name,hoursSource:p.hoursSource,hoursLabel:p.hoursLabel};};
    const atBlocked=blocked.eligibleInterviewers.map(i=>{
      const r=rejections.get(`${blocked.sessionId}|${i.userId}`)||{hours:0,busy:0,limits:0};
      const reason=['hours','busy','limits'].reduce((a,b)=>r[b]>r[a]?b:a,'hours');
      return {...person(i.userId),reason:r.hours+r.busy+r.limits?reason:'agenda',counts:{hours:r.hours,busy:r.busy,limits:r.limits}};
    });
    // Would the agenda fit if no interviewer constraint applied at all? If not,
    // the candidate's own availability is what's too short.
    const everyone=new Set(people.keys()),fits=relax=>{try{return search({relax,max:1,cap:RELAX_LIMIT}).proposals.length>0;}catch(e){if(e.relaxLimit)return false;throw e;}};
    const base={furthest:{placed,of:sessions.length,placedTitles:reach.events.map(e=>e.title),blockedAt:placed<sessions.length?{sessionId:blocked.sessionId,title:blocked.title}:null},atBlocked,conflicts};
    if(!fits({hours:everyone,busy:everyone,limits:everyone}))return {...base,unblock:[{kind:'availability',text:`The candidate's availability can't hold the whole ${totalMinutes}-minute agenda${minBreakMinutes?` with ${minBreakMinutes}-minute breaks`:''} on one day, even with every interviewer free.`}]};
    // One relaxation per (person, constraint) that rejected anything, most
    // rejections first; placeholder hours rank ahead because entering real
    // hours is the cheapest fix and the placeholder is likely wrong.
    const rank={'hours:default':0,'hours:assumed':1,'hours:override':1,'busy':2,'limits':3,'hours:verified':4};
    const options=[];
    for(const r of rejections.values())for(const kind of ['hours','busy','limits'])if(r[kind]){
      const existing=options.find(o=>o.kind===kind&&o.userId===r.userId);
      if(existing)existing.count+=r[kind];else options.push({kind,userId:r.userId,count:r[kind]});
    }
    // Sessions the search never reached rejected nobody, so add their people's
    // constraints as untested options after everything that was actually hit.
    const later=new Set(sessions.slice(Math.min(placed,sessions.length-1)).flatMap(x=>x.eligibleInterviewers.map(i=>i.userId)));
    for(const id of later)for(const kind of ['hours','busy','limits']){
      const p=people.get(id);if(kind==='busy'&&!p.busy.length||kind==='limits'&&!p.limited)continue;
      if(!options.some(o=>o.kind===kind&&o.userId===id))options.push({kind,userId:id,count:0});
    }
    for(const o of options)o.order=rank[o.kind==='hours'?`hours:${people.get(o.userId).hoursSource}`:o.kind];
    options.sort((a,b)=>(b.count>0)-(a.count>0)||a.order-b.order||b.count-a.count);
    const relaxFor=list=>{const r={hours:new Set(),busy:new Set(),limits:new Set()};for(const o of list)r[o.kind].add(o.userId);return r;};
    const candidates=options.slice(0,12);
    let found=candidates.filter(o=>fits(relaxFor([o]))).slice(0,2).map(o=>[o]);
    if(!found.length){
      outer:for(let i=0;i<Math.min(candidates.length,8);i++)for(let j=i+1;j<Math.min(candidates.length,8);j++)if(fits(relaxFor([candidates[i],candidates[j]]))){found=[[candidates[i],candidates[j]]];break outer;}
    }
    const unblock=found.map(group=>({kind:group.length>1?'combination':group[0].kind,changes:group.map(o=>({kind:o.kind,...person(o.userId),dataGap:o.kind==='hours'&&people.get(o.userId).hoursSource==='default'}))}));
    return {...base,unblock,unblockSearched:candidates.length};
  }
}
module.exports={proposeCalendarSchedule};
