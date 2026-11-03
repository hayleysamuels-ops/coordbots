'use strict';
// Two-person panels through each layer after the reader (panel.js): identity
// resolution, deactivated accounts, calendar inputs, the booking plan, the
// worker's checks, the post, Suggest and amend, and the larger-panel refusal.
const {test}=require('node:test'),assert=require('node:assert/strict');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const G={userId:id(31),name:'Gabrielle Struckell',email:'gabrielle@luminai.com'},R={userId:id(32),name:'Grace Buckingham',email:'grace@luminai.com'},A={userId:id(33),name:'Ali Feldman',email:'ali@luminai.com'};
const byName={[G.name]:G,[R.name]:R,[A.name]:A};
const welcomeRead=()=>({sessionId:'w',interviewId:id(40),title:'Welcome',durationMinutes:15,assignmentVerified:true,requiredCount:2,
  eligibleInterviewers:[{name:G.name},{name:R.name},{name:A.name}],slots:[{eligibleInterviewers:[{name:G.name}]},{eligibleInterviewers:[{name:R.name},{name:A.name}]}]});

test('identities resolve slot by slot through the same accounts; a deactivated person leaves their slot and the union',async()=>{
  const {createBookingFacts}=require('../src/scheduling/booking-facts');
  const people=[['Gabrielle','Struckell',true],['Grace','Buckingham',true],['Ali','Feldman',true],['Former','Host',false]];
  const reader=createBookingFacts({key:'key',clientId:'client',request:async(url,options)=>{const body=JSON.parse(options.body);
    return {ok:true,json:async()=>({success:true,results:people.filter(p=>body.includeDeactivated||p[2]).map(([firstName,lastName,isEnabled],i)=>({id:id(31+i),firstName,lastName,email:`${firstName.toLowerCase()}@luminai.com`,isEnabled})),moreDataAvailable:false})};}});
  const {sessions:[s]}=await reader.resolveInterviewers([welcomeRead()]);
  assert.deepEqual(s.slots.map(x=>x.eligibleInterviewers.map(p=>p.userId)),[[id(31)],[id(32),id(33)]]);
  assert.deepEqual(s.eligibleInterviewers.map(p=>p.userId),[id(31),id(32),id(33)]);
  assert.strictEqual(s.slots[1].eligibleInterviewers[0],s.eligibleInterviewers[1],'one account object per person');
  // Slot 2 lists a departed host; Ashby counts 2 eligible there.
  const w=welcomeRead();w.slots[1]={eligibleInterviewers:[{name:R.name},{name:'Former Host'},{name:A.name}],eligibleCount:2};w.eligibleInterviewers.push({name:'Former Host'});
  const [kept]=await reader.excludeDeactivated([w]);
  assert.deepEqual(kept.slots[1].eligibleInterviewers.map(p=>p.name),[R.name,A.name]);
  assert.equal(kept.slots[1].eligibleCount,undefined);
  assert.deepEqual(kept.eligibleInterviewers.map(p=>p.name),[G.name,R.name,A.name]);
  assert.deepEqual(kept.excludedInterviewers,[{name:'Former Host',reason:'deactivated in Ashby'}]);
  w.slots[1].eligibleCount=1;
  await assert.rejects(reader.excludeDeactivated([w]),/Session 1 \("Welcome"\), slot 2: Ashby shows 1 eligible but 2 of the listed interviewers are active/);
});

function inputs({exclude=[],require:need=[]}={}){
  const {buildCalendarInputs}=require('../src/scheduling/calendar-inputs');
  const {parseRules}=require('../src/scheduling/rules');
  const rules=parseRules(JSON.parse(JSON.stringify(require('../scheduling-rules/luminai.json'))),'luminai');
  const resolve=list=>list.map(p=>byName[p.name]);
  const facts={resolveInterviewers:async sessions=>({sessions:sessions.map(s=>({...s,eligibleInterviewers:resolve(s.eligibleInterviewers),...(s.slots?{slots:s.slots.map(x=>({eligibleInterviewers:resolve(x.eligibleInterviewers)}))}:{})})),interviewers:[G,R,A]}),
    interviewerLimits:async ids=>new Map(ids.map(i=>[i,{dailyLimit:null,weeklyLimit:5}]))};
  const freeBusy={read:async({calendarIds,timeMin,timeMax})=>calendarIds.map(c=>({calendarId:c,busy:[],coverage:[{start:timeMin,end:timeMax}],coverageVerified:true,checkedAt:Date.now()}))};
  return buildCalendarInputs({plan:{sessions:[welcomeRead()]},windows:[{start:'2099-01-05T09:00',end:'2099-01-05T17:00'}],timezone:'America/Los_Angeles',rules,facts,freeBusy,excludeInterviewers:exclude,requireInterviewers:need});
}

