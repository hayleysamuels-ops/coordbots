'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createBookingFacts}=require('../src/scheduling/booking-facts');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const now=Date.parse('2026-09-21T12:00:00Z');
const input={applicationId:id(1),interviewId:id(5),interviewerEmail:'mary@example.com',timezone:'America/Los_Angeles',windows:[{start:'2026-09-22T10:00',end:'2026-09-22T16:00'}]};
function setup(){
 const data={'application.info':{id:id(1),status:'Active',candidate:{id:id(2),name:'Test',primaryEmailAddress:{value:'test@example.com'}},job:{id:id(3),title:'Engineer'},currentInterviewStage:{id:id(4)}},'jobInterviewPlan.info':{stages:[{id:id(4),activities:[{id:id(6),interviews:[{interviewId:id(5),title:'Welcome',isSchedulable:true,interviewDurationMinutes:15}]}]}]},'user.search':[{id:id(7),email:'mary@example.com',firstName:'Mary',isEnabled:true}]};
 const calls=[];
 const reader=createBookingFacts({key:'test-key',clientId:'client-a',now:()=>now,request:async(url,options)=>{const endpoint=url.split('/').at(-1);calls.push({endpoint,body:JSON.parse(options.body)});assert.equal(options.redirect,'error');return{ok:true,json:async()=>({success:true,results:data[endpoint]})};}});
 return{data,calls,reader};
}
test('reads exact identities and duration without claiming availability',async()=>{const s=setup(),f=await s.reader.load(input);assert.equal(f.clientId,'client-a');assert.equal(f.durationMinutes,15);assert.equal(f.interviewer.userId,id(7));assert.equal(f.windows[0].start,'2026-09-22T17:00:00.000Z');assert.equal(f.availabilityVerified,false);assert.deepEqual(s.calls.map(c=>c.endpoint),['application.info','jobInterviewPlan.info','user.search']);});
test('candidate or plan changes invalidate fingerprints',async()=>{const s=setup(),a=await s.reader.load(input);s.data['application.info'].candidate.primaryEmailAddress.value='new@example.com';const b=await s.reader.load(input);assert.notEqual(a.sourceFingerprint,b.sourceFingerprint);s.data['jobInterviewPlan.info'].stages[0].activities[0].interviews[0].interviewDurationMinutes=30;assert.notEqual(b.templateRevision,(await s.reader.load(input)).templateRevision);});
test('rejects changed stage and inactive or ambiguous interviewers',async()=>{const s=setup();s.data['application.info'].currentInterviewStage.id=id(99);await assert.rejects(()=>s.reader.load(input),/current stage/);s.data['application.info'].currentInterviewStage.id=id(4);s.data['user.search'][0].isEnabled=false;await assert.rejects(()=>s.reader.load(input),/active Ashby interviewer/);s.data['user.search'][0].isEnabled=true;s.data['user.search'].push({...s.data['user.search'][0],id:id(8)});await assert.rejects(()=>s.reader.load(input),/unique/);});
test('rejects a returned application for a different request',async()=>{const s=setup();s.data['application.info'].id=id(99);await assert.rejects(()=>s.reader.load(input),/no longer active/);assert.equal(s.calls.length,1);});
test('bad windows and identifiers cause no Ashby calls',async()=>{const s=setup();await assert.rejects(()=>s.reader.load({...input,applicationId:'bad'}),/Choose/);await assert.rejects(()=>s.reader.load({...input,windows:[{start:'2026-09-20T10:00',end:'2026-09-20T16:00'}]}),/future/);assert.equal(s.calls.length,0);});
