"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createSchedulingService } = require("../lib/scheduling/service");
const P = require("../lib/scheduling/proposal");
const actor = { active: true, email: "rc@example.com", can_approve: true };
function setup() {
  let row, linked = "ashby", ready = true, stale = false, requestSeen;
  const plan = { candidateId:"ashby", applicationId:"application", kind:"new", templateRevision:"verified-v1", sourceFingerprint:"source", timezone:"America/New_York", role:"FDE", startDate:"2026-09-21", endDate:"2026-09-21", blockers:[], events:[{ key:"test", title:"Test", interviewId:"type", start:"2026-09-21T10:00:00-04:00", end:"2026-09-21T10:30:00-04:00", interviewers:[{userId:"jenna",email:"interviewer@example.com"}],conferencing:{provider:"zoom",accountId:"zoom"},notify:["test@example.com"] }] };
  const store = { list:async()=>row?[row]:[],get:async()=>row,insert:async value=>{row=value;return true;},replace:async(id,revision,next)=>{if(row.revision!==revision)return false;row=next;return true;} };
  const candidates = async()=>[{id:"tracker",values:{ashbyCandidateId:linked}}];
  const provider = {readiness:async()=>({ready,blockers:[]}),suggest:async(c,request)=>{requestSeen=request;return structuredClone(plan);},revalidate:async p=>({ready:true,digest:stale?"changed":P.digest(p)})};
  return { service:createSchedulingService({store,candidates,provider}), store,candidates, provider, plan, get row(){return row;},get request(){return requestSeen;},set linked(v){linked=v;},set ready(v){ready=v;},set stale(v){stale=v;} };
}
const request = {kind:"new",startDate:"2026-09-21",endDate:"2026-09-21",timezone:"America/New_York",startTime:"10:00",sessionTitle:"Agent Shadowing",interviewerEmail:"jenna@example.com"};
test("unconfigured integration cannot generate or approve bookings",async()=>{
 const t=setup(),service=createSchedulingService({store:t.store,candidates:t.candidates});
 assert.equal((await service.readiness()).ready,false);
 await assert.rejects(service.suggest("tracker",request,actor),{status:503});
 assert.equal(t.row,undefined);
});
test("suggestions use linked identity and server provider, not browser plan or clearance",async()=>{
 const t=setup();await t.service.suggest("tracker",{...request,plan:{candidateId:"other"},blockers:[],approved:true},actor);
 assert.equal(t.row.plan.candidateId,"ashby");assert.equal(t.row.trackerCandidateId,"tracker");assert.equal(t.row.state,"draft");
 assert.equal(t.request.plan,undefined);assert.equal(t.request.approved,undefined);
});
test("approval enforces actor, revision, digest and current link",async()=>{
 const t=setup();const row=await t.service.suggest("tracker",request,actor), input={revision:row.revision,digest:row.digest};
 await assert.rejects(t.service.approve(row.id,input,{...actor,can_approve:false}),{status:403});
 await assert.rejects(t.service.approve(row.id,{...input,revision:0},actor),{status:409});
 await assert.rejects(t.service.approve(row.id,{...input,digest:"forged"},actor),{status:422});
 t.linked="other";await assert.rejects(t.service.approve(row.id,input,actor),{status:409});t.linked="ashby";
 t.stale=true;await assert.rejects(t.service.approve(row.id,input,actor),{status:409});t.stale=false;
 t.ready=false;await assert.rejects(t.service.approve(row.id,input,actor),{status:503});t.ready=true;
 const approved=await t.service.approve(row.id,input,actor);assert.equal(approved.state,"approved");assert.equal(approved.approval.by,actor.email);
});
test("proposal-only approval is saved without entering the worker queue",async()=>{
 const t=setup(),service=createSchedulingService({store:t.store,candidates:t.candidates,provider:t.provider,proposalOnly:true});
 const row=await service.suggest("tracker",request,actor),approved=await service.approve(row.id,{revision:row.revision,digest:row.digest},actor);
 assert.equal(approved.state,"suggestion_approved");assert.equal(approved.audit.at(-1).action,"saved_as_suggestion");
});
test("rejection invalidates approval but cannot conceal attempted bookings",async()=>{
 const t=setup();let row=await t.service.suggest("tracker",request,actor);row=await t.service.approve(row.id,{revision:row.revision,digest:row.digest},actor);
 row=await t.service.reject(row.id,{revision:row.revision},actor);assert.equal(row.state,"rejected");assert.equal(row.approval,null);
 row.state="needs_review";row.operations=[{state:"started"}];
 await assert.rejects(t.service.reject(row.id,{revision:row.revision},actor),{status:409});
});
test("invalid dates and missing replacement identity never reach provider",async()=>{
 const t=setup();for(const bad of [{endDate:"2026-09-20"},{timezone:"fake"},{kind:"replacement"}])await assert.rejects(t.service.suggest("tracker",{...request,...bad},actor),{status:400});
 assert.equal(t.row,undefined);
});
test("context exposes server-selected resources for the requested dates",async()=>{
 const t=setup(),seen=[];t.provider.resources=async(_candidate,constraints)=>{seen.push(constraints);return {partner:{ok:true,value:"FDE-Liam"},laptop:{ok:true,value:"SF-Poetic 4"}};};
 const context=await t.service.context("tracker",{startDate:"2026-09-22",endDate:"2026-09-23"});
 assert.equal(context.resources.partner.value,"FDE-Liam");assert.equal(context.resources.laptop.value,"SF-Poetic 4");assert.deepEqual(seen,[{startDate:"2026-09-22",endDate:"2026-09-23"}]);
});
