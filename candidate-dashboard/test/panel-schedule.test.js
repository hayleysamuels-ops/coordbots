'use strict';
// Two-person panels in the calendar search (panel.js): one distinct person per
// slot, every one free at the session's time, flags per person, a Slack
// requirement held, and the same session refused when a slot can't be filled.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {proposeCalendarSchedule}=require('../src/scheduling/full-calendar-schedule');
const {validAssignment,peopleOf,tooLarge}=require('../src/scheduling/panel');
const now=Date.parse('2026-09-21T00:00Z'),interval={start:'2026-09-28T13:00:00Z',end:'2026-09-28T21:00:00Z'};
const g={userId:'g',name:'Gabrielle Struckell'},r={userId:'r',name:'Grace Buckingham'},al={userId:'al',name:'Ali Feldman'},x={userId:'x',name:'Coder'};
// Welcome (15 min): slot 1 Gabrielle, slot 2 Grace or Ali. Then a one-person 60.
function input(){
  const welcome={sessionId:'w',title:'Welcome',interviewId:'1',durationMinutes:15,assignmentVerified:true,requiredCount:2,eligibleInterviewers:[g,r,al],slots:[{eligibleInterviewers:[g]},{eligibleInterviewers:[r,al]}]};
  const coding={sessionId:'c',title:'Coding',interviewId:'2',durationMinutes:60,assignmentVerified:true,requiredCount:1,eligibleInterviewers:[x]};
  return {sessions:[welcome,coding],windows:[{start:'2026-09-28T09:00',end:'2026-09-28T17:00'}],timezone:'America/New_York',now,
    calendars:[g,r,al,x].map(p=>({userId:p.userId,verified:true,coverageVerified:true,workingHoursVerified:true,checkedAt:now,coverage:[interval],busy:[],sessionWorkingWindows:{w:[interval],c:[interval]},limits:{dailyLimit:null,weeklyLimit:null}}))};
}
const cal=(i,id)=>i.calendars.find(c=>c.userId===id);

test('a two-person panel gets one free person per slot, in slot order; a one-person session is unchanged',()=>{
  const res=proposeCalendarSchedule(input());
  const [w,c]=res.proposals[0].events;
  assert.deepEqual(w.interviewers.map(p=>p.name),['Gabrielle Struckell','Grace Buckingham']);
  assert.equal(w.interviewer,undefined,'a panel event has no single interviewer');
  assert.deepEqual(w.slots.map(s=>s.eligibleInterviewers.map(p=>p.userId)),[['g'],['r','al']]);
  assert.equal(c.interviewer.userId,'x');assert.equal(c.interviewers,undefined);
  assert.deepEqual(peopleOf(w).map(p=>p.userId),['g','r']);
});

test('a busy second-slot person yields to the other; nobody free for a slot moves the agenda; the fixed host is never swapped out',()=>{
  let i=input();cal(i,'r').busy=[{start:'2026-09-28T13:00Z',end:'2026-09-28T14:00Z'}];
  let res=proposeCalendarSchedule(i);
  assert.equal(res.proposals[0].start,'2026-09-28T13:00:00.000Z');
  assert.deepEqual(res.proposals[0].events[0].interviewers.map(p=>p.userId),['g','al']);
  // Both slot-2 people busy at 9am: the agenda starts when one is free.
  i=input();cal(i,'r').busy=[{start:'2026-09-28T13:00Z',end:'2026-09-28T14:00Z'}];cal(i,'al').busy=[{start:'2026-09-28T13:00Z',end:'2026-09-28T13:30Z'}];
  res=proposeCalendarSchedule(i);
  assert.equal(res.proposals[0].start,'2026-09-28T13:30:00.000Z');
  assert.deepEqual(res.proposals[0].events[0].interviewers.map(p=>p.userId),['g','al']);
  // The only slot-1 host busy all day: no fit, never Grace in Gabrielle's slot.
  i=input();cal(i,'g').busy=[interval];
  res=proposeCalendarSchedule(i);
  assert.equal(res.status,'no_calendar_fit');assert.deepEqual(res.proposals,[]);
  assert.equal(res.diagnosis.furthest.blockedAt.title,'Welcome');
});

