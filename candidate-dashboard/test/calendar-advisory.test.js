'use strict';
// The calendar-checked preview's advisory mode: busy time and meeting hours are
// flagged, not enforced. Template order and the earliest fit stay; the
// candidate's availability, start windows and the break budget stay hard.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {proposeCalendarSchedule}=require('../src/scheduling/full-calendar-schedule');
const {describeFlag}=require('../src/scheduling/flags');

const now=Date.parse('2026-09-21T00:00Z');
const A={userId:'a',name:'Gabrielle Struckell'},B={userId:'b',name:'Ben Ode'};
const day='2026-09-28',at=(h,m=0)=>new Date(Date.parse(`${day}T00:00Z`)+((h+4)*60+m)*60000).toISOString(); // New York wall time, EDT
const session=(id,minutes,eligible,title='Session '+id)=>({sessionId:id,interviewId:'i'+id,title,durationMinutes:minutes,assignmentVerified:true,requiredCount:1,eligibleInterviewers:eligible});
function calendar(person,{busy=[],hours=[[9,17]],source='override',verified=false,sessions}){
  const rows=hours.map(([s,e])=>({start:at(s),end:at(e)}));
  return {userId:person.userId,verified:true,coverageVerified:true,...(verified?{workingHoursVerified:true}:{workingHoursSource:'assumed',hoursSource:source,hoursLabel:`${source==='default'?'09:00–17:00 America/New_York, client default':'set for this person'}`}),checkedAt:now,
    coverage:[{start:at(0),end:at(20)}],busy:busy.map(([s,e])=>({start:at(...s),end:at(...e)})),
    sessionWorkingWindows:Object.fromEntries(sessions.map(s=>[s.sessionId,rows])),limits:{dailyLimit:null,weeklyLimit:null}};
}
const solve=(sessions,calendars,extra={})=>proposeCalendarSchedule({sessions,windows:[{start:`${day}T09:00`,end:`${day}T17:00`}],timezone:'America/New_York',now,calendars,advisory:true,...extra});

test('a busy interviewer is flagged, not routed around: template order at the earliest fit',()=>{
  const s=[session('1',15,[A],'Welcome'),session('2',60,[A])];
  const r=solve(s,[calendar(A,{busy:[[[9,0],[9,30]]],sessions:s})]);
  assert.equal(r.status,'needs_attention');
  // The earliest fit is still offered at 09:00, not nudged to 09:30 to dodge
  // the meeting; it's flagged. A clash-free option ranks above it.
  const first=r.proposals.find(p=>p.start===at(9));
  assert.ok(first,'the earliest-fit agenda is missing');
  assert.deepEqual(first.events.map(e=>[e.title,e.start]),[['Welcome',at(9)],['Session 2',at(9,15)]]);
  assert.equal(r.proposals[0].flagCount,0);
  assert.deepEqual(first.events[0].flags,[{kind:'busy',name:'Gabrielle Struckell',userId:'a',start:at(9),end:at(9,15),minutes:15}]);
  assert.deepEqual(first.events[1].flags,[{kind:'busy',name:'Gabrielle Struckell',userId:'a',start:at(9,15),end:at(9,30),minutes:15}]);
  assert.equal(first.flagCount,2);
  assert.equal(r.availabilityVerified,false);
  assert.match(r.reason,/flagged below\. Each clash needs the interviewer to move it, or to accept a booking over it/);
  assert.equal(describeFlag(first.events[0].flags[0],'America/New_York'),'Gabrielle Struckell is busy 9:00 AM–9:15 AM (EDT) on their primary calendar. The meeting needs moving, or booking over.');
});

test('at a session\'s fixed time a free interviewer is preferred; times never move',()=>{
  const s=[session('1',60,[A,B])];
  const r=solve(s,[calendar(A,{busy:[[[9],[10]]],sessions:s}),calendar(B,{sessions:s})]);
  assert.equal(r.status,'calendar_checked');
  assert.deepEqual([r.proposals[0].events[0].start,r.proposals[0].events[0].interviewer.name,r.proposals[0].flagCount],[at(9),'Ben Ode',0]);
});

