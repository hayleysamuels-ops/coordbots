"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {instant,suggestNew}=require("../lib/scheduling/planner");
test("civil times use requested timezone and refuse DST gaps and folds",()=>{
 assert.equal(instant("2026-09-21","10:00","America/New_York"),"2026-09-21T14:00:00.000Z");
 assert.throws(()=>instant("2026-03-08","02:30","America/New_York"),/daylight/);
 assert.throws(()=>instant("2026-11-01","01:30","America/New_York"),/daylight/);
});
function fixture(){const working=[{start:"2026-09-21T09:00:00Z",end:"2026-09-22T00:00:00Z"}],calendar={complete:true,busy:[],working};return {candidate:{id:"candidate",email:"candidate@example.com"},application:{id:"app",candidateId:"candidate",role:"FDE",active:true},template:{verified:true,revision:"v1",role:"FDE",sources:{ashby:"verified plan",playbook:"verified playbook"},sessions:[{key:"welcome",title:"Welcome",interviewId:"interview",dayOffset:0,localTime:"10:00",durationMinutes:30,requiresRoom:true,interviewers:[{userId:"person",email:"interviewer@example.com",active:true,eligible:true}],rooms:[{resourceId:"room",email:"room@example.com"}]}]},startDate:"2026-09-21",timezone:"America/New_York",zoomAccountId:"zoom",now:"2026-09-18T12:00:00Z",snapshot:{at:"2026-09-18T11:59:00Z",fingerprint:"source",complete:true,trials:[],resources:{"person:person":structuredClone(calendar),"room:room":structuredClone(calendar),"zoom:zoom":structuredClone(calendar)}}};}
test("proposal includes exact sessions, identities and all invitation recipients",()=>{const plan=suggestNew(fixture());assert.equal(plan.events[0].start,"2026-09-21T14:00:00.000Z");assert.deepEqual(plan.events[0].notify,["candidate@example.com","interviewer@example.com","room@example.com"]);assert.equal(plan.endDate,"2026-09-21");});
test("missing availability never becomes a free calendar",()=>{for(const resource of ["person:person","room:room","zoom:zoom"]){const data=fixture();delete data.snapshot.resources[resource];assert.throws(()=>suggestNew(data),/available|availability/);}});
test("busy interviewers and stale or unverified sources block generation",()=>{let data=fixture();data.snapshot.resources["person:person"].busy=[{start:"2026-09-21T14:00:00Z",end:"2026-09-21T15:00:00Z"}];assert.throws(()=>suggestNew(data),/interviewer/);data=fixture();data.template.verified=false;assert.throws(()=>suggestNew(data),/Verify/);data=fixture();data.snapshot.at="2026-09-18T10:00:00Z";assert.throws(()=>suggestNew(data),/Fresh/);});
test("replacement changes only declined assignment and records cancellation recipients",()=>{
 const {suggestReplacement}=require("../lib/scheduling/planner"),data=fixture(),original=suggestNew(data);
 original.ashbyScheduleId="schedule";original.events[0].ashbyEventId="event";
 const untouched=structuredClone(original);data.snapshot.resources["person:replacement"]=structuredClone(data.snapshot.resources["person:person"]);
 const result=suggestReplacement({original,eventId:"event",decline:{eventId:"event",status:"declined",kind:"interviewer",userId:"person"},alternatives:[{userId:"replacement",email:"replacement@example.com",active:true,eligible:true}],snapshot:data.snapshot,now:data.now});
 assert.deepEqual(original,untouched);assert.equal(result.events[0].start,original.events[0].start);assert.deepEqual(result.events[0].room,original.events[0].room);
 assert.equal(result.events[0].interviewers[0].userId,"replacement");assert.deepEqual(result.events[0].cancelNotify,["interviewer@example.com"]);assert.deepEqual(result.events[0].before,original.events[0]);assert.equal(result.kind,"replacement");
 assert.throws(()=>suggestReplacement({original,eventId:"event",decline:{eventId:"event",status:"accepted"},snapshot:data.snapshot,now:data.now}),/no longer active/);
});
