'use strict';
// Breaks between sessions, and the no-fit report: furthest reach, what would
// unblock it (ranked, placeholder hours called out as a data gap), and busy
// time counted apart from hours and limits.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {proposeCalendarSchedule}=require('../src/scheduling/full-calendar-schedule');

const now=Date.parse('2026-09-21T00:00Z');
const A={userId:'a',name:'Ana'},B={userId:'b',name:'Ben'},C={userId:'c',name:'Cy'};
const day='2026-09-28',at=(h,m=0)=>new Date(Date.parse(`${day}T00:00Z`)+((h+4)*60+m)*60000).toISOString(); // New York wall time, EDT
const session=(id,minutes,eligible)=>({sessionId:id,interviewId:'i'+id,title:'Session '+id,durationMinutes:minutes,assignmentVerified:true,requiredCount:1,eligibleInterviewers:eligible});
function calendar(person,{busy=[],hours=[[9,17]],source='override',sessions}){
  const rows=hours.map(([s,e])=>({start:at(s),end:at(e)}));
  return {userId:person.userId,verified:true,coverageVerified:true,workingHoursSource:'assumed',hoursSource:source,hoursLabel:`${source} hours`,checkedAt:now,
    coverage:[{start:at(0),end:at(20)}],busy:busy.map(([s,e])=>({start:at(...s),end:at(...e)})),
    sessionWorkingWindows:Object.fromEntries(sessions.map(s=>[s.sessionId,rows])),limits:{dailyLimit:null,weeklyLimit:null}};
}
const solve=(sessions,calendars,extra={})=>proposeCalendarSchedule({sessions,windows:[{start:`${day}T09:00`,end:`${day}T17:00`}],timezone:'America/New_York',now,calendars,...extra});

// ---- breaks ------------------------------------------------------------------

test('a minimum break puts that gap between every pair of sessions',()=>{
  const s=[session('1',30,[A]),session('2',30,[A])];
  const [first]=solve(s,[calendar(A,{sessions:s})],{minBreakMinutes:15,maxGapMinutes:15}).proposals;
  assert.equal(Date.parse(first.events[1].start)-Date.parse(first.events[0].end),15*60000);
});

test('a maximum gap lets a session wait out a busy block that back-to-back cannot',()=>{
  const s=[session('1',60,[A]),session('2',60,[B])];
  // Ana only 09:00-10:00; Ben busy 10:00-10:30.
  const cals=[calendar(A,{hours:[[9,10]],sessions:s}),calendar(B,{busy:[[[10],[10,30]]],sessions:s})];
  assert.equal(solve(s,cals).status,'no_calendar_fit');
  const r=solve(s,cals,{minBreakMinutes:0,maxGapMinutes:30});
  assert.equal(r.status,'calendar_checked');
  assert.equal(r.proposals[0].events[1].start,at(10,30));
});

test('breaks never push a session past the candidate window or onto another day',()=>{
  const s=[session('1',240,[A]),session('2',240,[A])];
  assert.equal(solve(s,[calendar(A,{sessions:s})],{minBreakMinutes:5,maxGapMinutes:60}).status,'no_calendar_fit');
});

test('an invalid break rule is refused',()=>{
  const s=[session('1',30,[A])];
  for(const extra of [{minBreakMinutes:30,maxGapMinutes:10},{minBreakMinutes:7,maxGapMinutes:7},{minBreakMinutes:-5,maxGapMinutes:0}])assert.throws(()=>solve(s,[calendar(A,{sessions:s})],extra),{status:422});
});

// ---- the no-fit report -------------------------------------------------------

test('it leads with the furthest reach and where every path stopped',()=>{
  const s=[session('1',60,[A]),session('2',60,[A]),session('3',60,[B])];
  // Ben is busy all day, so session 3 is where it dies.
  const r=solve(s,[calendar(A,{sessions:s}),calendar(B,{busy:[[[9],[17]]],sessions:s})]);
  assert.equal(r.status,'no_calendar_fit');
  assert.deepEqual(r.diagnosis.furthest,{placed:2,of:3,placedTitles:['Session 1','Session 2'],blockedAt:{sessionId:'3',title:'Session 3'}});
  assert.deepEqual(r.diagnosis.atBlocked.map(x=>[x.name,x.reason]),[['Ben','busy']]);
});

test('placeholder hours are reported as a data gap, not a conflict',()=>{
  const s=[session('1',60,[A]),session('2',60,[B])];
  // Ben's hours are the client default and only cover 06:00-09:00 local.
  const r=solve(s,[calendar(A,{sessions:s}),calendar(B,{hours:[[6,9]],source:'default',sessions:s})]);
  const [first]=r.diagnosis.unblock;
  assert.equal(first.kind,'hours');
  assert.deepEqual(first.changes.map(c=>[c.name,c.hoursSource,c.dataGap]),[['Ben','default',true]]);
  assert.equal(r.diagnosis.conflicts.busy,0);
  assert.ok(r.diagnosis.conflicts.hours.default>0);
});

test('hours set for a person are assumed but not a placeholder data gap',()=>{
  const s=[session('1',60,[A])];
  const r=solve(s,[calendar(A,{hours:[[19,20]],source:'override',sessions:s})]);
  const [first]=r.diagnosis.unblock;
  assert.deepEqual(first.changes.map(c=>[c.kind,c.hoursSource,c.dataGap]),[['hours','override',false]]);
});

test('busy time is counted separately and named when it is what binds',()=>{
  const s=[session('1',60,[A])];
  const r=solve(s,[calendar(A,{busy:[[[9],[17]]],sessions:s})]);
  assert.deepEqual(r.diagnosis.unblock.map(u=>u.kind),['busy']);
  assert.ok(r.diagnosis.conflicts.busy>0);
  assert.equal(r.diagnosis.conflicts.hours.default+r.diagnosis.conflicts.hours.override,0);
});

test('only relaxations that actually produce a fit are offered, at most two',()=>{
  const s=[session('1',60,[A,B,C])];
  // All three are busy all day; freeing any one of them fits, so only two are named.
  const cals=[A,B,C].map(p=>calendar(p,{busy:[[[9],[17]]],sessions:s}));
  const r=solve(s,cals);
  assert.equal(r.diagnosis.unblock.length,2);
  assert.ok(r.diagnosis.unblock.every(u=>u.kind==='busy'));
});

test('when one change is not enough it looks for a pair',()=>{
  const s=[session('1',60,[A]),session('2',60,[B])];
  // Both blocked: Ana busy all day, Ben's placeholder hours miss the window.
  const r=solve(s,[calendar(A,{busy:[[[9],[17]]],sessions:s}),calendar(B,{hours:[[6,9]],source:'default',sessions:s})]);
  assert.equal(r.diagnosis.unblock[0].kind,'combination');
  assert.deepEqual(r.diagnosis.unblock[0].changes.map(c=>c.kind).sort(),['busy','hours']);
});

test('an agenda longer than the candidate can offer blames availability, not interviewers',()=>{
  const s=[session('1',300,[A]),session('2',300,[A])];
  const r=solve(s,[calendar(A,{sessions:s})]);
  assert.deepEqual(r.diagnosis.unblock.map(u=>u.kind),['availability']);
});