test('calendar inputs keep a panel\'s slots; a left-out person leaves every slot; a slot left empty blocks by number',async()=>{
  let r=await inputs();
  assert.deepEqual(r.sessions[0].slots.map(x=>x.eligibleInterviewers.map(p=>p.name)),[[G.name],[R.name,A.name]]);
  assert.deepEqual(r.calendars.map(c=>c.userId).sort(),[G.userId,R.userId,A.userId].sort());
  r=await inputs({exclude:[{session:0,userId:R.userId,name:R.name}]});
  assert.deepEqual(r.sessions[0].slots[1].eligibleInterviewers.map(p=>p.name),[A.name]);
  r=await inputs({exclude:[{session:0,userId:G.userId,name:G.name}]});
  assert.equal(r.blocked,'No eligible interviewer can take slot 1 of Welcome (a panel of 2): everyone left for it was asked to be left out, or is excluded (see below).');
  assert.equal(r.noOtherInterviewer,true);
  // Required people (an amend keeps the rest of the panel) are held by the solver.
  r=await inputs({require:[{session:0,userId:A.userId,name:A.name},{session:0,userId:G.userId,name:G.name}]});
  assert.deepEqual(r.sessions[0].requiredUserIds,[A.userId,G.userId]);
  assert.deepEqual(r.sessions[0].slots[1].eligibleInterviewers.map(p=>p.name),[R.name,A.name],'slots aren\'t narrowed; the solver holds the requirement');
});

test('the booking plan carries the panel in slot order, refusing a person twice; one-person sessions are unchanged',()=>{
  const {bookingPlanFromOption}=require('../src/scheduling/booking-plan');
  const application={jobId:id(1),candidateId:id(2),applicationId:id(3),interviewScheduleId:id(4),candidate:{name:'TEST',email:'t@example.com'},job:{title:'TEST'},stage:{title:'Onsite'},activityTitle:'Onsite Interview Schedule'};
  const ev=(people,extra={})=>({interviewId:id(40),title:'Welcome',start:'2099-01-05T17:00:00Z',end:'2099-01-05T17:15:00Z',...people,...extra});
  let plan=bookingPlanFromOption({option:{events:[ev({interviewers:[G,R]})]},application,accountTimeZone:'America/Los_Angeles'});
  assert.deepEqual(plan.sessions[0].interviewers.map(p=>p.userId),[G.userId,R.userId]);
  plan=bookingPlanFromOption({option:{events:[ev({interviewer:G})]},application,accountTimeZone:'America/Los_Angeles'});
  assert.deepEqual(plan.sessions[0].interviewers,[{userId:G.userId,name:G.name,email:G.email}]);
  assert.throws(()=>bookingPlanFromOption({option:{events:[ev({interviewers:[G,G]})]},application,accountTimeZone:'America/Los_Angeles'}),/names one person twice on its panel/);
  assert.throws(()=>bookingPlanFromOption({option:{events:[ev({interviewers:[G,{name:'X'}]})]},application,accountTimeZone:'America/Los_Angeles'}),/has no fully identified interviewers/);
});

