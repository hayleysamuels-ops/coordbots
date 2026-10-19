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

test('each check is logged: started, then its outcome with every draft created or deleted',async()=>{
  const PROPOSAL='22222222-3333-4444-8555-666666666666';
  const logged=async(report,payload={plan,proposalId:PROPOSAL})=>{const lines=[],{deps}=fakes(report);
    try{await compose({env,payload,...deps,say:l=>lines.push(l)});}catch(_){}return lines;};
  const composed=await logged({status:'composed',draftId:DRAFT,displayZone:'America/Denver',cleanup:{deleted:false,kept:true,draftId:DRAFT},writes:{saves:3,refusedSaves:0},superseded:{draftId:OLD,deleted:true}});
  assert.deepEqual(composed,[`[booking] Ashby check for ${PROPOSAL} started: application ${plan.applicationId}, schedule ${plan.interviewScheduleId}, 1 session(s), plan zone America/Denver`,
    `[booking] Ashby check for ${PROPOSAL} composed; draft ${DRAFT} created, kept for a person to send; earlier draft ${OLD} deleted; composer zone America/Denver; 3 saves`]);
  const refused=await logged({status:'refused',step:'compose session 1 ("First Round")',reason:'Something.',draftId:DRAFT,cleanup:{deleted:true,draftId:DRAFT},writes:{saves:0,refusedSaves:1}});
  assert.equal(refused[1],`[booking] Ashby check for ${PROPOSAL} refused at "compose session 1 ("First Round")": Something; draft ${DRAFT} created, deleted; 0 saves, 1 refused`);
  const left=await logged({status:'error',step:'compose',reason:'Boom.',draftId:DRAFT,cleanup:{deleted:false,reason:'Ashby didn\'t answer'}});
  assert.match(left[1],new RegExp(`draft ${DRAFT} created, NOT deleted \\(Ashby didn't answer\\); delete it by hand$`));
  const none=await logged({status:'refused',step:'check the schedule\'s drafts',reason:'Already has one.',cleanup:{deleted:false,reason:'no draft was created'}});
  assert.match(none[1],/: Already has one; no draft created$/);
  // Skipped, with no proposal ID (an older dashboard): no "for".
  const skipped=await logged(undefined,{plan:{...plan,applicationId:'00000000-0000-4000-8000-000000000000'}});
  assert.match(skipped[0],/^\[booking\] Ashby check started:/);assert.match(skipped[1],/^\[booking\] Ashby check skipped: Application 0{8}-0{4}-4000-8000-0{12} isn't one the booking robot may use; no draft created$/);
  // A run that throws still says so.
  const lines=[],{deps}=fakes();
  await assert.rejects(compose({env,payload:{plan,supersedeDraftId:'bad'},...deps,say:l=>lines.push(l)}),{status:422});
  assert.match(lines[1],/didn't run to a result: The earlier draft reference isn't a draft ID; no draft created$/);
});

test('each sweep delete is logged with what happened to the draft',async()=>{
  const lines=[],{deps}=fakes();
  await discard({env,payload:{plan,draftId:DRAFT,proposalId:'22222222-3333-4444-8555-666666666666'},...deps,say:l=>lines.push(l)});
  assert.deepEqual(lines,[`[booking] Unsent draft ${DRAFT} for 22222222-3333-4444-8555-666666666666: deleting (schedule ${plan.interviewScheduleId})`,
    `[booking] Unsent draft ${DRAFT} for 22222222-3333-4444-8555-666666666666: deleted`]);
});

test('typed times, each save and the communications screen are logged as the check runs',async()=>{
  const {detailLine}=require('../worker/booking-compose');
  assert.equal(detailLine({type:'typed',session:1,title:'Onsite',zone:'MDT',approved:'2026-10-20T18:00:00.000Z–2026-10-20T18:30:00.000Z',
    date:{value:'Tue, Oct 20',typed:true},start:{value:'12:00pm',typed:true},end:{value:'12:30pm',typed:false}}),
    'session 1 ("Onsite") entered: Tue, Oct 20, 12:00pm – 12:30pm (already set) MDT; approved 2026-10-20T18:00:00.000Z–2026-10-20T18:30:00.000Z');
  assert.equal(detailLine({type:'save-checked',seq:2,events:['1 2026-10-20T18:00Z–18:30Z u-h']}),'save 2 passed the content check: 1 2026-10-20T18:00Z–18:30Z u-h');
  assert.equal(detailLine({type:'refused-save',seq:3,reason:'A draft save was refused: x.'}),'save 3 REFUSED by the content check: A draft save was refused: x.');
  assert.equal(detailLine({type:'save-result',seq:2,accepted:true,status:200}),'save 2 accepted by Ashby');
  assert.equal(detailLine({type:'save-result',seq:4,accepted:false,status:200,errors:['nope']}),'save 4 NOT accepted by Ashby (HTTP 200: nope)');
  assert.equal(detailLine({type:'screen',at:'refused',path:'/p',controls:[{el:'input',type:'checkbox',name:'Send Candidate Invite',checked:true}]}),
    'screen (refused): {"path":"/p","controls":[{"el":"input","type":"checkbox","name":"Send Candidate Invite","checked":true}]}');
  assert.equal(detailLine({type:'permitted'}),null);
  // Printed as the run goes, under the check's tag.
  const lines=[];
  const {deps}=fakes();
  deps.composer={dryRun:async o=>{o.log({type:'typed',session:1,title:'First Round',zone:'MDT',approved:'a–b',date:{value:'Thu, Oct 15',typed:true},start:{value:'1:00pm',typed:true},end:{value:'1:30pm',typed:true}});
    o.log({type:'permitted'});return {status:'composed',draftId:DRAFT,cleanup:{kept:true,draftId:DRAFT}};}};
  await compose({env,payload:{plan},...deps,say:l=>lines.push(l)});
  assert.equal(lines.length,3);
  assert.equal(lines[1],'[booking] Ashby check session 1 ("First Round") entered: Thu, Oct 15, 1:00pm – 1:30pm MDT; approved a–b');
});

test('a robot Send may reach only the allowlisted recipients; until Send exists that is only reported',()=>{
  const {SEND_RECIPIENTS,sendRecipientsOutside}=require('../worker/booking-locks');
  assert.deepEqual([...SEND_RECIPIENTS].sort(),['hayley@luminai.com','hayleysamuels511@gmail.com']);
  assert.deepEqual(sendRecipientsOutside(plan),[]);
  // TEST's Onsite, as approved on October 19: colleagues on four sessions.
  const onsite={...plan,sessions:['hayley@luminai.com','joe@luminai.com','Mary@Luminai.com','anna@luminai.com','hayley@luminai.com'].map(email=>({...plan.sessions[0],interviewers:[{...plan.sessions[0].interviewers[0],email}]}))};
  assert.deepEqual(sendRecipientsOutside(onsite),['anna@luminai.com','joe@luminai.com','mary@luminai.com']);
  assert.deepEqual(sendRecipientsOutside({...plan,candidate:{...plan.candidate,email:'someone@example.com'}}),['someone@example.com']);
  const {detailLine}=require('../worker/booking-compose');
  assert.equal(detailLine({type:'send-recipients',allowed:true}),'send recipients: all on the send allowlist');
  assert.equal(detailLine({type:'send-recipients',allowed:false,outside:['joe@luminai.com']}),'send recipients: outside the send allowlist: joe@luminai.com (reported only; nothing is sent)');
  assert.equal(detailLine({type:'screen',at:'schedule-menu',note:'"Schedule" is a plain button here'}),'screen (schedule-menu): "Schedule" is a plain button here');
});

test('TEMPORARY: the confirmation email\'s date and time lines are logged once, on TEST only, then never again',async t=>{
  const fsMod=require('fs'),os=require('os'),pathMod=require('path');
  const dir=fsMod.mkdtempSync(pathMod.join(os.tmpdir(),'email-lines-'));t.after(()=>fsMod.rmSync(dir,{recursive:true,force:true}));
  const markerFile=pathMod.join(dir,'email-lines-logged');
  const run=async(p,report={status:'composed',draftId:DRAFT,cleanup:{kept:true,draftId:DRAFT},emailLinesLogged:true})=>{
    const {seen,deps}=fakes(report);await compose({env,payload:{plan:p},...deps,markerFile,say:()=>{}});return seen.dryRun.logEmailLines;};
  // Another application never logs (here it's skipped by the allowlist before the composer, so check the flag path directly).
  assert.equal(await run(plan),true,'TEST, first run');
  assert.ok(fsMod.existsSync(markerFile),'the marker is written once logged');
  assert.equal(await run(plan),false,'never again');
  fsMod.rmSync(markerFile);
  assert.equal(await run({...plan,applicationId:'00000000-0000-4000-8000-000000000000'}).catch(()=>'skipped'),'skipped');
  // Without a session directory to mark, it doesn't log at all.
  const {seen,deps}=fakes();await compose({env,payload:{plan},...deps,markerFile:null,say:()=>{}});
  assert.equal(seen.dryRun.logEmailLines,false);
  // Only lines with a date or time.
  const {emailDateTimeLines}=require('../worker/booking-check');
  assert.deepEqual(emailDateTimeLines({subject:'Confirmed: Interview with Luminai - Thu, Oct 22, 2026',body:'Hi TEST,\nThanks for your time.\nThursday, October 22, 2026\n10:00 AM - 10:30 AM PDT Onsite\nSee you then.\nhttps://meet.google.com/abc'}),
    ['Subject: Confirmed: Interview with Luminai - Thu, Oct 22, 2026','Thursday, October 22, 2026','10:00 AM - 10:30 AM PDT Onsite']);
  const {detailLine}=require('../worker/booking-compose');
  assert.equal(detailLine({type:'email-lines',lines:['a']}),'confirmation email date/time lines (TEMPORARY, once on TEST): ["a"]');
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
