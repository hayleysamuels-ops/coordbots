'use strict';
// Luminai Scheduling SOP rules (October 3, 2026): no onsite on Wednesdays,
// Gabrielle Struckell hosts Welcome when free, debriefs deferred until the
// onsite is confirmed, Sanjay Saraf's hours, and the LinkedIn header source.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {proposeCalendarSchedule}=require('../src/scheduling/full-calendar-schedule');
const {proposeFullSchedule}=require('../src/scheduling/full-schedule');
const {loadRules}=require('../src/scheduling/rules');
const {createBookingFacts}=require('../src/scheduling/booking-facts');

const now=Date.parse('2026-09-21T00:00Z');
const G={userId:'g',name:'Gabrielle Struckell'},K={userId:'k',name:'Keshav Malhotra'};
// 2026-09-30 is a Wednesday, 2026-10-01 a Thursday. Pacific wall time, PDT.
const at=(day,h,m=0)=>new Date(Date.parse(`${day}T00:00Z`)+((h+7)*60+m)*60000).toISOString();
const session=(id,minutes,eligible,title='Session '+id,extra={})=>({sessionId:id,interviewId:'i'+id,title,durationMinutes:minutes,assignmentVerified:true,requiredCount:1,eligibleInterviewers:eligible,...extra});
function calendar(person,{busy=[],sessions}){
  const rows=[{start:at('2026-09-30',0),end:at('2026-10-02',0)}];
  return {userId:person.userId,verified:true,coverageVerified:true,workingHoursSource:'assumed',hoursSource:'override',hoursLabel:'set for this person',checkedAt:now,
    coverage:[{start:at('2026-09-30',0),end:at('2026-10-02',0)}],busy,sessionWorkingWindows:Object.fromEntries(sessions.map(s=>[s.sessionId,rows])),limits:{dailyLimit:null,weeklyLimit:null}};
}
const WED={days:['wed'],timezone:'America/Los_Angeles',reason:'Luminai works from home on Wednesdays.'};
const both=[{start:'2026-09-30T09:00',end:'2026-09-30T17:00'},{start:'2026-10-01T09:00',end:'2026-10-01T17:00'}];

test('no agenda is proposed on an excluded weekday, in either preview',()=>{
  const s=[session('1',60,[G],'Welcome')];
  const r=proposeCalendarSchedule({sessions:s,windows:both,timezone:'America/Los_Angeles',now,calendars:[calendar(G,{sessions:s})],advisory:true,excludedWeekdays:WED});
  assert.ok(r.proposals.length>0);
  assert.ok(r.proposals.every(p=>p.start.startsWith('2026-10-01')),'an agenda landed on Wednesday');
  const u=proposeFullSchedule({sessions:s.map(x=>({...x,eligibleInterviewers:[{name:G.name}]})),windows:both,timezone:'America/Los_Angeles',now,excludedWeekdays:WED});
  assert.ok(u.proposals.length>0&&u.proposals.every(p=>p.start.startsWith('2026-10-01')));
});

test('availability only on an excluded weekday says so, instead of "too short"',()=>{
  const s=[session('1',60,[G],'Welcome')];
  const wedOnly=[both[0]];
  const r=proposeCalendarSchedule({sessions:s,windows:wedOnly,timezone:'America/Los_Angeles',now,calendars:[calendar(G,{sessions:s})],advisory:true,excludedWeekdays:WED});
  assert.equal(r.status,'no_calendar_fit');
  assert.deepEqual(r.diagnosis.unblock,[{kind:'weekday',days:['wed'],text:"The candidate's availability only holds the whole agenda on Wednesday, when no onsite is held (Luminai works from home on Wednesdays). Ask the candidate for another day."}]);
  const u=proposeFullSchedule({sessions:s.map(x=>({...x,eligibleInterviewers:[{name:G.name}]})),windows:wedOnly,timezone:'America/Los_Angeles',now,excludedWeekdays:WED});
  assert.equal(u.proposals.length,0);
  assert.match(u.reason,/^No agenda is proposed on Wednesday \(Luminai works from home on Wednesdays\), and the candidate's other availability doesn't hold it\./);
});

