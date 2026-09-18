"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createService } = require("../src/scheduling/service");
const { createStore } = require("../src/scheduling/store");
const { createSlack } = require("../src/scheduling/slack");
const user = { id: "coord@example.test", canApprove: true };
const candidate = { applicationId: "app", candidateId: "candidate", candidateName: "Fictional Candidate", jobTitle: "Test Role", status: "Active" };
const input = { applicationId: "app", timezone: "America/Denver", sessions: [{title: "System Design",start:"2030-01-02T10:00:00-07:00",end:"2030-01-02T11:00:00-07:00",interviewers:"Fictional Interviewer",location:"Test room"}] };
function setup(t, options = {}) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-scheduling-")); t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
 const store=createStore(dir);let posts=0;
 const service=createService({store, candidates:async()=>[candidate],clientId:"test",candidateChannels:{candidate:{channelId:"C123",channelName:"candidate-fictional"}},slack:async()=>{posts++;return {ts:"1.2",channel:"C123"};},...options});
 return {service,store,posts:()=>posts,dir};
}
const approval = row => ({revision:row.revision,digest:row.digest,channelId:"C123"});
test("drafting never posts and sharing never grants booking approval",async t=>{
 const {service,posts}=setup(t);const draft=await service.draft(input,user);assert.equal(posts(),0);
 const shared=await service.share(draft.id,approval(draft),user);assert.equal(shared.state,"shared");assert.equal(posts(),1);assert.equal(shared.bookingApproval,null);assert.equal(shared.discussionApproval.by,user.id);
});
test("shared-password users cannot create or approve",async t=>{
 const {service,posts}=setup(t);await assert.rejects(service.draft(input,{}),{status:403});
 const draft=await service.draft(input,user);await assert.rejects(service.share(draft.id,approval(draft),{}),{status:403});assert.equal(posts(),0);
});
test("stale revisions and changed channels cannot post",async t=>{
 const {service,posts}=setup(t);const d=await service.draft(input,user);
 await assert.rejects(service.share(d.id,{...approval(d),revision:99},user),{status:409});
 await assert.rejects(service.share(d.id,{...approval(d),channelId:"C999"},user),{status:409});assert.equal(posts(),0);
});
test("two simultaneous approvals send once",async t=>{
 const {service,posts}=setup(t);const d=await service.draft(input,user);
 const results=await Promise.allSettled([service.share(d.id,approval(d),user),service.share(d.id,approval(d),user)]);
 assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(posts(),1);
});
test("uncertain delivery persists across restart and cannot be retried",async t=>{
 const {service,store,dir}=setup(t,{slack:async()=>{throw new Error("timeout after delivery");}});const d=await service.draft(input,user);
 const result=await service.share(d.id,approval(d),user);assert.equal(result.state,"discussion_uncertain");
 assert.equal((await createStore(dir).get(d.id)).state,"discussion_uncertain");await assert.rejects(service.share(d.id,approval(result),user),{status:409});
});
test("candidate-specific routing never falls back to a client channel",async t=>{
 const {service,posts}=setup(t,{candidateChannels:{},channelId:"C123"});const d=await service.draft(input,user);
 await assert.rejects(service.share(d.id,approval(d),user),{status:503});assert.equal(posts(),0);
});
test("client-wide routing is an explicit option",async t=>{
 const {service}=setup(t,{candidateChannels:{},channelId:"C123",routing:"client"});const d=await service.draft(input,user);assert.equal((await service.share(d.id,approval(d),user)).state,"shared");
});
test("cross-client proposals cannot be approved",async t=>{
 const {service,store}=setup(t);const d=await service.draft(input,user);await store.replace(d.id,1,{...d,clientId:"other",revision:2});
 await assert.rejects(service.share(d.id,{...approval(d),revision:2},user),{status:404});
});
test("disconnected booking records no approval and performs no write",async t=>{
 const {service,store}=setup(t);const d=await service.draft(input,user);await assert.rejects(service.approveBooking(d.id,approval(d),user),{status:503});assert.equal((await store.get(d.id)).bookingApproval,null);
});
test("date validation rejects ambiguous and reversed session times",async t=>{
 const {service}=setup(t);await assert.rejects(service.draft({...input,sessions:[{...input.sessions[0],start:"2030-01-02T10:00:00"}]},user),{status:400});await assert.rejects(service.draft({...input,sessions:[{...input.sessions[0],end:"2029-01-01T00:00:00Z"}]},user),{status:400});
});
test("corrupt storage and stale writer locks fail closed",async t=>{
 const {store,dir}=setup(t);fs.writeFileSync(path.join(dir,"scheduling.json"),"invalid");await assert.rejects(store.list());fs.writeFileSync(path.join(dir,"scheduling.json"),"{}");fs.writeFileSync(path.join(dir,"scheduling.json.lock"),"");await assert.rejects(store.insert({id:"test"}),{status:409});
});
test("Slack uses reviewed channel, plain text, and requires a success receipt",async()=>{
 let sent;const slack=createSlack("fictional-token",async(url,init)=>{sent=JSON.parse(init.body);return {ok:true,json:async()=>({ok:true,ts:"1",channel:"C123"})};});
 await slack({...input,candidateName:"Fictional",jobTitle:"Role"},{channelId:"C123",proposalId:"draft",approver:user.id});assert.equal(sent.channel,"C123");assert.equal(sent.mrkdwn,false);assert.match(sent.text,/not been booked/);
 const failed=createSlack("fictional-token",async()=>({ok:true,json:async()=>({ok:false})}));await assert.rejects(failed({...input},{channelId:"C123"}));
});
test("Ashby template reader uses the active stage and rejects inactive applications",async()=>{
 const {createTemplateReader}=require("../src/scheduling/ashby-template");const called=[];
 const read=createTemplateReader("fictional",async(url,init)=>{called.push(url);const results=url.endsWith("application.info")?{status:"Active",candidate:{id:"candidate"},job:{id:"job"},currentInterviewStage:{id:"current"}}:{stages:[{id:"wrong",activities:[{id:"bad",interviews:[{isSchedulable:true}]}]},{id:"current",title:"Onsite",activities:[{id:"loop",title:"Loop",interviews:[{title:"Design",interviewId:"design",interviewDurationMinutes:60,isSchedulable:true},{title:"Hidden",isSchedulable:false}]}]}]};return {ok:true,json:async()=>({success:true,results})};});
 const plan=await read("app");assert.equal(plan.activities.length,1);assert.equal(plan.activities[0].sessions.length,1);assert.equal(plan.activities[0].sessions[0].durationMinutes,60);assert.equal(plan.availabilityVerified,false);assert.equal(called.length,2);
 const archived=createTemplateReader("fictional",async()=>({ok:true,json:async()=>({success:true,results:{status:"Archived"}})}));await assert.rejects(archived("app"),{status:409});
});
test("sharing rechecks the current application and stops on changed candidate",async t=>{
 const {service,posts}=setup(t,{templateReader:async()=>({candidateId:"different"})});const d=await service.draft(input,user);await assert.rejects(service.share(d.id,approval(d),user),{status:409});assert.equal(posts(),0);
});
