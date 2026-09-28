'use strict';
const {windowsToInstants}=require('./booking-planner');
const fail=message=>{throw Object.assign(Error(message),{status:422});};
// Agenda proposals only. No calendar availability claim, persistence or dispatch.
function proposeFullSchedule({sessions,windows,timezone,now=Date.now()}){
  if(!Array.isArray(sessions)||!sessions.length||sessions.length>30)fail('Load a complete interview plan first.');
  for(const s of sessions)if(!Number.isInteger(s.durationMinutes)||s.durationMinutes<5||s.durationMinutes>480||s.assignmentVerified!==true||s.requiredCount!==1||!s.eligibleInterviewers?.length)fail('Every interview needs a verified duration and eligible interviewer list.');
  const totalMinutes=sessions.reduce((n,s)=>n+s.durationMinutes,0),proposals=[];
  for(const w of windowsToInstants(windows,timezone,now)){
    const start=Math.ceil(w.start/300000)*300000;
    if(start+totalMinutes*60000>w.end)continue;
    let cursor=start;const used=new Map();
    const events=sessions.map(s=>{
      const eligible=s.eligibleInterviewers;
      const interviewer=eligible.slice().sort((a,b)=>(used.get(a.name)||0)-(used.get(b.name)||0))[0];
      used.set(interviewer.name,(used.get(interviewer.name)||0)+1);
      const event={sessionId:s.sessionId,interviewId:s.interviewId,title:s.title,durationMinutes:s.durationMinutes,start:new Date(cursor).toISOString(),end:new Date(cursor+s.durationMinutes*60000).toISOString(),interviewer,eligibleInterviewers:eligible};cursor+=s.durationMinutes*60000;return event;
    });
    proposals.push({start:new Date(start).toISOString(),end:new Date(cursor).toISOString(),events});if(proposals.length===5)break;
  }
  return {status:'needs_review',bookingEnabled:false,availabilityVerified:false,totalMinutes,timezone,proposals,reason:proposals.length?'Agenda options fit the candidate’s availability and preserve the template order. Interviewer calendars, working hours, limits, rooms and breaks still need review.':'No submitted window fits the entire interview plan in one day. Request a longer window or review the interview plan in Ashby.'};
}
module.exports={proposeFullSchedule};