test('one person in both slots is never used twice on the same panel',()=>{
  const i=input();i.sessions[0].slots=[{eligibleInterviewers:[g,r]},{eligibleInterviewers:[g,r]}];i.sessions[0].eligibleInterviewers=[g,r];
  const w=proposeCalendarSchedule(i).proposals[0].events[0];
  assert.equal(new Set(w.interviewers.map(p=>p.userId)).size,2);
  // With only Gabrielle free, the panel can't be filled at that time.
  cal(i,'r').busy=[interval];
  assert.equal(proposeCalendarSchedule(i).status,'no_calendar_fit');
});

test('advisory: a panel is placed at the agenda\'s time and each person\'s clash is flagged under them',()=>{
  const i=input();cal(i,'r').busy=[interval];cal(i,'al').busy=[interval];
  const res=proposeCalendarSchedule({...i,advisory:true});
  const w=res.proposals[0].events[0];
  assert.equal(res.status,'needs_attention');
  assert.equal(w.start,'2026-09-28T13:00:00.000Z');
  assert.equal(w.interviewers.length,2);
  assert.deepEqual(w.flags.map(f=>[f.kind,f.userId]),[['busy',w.interviewers[1].userId]]);
  assert.equal(w.flags[0].name,w.interviewers[1].name);
});

test('a required person (Slack amend) takes their slot on the panel, with the other slot filled as usual',()=>{
  const i=input();i.sessions[0].requiredUserIds=['al'];
  const w=proposeCalendarSchedule(i).proposals[0].events[0];
  assert.deepEqual(w.interviewers.map(p=>p.userId),['g','al']);
  // Busy all day: no fit, never someone else in their place.
  cal(i,'al').busy=[interval];
  assert.equal(proposeCalendarSchedule(i).status,'no_calendar_fit');
});

test('options differ by who is on the panel, either slot',()=>{
  const {distinctFrom}=require('../src/scheduling/option-variety');
  const at=(...ids)=>({start:'2026-09-28T13:00:00.000Z',events:[{interviewers:ids.map(id=>({userId:id}))},{interviewer:{userId:'x'}}]});
  assert.equal(distinctFrom([at('g','r')],at('g','al'),'America/New_York'),true);
  assert.equal(distinctFrom([at('g','r')],at('g','r'),'America/New_York'),false);
});

test('only panels of two are searched; malformed or larger panels are refused before any search',()=>{
  const w=input().sessions[0];
  assert.equal(validAssignment(w),true);
  assert.equal(validAssignment({...w,requiredCount:3}),false);
  assert.equal(validAssignment({...w,slots:[...w.slots,{eligibleInterviewers:[g]}],requiredCount:3}),false);
  assert.equal(validAssignment({...w,slots:[{eligibleInterviewers:[g]},{eligibleInterviewers:[]}]}),false);
  assert.equal(validAssignment({...w,slots:[{eligibleInterviewers:[g]},{eligibleInterviewers:[{userId:'zz',name:'Not listed'}]}]}),false);
  assert.equal(validAssignment({...w,slots:undefined}),false,'requiredCount 2 with no slots');
  const i=input();i.sessions[0]={...w,requiredCount:3,slots:[...w.slots,{eligibleInterviewers:[g]}]};
  assert.throws(()=>proposeCalendarSchedule(i),/Every interview needs a verified duration/);
  assert.equal(tooLarge({title:'Case Study Presentation ',slots:[1,2,3,4]}),'"Case Study Presentation" is a panel: it has 4 interviewer slots, so it expects 4 people. Two-person panels are supported; larger ones aren\'t yet, so this can\'t be proposed or booked here. Schedule it by hand in Ashby.');
});
