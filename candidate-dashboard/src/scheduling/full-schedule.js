'use strict';
const {windowsToInstants}=require('./booking-planner');
const {distinctFrom,withinStartWindows}=require('./option-variety');
const fail=message=>{throw Object.assign(Error(message),{status:422});};
// Agenda proposals only. No calendar availability claim, persistence or dispatch.
// Applies client start windows (session.placementWindows); doesn't check
// interviewer calendars, meeting hours, limits or breaks.
// excludedWeekdays ({days,timezone}, scheduling-rules agenda): no agenda starts
// on these weekdays in that zone (Luminai: WFH Wednesdays). Hard here too.
function proposeFullSchedule({sessions,windows,timezone,now=Date.now(),excludedWeekdays=null}){
  const weekdayOf=ms=>new Intl.DateTimeFormat('en-US',{timeZone:excludedWeekdays.timezone,weekday:'short'}).format(ms).toLowerCase();
  let skippedWeekday=0;
  if(!Array.isArray(sessions)||!sessions.length||sessions.length>30)fail('Load a complete interview plan first.');
  for(const s of sessions)if(!Number.isInteger(s.durationMinutes)||s.durationMinutes<5||s.durationMinutes>480||s.assignmentVerified!==true||s.requiredCount!==1||!s.eligibleInterviewers?.length)fail('Every interview needs a verified duration and eligible interviewer list.');
  const totalMinutes=sessions.reduce((n,s)=>n+s.durationMinutes,0),proposals=[];
  // Every 5-minute start in each window, back-to-back in template order. Start
  // windows from client rules are applied; an agenda where any session misses
  // its window is skipped. Options must differ by day, an hour or panel.
  for(const w of windowsToInstants(windows,timezone,now)){
    for(let start=Math.ceil(w.start/300000)*300000;start+totalMinutes*60000<=w.end&&proposals.length<5;start+=300000){
      if(excludedWeekdays&&excludedWeekdays.days.includes(weekdayOf(start))){skippedWeekday++;continue;}
      let cursor=start;const used=new Map(),events=[];let fits=true;
      for(const s of sessions){
        if(!withinStartWindows(s,cursor)){fits=false;break;}
        const eligible=s.eligibleInterviewers;
        const interviewer=eligible.slice().sort((a,b)=>(used.get(a.name)||0)-(used.get(b.name)||0))[0];
        used.set(interviewer.name,(used.get(interviewer.name)||0)+1);
        events.push({sessionId:s.sessionId,interviewId:s.interviewId,title:s.title,durationMinutes:s.durationMinutes,start:new Date(cursor).toISOString(),end:new Date(cursor+s.durationMinutes*60000).toISOString(),interviewer,eligibleInterviewers:eligible});cursor+=s.durationMinutes*60000;
      }
      if(!fits)continue;
      const option={start:new Date(start).toISOString(),end:new Date(cursor).toISOString(),events};
      if(distinctFrom(proposals,option,timezone))proposals.push(option);
    }
    if(proposals.length===5)break;
  }
  return {status:'needs_review',bookingEnabled:false,availabilityVerified:false,totalMinutes,timezone,proposals,startWindowsApplied:[...new Map(sessions.flatMap(x=>(x.placementWindows||[]).map(w=>[`${x.title}|${w.earliestStart}|${w.latestStart}|${w.timezone}`,{title:x.title,earliestStart:w.earliestStart,latestStart:w.latestStart,timezone:w.timezone}]))).values()],
    notChecked:['interviewer calendars','meeting hours','interview limits','breaks between sessions'],
    reason:!proposals.length&&skippedWeekday?`No agenda is proposed on ${excludedWeekdays.days.map(d=>({sun:'Sunday',mon:'Monday',tue:'Tuesday',wed:'Wednesday',thu:'Thursday',fri:'Friday',sat:'Saturday'})[d]).join(' or ')}${excludedWeekdays.reason?` (${excludedWeekdays.reason.replace(/\.$/,'')})`:''}, and the candidate's other availability doesn't hold it. Ask the candidate for another day.`:proposals.length?'Agenda options fit the candidate’s availability and preserve the template order. Interviewer calendars, working hours, limits, rooms and breaks still need review.':sessions.some(x=>x.placementWindows)?'No back-to-back agenda fits the candidate’s availability with every session inside its start window. Request more availability or review the interview plan in Ashby.':'No submitted window fits the entire interview plan in one day. Request a longer window or review the interview plan in Ashby.'};
}
module.exports={proposeFullSchedule};
