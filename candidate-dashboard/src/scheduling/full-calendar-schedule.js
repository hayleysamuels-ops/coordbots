'use strict';
const {windowsToInstants}=require('./booking-planner');
const {distinctFrom}=require('./option-variety');
const fail=message=>{throw Object.assign(Error(message),{status:422});};
const MAX_AGE=60000,STEP=5*60000,SEARCH_LIMIT=100000,RELAX_LIMIT=20000;
function intervals(rows){
  if(!Array.isArray(rows))fail('Complete calendar intervals are required.');
  return rows.map(r=>{const start=Date.parse(r.start),end=Date.parse(r.end);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)fail('Invalid calendar interval.');return {start,end};});
}
const contains=(rows,start,end)=>rows.some(r=>r.start<=start&&r.end>=end);
// Local HH:MM, 24-hour, for placement windows.
function timeIn(ms,timezone){
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(ms).map(x=>[x.type,x.value]));
  return `${p.hour}:${p.minute}`;
}
function dateIn(ms,timezone){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(ms).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
// Input comes exclusively from a server-side calendar provider. Browser-supplied
// calendars must never be passed here. Coverage, hours and capacity are separate
// attestations; seeing a few rendered events does not attest any of them.
//
// Breaks (scheduling-rules agenda): each gap between sessions is either 0 or a
// break of minBreakMinutes..maxGapMinutes, and at most maxGapCount gaps are
// breaks. maxGapCount 0 (the default) is the original back-to-back search.
// minBreakMinutes/maxGapMinutes alone (legacy description) allow a gap between
// consecutive sessions. Both 0 (the default) is exactly the original
// back-to-back search; test/full-calendar-schedule-v1.test.js holds it to that.
// variety (default on) keeps only options that differ from every earlier one by
// day, by an hour or more, or by interviewer (option-variety.js). The first
// option is always the one the search finds first, variety or not.
// advisory: interviewer busy time and meeting hours (assumed or verified) stop
// being constraints. The agenda is built as if calendars were clear: template
// order, the earliest start that fits the candidate's availability, the start
// windows (Lunch 12:00–13:30) and the break budget, which all stay hard. Each
// session whose interviewer has a conflict is then flagged with who, what and
// by how much. Sessions are never reordered and times never moved to avoid a
// conflict. At a session's fixed time, an eligible interviewer who is free is
// preferred over one who isn't; that changes who, never when. Zero interview
// limits stay hard upstream (calendar-inputs excludes those people).
function proposeCalendarSchedule({sessions,windows,timezone,calendars,now=Date.now(),limit=5,minBreakMinutes=0,maxGapMinutes=0,maxGapCount=0,variety=true,advisory=false}){
  if(!Array.isArray(sessions)||!sessions.length||sessions.length>30)fail('Load a complete interview plan first.');
  if(!Number.isInteger(limit)||limit<1||limit>5)fail('Invalid proposal limit.');
  if(![minBreakMinutes,maxGapMinutes].every(m=>Number.isInteger(m)&&m>=0&&m%5===0)||maxGapMinutes<minBreakMinutes||maxGapMinutes>480)fail('Breaks must be whole 5-minute steps, with the maximum gap at least the minimum break.');
  if(!Number.isInteger(maxGapCount)||maxGapCount<0||maxGapCount>29||(maxGapCount>0&&maxGapMinutes<5))fail('The break count must be 0 to 29, and breaks need a maximum of at least 5 minutes.');
  const BREAKS={count:maxGapCount,min:Math.max(minBreakMinutes,5),max:maxGapMinutes};
  const candidate=windowsToInstants(windows,timezone,now);
  const ids=new Set();
  for(const s of sessions){
    if(!s.sessionId||ids.has(s.sessionId)||!Number.isInteger(s.durationMinutes)||s.durationMinutes<5||s.durationMinutes>480||s.assignmentVerified!==true||s.requiredCount!==1||!Array.isArray(s.eligibleInterviewers)||!s.eligibleInterviewers.length||s.eligibleInterviewers.some(i=>!i.userId||!i.name))fail('Every interview needs a verified duration and resolved eligible interviewer identities.');
    ids.add(s.sessionId);
    // Optional start windows from scheduling-rules sessions.placementWindows.
    if(s.placementWindows!==undefined&&(!Array.isArray(s.placementWindows)||s.placementWindows.some(w=>!/^([01]\d|2[0-3]):[0-5]\d$/.test(w?.earliestStart||'')||!/^([01]\d|2[0-3]):[0-5]\d$/.test(w?.latestStart||'')||w.latestStart<w.earliestStart||(()=>{try{timeIn(0,w.timezone);return false;}catch(_){return true;}})())))fail(`The start window for ${s.title} is invalid.`);
  }
  const placementOk=(s,start)=>!s.placementWindows||s.placementWindows.every(w=>{const t=timeIn(start,w.timezone);return t>=w.earliestStart&&t<=w.latestStart;});
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
  // Breaks are optional, so the shortest agenda is back to back.
  const minSpan=totalMinutes*60000;
  const limitedIds=[...people.keys()].filter(id=>people.get(id).limited);
  const NONE={hours:new Set(),busy:new Set(),limits:new Set(),placement:new Set()};
  const everyoneIds=new Set(people.keys());
  // What a search always relaxes: nothing normally; every interviewer
  // constraint in advisory mode, leaving availability, start windows and breaks.
  const BASE=advisory?{hours:everyoneIds,busy:everyoneIds,limits:everyoneIds,placement:new Set()}:NONE;
  const withBase=r=>({hours:new Set([...BASE.hours,...r.hours]),busy:new Set([...BASE.busy,...r.busy]),limits:new Set([...BASE.limits,...r.limits]),placement:new Set([...BASE.placement,...r.placement])});
  // Preserve the plan order and a single-day agenda inside one candidate window.
  // Backtracking matters: an early flexible assignment must not consume a later
  // fixed interviewer's remaining daily or weekly capacity. `dead` remembers
  // sub-problems already proven impossible; it only skips failures, so it never
  // changes which agenda is found first.
  function search({relax=BASE,max=limit,cap=SEARCH_LIMIT,tally=null,breaks=BREAKS,tallyPlacement=null,accepted=[]}={}){
    const proposals=[],seen=new Set(),dead=new Set();let examined=0;const reach={placed:-1,events:[]};
    // `used` is how many breaks this agenda has taken so far.
    function assign(index,cursor,events,window,day,used=0){
      if(++examined>cap){if(cap===SEARCH_LIMIT)fail('Calendar search exceeded its limit. Narrow the availability range.');throw Object.assign(Error('relaxation search limit'),{relaxLimit:true});}
      if(index>reach.placed){reach.placed=index;reach.events=events;}
      if(index===sessions.length)return events;
      const key=`${index}|${cursor}|${window.end}|${day}|${used}|${limitedIds.map(id=>events.filter(e=>e.interviewer.userId===id).length).join(',')}`;
      if(dead.has(key))return null;
      const s=sessions[index],duration=s.durationMinutes*60000;
      const eligible=s.eligibleInterviewers.slice().sort((a,b)=>events.filter(e=>e.interviewer.userId===a.userId).length-events.filter(e=>e.interviewer.userId===b.userId).length);
      // Back to back first, then each allowed break length, shortest first.
      const starts=[cursor];
      if(index>0&&used<breaks.count)for(let g=breaks.min;g<=breaks.max;g+=5)starts.push(cursor+g*60000);
      for(const start of starts){
        const end=start+duration;
        if(end>window.end||dateIn(end-1,timezone)!==day)break;
        // Pruned here, not filtered afterwards: a session outside its start
        // window is never placed. A later start may still be inside it.
        if(!relax.placement.has(s.sessionId)&&!placementOk(s,start)){if(tallyPlacement)tallyPlacement(s);continue;}
        // Advisory: at this fixed time, a free interviewer before a busy one.
        const order=advisory?eligible.map((p,i)=>({p,i,c:unavailable(p,s,start,end,events,NONE)?1:0})).sort((a,b)=>a.c-b.c||a.i-b.i).map(x=>x.p):eligible;
        for(const person of order){
          const why=unavailable(person,s,start,end,events,relax);
          if(why){if(tally)tally(s,person,why);continue;}
          const found=assign(index+1,end,[...events,{sessionId:s.sessionId,interviewId:s.interviewId,title:s.title,durationMinutes:s.durationMinutes,start:new Date(start).toISOString(),end:new Date(end).toISOString(),interviewer:person,eligibleInterviewers:s.eligibleInterviewers}],window,day,used+(start>cursor?1:0));
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
        const option={start:events[0].start,end:events.at(-1).end,events};
        if(variety&&!distinctFrom([...accepted,...proposals],option,timezone))continue;
        proposals.push(option);
        if(proposals.length>=max)break;
      }
      if(proposals.length>=max)break;
    }
    return {proposals,reach};
  }
  // Rejections by session, interviewer and reason, kept only for the report.
  const rejections=new Map();
  const tally=(s,person,why)=>{const key=`${s.sessionId}|${person.userId}`,row=rejections.get(key)||{sessionId:s.sessionId,userId:person.userId,hours:0,busy:0,limits:0};row[why]++;rejections.set(key,row);};
  const placementRejections=new Map(),tallyPlacement=s=>placementRejections.set(s.sessionId,(placementRejections.get(s.sessionId)||0)+1);
  // Fewest breaks first: fill the options with back-to-back agendas, then ones
  // with up to one break, and so on up to the budget, so an earlier start that
  // needs breaks never outranks a compact agenda later the same day. Only the
  // last, widest pass is tallied for the no-fit report, so nothing is counted
  // twice. With no break budget this is the single original pass.
  const proposals=[];let reach;
  // Advisory: one pass with the whole break budget, so the first agenda is the
  // earliest that fits (back to back is still tried first at every step).
  for(let count=advisory?BREAKS.count:0;count<=BREAKS.count;count++){
    const last=count===BREAKS.count,pass=search({breaks:{...BREAKS,count},max:limit-proposals.length,accepted:proposals,...(last?{tally,tallyPlacement}:{})});
    proposals.push(...pass.proposals);reach=pass.reach;
    if(proposals.length>=limit)break;
  }
  const checkedAt=Math.min(...[...people.keys()].map(id=>calendars.find(c=>c.userId===id).checkedAt));
  const assumedNote=hoursAssumed?' Meeting hours are assumed from client rules, not verified.':'';
  const base={bookingEnabled:false,availabilityVerified:!hoursAssumed,meetingHoursAssumed:hoursAssumed,calendarCheckedAt:checkedAt,totalMinutes,timezone,minBreakMinutes,maxGapMinutes,maxGapCount,proposals};
  if(proposals.length&&advisory){
    for(const p of proposals){for(const e of p.events)e.flags=flagsFor(e);p.flagCount=p.events.reduce((n,e)=>n+e.flags.length,0);}
    // Fewest clashes first, then earliest start. The page and the Slack post
    // both number options from this array (posting rebuilds it and takes the
    // option by index), so "option 1" is the same agenda in both.
    proposals.sort((a,b)=>a.flagCount-b.flagCount||Date.parse(a.start)-Date.parse(b.start));
    const flagged=proposals.filter(p=>p.flagCount).length;
    if(flagged)return {...base,availabilityVerified:false,status:'needs_attention',flaggedOptions:flagged,
      reason:`These agendas follow the template order at the earliest times the candidate's availability and the start windows allow. ${flagged===proposals.length?'Every option':`${flagged} of ${proposals.length} options`} has sessions that clash with an interviewer's calendar or meeting hours, flagged below. Each clash needs the interviewer to move it, or to accept a booking over it, before this goes anywhere.`+assumedNote};
    return {...base,status:'calendar_checked',reason:'These agendas follow the template order at the earliest times that fit, and every interviewer is free on their primary calendar and within their meeting hours. Review remaining client rules before approval.'+assumedNote};
  }
  if(proposals.length)return {...base,status:'calendar_checked',reason:'These agendas fit candidate availability, interviewer calendars, meeting hours and interview limits. Review remaining client rules before approval.'+assumedNote};
  const diagnosis=diagnose(reach);
  return {...base,status:'no_calendar_fit',diagnosis,reason:advisory?'No agenda in template order fits the candidate\'s availability and the start windows, even with every interviewer treated as free.'+assumedNote:'No agenda in template order fits the calendars, meeting hours and interview limits.'+assumedNote};

  // A session's clashes for its assigned interviewer: each busy period that
  // overlaps it, and each part of it outside their meeting hours, clipped to
  // the session, with minutes. Times are ISO; the page and Slack format them.
  function flagsFor(e){
    const p=people.get(e.interviewer.userId),start=Date.parse(e.start),end=Date.parse(e.end),out=[];
    const merged=[];for(const b of p.busy.filter(b=>b.start<end&&b.end>start).map(b=>({start:Math.max(b.start,start),end:Math.min(b.end,end)})).sort((a,b)=>a.start-b.start)){const last=merged.at(-1);if(last&&b.start<=last.end)last.end=Math.max(last.end,b.end);else merged.push({...b});}
    for(const b of merged)out.push({kind:'busy',name:p.name,userId:e.interviewer.userId,start:new Date(b.start).toISOString(),end:new Date(b.end).toISOString(),minutes:Math.round((b.end-b.start)/60000)});
    // Parts of [start,end) no meeting-hours interval covers.
    let cursor=start;const hours=p.hours.get(e.sessionId).filter(h=>h.end>start&&h.start<end).sort((a,b)=>a.start-b.start);
    const gaps=[];for(const h of hours){if(h.start>cursor)gaps.push({start:cursor,end:Math.min(h.start,end)});cursor=Math.max(cursor,h.end);if(cursor>=end)break;}
    if(cursor<end)gaps.push({start:cursor,end});
    for(const g of gaps)out.push({kind:'hours',name:p.name,userId:e.interviewer.userId,start:new Date(g.start).toISOString(),end:new Date(g.end).toISOString(),minutes:Math.round((g.end-g.start)/60000),hoursSource:p.hoursSource,hoursLabel:p.hoursLabel});
    return out;
  }

  // What would unblock a no-fit, ranked, instead of every rejected slot.
  function diagnose(reach){
    const placed=Math.max(0,reach.placed),blocked=sessions[Math.min(placed,sessions.length-1)];
    const conflicts={busy:0,hours:{default:0,override:0,assumed:0,verified:0},limits:0,placement:[...placementRejections.values()].reduce((a,b)=>a+b,0)};
    for(const r of rejections.values()){conflicts.busy+=r.busy;conflicts.limits+=r.limits;conflicts.hours[people.get(r.userId).hoursSource]+=r.hours;}
    const person=id=>{const p=people.get(id);return {userId:id,name:p.name,hoursSource:p.hoursSource,hoursLabel:p.hoursLabel};};
    const atBlocked=blocked.eligibleInterviewers.map(i=>{
      const r=rejections.get(`${blocked.sessionId}|${i.userId}`)||{hours:0,busy:0,limits:0};
      const reason=['hours','busy','limits'].reduce((a,b)=>r[b]>r[a]?b:a,'hours');
      // A start rejected by the session's own window never reaches the
      // interviewers, so with no interviewer rejections the window is the reason.
      return {...person(i.userId),reason:r.hours+r.busy+r.limits?reason:placementRejections.get(blocked.sessionId)?'placement':'agenda',counts:{hours:r.hours,busy:r.busy,limits:r.limits}};
    });
    const windowOf=x=>x.placementWindows.map(w=>({value:w.value,timezone:w.timezone,earliestStart:w.earliestStart,latestStart:w.latestStart}));
    const blockedPlacement=blocked.placementWindows&&placementRejections.get(blocked.sessionId)?{title:blocked.title,windows:windowOf(blocked),rejectedStarts:placementRejections.get(blocked.sessionId)}:null;
    // Would the agenda fit if no interviewer constraint applied at all? If not,
    // the candidate's own availability is what's too short.
    const everyone=new Set(people.keys()),fits=relax=>{try{return search({relax:withBase(relax),max:1,cap:RELAX_LIMIT}).proposals.length>0;}catch(e){if(e.relaxLimit)return false;throw e;}};
    const base={furthest:{placed,of:sessions.length,placedTitles:reach.events.map(e=>e.title),blockedAt:placed<sessions.length?{sessionId:blocked.sessionId,title:blocked.title}:null},atBlocked,blockedPlacement,conflicts};
    if(!fits({hours:everyone,busy:everyone,limits:everyone,placement:new Set(sessions.map(x=>x.sessionId))}))return {...base,unblock:[{kind:'availability',text:`The candidate's availability can't hold the whole ${totalMinutes}-minute agenda on one day, even with every interviewer free.`}]};
    // One relaxation per (person, constraint) that rejected anything, most
    // rejections first; placeholder hours rank ahead because entering real
    // hours is the cheapest fix and the placeholder is likely wrong.
    // Placeholder hours first (a data gap, cheapest to fix), then a session's
    // start window (a firm client rule, and at 0/0 gaps only the agenda start
    // can meet it), then hours set for a person, busy time, limits, verified hours.
    const rank={'hours:default':0,'placement':1,'hours:assumed':1.5,'hours:override':1.5,'busy':2,'limits':3,'hours:verified':4};
    const options=[];
    for(const [sessionId,count] of placementRejections)options.push({kind:'placement',sessionId,count});
    for(const r of rejections.values())for(const kind of ['hours','busy','limits'])if(r[kind]){
      const existing=options.find(o=>o.kind===kind&&o.userId===r.userId);
      if(existing)existing.count+=r[kind];else options.push({kind,userId:r.userId,count:r[kind]});
    }
    // Sessions the search never reached rejected nobody, so add their people's
    // constraints as untested options after everything that was actually hit.
    const later=new Set(sessions.slice(Math.min(placed,sessions.length-1)).flatMap(x=>x.eligibleInterviewers.map(i=>i.userId)));
    for(const x of sessions.slice(Math.min(placed,sessions.length-1)))if(x.placementWindows&&!options.some(o=>o.kind==='placement'&&o.sessionId===x.sessionId))options.push({kind:'placement',sessionId:x.sessionId,count:0});
    for(const id of later)for(const kind of ['hours','busy','limits']){
      const p=people.get(id);if(kind==='busy'&&!p.busy.length||kind==='limits'&&!p.limited)continue;
      if(!options.some(o=>o.kind===kind&&o.userId===id))options.push({kind,userId:id,count:0});
    }
    for(const o of options)o.order=rank[o.kind==='hours'?`hours:${people.get(o.userId).hoursSource}`:o.kind];
    for(const o of options)o.order??=rank[o.kind];
    options.sort((a,b)=>(b.count>0)-(a.count>0)||a.order-b.order||b.count-a.count);
    const relaxFor=list=>{const r={hours:new Set(),busy:new Set(),limits:new Set(),placement:new Set()};for(const o of list)r[o.kind].add(o.kind==='placement'?o.sessionId:o.userId);return r;};
    const candidates=options.slice(0,12);
    let found=candidates.filter(o=>fits(relaxFor([o]))).slice(0,2).map(o=>[o]);
    if(!found.length){
      outer:for(let i=0;i<Math.min(candidates.length,8);i++)for(let j=i+1;j<Math.min(candidates.length,8);j++)if(fits(relaxFor([candidates[i],candidates[j]]))){found=[[candidates[i],candidates[j]]];break outer;}
    }
    // With no gap allowed, a start window can only be met by moving the whole
    // agenda. Say so, and find the smallest gap that would fit on its own:
    // that's the evidence the breaks decision needs.
    // Smallest break allowance beyond the current one that would fit: fewest
    // breaks first, then shortest. "One break of up to 30 minutes" is more
    // actionable than a per-gap number. Allowances no wider than the current
    // one can't help and are skipped.
    const gapFits=()=>{
      for(let count=1;count<=Math.min(3,sessions.length-1);count++)for(const length of [15,30,45,60,90,120]){
        if(length<BREAKS.min||(count<=BREAKS.count&&length<=BREAKS.max))continue;
        try{if(search({max:1,cap:RELAX_LIMIT,breaks:{count,min:BREAKS.min,max:length}}).proposals.length)return {count,maxMinutes:length};}catch(e){if(!e.relaxLimit)throw e;}
      }
      return null;
    };
    let gapTried=false,gapResult=null;
    const describe=o=>{
      if(o.kind!=='placement')return {kind:o.kind,...person(o.userId),dataGap:o.kind==='hours'&&people.get(o.userId).hoursSource==='default'};
      const x=sessions.find(y=>y.sessionId===o.sessionId);
      if(!gapTried){gapTried=true;gapResult=gapFits();}
      return {kind:'placement',sessionId:x.sessionId,title:x.title,windows:windowOf(x),currentBreaks:{count:BREAKS.count,minMinutes:BREAKS.count?BREAKS.min:0,maxMinutes:BREAKS.count?BREAKS.max:0},fitsWithBreaks:gapResult};
    };
    const unblock=found.map(group=>({kind:group.length>1?'combination':group[0].kind,changes:group.map(describe)}));
    return {...base,unblock,unblockSearched:candidates.length};
  }
}
module.exports={proposeCalendarSchedule};
