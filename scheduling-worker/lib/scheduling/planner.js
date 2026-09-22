"use strict";
const P=require("./proposal"), DAY=require("../dateday");
const fail=message=>{throw Object.assign(new Error(message),{status:422});};
function localParts(ms,timezone){return Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(new Date(ms)).filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));}
// Resolve local civil time without relying on the server timezone. DST gaps and
// folds are refused rather than silently moving a candidate's session.
function instant(date,time,timezone){
 if(!DAY.parseDay(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))fail("Invalid session date or local time");
 const target=date+"T"+time+":00",naive=Date.parse(target+"Z"),offsets=new Set();
 for(const delta of [-36,-12,0,12,36]){const ms=naive+delta*3600000,p=localParts(ms,timezone);offsets.add(Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`)-ms);}
 const matches=[...offsets].map(offset=>naive-offset).filter(ms=>{const p=localParts(ms,timezone);return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`===target;});
 if(matches.length!==1)fail("Session time is ambiguous or does not exist because of daylight saving. Choose another time.");
 return new Date(matches[0]).toISOString();
}
function overlaps(a,b){return Date.parse(a.start)<Date.parse(b.end)&&Date.parse(b.start)<Date.parse(a.end);}
function available(resource,event,snapshot,reservations){
 const calendar=snapshot.resources[resource];
 if(!calendar||calendar.complete!==true||!Array.isArray(calendar.busy)||!Array.isArray(calendar.working))return false;
 const valid=range=>range&&Number.isFinite(Date.parse(range.start))&&Number.isFinite(Date.parse(range.end))&&Date.parse(range.start)<Date.parse(range.end);
 if(!calendar.busy.every(valid)||!calendar.working.every(valid))return false;
 return calendar.working.some(w=>Date.parse(w.start)<=Date.parse(event.start)&&Date.parse(w.end)>=Date.parse(event.end))&&
 !calendar.busy.some(b=>overlaps(b,event))&&!reservations.some(r=>r.resource===resource&&overlaps(r,event));
}
function suggestNew({candidate,application,template,startDate,timezone,snapshot,zoomAccountId,now}){
 if(!template||template.verified!==true||!template.revision||!template.sources?.ashby||!template.sources?.playbook)fail("Verify the role's Ashby plan and playbook before generating schedules");
 if(template.role!==application.role||application.candidateId!==candidate.id||application.active!==true)fail("Candidate application or role is not eligible for this schedule");
 if(!snapshot||snapshot.complete!==true||!snapshot.fingerprint||!Number.isFinite(Date.parse(now))||!Number.isFinite(Date.parse(snapshot.at))||Date.parse(now)-Date.parse(snapshot.at)>300000||Date.parse(snapshot.at)>Date.parse(now))fail("Fresh availability and trial capacity are required");
 if(!Array.isArray(snapshot.trials)||!snapshot.resources||!Array.isArray(template.sessions)||!template.sessions.length||template.sessions.length>60)fail("Scheduling source is incomplete");
 if(!zoomAccountId)fail("Verify Tess's Zoom account before generating schedules");
 const events=[],reservations=[];
 for(const session of template.sessions){
  if(!Number.isInteger(session.dayOffset)||session.dayOffset<0||session.dayOffset>13||!Number.isInteger(session.durationMinutes)||session.durationMinutes<1||session.durationMinutes>480)fail("Template has invalid session timing");
  const day=DAY.addDays(DAY.parseDay(startDate),session.dayOffset),date=String(day).replace(/^(\d{4})(\d{2})(\d{2})$/,"$1-$2-$3");
  const start=instant(date,session.localTime,timezone),end=new Date(Date.parse(start)+session.durationMinutes*60000).toISOString();
  const event={key:session.key,title:session.title,interviewId:session.interviewId,start,end,requiresRoom:!!session.requiresRoom,conferencing:{provider:"zoom",accountId:zoomAccountId}};
  if(events.some(previous=>overlaps(previous,event)))fail("The template schedules overlapping candidate sessions");
  const ranked=(session.interviewers||[]).filter(p=>p.active===true&&p.eligible===true&&p.userId&&p.email&&available("person:"+p.userId,event,snapshot,reservations))
   .sort((a,b)=>(a.confirmedLoad||0)-(b.confirmedLoad||0)||a.userId.localeCompare(b.userId));
  const count=session.interviewerCount||1;
  if(!Number.isInteger(count)||count<1||ranked.length<count)fail("No verified available interviewer for "+session.title);
  event.interviewers=ranked.slice(0,count).map(({userId,name,email})=>({userId,name:name||email,email}));
  event.interviewers.forEach(p=>reservations.push({resource:"person:"+p.userId,start,end}));
  if(event.requiresRoom){
   const room=(session.rooms||[]).find(r=>r.resourceId&&available("room:"+r.resourceId,event,snapshot,reservations));
   if(!room)fail("No verified available room for "+session.title);
   event.room={resourceId:room.resourceId,name:room.name||room.resourceId};reservations.push({resource:"room:"+room.resourceId,start,end});
  }
  if(!available("zoom:"+zoomAccountId,event,snapshot,reservations))fail("Zoom availability could not be verified for "+session.title);
  reservations.push({resource:"zoom:"+zoomAccountId,start,end});
  event.notify=[...new Set([candidate.email,...event.interviewers.map(p=>p.email),...(event.room?[(session.rooms||[]).find(r=>r.resourceId===event.room.resourceId).email]:[])])];
  events.push(event);
 }
 const last=localParts(Math.max(...events.map(e=>Date.parse(e.end)-1)),timezone);
 const plan={kind:"new",candidateId:candidate.id,applicationId:application.id,role:application.role,startDate,endDate:`${last.year}-${last.month}-${last.day}`,timezone,templateRevision:template.revision,sourceFingerprint:snapshot.fingerprint,events,blockers:[],sources:template.sources};
 plan.blockers=P.capacityIssues(plan,snapshot.trials);P.validatePlan(plan);return plan;
}
function suggestReplacement({original, eventId, decline, alternatives, snapshot, now}) {
 if(!snapshot || snapshot.complete!==true || !snapshot.fingerprint || !Number.isFinite(Date.parse(snapshot.at)) || !Number.isFinite(Date.parse(now)) || Date.parse(now)-Date.parse(snapshot.at)>300000 || Date.parse(snapshot.at)>Date.parse(now)) fail("Fresh availability is required for replacement");
 P.validatePlan(original);
 const before=original.events.find(event=>event.ashbyEventId===eventId);
 if(!before || !original.ashbyScheduleId || Date.parse(before.start)<=Date.parse(now)) fail("Choose an upcoming existing Ashby session");
 if(!decline || decline.eventId!==eventId || decline.status!=="declined") fail("The selected decline is no longer active");
 const event=JSON.parse(JSON.stringify(before));
 const availability={...snapshot,resources:Object.fromEntries(Object.entries(snapshot.resources||{}).map(([key,value])=>[key,{...value,busy:Array.isArray(value.busy)?value.busy.filter(b=>b.ashbyEventId!==eventId):value.busy}]))};
 if(decline.kind==="interviewer") {
  const index=event.interviewers.findIndex(person=>person.userId===decline.userId);
  if(index<0) fail("Declined interviewer is not on this session");
  const replacement=(alternatives||[]).filter(person=>person.active===true&&person.eligible===true&&person.userId&&person.email&&!event.interviewers.some(p=>p.userId===person.userId))
   .sort((a,b)=>(a.confirmedLoad||0)-(b.confirmedLoad||0)||a.userId.localeCompare(b.userId))
   .find(person=>available("person:"+person.userId,event,availability,[]));
  if(!replacement) fail("No verified available replacement interviewer");
  const oldEmail=event.interviewers[index].email;
  event.interviewers[index]={userId:replacement.userId,name:replacement.name||replacement.email,email:replacement.email};
  event.notify=event.notify.map(email=>email===oldEmail?replacement.email:email);
  if(!event.notify.includes(replacement.email))event.notify.push(replacement.email);
  event.cancelNotify=[oldEmail];
 } else if(decline.kind==="room") {
  if(!event.room || event.room.resourceId!==decline.resourceId) fail("Declined room is not on this session");
  const room=(alternatives||[]).find(r=>r.resourceId!==decline.resourceId&&r.resourceId&&r.email&&available("room:"+r.resourceId,event,availability,[]));
  if(!room) fail("No verified available replacement room");
  if(!decline.email || !event.notify.includes(decline.email))fail("Original room invitation identity is missing");
  event.room={resourceId:room.resourceId,name:room.name||room.resourceId};
  event.notify=event.notify.map(email=>email===decline.email?room.email:email);event.cancelNotify=[decline.email];
 } else fail("Choose an interviewer or room decline");
 event.before=JSON.parse(JSON.stringify(before));event.beforeFingerprint=P.digest(before);
 const plan={...original,kind:"replacement",sourceFingerprint:snapshot.fingerprint,events:[event],blockers:[]};
 // Capacity remains relevant even when only changing an assignment; it is
 // surfaced for coordinator review, and never silently overridden.
 plan.blockers=P.capacityIssues(plan,snapshot.trials);P.validatePlan(plan);return plan;
}
module.exports={instant,available,suggestNew,suggestReplacement};
