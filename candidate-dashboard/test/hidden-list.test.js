'use strict';
// The Action queue's Hidden & snoozed tab (hidden-list.js) and what each
// dismissal now saves (dismissals.js).
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'dismissals-'));
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
const {hiddenEntries}=require('../src/hidden-list');
const dismissals=require('../src/dismissals');

const keys={candidateKeys:['feedbackOverdue','staleCandidates','offersSigned'],interviewerKeys:['interviewerLimits'],disabledSections:['offersSigned']};
const snap={
  feedbackOverdue:[{candidateId:'c1',candidateName:'Ada',jobTitle:'FDE',ashbyProfileUrl:'https://x/c1'}],
  staleCandidates:[{candidateId:'c1',candidateName:'Ada'}],
  offersSigned:[{candidateId:'c3',candidateName:'Off'}],
  interviewerLimits:[{userId:'u1',name:'Ivy'}],
  readyToSchedule:[{dismissKey:'schedule:s1:2026-11-01T00:00:00Z',candidateName:'Rae',jobTitle:'AE'}],
};
const d=(key,extra={})=>({key,scope:'forever',expiresAt:null,hiddenAt:null,by:null,label:null,...extra});

test('a hidden candidate names every section they would show in now',()=>{
  const [e]=hiddenEntries([d('candidate:c1',{by:'Anna',hiddenAt:5})],snap,keys);
  assert.deepEqual({name:e.name,sections:e.sections,onDashboard:e.onDashboard,by:e.by,url:e.ashbyProfileUrl,job:e.jobTitle},
    {name:'Ada',sections:['feedbackOverdue','staleCandidates'],onDashboard:true,by:'Anna',url:'https://x/c1',job:'FDE'});
});

test('a hidden candidate not on the dashboard is still listed, by the name saved when hidden',()=>{
  const [e]=hiddenEntries([d('candidate:gone',{label:'Bo'})],snap,keys);
  assert.equal(e.name,'Bo');assert.equal(e.onDashboard,false);assert.deepEqual(e.sections,[]);
  assert.equal(hiddenEntries([d('candidate:gone')],snap,keys)[0].name,null);
});

test('a section the client has turned off is never named',()=>{
  const [e]=hiddenEntries([d('candidate:c3',{label:'Off'})],snap,keys);
  assert.deepEqual(e.sections,[]);assert.equal(e.onDashboard,false);
});

test('interviewers and Ready to schedule submissions are listed; a changed submission is not',()=>{
  const out=hiddenEntries([d('interviewer:u1'),d('schedule:s1:2026-11-01T00:00:00Z'),d('schedule:s1:2026-10-01T00:00:00Z')],snap,keys);
  assert.deepEqual(out.map(e=>[e.kind,e.name,e.sections]),[['interviewer','Ivy',['interviewerLimits']],['schedule','Rae',['readyToSchedule']]]);
});

test('on the dashboard first, then most recently hidden, entries with no time last',()=>{
  const out=hiddenEntries([d('candidate:gone',{hiddenAt:9}),d('candidate:c1',{hiddenAt:1}),d('interviewer:u1'),d('interviewer:u9',{hiddenAt:3})],snap,keys);
  assert.deepEqual(out.map(e=>e.key),['candidate:c1','interviewer:u1','candidate:gone','interviewer:u9']);
});

test('a snooze lifts at the next midnight in the display time zone, across DST changes',()=>{
  const at=(iso,tz)=>new Date(dismissals.nextMidnight(Date.parse(iso),tz)).toISOString();
  assert.equal(at('2026-11-05T21:00:00Z','America/Los_Angeles'),'2026-11-06T08:00:00.000Z'); // 1pm PST
  assert.equal(at('2026-11-01T06:30:00Z','America/Los_Angeles'),'2026-11-01T07:00:00.000Z'); // 11:30pm PDT, before fall back
  assert.equal(at('2026-03-08T05:00:00Z','America/Los_Angeles'),'2026-03-08T08:00:00.000Z'); // 9pm PST, before spring forward
  assert.equal(at('2026-03-08T05:00:00Z','America/New_York'),'2026-03-09T04:00:00.000Z');    // midnight EST, the day DST starts
});

test('a dismissal saves when, by whom (trimmed, or null) and the name; restore removes it',()=>{
  dismissals.add('candidate:t1','forever',{by:'  Anna ',label:'Ada',now:1000});
  dismissals.add('candidate:t2','today',{by:'',now:Date.now()});
  const byKey=Object.fromEntries(dismissals.list().map(e=>[e.key,e]));
  assert.deepEqual(byKey['candidate:t1'],{key:'candidate:t1',scope:'forever',expiresAt:null,hiddenAt:1000,by:'Anna',label:'Ada'});
  assert.equal(byKey['candidate:t2'].by,null);assert.ok(byKey['candidate:t2'].expiresAt>Date.now());
  dismissals.remove('candidate:t1');
  assert.ok(!dismissals.isDismissed('candidate:t1'));
});
