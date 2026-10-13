'use strict';
// Booking's permitted writes (worker/booking-permit.js), in front of the write
// guard, in a real browser. A stand-in answers every permitted request, so no
// test reaches Ashby; what's measured is what the stand-in received.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {guardWrites}=require('../worker/template-guard');
const {installBookingPermits,OP}=require('../worker/booking-permit');

let chromium=null;
try{chromium=require('../worker/node_modules/playwright').chromium;}catch(_){}
async function launch(){
  if(!chromium)return null;
  for(const options of [{},{channel:'chrome'}]){try{return await chromium.launch({headless:true,...options});}catch(_){}}
  return null;
}

const HAYLEY={userId:'u-hayley',name:'Hayley Samuels',email:'hayley@luminai.com'};
const plan={candidate:{name:'TEST',email:'t@example.com'},job:{title:'TEST'},stage:{title:'Initial Screen'},activityTitle:'Initial Screen Interview Schedule',
  interviewScheduleId:'sched-1',timeZone:'America/Denver',
  sessions:[{title:'Initial',interviewId:'int-1',start:'2099-10-20T19:05:00.000Z',end:'2099-10-20T19:35:00.000Z',interviewers:[HAYLEY]}]};
const event=(o={})=>({id:'ev-1',title:'Initial',startTimeISO:'2099-10-12T17:00:00.000Z',endTimeISO:'2099-10-12T17:30:00.000Z',interviewId:'int-1',interviewSlots:[{selected:'u-mary',alternates:[]}],...o});

async function setup(t,{baseline=event()}={}){
  const browser=await launch();
  if(!browser){t.skip('no Chromium available');return null;}
  t.after(()=>browser.close());
  const context=await browser.newContext({serviceWorkers:'block'});
  const received=[],log=[];
  await context.route('https://app.ashbyhq.com/**',route=>route.fulfill({contentType:'text/html',body:'<html><body>stand-in</body></html>'}));
  await guardWrites(context,{warn:()=>{}});
  const state={};
  // The stand-in: records each permitted operation and replies as Ashby would.
  const respond=async route=>{const b=JSON.parse(route.request().postData());received.push(b.operationName);
    if(b.operationName===OP.create)return {status:200,json:{data:{draftInterviewSchedule:{id:'draft-1',draftSchedule:{events:[baseline]}}}}};
    return {status:200,json:{data:{ok:true}}};};
  await installBookingPermits(context,{plan,state,respond,log:e=>log.push(e)});
  const page=await context.newPage();await page.goto('https://app.ashbyhq.com/');
  const send=(name,variables)=>page.evaluate(b=>fetch('/api/graphql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.status,()=>'blocked'),
    {operationName:name,query:`mutation ${name} { x }`,variables});
  return {state,received,log,send};
}
const save=(o)=>({draftInterviewScheduleId:'draft-1',draftSchedule:{events:[event(o)]}});

test('the dry run\'s writes: create once, content-checked saves, refreshes, discard only in cleanup, never Send',async t=>{
  const s=await setup(t);if(!s)return;
  // Nothing draft-bound passes before the draft exists.
  assert.equal(await s.send(OP.save,save({interviewSlots:[{selected:'u-hayley',alternates:[]}]})),'blocked');
  assert.equal(await s.send(OP.create,{interviewScheduleId:'someone-elses'}),'blocked');
  assert.equal(await s.send(OP.create,{interviewScheduleId:'sched-1'}),200);
  assert.equal(s.state.draftId,'draft-1');
  assert.equal(await s.send(OP.create,{interviewScheduleId:'sched-1'}),'blocked','a second draft');
  // Saves: toward the approval passes; an unapproved interviewer or another draft doesn't.
  assert.equal(await s.send(OP.save,save({interviewSlots:[{selected:'u-hayley',alternates:[]}]})),200);
  assert.equal(await s.send(OP.save,save({interviewSlots:[{selected:'u-stranger',alternates:[]}]})),'blocked');
  assert.match(s.state.refusals[0],/an interviewer who wasn't approved was selected/);
  assert.equal(await s.send(OP.save,{...save(),draftInterviewScheduleId:'draft-2'}),'blocked');
  assert.equal(await s.send(OP.save,save({startTimeISO:'2099-10-20T19:05:00.000Z',endTimeISO:'2099-10-20T19:35:00.000Z',interviewSlots:[{selected:'u-hayley',alternates:[]}]})),200);
  assert.equal(s.state.last[0].start,Date.parse('2099-10-20T19:05:00.000Z'));
  assert.equal(await s.send(OP.refresh,{draftInterviewScheduleId:'draft-1'}),200);
  // Never: Send, Delete Activity, calendar settings. The discard waits for cleanup.
  assert.equal(await s.send(OP.send,{interviewScheduleId:'sched-1',draftInterviewScheduleId:'draft-1'}),'blocked');
  assert.equal(await s.send('ApiCancelInterviewScheduleProcess',{interviewScheduleId:'sched-1'}),'blocked');
  assert.equal(await s.send('ApiUpdateDraftScheduleCalendarSettings',{draftInterviewScheduleId:'draft-1'}),'blocked');
  assert.equal(await s.send(OP.discard,{draftInterviewScheduleId:'draft-1'}),'blocked','before cleanup');
  s.state.cleanup=true;
  assert.equal(await s.send(OP.discard,{draftInterviewScheduleId:'draft-2'}),'blocked','another draft');
  assert.equal(await s.send(OP.discard,{draftInterviewScheduleId:'draft-1'}),200);
  assert.equal(await s.send(OP.discard,{draftInterviewScheduleId:'draft-1'}),'blocked','a second discard');
  assert.deepEqual(s.received,[OP.create,OP.save,OP.save,OP.refresh,OP.discard]);
});

test('a draft that doesn\'t match the approval still records its ID for cleanup, but no save passes',async t=>{
  const s=await setup(t,{baseline:event({interviewId:'int-other',title:'Other'})});if(!s)return;
  assert.equal(await s.send(OP.create,{interviewScheduleId:'sched-1'}),200);
  assert.equal(s.state.draftId,'draft-1');
  assert.match(s.state.baselineError.message,/doesn't match the approval/);
  assert.equal(await s.send(OP.save,save({interviewSlots:[{selected:'u-hayley',alternates:[]}]})),'blocked');
  s.state.cleanup=true;
  assert.equal(await s.send(OP.discard,{draftInterviewScheduleId:'draft-1'}),200,'it can still be cleaned up');
});
