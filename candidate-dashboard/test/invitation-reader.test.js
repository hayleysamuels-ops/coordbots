'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {parseInvitations}=require('../worker/invitation-reader');
function cards(){return [{kind:'candidate',title:'Interview with Example',text:'Interview with Example\nTue, Sep 22, 2026 5:15pm - 5:30pm UTC\nEVENT DETAILS\nGoogle Meet\nVirtual welcome\nINVITEES\nTEST Candidate\ntest@example.com'},{kind:'interviewer',title:'Welcome - TEST',text:'Welcome - TEST\nTue, Sep 22, 2026 5:15pm - 5:30pm UTC\nEVENT DETAILS\nGoogle Meet\nAgenda\nINVITEES & ROOMS\nMary\nmary@example.com'}];}
test('separates event text from invitation recipients',()=>{const r=parseInvitations(cards());assert.equal(r.complete,true);assert.deepEqual(r.candidate.recipients,['test@example.com']);assert.deepEqual(r.interviewer.recipients,['mary@example.com']);assert.equal(r.candidate.details,'Google Meet\nVirtual welcome');});
test('message body emails cannot become recipients',()=>{const c=cards();c[0].text=c[0].text.replace('Virtual welcome','Contact other@example.com');assert.deepEqual(parseInvitations(c).candidate.recipients,['test@example.com']);});
test('missing or multiple invitation cards require review',()=>{assert.equal(parseInvitations([]).complete,false);assert.equal(parseInvitations([...cards(),cards()[0]]).complete,false);});
test('missing recipient and time sections cannot count as complete',()=>{const c=cards();c[0].text='Interview\nEVENT DETAILS\nMessage';assert.equal(parseInvitations(c).complete,false);});
