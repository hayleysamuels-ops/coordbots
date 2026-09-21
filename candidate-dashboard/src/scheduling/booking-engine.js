"use strict";
const crypto=require("crypto");
const {digest}=require("./service");
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const copy=value=>JSON.parse(JSON.stringify(value));
function validate(plan,now=Date.now()) {
  if(!plan || !plan.clientId || !plan.applicationId || !plan.candidateId || !plan.sourceFingerprint || !plan.templateRevision) fail(422,"Verified scheduling sources are required");
  if(!Array.isArray(plan.events)||!plan.events.length||plan.events.length>30)fail(422,"Review the complete interview agenda");
  const keys=new Set();
  for(const e of plan.events){
    if(!e.key||keys.has(e.key)||!e.interviewId||!e.title)fail(422,"Each interview needs a unique source identity");keys.add(e.key);
    if(![e.start,e.end].every(s=>typeof s==="string"&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(s)&&Number.isFinite(Date.parse(s)))||Date.parse(e.start)<=now||Date.parse(e.end)<=Date.parse(e.start))fail(422,"Choose future, unambiguous interview times");
    if(!Array.isArray(e.interviewers)||!e.interviewers.length||e.interviewers.some(p=>!p.userId||!p.email))fail(422,"Verified interviewers are required");
    if(!e.location || !e.conferencing || !["none","google_meet","zoom"].includes(e.conferencing.provider))fail(422,"Review location and conferencing");
    if(e.conferencing.provider!=="none"&&!e.conferencing.accountId)fail(422,"Verify the conferencing organizer");
    if(!Array.isArray(e.notify)||!e.notify.length||e.notify.some(v=>typeof v!=="string"||!/^\S+@\S+\.\S+$/.test(v))||!e.notify.includes(plan.candidateEmail)||e.interviewers.some(p=>!e.notify.includes(p.email)))fail(422,"Review every invitation recipient");
    if(e.room && (!e.room.resourceId||!e.room.email||!e.notify.includes(e.room.email)))fail(422,"Verify the room invitation");
  }
  if (!plan.communications) fail(422,"Review calendar invitations and the candidate confirmation email");
  if (plan.communications) {
    const c=plan.communications;
    if(c.sendCandidateInvite!==true || c.sendInterviewerInvite!==true || c.sendConfirmation!==true) fail(422,"Calendar invitations and candidate confirmation must be enabled");
    if(!c.confirmation || c.confirmation.to!==plan.candidateEmail || !c.confirmation.from || !c.confirmation.subject || !c.confirmation.body || !Array.isArray(c.confirmation.cc) || !Array.isArray(c.confirmation.bcc)) fail(422,"Review the complete confirmation email and recipients");
  }
  const sorted=plan.events.slice().sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
  if(sorted.some((e,i)=>i&&Date.parse(e.start)<Date.parse(sorted[i-1].end)))fail(422,"Candidate sessions overlap");
}
// Used only with a separately verified adapter. No public API record is treated
// as a dispatched invitation. Readback must match the full approved event list.
function receiptMatches(plan,receipt){
  if(!receipt?.scheduleId||receipt.applicationId!==plan.applicationId||receipt.candidateId!==plan.candidateId||receipt.readBack!==true||!Array.isArray(receipt.events)||digest(receipt.events)!==digest(plan.events))return false;
  if(plan.communications?.sendConfirmation && (!receipt.confirmation || receipt.confirmation.state!=="sent" || !receipt.confirmation.externalId || receipt.confirmation.to!==plan.candidateEmail || receipt.confirmation.contentDigest!==digest(plan.communications.confirmation))) return false;
  const expected=plan.events.flatMap(e=>[...new Set(e.notify)].map(recipient=>JSON.stringify([e.key,recipient]))).sort();
  const sent=receipt.notifications;
  return Array.isArray(sent)&&sent.length===expected.length&&sent.every(n=>n.state==="sent"&&n.externalId)&&digest(sent.map(n=>JSON.stringify([n.eventKey,n.recipient])).sort())===digest(expected);
}
function createBookingEngine({store,clientId,source,executor,userById,now=()=>Date.now()}) {
  const actor=user=>{if(!user?.id||user.canApprove!==true)fail(403,"Individual coordinator approval is required");};
  async function current(id,input){const row=await store.get(id);if(!row||row.clientId!==clientId)fail(404,"Booking draft not found");if(row.revision!==input.revision||row.digest!==input.digest||digest(row.plan)!==row.digest)fail(409,"Review the latest booking draft");return row;}
  async function transition(row,state,details={}){const next={...row,...details,state,revision:row.revision+1};if(!await store.replace(row.id,row.revision,next))fail(409,"Booking draft changed");return next;}
  async function revalidate(plan){const fresh=await source.revalidate(copy(plan));if(!fresh||fresh.ready!==true||fresh.available!==true||fresh.sourceFingerprint!==plan.sourceFingerprint||fresh.templateRevision!==plan.templateRevision||!Number.isFinite(fresh.checkedAt)||now()-fresh.checkedAt>60000||fresh.checkedAt>now())fail(409,"Availability or interview requirements changed; review a new draft");}
  return {
    async draft(request,user){actor(user);if(!source)fail(503,"Verified availability source is not connected");
      const plan=copy(await source.suggest(request));if(plan.clientId!==clientId)fail(409,"Wrong client source");validate(plan,now());await revalidate(plan);
      const row={id:crypto.randomUUID(),clientId,state:"draft",revision:1,plan,digest:digest(plan),approval:null,operation:null,audit:[{action:"drafted",by:user.id,at:now()}]};
      if(!await store.insert(row))fail(409,"An unresolved booking already exists for this candidate");return row;
    },
    async reject(id,input,user){actor(user);const row=await current(id,input);if(!["draft","needs_review"].includes(row.state))fail(409,"This booking cannot be rejected after submission");return transition(row,"rejected",{approval:null,audit:[...row.audit,{action:"rejected",by:user.id,at:now()}]});},
    async approve(id,input,user){actor(user);if(!executor || executor.verified!==true)fail(503,"Booking adapter has not been verified; no approval recorded");
      let row=await current(id,input);if(row.state!=="draft")fail(409,"This draft is not awaiting booking approval");validate(row.plan,now());await revalidate(row.plan);
      return transition(row,"approved",{approval:{by:user.id,digest:row.digest,revision:row.revision,at:now()},audit:[...row.audit,{action:"approved_for_booking",by:user.id,at:now()}]});
    },
    async execute(id){
      if(!executor||executor.verified!==true)fail(503,"Booking adapter is unavailable");
      let row=await store.get(id);if(!row||row.clientId!==clientId||row.state!=="approved")return {skipped:true};
      try{row=await transition(row,"checking");}catch(e){if(e.status===409)return {skipped:true};throw e;}
      try{
        actor(await userById(row.approval?.by));validate(row.plan,now());
        if(!row.approval||row.approval.digest!==row.digest||digest(row.plan)!==row.digest)fail(409,"Approval changed");
        await revalidate(row.plan);
        // Intent is durable before the first potentially mutating action. A
        // crash or timeout here is never retried automatically.
        row=await transition(row,"submitting",{operation:{id:row.id+":"+row.digest,startedAt:now()}});
        const result=await executor.submit(copy(row.plan),{operationId:row.operation.id});
        const receipt=await executor.readBack(copy(row.plan),result);
        if(!receiptMatches(row.plan,receipt))throw new Error("Invitation delivery not verified");
        return await transition(row,"scheduled",{receipt,audit:[...row.audit,{action:"booking_verified",at:now()}]});
      }catch(_){return transition(row,row.operation?"reconciliation_required":"needs_review",{approval:null,issue:row.operation?"Check Ashby and invitation delivery before any retry.":"Scheduling facts or coordinator permission changed. Prepare a new draft."});}
    },
  };
}
module.exports={createBookingEngine,validate,receiptMatches};