test('time outside meeting hours is flagged with how much, and whether the hours are assumed or verified',()=>{
  const s=[session('1',60,[A])];
  // Hours 09:30-17:00; the earliest fit is 09:00, so 30 minutes fall outside.
  let r=solve(s,[calendar(A,{source:'default',sessions:s})].map(c=>{c.sessionWorkingWindows['1']=[{start:at(9,30),end:at(17)}];return c;}));
  const [flag]=r.proposals.find(p=>p.start===at(9)).events[0].flags;
  assert.deepEqual([flag.kind,flag.start,flag.end,flag.minutes,flag.hoursSource],['hours',at(9),at(9,30),30,'default']);
  assert.equal(describeFlag(flag,'America/New_York'),"30 minutes of this session (9:00 AM–9:30 AM (EDT)) is outside Gabrielle Struckell's assumed meeting hours (09:00–17:00 America/New_York, client default).");
  const cal=calendar(A,{verified:true,sessions:s});cal.sessionWorkingWindows['1']=[{start:at(9,30),end:at(17)}];
  r=solve(s,[cal]);
  assert.match(describeFlag(r.proposals.find(p=>p.start===at(9)).events[0].flags[0],'America/New_York'),/outside Gabrielle Struckell's verified meeting hours\.$/);
});

test('the lunch start window stays hard while busy time is only flagged',()=>{
  const LUNCH={match:'contains',value:'Lunch',timezone:'America/Los_Angeles',earliestStart:'12:00',latestStart:'13:30'};
  const pacific=(hh,mm=0)=>new Date(Date.parse(`${day}T00:00Z`)+((hh+7)*60+mm)*60000).toISOString();
  // A New York candidate, 09:00-15:30 ET, with lunch third. Back to back from
  // 09:00 ET would put lunch at 08:00 PT, so the earliest fit starts the agenda
  // at 13:00 ET and lunch lands at 12:00 PT. The interviewer is busy all day:
  // that's flagged on every session, never a reason to refuse.
  const s=[session('1',60,[A],'Welcome'),session('2',60,[A]),{...session('3',30,[A],'Lunch'),placementWindows:[LUNCH]}];
  const r=proposeCalendarSchedule({sessions:s,windows:[{start:`${day}T09:00`,end:`${day}T15:30`}],timezone:'America/New_York',now,calendars:[calendar(A,{busy:[[[9],[17]]],sessions:s})],advisory:true});
  assert.equal(r.status,'needs_attention');
  assert.equal(r.proposals[0].events[0].start,at(13));
  assert.equal(r.proposals[0].events[2].start,pacific(12));
  assert.ok(r.proposals[0].events.every(e=>e.flags.length===1&&e.flags[0].kind==='busy'));
});

test('a lunch window met only with a break: the gap suggestion names the cheapest allowance',()=>{
  // Welcome must start at 10:00 and Lunch at 13:00. Back to back, lunch would
  // start 12:35, so it needs a 25-minute break, which a budget of 0 forbids.
  const at10={match:'contains',value:'Welcome',timezone:'America/New_York',earliestStart:'10:00',latestStart:'10:00'};
  const at13={match:'contains',value:'Lunch',timezone:'America/New_York',earliestStart:'13:00',latestStart:'13:00'};
  const s=[{...session('1',60,[A],'Welcome'),placementWindows:[at10]},session('2',95,[A]),{...session('3',30,[A],'Lunch'),placementWindows:[at13]}];
  const run=count=>proposeCalendarSchedule({sessions:s,windows:[{start:`${day}T09:00`,end:`${day}T15:00`}],timezone:'America/New_York',now,calendars:[calendar(A,{busy:[[[9],[15]]],sessions:s})],advisory:true,minBreakMinutes:15,maxGapMinutes:30,maxGapCount:count});
  const r=run(0);
  assert.equal(r.status,'no_calendar_fit');
  assert.equal(r.proposals.length,0,'never proposes lunch out of its window');
  const placement=r.diagnosis.unblock.flatMap(u=>u.changes||[]).find(c=>c.kind==='placement');
  assert.ok(placement,JSON.stringify(r.diagnosis.unblock));
  // "Allowing one break of up to 30 minutes would fit": busy time didn't count against it.
  assert.deepEqual(placement.fitsWithBreaks,{count:1,maxMinutes:30});
  // And with that allowance, it does fit, lunch at 13:00, busy time flagged.
  const fits=run(1);
  assert.equal(fits.status,'needs_attention');
  assert.equal(fits.proposals[0].events[2].start,at(13));
});

test('the default (non-advisory) solver still refuses busy time',()=>{
  const s=[session('1',60,[A])];
  const cal=calendar(A,{busy:[[[9],[17]]],sessions:s});
  assert.equal(proposeCalendarSchedule({sessions:s,windows:[{start:`${day}T09:00`,end:`${day}T17:00`}],timezone:'America/New_York',now,calendars:[cal]}).status,'no_calendar_fit');
});

test('options are ordered fewest clashes first, then earliest start',()=>{
  const s=[session('1',60,[A],'Welcome')];
  // Busy 09:00-10:30 and 13:00-13:30: options at 09:00 and 10:00 clash, 11:00 doesn't.
  const r=solve(s,[calendar(A,{busy:[[[9],[10,30]],[[13],[13,30]]],sessions:s})]);
  // Found earliest first an hour apart (09, 10, 11, 12, 13), then ranked.
  assert.deepEqual(r.proposals.map(p=>[p.flagCount,p.start]),[[0,at(11)],[0,at(12)],[1,at(9)],[1,at(10)],[1,at(13)]]);
});
