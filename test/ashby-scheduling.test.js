"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createAshbySchedulingApi}=require("../lib/scheduling/ashby-api");
const {createAshbyProvider,at}=require("../lib/scheduling/ashby-provider");

test("Eastern wall time is converted across daylight saving time",()=>{
  assert.equal(at("2026-09-21","10:00","America/New_York"),"2026-09-21T14:00:00.000Z");
  assert.equal(at("2026-12-21","10:00","America/New_York"),"2026-12-21T15:00:00.000Z");
});
test("Ashby scheduling API keeps the key in Basic auth and exposes the supported write",async()=>{
  let seen;const api=createAshbySchedulingApi("secret",async(url,options)=>{seen={url,options};return {success:true,results:{id:"schedule"}};});
  assert.deepEqual(await api.createSchedule({applicationId:"app",interviewEvents:[]}),{id:"schedule"});
  assert.equal(seen.url,"https://api.ashbyhq.com/interviewSchedule.create");
  assert.equal(seen.options.headers.Authorization,"Basic "+Buffer.from("secret:").toString("base64"));
});
test("user lookup supplies the email required by Ashby",async()=>{
 let seen;const api=createAshbySchedulingApi("secret",async(_url,options)=>{seen=options.body;return {success:true,results:[]};});
 await api.users("jenna@example.com");assert.deepEqual(seen,{email:"jenna@example.com"});
});
test("provider resolves the active work-trial application, plan session and enabled interviewer",async()=>{
  const api={candidate:async()=>({applicationIds:["app"],primaryEmailAddress:{value:"candidate@example.com"}}),application:async()=>({id:"app",status:"Active",job:{id:"job"},currentInterviewStage:{id:"stage",title:"Work Trial"}}),interviewPlan:async()=>({stages:[{id:"stage",title:"Work Trial",activities:[{title:"Agent Shadowing",interviewId:"interview",durationMinutes:45}]}]}),users:async()=>[{id:"user",name:"Liam",email:"liam@poetic.com",enabled:true}],fingerprint:value=>JSON.stringify(value)};
  const provider=createAshbyProvider({api,trials:async()=>[],assignments:async()=>({partner:{ok:true,value:"FDE-Liam"}})});
  const plan=await provider.suggest({name:"Test Tess",values:{ashbyCandidateId:"candidate",position:"FDE"}},{kind:"new",startDate:"2026-09-21",endDate:"2026-09-21",timezone:"America/New_York",startTime:"10:00",sessionTitle:"Agent Shadowing"});
  assert.equal(plan.applicationId,"app");assert.equal(plan.events[0].start,"2026-09-21T14:00:00.000Z");assert.equal(plan.events[0].end,"2026-09-21T14:45:00.000Z");assert.equal(plan.events[0].interviewers[0].userId,"user");assert.deepEqual(plan.events[0].notify,["candidate@example.com"]);
  assert.equal(plan.role,"FDE");assert.equal(plan.pilot,true);assert.deepEqual(plan.blockers,[]);
});
test("full work trial includes the main Ashby agenda and excludes pre-trial agent shadowing",async()=>{
  const api={candidate:async()=>({applicationIds:["app"],email:"candidate@example.com"}),application:async()=>({id:"app",status:"Active",job:{id:"job"},currentInterviewStage:{id:"stage",title:"Work Trial"}}),interviewPlan:async()=>({stages:[{id:"stage",title:"Work Trial",activities:[{interviews:[{title:"Welcome",interviewId:"welcome",interviewDurationMinutes:45},{title:"Build Time",interviewId:"build",interviewDurationMinutes:195}]},{interviews:[{title:"Agent Shadowing",interviewId:"shadow",interviewDurationMinutes:45}]}]}]}),users:async()=>[{id:"user",email:"liam@poetic.com",enabled:true}],fingerprint:value=>JSON.stringify(value)};
  const plan=await createAshbyProvider({api,trials:async()=>[],assignments:async()=>({partner:{ok:true,value:"FDE-Liam"}})}).suggest({name:"Test Tess",values:{ashbyCandidateId:"candidate",position:"FDE"}},{kind:"new",startDate:"2026-09-22",endDate:"2026-09-22",timezone:"America/New_York",startTime:"09:00",sessionTitle:"Full Work Trial"});
  assert.deepEqual(plan.events.map(e=>e.title),["Welcome","Build Time"]);assert.equal(plan.events[0].start,"2026-09-22T13:00:00.000Z");assert.equal(plan.events[1].start,"2026-09-22T13:45:00.000Z");assert.equal(plan.events[1].end,"2026-09-22T17:00:00.000Z");
});
