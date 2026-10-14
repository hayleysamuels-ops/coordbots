'use strict';
// The Slack-approved check in the worker (worker/booking-compose.js) and its
// routes (worker/booking-routes.js): the off switch and the allowlist answer
// "skipped" before a session is read or a browser starts; the composer is
// asked to check the schedule's drafts and keep its draft only on success;
// and Ashby work takes turns.
const {test}=require('node:test'),assert=require('node:assert/strict');
const express=require('express');
const {compose,discard}=require('../worker/booking-compose');
const {bookingRoutes}=require('../worker/booking-routes');
const {signed}=require('../src/scheduling/worker-auth');

const plan={jobId:'837cc1e9-15ed-4f07-8755-51ee29f4ea39',candidateId:'fc88f24e-d59b-4e58-aa51-f0e94b1a32da',applicationId:'8dfd8f14-83c4-41f8-aaf1-416b75cb0892',
  interviewScheduleId:'18599066-1d55-493a-8c2f-1e970b04f86c',timeZone:'America/Denver',candidate:{name:'TEST',email:'hayleysamuels511@gmail.com'},
  job:{title:'TEST'},stage:{title:'First Round'},activityTitle:'First Round Interview Schedule',
  sessions:[{title:'First Round',interviewId:'8b357d3b-5bff-41a6-896f-94da41ddd08c',start:'2099-10-15T19:00:00.000Z',end:'2099-10-15T19:30:00.000Z',
    interviewers:[{userId:'c251f667-e04c-403a-8c70-4cbc8fc3f435',name:'Hayley Samuels',email:'hayley@luminai.com'}]}]};
const env={BOOKING_COMPOSE:'on',ASHBY_BROWSER_ISOLATION:'container'};
const who={clientId:'luminai',expectedIdentity:'Anna Example'};
const session={...who,storageState:{cookies:[],origins:[]}};
const OLD='11111111-2222-4333-8444-555555555555',DRAFT='99999999-8888-4777-8666-555555555555';

function fakes(report={status:'composed',draftId:DRAFT,cleanup:{deleted:false,kept:true,draftId:DRAFT}}){
  const seen={launched:0,sessionReads:0,closed:0,dryRun:null,discardDraft:null};
  const context={setDefaultTimeout(){},route:async()=>{},newPage:async()=>({})};
  const chromium={launch:async()=>{seen.launched++;return {newContext:async()=>context,close:async()=>{seen.closed++;}};}};
  const composer={dryRun:async o=>{seen.dryRun=o;return report;},discardDraft:async o=>{seen.discardDraft=o;return {deleted:true,draftId:o.draftId};}};
  return {seen,deps:{chromium,composer,loadSession:()=>{seen.sessionReads++;return session;},...who}};
}

