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
