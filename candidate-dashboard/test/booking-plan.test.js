'use strict';
// The hand-off from the calendar-checked preview to the booking robot
// (src/scheduling/booking-plan.js), using a real preview response for the
// TEST application at First Round (October 13, 2026).
const {test}=require('node:test'),assert=require('node:assert/strict');
const {bookingPlanFromOption}=require('../src/scheduling/booking-plan');
const preview=require('./fixtures/full-schedule-preview-first-round.json');

const application={jobId:'837cc1e9-15ed-4f07-8755-51ee29f4ea39',candidateId:'fc88f24e-d59b-4e58-aa51-f0e94b1a32da',applicationId:'8dfd8f14-83c4-41f8-aaf1-416b75cb0892',
  interviewScheduleId:'18599066-1d55-493a-8c2f-1e970b04f86c',candidate:{name:'TEST',email:'hayleysamuels511@gmail.com'},job:{title:'TEST'},stage:{title:'First Round'},activityTitle:'First Round Interview Schedule'};

test('a preview option becomes the robot\'s plan: the solver\'s sessions, times and interviewers',()=>{
  const plan=bookingPlanFromOption({option:preview.proposals[0],application,accountTimeZone:'America/Denver'});
  assert.equal(plan.interviewScheduleId,'18599066-1d55-493a-8c2f-1e970b04f86c');
  assert.equal(plan.timeZone,'America/Denver');
  assert.deepEqual(plan.sessions,[
    {title:'First Round',interviewId:'8b357d3b-5bff-41a6-896f-94da41ddd08c',start:'2026-10-15T19:00:00.000Z',end:'2026-10-15T19:30:00.000Z',
      interviewers:[{userId:'c251f667-e04c-403a-8c70-4cbc8fc3f435',name:'Hayley Samuels',email:'hayley@luminai.com'}]},
    {title:'First Round',interviewId:'2edf27b9-b916-4264-9219-28f3ba29b2e4',start:'2026-10-15T19:30:00.000Z',end:'2026-10-15T20:00:00.000Z',
      interviewers:[{userId:'4a8a726c-adce-4653-8874-3828c8f4e4a2',name:'Mary Petrino',email:'mary@luminai.com'}]},
  ]);
});

test('the account\'s display zone is its own input, not the candidate\'s availability zone',()=>{
  const plan=bookingPlanFromOption({option:preview.proposals[0],application,accountTimeZone:'America/Los_Angeles'});
  assert.equal(preview.timezone,'America/Denver');assert.equal(plan.timeZone,'America/Los_Angeles');
  assert.throws(()=>bookingPlanFromOption({option:preview.proposals[0],application,accountTimeZone:'PST'}),/IANA zone/);
  assert.throws(()=>bookingPlanFromOption({option:preview.proposals[0],application}),/time zone/);
});

test('incomplete options and applications are refused',()=>{
  const option=structuredClone(preview.proposals[0]);
  option.events[1].interviewer={name:'Mary Petrino'};
  assert.throws(()=>bookingPlanFromOption({option,application,accountTimeZone:'America/Denver'}),/Session 2 \("First Round"\) has no fully identified interviewer/);
  const overlap=structuredClone(preview.proposals[0]);overlap.events[1].start='2026-10-15T19:15:00.000Z';
  assert.throws(()=>bookingPlanFromOption({option:overlap,application,accountTimeZone:'America/Denver'}),/Sessions 1 and 2 overlap/);
  assert.throws(()=>bookingPlanFromOption({option:preview.proposals[0],application:{...application,interviewScheduleId:undefined},accountTimeZone:'America/Denver'}),/interviewScheduleId/);
  assert.throws(()=>bookingPlanFromOption({option:{events:[]},application,accountTimeZone:'America/Denver'}),/no sessions/);
});