test('off unless BOOKING_COMPOSE is exactly "on", and only for allowlisted applications: skipped, no session read, no browser',async()=>{
  for(const [e,p,pattern] of [[{...env,BOOKING_COMPOSE:undefined},plan,/switched off/],[{...env,BOOKING_COMPOSE:'true'},plan,/switched off/],
    [env,{...plan,applicationId:'00000000-0000-4000-8000-000000000000'},/isn't one the booking robot may use/],
    [env,{...plan,interviewScheduleId:'00000000-0000-4000-8000-000000000000'},/scheduling activity isn't one of its application's/]]){
    for(const run of [compose,discard]){
      const {seen,deps}=fakes();
      const r=await run({env:e,payload:{plan:p,draftId:DRAFT},...deps});
      assert.equal(r.status,'skipped');assert.match(r.reason,pattern);
      assert.equal(seen.sessionReads,0);assert.equal(seen.launched,0);
    }
  }
});

test('a check composes with the drafts check, the earlier draft to replace, and the draft kept only on success',async()=>{
  const {seen,deps}=fakes();
  const r=await compose({env,payload:{plan,supersedeDraftId:OLD},...deps});
  assert.equal(r.status,'composed');
  assert.equal(seen.dryRun.checkExistingDrafts,true);assert.equal(seen.dryRun.keepOnSuccess,true);
  assert.equal(seen.dryRun.supersedeDraftId,OLD);assert.equal(seen.dryRun.expectedIdentity,'Anna Example');
  assert.deepEqual(seen.dryRun.plan,plan);assert.equal(seen.closed,1);
  // A malformed earlier-draft reference is refused before anything starts.
  const bad=fakes();
  await assert.rejects(compose({env,payload:{plan,supersedeDraftId:'not-a-draft'},...bad.deps}),{status:422});
  assert.equal(bad.seen.launched,0);
});

test('a session for another account is refused with a 409 before a browser starts',async()=>{
  const {seen,deps}=fakes();
  await assert.rejects(compose({env,payload:{plan},...deps,loadSession:()=>({...session,expectedIdentity:'Someone Else'})}),{status:409,message:/No saved Ashby session for Anna Example/});
  assert.equal(seen.launched,0);
});

test('the sweep\'s delete may run after the interview has passed, for exactly the named draft',async()=>{
  const past=structuredClone(plan);past.sessions[0].start='2001-01-01T19:00:00.000Z';past.sessions[0].end='2001-01-01T19:30:00.000Z';
  const {seen,deps}=fakes();
  const r=await discard({env,payload:{plan:past,draftId:DRAFT},...deps});
  assert.deepEqual(r,{deleted:true,draftId:DRAFT});assert.equal(seen.discardDraft.draftId,DRAFT);
  await assert.rejects(discard({env,payload:{plan,draftId:'x'},...fakes().deps}),{status:422});
});

// The routes, over HTTP, with a stand-in draft reader and check.
async function serve({inspect,chromium=null,writeWaitMs=400,signIn=false}){
  const secret='s'.repeat(40);
  const router=bookingRoutes({secret,...who,draftReader:{inspect},writeWaitMs,sleep:ms=>new Promise(r=>setTimeout(r,ms)),
    ashby:{env,chromium,loadSession:()=>session,connection:{status:async()=>({signInOpen:signIn})}}});
  const app=express();app.use('/booking',router);
  const server=await new Promise(r=>{const s=app.listen(0,()=>r(s));});
  const call=async(action,payload={})=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/booking`,{method:'POST',...signed(secret,{action,...who,payload})});return {status:res.status,body:await res.json()};};
  return {call,close:()=>new Promise(r=>server.close(r))};
}

test('Ashby work takes turns: a check waits for inspections, and inspections are refused during a check',async t=>{
  // The check's composer is replaced here by holding the worker's lock with a slow inspection.
  let release;const held=new Promise(r=>{release=r;});
  const s=await serve({inspect:async()=>{await held;return {ok:true};}});
  t.after(()=>s.close());
  const inspection=s.call('inspect-plan',{});
  await new Promise(r=>setTimeout(r,50));
  // A check can't start while the inspection runs; after the wait it gives up with a 409.
  const check=await s.call('compose',{plan:{...plan,applicationId:'00000000-0000-4000-8000-000000000000'}});
  assert.equal(check.status,409);assert.match(check.body.error,/busy with another check for two minutes/);
  release();assert.equal((await inspection).status,200);
  // With nothing running, the check starts (and here is skipped by the allowlist).
  const skippedRun=await s.call('compose',{plan:{...plan,applicationId:'00000000-0000-4000-8000-000000000000'}});
  assert.equal(skippedRun.status,200);assert.equal(skippedRun.body.result.status,'skipped');
});

test('an inspection that arrives during a check is told Ashby is busy',async t=>{
  let release;const held=new Promise(r=>{release=r;});
  // A browser that takes its time to start holds the check open.
  const s=await serve({inspect:async()=>({ok:true}),chromium:{launch:async()=>{await held;throw Error('stand-in browser');}}});
  t.after(()=>s.close());
  const check=s.call('compose',{plan});
  await new Promise(r=>setTimeout(r,100));
  const during=await s.call('inspect-draft',{});
  assert.equal(during.status,409);assert.match(during.body.error,/busy checking an approved schedule/);
  release();assert.equal((await check).status,503);
  assert.equal((await s.call('inspect-draft',{})).status,200);
});

test('a check doesn\'t start while the Ashby sign-in window is open',async t=>{
  const s=await serve({inspect:async()=>({}),signIn:true});
  t.after(()=>s.close());
  const r=await s.call('compose',{plan});
  assert.equal(r.status,409);assert.match(r.body.error,/sign-in window is open/);
});