test('Welcome goes to the preferred host while free, and to a colleague only when the host is not',()=>{
  const day=['2026-10-01'];
  const s=[session('1',15,[K,G],'Welcome',{preferredUserIds:['g']})];
  const run=(busy,advisory=true)=>proposeCalendarSchedule({sessions:s,windows:[both[1]],timezone:'America/Los_Angeles',now,calendars:[calendar(G,{busy,sessions:s}),calendar(K,{sessions:s})],advisory,limit:1});
  // Free: Gabrielle, though Keshav is listed first in Ashby.
  assert.equal(run([]).proposals[0].events[0].interviewer.name,'Gabrielle Struckell');
  // Busy at 9:00: Keshav takes it at 9:00 rather than the agenda moving.
  const busy=[{start:at(day[0],9),end:at(day[0],10)}];
  const r=run(busy);
  assert.deepEqual([r.proposals[0].start,r.proposals[0].events[0].interviewer.name,r.proposals[0].flagCount],[at(day[0],9),'Keshav Malhotra',0]);
  // Strict mode: preferred first too.
  assert.equal(run([],false).proposals[0].events[0].interviewer.name,'Gabrielle Struckell');
});

test('the preferred host is used, flagged, only when nobody else is free',()=>{
  const day='2026-10-01';
  const s=[session('1',15,[K,G],'Welcome',{preferredUserIds:['g']})];
  const allBusy=[{start:at(day,0),end:at(day,23)}];
  const r=proposeCalendarSchedule({sessions:s,windows:[both[1]],timezone:'America/Los_Angeles',now,calendars:[calendar(G,{busy:allBusy,sessions:s}),calendar(K,{busy:allBusy,sessions:s})],advisory:true,limit:1});
  assert.equal(r.proposals[0].events[0].interviewer.name,'Gabrielle Struckell');
  assert.equal(r.proposals[0].flagCount,1);
});

test('Luminai\'s rules: WFH Wednesdays, Gabrielle for Welcome, deferred debriefs, Sanjay 07:00–17:00 Pacific',()=>{
  const r=loadRules({clientId:'luminai',log:{log(){},warn(){}}}).get();
  assert.equal(r.rulesRevision,6);
  assert.deepEqual([r.agenda.excludedWeekdays.days,r.agenda.excludedWeekdays.timezone],[['wed'],'America/Los_Angeles']);
  assert.deepEqual([r.preferredFor('Welcome'),r.preferredFor('  welcome '),r.preferredFor('Welcome Lunch')],[['gabrielle@luminai.com'],['gabrielle@luminai.com'],[]]);
  assert.deepEqual(r.debriefs,{afterOnsiteConfirmed:true,meetingHoursExempt:true});
  assert.deepEqual(r.meetingHoursFor('sanjay@luminai.com'),{hours:{timezone:'America/Los_Angeles',days:['mon','tue','wed','thu','fri'],start:'07:00',end:'17:00'},source:'override'});
});

test('debrief ids and the candidate\'s LinkedIn come from Ashby, and are never guessed',async()=>{
  const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  let social=[{type:'LinkedIn',url:'https://www.linkedin.com/in/example'}];
  const reader=createBookingFacts({key:'k',clientId:'c',request:async(url,options)=>{const endpoint=url.split('/').pop(),body=JSON.parse(options.body);
    const results=endpoint==='interview.list'?[{id:id(1),isDebrief:true},{id:id(2),isDebrief:false}]:endpoint==='candidate.info'?{id:body.id,socialLinks:social}:null;
    return {ok:true,json:async()=>({success:true,results,moreDataAvailable:false})};}});
  assert.deepEqual([...await reader.debriefInterviewIds()],[id(1)]);
  assert.equal(await reader.candidateLinkedIn(id(3)),'https://www.linkedin.com/in/example');
  social=[{type:'LinkedIn',url:'https://evil.example/linkedin.com'}];
  assert.equal(await reader.candidateLinkedIn(id(3)),null);
  social=[];
  assert.equal(await reader.candidateLinkedIn(id(3)),null);
});
