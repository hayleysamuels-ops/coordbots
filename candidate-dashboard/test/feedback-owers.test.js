'use strict';
// Feedback Overdue skips an event when nobody on it owes a scorecard
// (ashby.js feedbackOwers): a Welcome whose hosts are all feedback-not-required.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {feedbackOwers}=require('../src/ashby');

test('only interviewers not marked feedback-not-required owe a scorecard; a missing flag counts as required',()=>{
  const ev={interviewers:[{email:'a',isFeedbackRequired:true},{email:'b',isFeedbackRequired:false},{email:'c'}]};
  assert.deepEqual(feedbackOwers(ev).map(i=>i.email),['a','c']);
});

test('an event where nobody owes feedback, or with no interviewers, has no one to chase',()=>{
  assert.deepEqual(feedbackOwers({interviewers:[{email:'g',isFeedbackRequired:false},{email:'r',isFeedbackRequired:false}]}),[]);
  assert.deepEqual(feedbackOwers({interviewers:[]}),[]);
  assert.deepEqual(feedbackOwers({}),[]);
});

// Ashby's hasSubmittedFeedback turns true when ANYONE on the event submits, so
// a panel can read "in" with a required interviewer missing (12 of 50 Forus
// panels, 2026-11-17). missingFeedbackOwers resolves it per person from
// applicationFeedback.list.
const {missingFeedbackOwers}=require('../src/ashby');
const panel={id:'ev1',interviewers:[{id:'ana',isFeedbackRequired:true},{id:'ben',isFeedbackRequired:true},{id:'tia',isFeedbackRequired:false}]};

test('a panel with one of two scorecards in is still waiting on the other',()=>{
  const rows=[{interviewEventId:'ev1',submittedByUser:{id:'ana'},creditedToUser:{id:'ana'}}];
  assert.deepEqual(missingFeedbackOwers(panel,rows).map(i=>i.id),['ben']);
});

test('a scorecard submitted on someone\'s behalf counts for the person it is credited to, not the submitter',()=>{
  const rows=[{interviewEventId:'ev1',submittedByUser:{id:'coordinator'},creditedToUser:{id:'ben'}},
              {interviewEventId:'ev1',submittedByUser:{id:'ana'},creditedToUser:{id:'ana'}}];
  assert.deepEqual(missingFeedbackOwers(panel,rows),[]);
});

test('without a credit, the submitter is who it counts for',()=>{
  assert.deepEqual(missingFeedbackOwers(panel,[{interviewEventId:'ev1',submittedByUser:{id:'ben'}}]).map(i=>i.id),['ana']);
});

test('feedback for another interview on the same application does not count; a non-required trainee is never missing',()=>{
  const rows=[{interviewEventId:'other-round',creditedToUser:{id:'ana'}},{interviewEventId:'ev1',creditedToUser:{id:'tia'}}];
  assert.deepEqual(missingFeedbackOwers(panel,rows).map(i=>i.id),['ana','ben']);
});
