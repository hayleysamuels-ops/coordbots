'use strict';
const {digest}=require('./service');
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
  return {timezone:data.timezone,scope:data.scope||null,windows,localWindows:windows.map(w=>({start:local(Date.parse(w.start)),end:local(Date.parse(w.end))})),expiredCount,notes:typeof data.notes==='string'?data.notes:'',complete:true};
}
function createAvailabilitySource({key,clientId,inspect,request=fetch,now=()=>Date.now()}){
  async function read(endpoint,body){if(!key||!clientId)fail(503,'The client Ashby connection is not configured.');const r=await request('https://api.ashbyhq.com/'+endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Basic '+Buffer.from(key+':').toString('base64'),'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok||d.success!==true)fail(503,'Could not refresh submitted availability from Ashby.');return d;}
  async function requests(applicationId){
    if(!uuid(applicationId))fail(422,'Choose a candidate application.');
    const app=(await read('application.info',{applicationId})).results;
    if(app?.id!==applicationId||app.status!=='Active'||!uuid(app.candidate?.id)||!uuid(app.currentInterviewStage?.id))fail(409,'The candidate application or current stage has changed.');
    const rows=[];let cursor;const cursors=new Set();
    do{const d=await read('interviewSchedule.list',{applicationId,limit:100,...(cursor?{cursor}:{})});if(!Array.isArray(d.results))fail(503,'The pending interview requests could not be read.');rows.push(...d.results);cursor=d.moreDataAvailable?d.nextCursor:null;if(d.moreDataAvailable&&(!cursor||cursors.has(cursor)))fail(503,'The pending request list is incomplete.');cursors.add(cursor);if(cursors.size>50)fail(503,'The pending request list is too large.');}while(cursor);
    return {applicationId,candidateId:app.candidate.id,candidateName:app.candidate.name,stageId:app.currentInterviewStage.id,requests:rows.filter(s=>s.applicationId===applicationId&&s.status==='CandidateAvailabilitySubmitted'&&s.interviewStageId===app.currentInterviewStage.id&&uuid(s.id)).map(s=>({scheduleId:s.id,stageId:s.interviewStageId,updatedAt:s.updatedAt}))};
  }
  async function load({applicationId,scheduleId}){
    if(!uuid(scheduleId))fail(422,'Choose the pending availability request.');
    const before=await requests(applicationId),selected=before.requests.find(s=>s.scheduleId===scheduleId);
    if(!selected||!Number.isFinite(Date.parse(selected.updatedAt)))fail(409,'That availability request is no longer pending in the candidate’s current stage.');
    if(!inspect)fail(503,'Submitted availability reading is not connected.');
    const raw=await inspect({...before,requests:undefined,scheduleId});
    if(raw.scheduleId!==scheduleId||raw.applicationId!==applicationId||raw.candidateId!==before.candidateId)fail(409,'The availability belongs to a different interview request.');
    const normalized=normalizeSubmission(raw,now());
    const after=await requests(applicationId),latest=after.requests.find(s=>s.scheduleId===scheduleId);
    if(!latest||after.candidateId!==before.candidateId||after.stageId!==before.stageId||latest.updatedAt!==selected.updatedAt)fail(409,'The availability request changed while it was being read. Reload it.');
    return {...normalized,applicationId,scheduleId,stageId:before.stageId,source:'ashby_submission',requestUpdatedAt:selected.updatedAt,checkedAt:now(),revision:digest({scheduleId,updatedAt:selected.updatedAt,...normalized}),bookingEnabled:false};
  }
  return {requests,load};
}
module.exports={createAvailabilitySource,normalizeSubmission};
