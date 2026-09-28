'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {readyQueue,dismissKey,splitDismissed}=require('../src/scheduling/ready-queue');
const apps=new Map([['a',{applicationId:'a',status:'Active',currentStageId:'stage'}],['b',{applicationId:'b',status:'Archived'}]]);
const schedule=(id,status='CandidateAvailabilitySubmitted')=>({id,applicationId:'a',status,interviewStageId:'stage',updatedAt:'2026-09-21T12:00:00Z'});
test('only active candidates who submitted availability enter the scheduling queue',()=>{assert.deepEqual(readyQueue([schedule('1','NeedsScheduling'),schedule('2','Scheduled'),{...schedule('3'),applicationId:'b'},schedule('4')],apps).map(r=>r.scheduleId),['4']);});
test('multiple pending schedules survive unrelated triage and retain distinct identities',()=>{const result=readyQueue([schedule('1'),schedule('2'),schedule('1')],apps);assert.equal(result.length,2);assert.ok(result.every(r=>r.stageMatches));});
test('changed or missing stages remain visible but block plan preparation',()=>{const result=readyQueue([{...schedule('1'),interviewStageId:'old'},{...schedule('2'),interviewStageId:null}],apps);assert.ok(result.every(r=>!r.stageMatches));});
test('each submission gets its own dismiss key, and none without a submission time',()=>{
  const [row]=readyQueue([schedule('1')],apps);
  assert.equal(row.dismissKey,'schedule:1:2026-09-21T12:00:00Z');
  assert.equal(dismissKey({scheduleId:'1'}),null);
});
test('a snoozed or hidden submission moves to hidden; a candidate dismissal from another section does not',()=>{
  const rows=readyQueue([schedule('1'),schedule('2')],apps).map(r=>({...r,candidateId:'c'}));
  const dismissed=new Set(['candidate:c','schedule:2:2026-09-21T12:00:00Z']);
  const {visible,hidden}=splitDismissed(rows,k=>dismissed.has(k));
  assert.deepEqual(visible.map(r=>r.scheduleId),['1']);
  assert.deepEqual(hidden.map(r=>r.scheduleId),['2']);
});
test('any later change to the schedule resurfaces a hidden submission',()=>{
  const dismissed=new Set([dismissKey({scheduleId:'1',submittedAt:'2026-09-21T12:00:00Z'})]);
  const rows=readyQueue([{...schedule('1'),updatedAt:'2026-09-23T09:00:00Z'}],apps);
  assert.equal(splitDismissed(rows,k=>dismissed.has(k)).visible.length,1);
});
test('a row without a dismiss key is never hidden',()=>{
  assert.equal(splitDismissed([{scheduleId:'1',dismissKey:null}],()=>true).visible.length,1);
});
