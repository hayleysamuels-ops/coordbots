'use strict';
const {digest}=require('./service');
const {ashbyRead}=require('./ashby-read');
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
function normalizeSubmission(data,now=Date.now()){
  if(data?.complete!==true||!data.timezone||!Array.isArray(data.windows))fail(409,'The submitted availability could not be read completely. Review it in Ashby.');
  let format;try{format=new Intl.DateTimeFormat('en-CA',{timeZone:data.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}catch(_){fail(409,'The submitted availability timezone could not be verified.');}
  const local=ms=>{const p=Object.fromEntries(format.formatToParts(ms).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;};
  const seen=new Set(),windows=[];let expiredCount=0;
  for(const w of data.windows){
    if(![w.start,w.end].every(v=>typeof v==='string'&&/(Z|[+-]\d{2}:\d{2})$/.test(v)))fail(409,'Availability windows must include their UTC offset.');
    const start=Date.parse(w.start),end=Date.parse(w.end);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>86400000)fail(409,'A submitted availability window could not be verified.');
    // Never silently shrink a candidate's partially elapsed window.
    if(start<=now){expiredCount++;continue;}
    const key=start+':'+end;if(seen.has(key))continue;seen.add(key);windows.push({start:new Date(start).toISOString(),end:new Date(end).toISOString()});
  }
  windows.sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
  if(windows.length>20)fail(409,'This submission has more than 20 windows. Review it in Ashby.');
  // Weeks the worker couldn't read: availability in them is unknown, not empty.
  const unreadWeeks=Array.isArray(data.unreadWeeks)?data.unreadWeeks.filter(w=>Number.isInteger(w?.week)).map(w=>({week:w.week,shown:typeof w.shown==='string'?w.shown.slice(0,40):''})):[];
  return {timezone:data.timezone,scope:data.scope||null,windows,localWindows:windows.map(w=>({start:local(Date.parse(w.start)),end:local(Date.parse(w.end))})),expiredCount,unreadWeeks,notes:typeof data.notes==='string'?data.notes:'',complete:true};
}
// Reads go through ashby-read.js: status kept, transient failures retried within seconds.
function createAvailabilitySource({key,clientId,inspect,request=fetch,now=()=>Date.now(),sleep,log=console}){
  async function read(endpoint,body){if(!key||!clientId)fail(503,'The client Ashby connection is not configured.');const {ok,data:d}=await ashbyRead({key,endpoint,body,request,...(sleep?{sleep}:{}),log});if(!ok||d?.success!==true)fail(503,'Could not refresh submitted availability from Ashby.');return d;}
  // Every interview schedule on the application, all pages, or a refusal.
  async function schedules(applicationId){
    const rows=[];let cursor;const cursors=new Set();
    do{const d=await read('interviewSchedule.list',{applicationId,limit:100,...(cursor?{cursor}:{})});if(!Array.isArray(d.results))fail(503,'The pending interview requests could not be read.');rows.push(...d.results);cursor=d.moreDataAvailable?d.nextCursor:null;if(d.moreDataAvailable&&(!cursor||cursors.has(cursor)))fail(503,'The pending request list is incomplete.');cursors.add(cursor);if(cursors.size>50)fail(503,'The pending request list is too large.');}while(cursor);
    return rows;
  }
  async function requests(applicationId){
    if(!uuid(applicationId))fail(422,'Choose a candidate application.');
    const app=(await read('application.info',{applicationId})).results;
    if(app?.id!==applicationId||app.status!=='Active'||!uuid(app.candidate?.id)||!uuid(app.currentInterviewStage?.id))fail(409,'The candidate application or current stage has changed.');
    const rows=await schedules(applicationId);
    const pending=s=>s.status==='CandidateAvailabilitySubmitted'&&s.interviewStageId===app.currentInterviewStage.id;
    const mine=rows.filter(s=>s.applicationId===applicationId&&uuid(s.id));
    // `others`: this application's schedules that aren't pending, with their
    // status and stage, so a refusal can say what happened to one (notPending).
    return {applicationId,candidateId:app.candidate.id,candidateName:app.candidate.name,stageId:app.currentInterviewStage.id,requests:mine.filter(pending).map(s=>({scheduleId:s.id,stageId:s.interviewStageId,updatedAt:s.updatedAt})),
      others:mine.filter(s=>!pending(s)).map(s=>({scheduleId:s.id,stageId:s.interviewStageId,status:typeof s.status==='string'?s.status.slice(0,60):null}))};
  }
  async function load({applicationId,scheduleId}){
    if(!uuid(scheduleId))fail(422,'Choose the pending availability request.');
    const before=await requests(applicationId),selected=before.requests.find(s=>s.scheduleId===scheduleId);
    // `notPending` on the error says why, for a caller with other words (ashby-check.js).
    if(!selected){const why=whyNotPending(before,scheduleId);throw Object.assign(Error(notPendingText(why)),{status:409,notPending:why});}
    if(!Number.isFinite(Date.parse(selected.updatedAt)))fail(409,'The availability request\'s last update couldn\'t be read from Ashby. Review the request there.');
    if(!inspect)fail(503,'Submitted availability reading is not connected.');
    const raw=await inspect({...before,requests:undefined,scheduleId});
    if(raw.scheduleId!==scheduleId||raw.applicationId!==applicationId||raw.candidateId!==before.candidateId)fail(409,'The availability belongs to a different interview request.');
    const normalized=normalizeSubmission(raw,now());
    const after=await requests(applicationId),latest=after.requests.find(s=>s.scheduleId===scheduleId);
    if(!latest||after.candidateId!==before.candidateId||after.stageId!==before.stageId||latest.updatedAt!==selected.updatedAt)fail(409,'The availability request changed while it was being read. Reload it.');
    return {...normalized,applicationId,scheduleId,stageId:before.stageId,source:'ashby_submission',requestUpdatedAt:selected.updatedAt,checkedAt:now(),revision:digest({scheduleId,updatedAt:selected.updatedAt,...normalized}),bookingEnabled:false};
  }
  // Where one interview schedule stands in Ashby now, for an open post built
  // from it (post-watch.js): the application's status and current stage, and
  // the schedule's status, stage, who booked it and its events, names only.
  // Unlike requests(), an application that isn't Active is an answer, not a
  // refusal. `schedule` is null when the application has no such schedule.
  async function scheduleState(applicationId,scheduleId){
    if(!uuid(applicationId)||!uuid(scheduleId))fail(422,'Choose a candidate application and interview request.');
    const app=(await read('application.info',{applicationId})).results;
    if(app?.id!==applicationId||typeof app.status!=='string')fail(503,'The candidate application could not be read from Ashby.');
    const s=(await schedules(applicationId)).find(x=>x.id===scheduleId&&x.applicationId===applicationId);
    const name=u=>[u?.firstName,u?.lastName].filter(x=>typeof x==='string'&&x.trim()).join(' ').slice(0,80)||null;
    return {applicationStatus:app.status.slice(0,40),stageId:app.currentInterviewStage?.id||null,
      schedule:s?{status:typeof s.status==='string'?s.status.slice(0,60):null,stageId:s.interviewStageId||null,scheduledBy:name(s.scheduledBy),
        events:(Array.isArray(s.interviewEvents)?s.interviewEvents:[]).filter(e=>Number.isFinite(Date.parse(e?.startTime))&&Number.isFinite(Date.parse(e?.endTime)))
          .map(e=>({start:new Date(Date.parse(e.startTime)).toISOString(),end:new Date(Date.parse(e.endTime)).toISOString(),interviewers:(Array.isArray(e.interviewers)?e.interviewers:[]).map(name).filter(Boolean)}))
          .sort((a,b)=>Date.parse(a.start)-Date.parse(b.start))}:null};
  }
  return {requests,load,scheduleState};
}
// What happened to an interview request that isn't pending any more, and
// what the reader should do, in words for Slack and booking review.
// whyNotPending: `pending` is requests() for the application, `scheduleId`
// the request the option was built from, and `stageId`, if given, the stage
// the plan was read in (a move between the two reads is a stage change too).
// An older requests() result without `others` reads as "gone".
// notPendingText: `after` is what was being attempted, "rebuild" (Suggest
// another time, booking review) or "approval" (the Schedule button's Ashby
// check), which changes only the middle of the sentence.
const BOOKED=new Set(['Scheduled','WaitingOnFeedback','Complete']);
function whyNotPending(pending,scheduleId,stageId=pending?.stageId){
  const s=(pending?.others||[]).find(x=>x.scheduleId===scheduleId);
  if(pending?.stageId!==stageId||(s&&s.stageId!==pending.stageId))return {kind:'stage'};
  if(s&&BOOKED.has(s.status))return {kind:'booked',status:s.status};
  if(s?.status==='Cancelled')return {kind:'cancelled',status:s.status};
  if(s?.status)return {kind:'other',status:s.status};
  return {kind:'gone'};
}
const NOT_PENDING={
  stage:{cause:()=>'The candidate has moved to another stage in Ashby since this option was built',rebuild:"so this option no longer applies: don't schedule it.",action:'Schedule the new stage from its own request.'},
  booked:{cause:w=>`This interview has already been booked in Ashby (its status there is ${w.status})`,rebuild:"so this option is out of date and there's nothing to replace: don't schedule it.",action:'Check the booked time in Ashby, and change it there if it needs changing.'},
  cancelled:{cause:()=>'This interview request was cancelled in Ashby',rebuild:"so this option is out of date and there's no availability to build another from.",action:'If the candidate still needs this interview, send them a new availability request in Ashby.'},
  other:{cause:w=>`This interview request is no longer waiting to be scheduled in Ashby (its status there is ${w.status})`,rebuild:"so another option can't be built from it.",action:'Check the request in Ashby; once the candidate has submitted availability again, post a fresh option from booking review.'},
  gone:{cause:()=>'This interview request is no longer pending in Ashby',rebuild:"so another option can't be built from it.",action:'Check the candidate in Ashby: if this interview has been booked there, nothing more is needed; if not, send a new availability request.'},
};
function notPendingText(why,after='rebuild'){
  const t=NOT_PENDING[why?.kind]||NOT_PENDING.gone;
  return `${t.cause(why||{})}, ${after==='approval'?'so this approval wasn\'t composed and nothing was made in Ashby.':t.rebuild} ${t.action}`;
}
const notPending=(pending,scheduleId,stageId,after)=>notPendingText(whyNotPending(pending,scheduleId,stageId),after);
module.exports={createAvailabilitySource,normalizeSubmission,whyNotPending,notPendingText,notPending,BOOKED};