test('the worker holds each panel slot to its own approved person, never the two swapped',()=>{
  const {checkFinal,checkSave}=require('../worker/booking-check');
  const plan={timeZone:'America/Los_Angeles',sessions:[{title:'Welcome',interviewId:id(40),start:'2099-01-05T17:00:00.000Z',end:'2099-01-05T17:15:00.000Z',interviewers:[G,R]}]};
  const event=(a,b)=>({id:'e1',title:'Welcome',interviewId:id(40),start:Date.parse(plan.sessions[0].start),end:Date.parse(plan.sessions[0].end),slots:[{selected:a,alternates:[],rest:{}},{selected:b,alternates:[],rest:{}}]});
  assert.doesNotThrow(()=>checkFinal([event(G.userId,R.userId)],plan));
  assert.throws(()=>checkFinal([event(R.userId,G.userId)],plan),/doesn't have exactly the approved interviewers, each in their approved slot/);
  const prev=[event(null,null)],next=[event(R.userId,null)];
  const r=(()=>{try{checkSave(prev,next,plan,{});return null;}catch(e){return e;}})();
  assert.ok(r,'a save putting slot 2\'s person in slot 1 is refused');
  assert.match(r.message,/slot 1: an interviewer who wasn't approved was selected \(not the one approved for this slot\)/);
});

test('the post lists both people; Suggest offers each one by name; booking review shows the slots',()=>{
  const {createSlack}=require('../src/scheduling/slack');
  const posts=[];
  const send=createSlack('xoxb-test',async(url,init)=>{posts.push(JSON.parse(init.body));return {ok:true,json:async()=>({ok:true,ts:'1.2',channel:'C1'})};},{displayTimeZone:'America/Los_Angeles',interactive:true,clientName:'Luminai'});
  const plan={format:'calendar_checked',candidateName:'TEST',candidateId:id(2),jobTitle:'TEST',timezone:'America/Los_Angeles',timezoneSource:'candidate_submitted',notes:'n',submittedAvailability:{},
    bookingPlan:{interviewScheduleId:id(4),sessions:[{interviewers:[G,R]}]},
    sessions:[{title:'Welcome',start:'2099-01-05T17:00:00.000Z',end:'2099-01-05T17:15:00.000Z',location:'Room / location to confirm',people:[{name:G.name},{name:R.name}]}]};
  return send(plan,{channelId:'C1',proposalId:'d1',approver:'X',digest:'d'.repeat(64)}).then(()=>{
    const text=posts[0].blocks.filter(b=>b.text).map(b=>b.text.text).join('\n');
    assert.match(text,/• 9:00 AM – 9:15 AM \(PST\) – Welcome {2}Gabrielle Struckell and Grace Buckingham/);
    const menu=posts[0].blocks.flatMap(b=>b.elements||[]).find(e=>e.action_id==='suggest_interviewer');
    assert.deepEqual(menu.options.map(o=>[o.text.text,JSON.parse(o.value).p]),[['1. 9:00 AM – 9:15 AM (PST) Welcome – instead of Gabrielle Struckell',0],['1. 9:00 AM – 9:15 AM (PST) Welcome – instead of Grace Buckingham',1]]);
  });
});

test('Suggest on a panel leaves out exactly the chosen person; a panel entry without one is refused',()=>{
  const {nextSuggestion}=require('../src/scheduling/suggestion');
  const row={id:'d1',plan:{sessions:[{start:'2099-01-05T17:00:00.000Z'}],bookingPlan:{sessions:[{start:'2099-01-05T17:00:00.000Z',interviewers:[G,R]}]}}};
  const s=nextSuggestion(row,{kind:'interviewer',session:0,person:1,by:'a@x.com'});
  assert.deepEqual(s.excludeInterviewers,[{session:0,userId:R.userId,name:R.name}]);
  assert.throws(()=>nextSuggestion(row,{kind:'interviewer',session:0,by:'a@x.com'}),/can't be identified/);
  // An amend's `out` may be either person on the panel.
  const a=nextSuggestion(row,{kind:'amend',session:0,by:'a@x.com',change:{label:'Welcome',out:{userId:R.userId,name:R.name},in:{userId:A.userId,name:A.name}}});
  assert.deepEqual(a.excludeInterviewers,[{session:0,userId:R.userId,name:R.name}]);
});

test('amend on a panel: says which person comes off, asks when it isn\'t said, and keeps the other',async()=>{
  const {resolveChange}=require('../src/scheduling/amend');
  const sessions=[{title:'Welcome',start:'2099-01-05T17:00:00.000Z',end:'2099-01-05T17:15:00.000Z',interviewers:[G,R]}];
  const eligible=[[G,R,A]],findPeople=async()=>[];
  let r=await resolveChange({kind:'replace_interviewer',session:null,replace:'Grace',with:'Ali'},{sessions,eligible,findPeople,timeZone:'America/Los_Angeles'});
  assert.deepEqual([r.change.out.userId,r.change.in.userId],[R.userId,A.userId]);
  assert.match(r.restatement,/^Replace Grace Buckingham with Ali Feldman on Welcome \(.*\), keeping Gabrielle Struckell on it\?$/);
  r=await resolveChange({kind:'replace_interviewer',session:1,replace:null,with:'Ali'},{sessions,eligible,findPeople,timeZone:'America/Los_Angeles'});
  assert.equal(r.ask,'Welcome has Gabrielle Struckell and Grace Buckingham. Which of them should Ali replace?');
  r=await resolveChange({kind:'replace_interviewer',session:null,replace:'Grace',with:'Gabrielle'},{sessions,eligible,findPeople,timeZone:'America/Los_Angeles'});
  assert.equal(r.decline,'Gabrielle Struckell is already on Welcome. Nothing was changed.');
});

test('a panel larger than two refuses the plan read by name, as needing a person',async t=>{
  const express=require('express');
  const {bookingRoutes}=require('../src/scheduling/booking-routes');
  const {needsPerson}=require('../src/scheduling/auto-post');
  const s=(k,title,d)=>({sessionId:'s'+k,interviewId:id(50+k),title,durationMinutes:d});
  const onsite=[s(0,'Welcome',15),s(1,'Case Study Presentation',60)];
  const plan={applicationId:'app',candidateId:'candidate',stageId:'stage',templateRevision:'v1',jobId:id(9),activities:[{id:'a0',title:'Onsite Interview Schedule',sessions:onsite}]};
  const four={requiredCount:4,eligibleInterviewers:[{name:'P1'},{name:'P2'},{name:'P3'},{name:'P4'}],slots:[1,2,3,4].map(n=>({eligibleInterviewers:[{name:'P'+n}]})),assignmentVerified:true};
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.schedulingUser={id:'c',canApprove:true};next();});
  app.use('/booking',bookingRoutes({rules:{get:()=>({alternativesFor:()=>[]})},facts:{application:async()=>plan},availability:{requests:async()=>({stageId:'stage',requests:[{scheduleId:'request',updatedAt:'v'}]})},
    inspectPlan:async input=>({...input,activityId:'a0',alternativesLeftOut:[],sessions:[{...onsite[0],requiredCount:1,eligibleInterviewers:[{name:'G'}],assignmentVerified:true},{...onsite[1],...four}]})}));
  const server=await new Promise(resolve=>{const x=app.listen(0,'127.0.0.1',()=>resolve(x));});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const r=await fetch(`http://127.0.0.1:${server.address().port}/booking/full-plan`,{method:'POST',headers:{'Content-Type':'application/json','X-Scheduling-Request':'1'},body:JSON.stringify({applicationId:'app',scheduleId:'request'})});
  const body=await r.json();
  assert.equal(r.status,409);
  assert.equal(body.error,'"Case Study Presentation" is a panel: it has 4 interviewer slots, so it expects 4 people. Two-person panels are supported; larger ones aren\'t yet, so this can\'t be proposed or booked here. Schedule it by hand in Ashby.');
  assert.equal(needsPerson({message:body.error}),true);
});

test('SCHEDULING_PANELS: off refuses a two-person panel as needing a person; test allows it on TEST only; on allows it everywhere',async t=>{
  const express=require('express');
  const {bookingRoutes}=require('../src/scheduling/booking-routes');
  const {needsPerson,TEST_APPLICATION}=require('../src/scheduling/auto-post');
  const onsite=[{sessionId:'s0',interviewId:id(60),title:'Welcome',durationMinutes:15}];
  const two={requiredCount:2,eligibleInterviewers:[{name:G.name},{name:R.name}],slots:[{eligibleInterviewers:[{name:G.name}]},{eligibleInterviewers:[{name:R.name}]}],assignmentVerified:true};
  const load=async(panels,applicationId)=>{
    const plan={applicationId,candidateId:'candidate',stageId:'stage',templateRevision:'v1',jobId:id(9),activities:[{id:'a0',title:'Onsite Interview Schedule',sessions:onsite}]};
    const app=express();app.use(express.json());app.use((req,res,next)=>{req.schedulingUser={id:'c',canApprove:true};next();});
    app.use('/booking',bookingRoutes({panels,rules:{get:()=>({alternativesFor:()=>[]})},facts:{application:async()=>plan},availability:{requests:async()=>({stageId:'stage',requests:[{scheduleId:'request',updatedAt:'v'}]})},
      inspectPlan:async input=>({...input,activityId:'a0',alternativesLeftOut:[],sessions:[{...onsite[0],...two}]})}));
    const server=await new Promise(resolve=>{const x=app.listen(0,'127.0.0.1',()=>resolve(x));});t.after(()=>new Promise(resolve=>server.close(resolve)));
    const r=await fetch(`http://127.0.0.1:${server.address().port}/booking/full-plan`,{method:'POST',headers:{'Content-Type':'application/json','X-Scheduling-Request':'1'},body:JSON.stringify({applicationId,scheduleId:'request'})});
    return {status:r.status,body:await r.json()};
  };
  let r=await load(undefined,'app');
  assert.equal(r.status,409);
  assert.equal(r.body.error,'"Welcome" is a panel: it has 2 interviewer slots, so it expects 2 people. Two-person panels are built but not switched on yet, so this can\'t be proposed or booked here; schedule it by hand in Ashby.');
  assert.equal(needsPerson({message:r.body.error}),true);
  r=await load('test','app');assert.equal(r.status,409);assert.match(r.body.error,/not switched on beyond TEST yet/);
  r=await load('test',TEST_APPLICATION);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.sessions[0].slots.length,2);
  r=await load('on','app');assert.equal(r.status,200);
});
