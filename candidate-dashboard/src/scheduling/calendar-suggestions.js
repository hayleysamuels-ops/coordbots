'use strict';
// Advisory only: observed blocks do not establish a complete free/busy source.
// These options never enter the booking engine or create an Ashby draft.
function tentativeSuggestions({facts,calendar,override,now=Date.now()}){
  const result={status:'needs_review',slots:[],bookingEnabled:false,checks:['Complete calendar coverage','Current daily and weekly interview counts','Final calendar recheck before approval']};
  if(!override)return {...result,reason:'Enter confirmed interviewer working hours to calculate tentative times.'};
  if(!Array.isArray(calendar.days)||!calendar.days.length)return {...result,reason:'Read the candidate availability dates first.'};
  if(facts.interviewerLimits?.dailyLimit===0||facts.interviewerLimits?.weeklyLimit===0)return {...result,reason:'The interviewer has a zero interview limit.'};
  const intervals=rows=>{if(!Array.isArray(rows))throw Error();return rows.map(w=>{const start=Date.parse(w.start),end=Date.parse(w.end);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw Error();return {start,end};});};
  try{
    if(!Number.isFinite(calendar.checkedAt)||calendar.checkedAt>now||now-calendar.checkedAt>120000)throw Error();
    const candidate=intervals(facts.windows),working=intervals(override.windows),busy=intervals(calendar.observedBusy);
    const duration=facts.durationMinutes*60000;if(!Number.isInteger(facts.durationMinutes)||duration<300000||duration>28800000)throw Error();
    const zone=calendar.viewTimezone;if(!zone)throw Error();
    const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
    const day=ms=>{const p=Object.fromEntries(formatter.formatToParts(ms).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;};
    const dates=new Set(calendar.days.map(d=>d.date));
    // Time-only UI labels cannot disambiguate a different local calendar day.
    // Do not offer tentative slots near cross-zone midnight boundaries yet.
    if(!calendar.timezone)throw Error();
    const interviewerDay=ms=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:calendar.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(ms).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;};
    if(candidate.some(w=>day(w.start)!==interviewerDay(w.start)||day(w.end-1)!==interviewerDay(w.end-1)))return {...result,reason:'These windows cross different local calendar dates. Review them directly in Ashby.'};
    if(candidate.some(w=>!dates.has(day(w.start))||!dates.has(day(w.end-1))))return {...result,reason:'Not all availability dates have been read.'};
    const seen=new Set();
    // Distribute choices across candidate days; avoid showing five variations
    // of the first gap while hiding the next day's alternatives.
    for(const w of candidate){let count=0;for(let start=Math.ceil(Math.max(w.start,now+1)/300000)*300000;start+duration<=w.end;start+=300000){const end=start+duration;if(seen.has(start)||!working.some(r=>r.start<=start&&r.end>=end)||busy.some(r=>r.start<end&&r.end>start))continue;result.slots.push({start:new Date(start).toISOString(),end:new Date(end).toISOString()});seen.add(start);if(++count>=3||result.slots.length>=15)break;}if(result.slots.length>=15)break;}
    return {...result,reason:result.slots.length?'Tentative times based on observed blocks and coordinator working hours. Review the outstanding checks before booking.':'No tentative times fit the observed meetings and entered working hours.'};
  }catch(_){return {...result,slots:[],reason:'The calendar or availability data is incomplete or stale. Read the calendar again.'};}
}
module.exports={tentativeSuggestions};
