"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createAshbyExecutor}=require("../lib/scheduling/ashby-executor");
const plan={kind:"new",applicationId:"app",sourceFingerprint:"fingerprint",events:[{interviewId:"interview",start:"2026-09-21T14:00:00Z",end:"2026-09-21T14:45:00Z",interviewers:[{email:"jenna@example.com"}]}]};
test("executor creates only the immutable approved events and verifies the receipt",async()=>{
 let input;const api={application:async()=>({id:"app",status:"Active",job:{id:"job"},currentInterviewStage:{id:"stage"}}),interviewPlan:async()=>({activities:[{interviewId:"interview"}]}),users:async()=>[{id:"user",email:"jenna@example.com",enabled:true}],fingerprint:()=>"fingerprint",createSchedule:async value=>{input=value;return {id:"schedule",status:"Scheduled",interviewEvents:[{interviewId:"interview",startTime:"2026-09-21T14:00:00Z",endTime:"2026-09-21T14:45:00Z",interviewers:[{email:"jenna@example.com"}]}]};}};
 const executor=createAshbyExecutor({api});assert.deepEqual(await executor.preflight(plan),{sourceFingerprint:"fingerprint",available:true,ready:true});
 const receipt=await executor.book(plan,{operationId:"op"});assert.equal(input.applicationId,"app");assert.equal(input.interviewEvents[0].extraData.trackerOperationId,"op");assert.deepEqual(input.interviewEvents[0].interviewers,[{email:"jenna@example.com"}]);
 const verified=await executor.verify(plan,receipt);assert.equal(verified.matches,true);assert.equal(verified.invitesConfirmed,false);assert.equal(verified.deliveryStatus,"not_verified");assert.equal(verified.scheduleId,"schedule");
});
