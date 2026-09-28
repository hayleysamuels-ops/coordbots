'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {readyQueue}=require('../src/scheduling/ready-queue');
const apps=new Map([['a',{applicationId:'a',status:'Active',currentStageId:'stage'}],['b',{applicationId:'b',status:'Archived'}]]);
const schedule=(id,status='CandidateAvailabilitySubmitted')=>({id,applicationId:'a',status,interviewStageId:'stage',updatedAt:'2026-09-21T12:00:00Z'});
test('only active candidates who submitted availability enter the scheduling queue',()=>{assert.deepEqual(readyQueue([schedule('1','NeedsScheduling'),schedule('2','Scheduled'),{...schedule('3'),applicationId:'b'},schedule('4')],apps).map(r=>r.scheduleId),['4']);});
test('multiple pending schedules survive unrelated triage and retain distinct identities',()=>{const result=readyQueue([schedule('1'),schedule('2'),schedule('1')],apps);assert.equal(result.length,2);assert.ok(result.every(r=>r.stageMatches));});
test('changed or missing stages remain visible but block plan preparation',()=>{const result=readyQueue([{...schedule('1'),interviewStageId:'old'},{...schedule('2'),interviewStageId:null}],apps);assert.ok(result.every(r=>!r.stageMatches));});
