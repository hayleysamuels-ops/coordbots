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
  assert.deepEqual([...SEND_RECIPIENTS].sort(),['anna@luminai.com','hayley@luminai.com','hayleysamuels511@gmail.com','joe@luminai.com','mary@luminai.com']);
  assert.deepEqual(sendRecipientsOutside(plan),[]);
  // TEST's Onsite: colleagues on three sessions, all on the list since October 26.
  const onsite={...plan,sessions:['hayley@luminai.com','joe@luminai.com','Mary@Luminai.com','anna@luminai.com','hayley@luminai.com'].map(email=>({...plan.sessions[0],interviewers:[{...plan.sessions[0].interviewers[0],email}]}))};
  assert.deepEqual(sendRecipientsOutside(onsite),[]);
  const other={...onsite,sessions:[...onsite.sessions,{...plan.sessions[0],interviewers:[{...plan.sessions[0].interviewers[0],email:'tom@luminai.com'}]}]};
  assert.deepEqual(sendRecipientsOutside(other),['tom@luminai.com']);
  assert.deepEqual(sendRecipientsOutside({...plan,candidate:{...plan.candidate,email:'someone@example.com'}}),['someone@example.com']);
  const {detailLine}=require('../worker/booking-compose');
  assert.equal(detailLine({type:'send-recipients',allowed:true}),'send recipients: all on the send allowlist');
  assert.equal(detailLine({type:'send-recipients',allowed:false,outside:['joe@luminai.com']}),'send recipients: outside the send allowlist: joe@luminai.com (reported only; nothing is sent)');
  assert.equal(detailLine({type:'screen',at:'schedule-menu',note:'"Schedule" is a plain button here'}),'screen (schedule-menu): "Schedule" is a plain button here');
});

test('an unreadable candidate agenda is logged by its shape only',()=>{
  const {detailLine}=require('../worker/booking-compose');
  assert.equal(detailLine({type:'agenda-shape',lists:[{items:6,first:['9:00[nnbsp]AM - 9:30']}],lines:6}),
    'candidate invite agenda unreadable, its shape (letters masked): {"lists":[{"items":6,"first":["9:00[nnbsp]AM - 9:30"]}],"lines":6}');
});

// ---- the robot's Send: every lock ------------------------------------------

const FIRST_ROUND='199e1b3d-3f4f-4629-98a5-3ec323fd1206';
const sendPlan={...plan,interviewScheduleId:FIRST_ROUND,send:true,sendAs:'Anna Jones Example'};
test('Send needs every lock: the announced plan, BOOKING_SEND exactly "on", the send allowlist, and only allowlisted recipients',async()=>{
  const {sendBlocked}=require('../worker/booking-locks');
  const sendEnv={...env,BOOKING_SEND:'on'};
  assert.equal(sendBlocked(sendPlan,sendEnv),null);
  assert.match(sendBlocked(sendPlan,env),/switched off .*BOOKING_SEND/);
  assert.match(sendBlocked(sendPlan,{...env,BOOKING_SEND:'true'}),/switched off/);
  assert.match(sendBlocked({...sendPlan,interviewScheduleId:plan.interviewScheduleId},sendEnv),/aren't on the send allowlist/,'compose-allowed but not send-allowed');
  const tom={...sendPlan,sessions:[{...sendPlan.sessions[0],interviewers:[{...sendPlan.sessions[0].interviewers[0],email:'tom@luminai.com'}]}]};
  assert.match(sendBlocked(tom,sendEnv),/outside the send allowlist: tom@luminai.com/);
  // compose() passes `send` to the composer only when the plan announced it and every lock is open.
  const decided=async(p,e)=>{const lines=[],{seen,deps}=fakes();await compose({env:e,payload:{plan:p},...deps,say:l=>lines.push(l)});return {send:seen.dryRun.send,lines};};
  const on=await decided(sendPlan,sendEnv);
  assert.equal(on.send,true);assert.match(on.lines[1],/send: every lock is open; Schedule will be clicked once/);
  assert.equal((await decided({...sendPlan,send:undefined},sendEnv)).send,false,'not announced at posting: never sends');
  const off=await decided(sendPlan,env);
  assert.equal(off.send,false);assert.match(off.lines[1],/send announced but not happening: Send is switched off/);
  assert.equal((await decided(tom,sendEnv)).send,false);
});

test('send-status, at posting, is read-only and says whether approving would send',()=>{
  const {sendStatus}=require('../worker/booking-compose');
  const sendEnv={...env,BOOKING_SEND:'on'};
  assert.deepEqual(sendStatus({env:sendEnv,payload:{plan:sendPlan},expectedIdentity:'Anna Jones Example'}),{sendOn:true,as:'Anna Jones Example'});
  assert.equal(sendStatus({env,payload:{plan:sendPlan}}).sendOn,false);
  assert.match(sendStatus({env:{...sendEnv,BOOKING_COMPOSE:undefined},payload:{plan:sendPlan}}).reason,/BOOKING_COMPOSE/);
  assert.match(sendStatus({env:sendEnv,payload:{plan:{...sendPlan,applicationId:'00000000-0000-4000-8000-000000000000'}}}).reason,/isn't one the booking robot may use/);
});

test('the draft is found in a read response by its ID, at any depth, exactly',()=>{
  const {draftsIn}=require('../worker/booking-check');
  const d={id:DRAFT,draftSchedule:{events:[{id:'e'}]}};
  assert.deepEqual(draftsIn({data:{viewer:{draft:d}}},DRAFT),[d]);
  assert.equal(draftsIn({data:{a:d,b:{...d}}},DRAFT).length,2,'two copies are counted, and the re-read refuses');
  assert.deepEqual(draftsIn({data:{draft:{id:OLD,draftSchedule:{events:[]}}}},DRAFT),[]);
  assert.deepEqual(draftsIn({data:{draft:{id:DRAFT,draftSchedule:{}}}},DRAFT),[],'no events: not a draft read');
  assert.deepEqual(draftsIn(null,DRAFT),[]);
});

test('the re-read takes the draft at data.draftInterviewSchedule, and every other copy must match it exactly',()=>{
  const {draftReadCopy,DRAFT_READ_OP}=require('../worker/booking-check');
  assert.equal(DRAFT_READ_OP,'ApiGetDraftSchedule');
  // As ApiGetDraftSchedule answered on October 20: the draft, and again in the schedule's own list of drafts.
  const event=(start='2026-10-22T18:00:00.000Z',selected='u-h')=>({id:'ev-1',title:'First Round',startTimeISO:start,endTimeISO:'2026-10-22T18:30:00.000Z',interviewId:'i-1',interviewSlots:[{selected,alternates:[]}]});
  const draft=(e=event())=>({id:DRAFT,__typename:'DraftInterviewSchedule',draftSchedule:{events:[e],externalInterviewResourceDraftScheduleAssignments:[]}});
  const response=(main,listed=[draft()])=>({data:{draftInterviewSchedule:{...main,interviewSchedule:{drafts:listed}}}});
  assert.deepEqual(draftReadCopy(response(draft()),DRAFT).events[0].startTimeISO,'2026-10-22T18:00:00.000Z');
  assert.ok(draftReadCopy(response(draft(),[]),DRAFT),'with no other copy');
  assert.throws(()=>draftReadCopy(response(draft(),[draft(event('2026-10-22T19:00:00.000Z'))]),DRAFT),/holds 1 other copy of it that differs from the one read/);
  assert.throws(()=>draftReadCopy(response(draft(),[draft(event(undefined,'u-other'))]),DRAFT),/differs/);
  assert.throws(()=>draftReadCopy({data:{other:draft()}},DRAFT),/doesn't hold it at data.draftInterviewSchedule/);
  assert.throws(()=>draftReadCopy({data:{draftInterviewSchedule:{...draft(),id:OLD}}},DRAFT),/doesn't hold it at data.draftInterviewSchedule/);
  assert.throws(()=>draftReadCopy({data:{draftInterviewSchedule:{id:DRAFT,draftSchedule:'{}'}}},DRAFT),/doesn't hold it/);
});

test('when no draft read is found, the requests that mentioned the draft are logged by structure only, never values',()=>{
  const {draftShape}=require('../worker/booking-check');
  const json={data:{draft:{id:DRAFT,title:'Secret Title',draftSchedule:{events:[{id:'e',title:'Hayley Samuels'}],timeZone:'America/Denver'}},
    other:{draftInterviewScheduleId:DRAFT,name:'TEST candidate'},asText:{id:DRAFT,draftSchedule:'{"events":[]}'}}};
  const shape=draftShape(json,DRAFT);
  assert.deepEqual(shape.objects,[
    {path:'data.draft',keys:['draftSchedule','id','title'],draftSchedule:'object',draftScheduleKeys:['events','timeZone'],events:'list(1)'},
    {path:'data.asText',keys:['draftSchedule','id'],draftSchedule:'string'}]);
  assert.deepEqual(shape.references,['data.other.draftInterviewScheduleId']);
  assert.doesNotMatch(JSON.stringify(shape),/Secret Title|Hayley Samuels|TEST candidate|America\/Denver/);
  assert.deepEqual(draftShape({data:{x:1}},DRAFT),{objects:[],references:[]});
  // Capped, however large the response.
  const many={data:Array.from({length:50},()=>({id:DRAFT}))};
  assert.ok(draftShape(many,DRAFT).objects.length<=20);
  const {detailLine}=require('../worker/booking-compose');
  assert.equal(detailLine({type:'draft-mentions',count:1,mentions:[{operations:['ApiGetDraft'],read:true}]}),
    'no draft read found; the requests that mentioned the draft (structure only): {"count":1,"mentions":[{"operations":["ApiGetDraft"],"read":true}]}');
});

test('invite status comes from what Ashby shows: pending on its pending signs, sent only on an explicit sent, otherwise unknown',()=>{
  const {classifyInviteStatus}=require('../worker/booking-check');
  // TEST's First Round on October 20, after the publish was blocked.
  const seen={headings:['Schedule TEST TEST First Round Scheduled Pending invites Pending invite','SEND CALENDAR INVITES'],lines:['Pending invites','Pending invite','SEND CALENDAR INVITES','Send to Candidate','Send to Interviewers'],
    buttons:['Send to Candidate','Send to Interviewers','Manual Reschedule','Cancel Interview']};
  const pending=classifyInviteStatus(seen);
  assert.equal(pending.state,'pending');assert.ok(pending.evidence.includes('Pending invites')&&pending.evidence.includes('button: Send to Candidate'));
  assert.equal(classifyInviteStatus({lines:['Candidate Invite Not Sent']}).state,'pending');
  assert.equal(classifyInviteStatus({buttons:['Send to Interviewers']}).state,'pending');
  assert.equal(classifyInviteStatus({lines:['Invites sent']}).state,'sent');
  assert.equal(classifyInviteStatus({lines:['Invites sent','Pending invite']}).state,'pending','any pending sign wins');
  assert.equal(classifyInviteStatus({headings:['Schedule TEST TEST First Round Scheduled'],lines:['SEND CALENDAR INVITES']}).state,'unknown','no sign either way is unknown, never sent');
  // TEST's First Round once its invites went out (October 20).
  const rsvp=classifyInviteStatus({headings:['Schedule TEST TEST First Round Scheduled Waiting on RSVPs Waiting on RSVP','ACTIONS'],lines:[],buttons:['Manual Reschedule','Cancel Interview','Email Candidate','Email Panel']});
  assert.equal(rsvp.state,'sent');assert.match(rsvp.evidence[0],/Waiting on RSVPs/);
  assert.equal(classifyInviteStatus({headings:['Scheduled Waiting on RSVP'],buttons:['Send to Candidate']}).state,'pending','a Send to button wins over Waiting on RSVP');
  assert.equal(classifyInviteStatus({headings:['Scheduled Waiting on RSVPs Pending invite']}).state,'pending','a pending sign wins too');
  assert.equal(classifyInviteStatus({}).state,'unknown');
});

test('the publish permit is one, armed with Send, and only for a request that names this schedule or draft',()=>{
  const fsMod=require('fs'),pathMod=require('path');
  const composer=fsMod.readFileSync(pathMod.join(__dirname,'..','worker','booking-composer.js'),'utf8');
  assert.equal((composer.match(/op:OP\.publish\b/g)||[]).length,1,'one publish permit');
  assert.match(composer,/if\(send&&keepOnSuccess\)await installPermit\(context,\{op:OP\.publish,max:1,/);
  assert.match(composer,/if\(!publishing\.armed\)return false;[\s\S]{0,200}return t\.includes\(plan\.interviewScheduleId\)\|\|\(!!state\.draftId&&t\.includes\(state\.draftId\)\);/);
  assert.equal((composer.match(/publishing\.armed=true/g)||[]).length,1,'armed in one place');
  assert.match(composer,/sending\.armed=true;publishing\.armed=true;emailing\.armed=true;\s*try\{\s*try\{await schedule\.click\(\);/,'armed with Send, right before the one click');
  // The confirmation email's permit, the same way.
  assert.equal((composer.match(/op:OP\.confirmationEmail\b/g)||[]).length,1,'one confirmation email permit');
  assert.match(composer,/if\(send&&keepOnSuccess\)await installPermit\(context,\{op:OP\.confirmationEmail,max:1,/);
  assert.match(composer,/if\(!emailing\.armed\)return false;[\s\S]{0,200}return t\.includes\(plan\.interviewScheduleId\)\|\|\(!!state\.draftId&&t\.includes\(state\.draftId\)\);/);
  assert.equal((composer.match(/emailing\.armed=true/g)||[]).length,1);
  const {composeOutcome}=require('../worker/booking-compose');
  assert.match(composeOutcome({status:'sent',draftId:DRAFT,send:{attempted:true,reply:{status:200,accepted:true},publish:{reply:null,blockedByGuard:true,variables:'input'}},invites:{state:'pending'},cleanup:{kept:true}}),
    /invites: publish BLOCKED by the guard \(variables: input\); Ashby shows the invites PENDING$/);
});

test('the log says plainly whether the check sent',()=>{
  const {composeOutcome}=require('../worker/booking-compose');
  assert.match(composeOutcome({status:'sent',draftId:DRAFT,send:{attempted:true,reply:{status:200,accepted:true}},cleanup:{kept:true}}),/^SENT by clicking Schedule once \(Ashby answered HTTP 200, accepted\); draft .* created, kept \(a send was attempted\)/);
  assert.match(composeOutcome({status:'send_uncertain',draftId:DRAFT,send:{attempted:true,reply:null,blockedByGuard:true},cleanup:{kept:true}}),/^SEND UNCERTAIN after clicking Schedule once \(the write guard blocked it, so it never reached Ashby\); not retried/);
  assert.match(composeOutcome({status:'composed',draftId:DRAFT,sendSkipped:'Send is switched off.',cleanup:{kept:true}}),/^composed \(not sent: Send is switched off\)/);
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

test('the worker\'s startup line says whether the Ashby check and Send are on, each only when exactly "on"',()=>{
  const {switchesLine}=require('../worker/server');
  assert.equal(switchesLine({BOOKING_COMPOSE:'on'}),'Ashby check on (allowlisted applications only); Send off (BOOKING_SEND isn\'t "on"): nothing is sent');
  assert.equal(switchesLine({BOOKING_COMPOSE:'on',BOOKING_SEND:'on'}),'Ashby check on (allowlisted applications only); Send ON: an approved post that announced Send is sent once, to the send allowlist only');
  assert.match(switchesLine({BOOKING_COMPOSE:'on',BOOKING_SEND:'true'}),/Send off/);
  assert.equal(switchesLine({BOOKING_SEND:'on'}),'Ashby check off; Send on, but inert while the Ashby check is off');
});

test('the cancelled First Round is on neither list; the new one is on both',()=>{
  const {ALLOWED_APPLICATIONS,SEND_ALLOWED}=require('../worker/booking-locks');
  const test=ALLOWED_APPLICATIONS['8dfd8f14-83c4-41f8-aaf1-416b75cb0892'];
  assert.ok(test.interviewScheduleIds.includes('199e1b3d-3f4f-4629-98a5-3ec323fd1206'));for(const old of ['bbf93574-2e4c-4c61-8cd9-4e6f69d7d661','8dc8e6b6-1aa2-4470-8b00-e932459fc499'])assert.ok(!test.interviewScheduleIds.includes(old),old);
  assert.ok(!Object.values(SEND_ALLOWED).flat().includes('8dc8e6b6-1aa2-4470-8b00-e932459fc499'));
  assert.deepEqual(SEND_ALLOWED['8dfd8f14-83c4-41f8-aaf1-416b75cb0892'],['199e1b3d-3f4f-4629-98a5-3ec323fd1206','c95bfecf-9e5c-4d61-8f32-2586d26fa96f','81402bbd-2e50-43bb-afd9-4fa53698c63f','faecb1da-ea68-410e-b57d-b95c13ab2eef']);
});
test('the six-session TEST Onsite c95bfecf may be composed and sent; the old Onsite only composed',()=>{
  const {ALLOWED_APPLICATIONS,SEND_ALLOWED}=require('../worker/booking-locks');
  const app='8dfd8f14-83c4-41f8-aaf1-416b75cb0892';
  assert.ok(ALLOWED_APPLICATIONS[app].interviewScheduleIds.includes('c95bfecf-9e5c-4d61-8f32-2586d26fa96f'));
  assert.ok(SEND_ALLOWED[app].includes('c95bfecf-9e5c-4d61-8f32-2586d26fa96f'));
  assert.ok(!SEND_ALLOWED[app].includes('d98941b3-5900-4ecc-a5cb-c57ed6729702'));
});

test('the October 27 TEST First Round 81402bbd may be composed and sent',()=>{
  const {ALLOWED_APPLICATIONS,SEND_ALLOWED}=require('../worker/booking-locks');
  const app='8dfd8f14-83c4-41f8-aaf1-416b75cb0892';
  assert.ok(ALLOWED_APPLICATIONS[app].interviewScheduleIds.includes('81402bbd-2e50-43bb-afd9-4fa53698c63f'));
  assert.ok(SEND_ALLOWED[app].includes('81402bbd-2e50-43bb-afd9-4fa53698c63f'));
});

test('the October 27 TEST Initial Screen faecb1da may be composed and sent',()=>{
  const {ALLOWED_APPLICATIONS,SEND_ALLOWED}=require('../worker/booking-locks');
  const app='8dfd8f14-83c4-41f8-aaf1-416b75cb0892';
  assert.ok(ALLOWED_APPLICATIONS[app].interviewScheduleIds.includes('faecb1da-ea68-410e-b57d-b95c13ab2eef'));
  assert.ok(SEND_ALLOWED[app].includes('faecb1da-ea68-410e-b57d-b95c13ab2eef'));
});

test('slot states are logged at creation and around a refused or slot-changing save, by ID with approved names (diagnostic only)',()=>{
  const {slotSummary}=require('../worker/booking-permit');
  const {detailLine}=require('../worker/booking-compose');
  const names=new Map([['u-mary','Mary Petrino']]);
  const ev=(selected,alternates)=>[{slots:[{selected,alternates}]}];
  assert.equal(slotSummary(ev('u-hayley',['u-mary','u-hayley']),names),'event 1 slot 1: selected u-hayley; alternates [u-mary (Mary Petrino), u-hayley]');
  assert.equal(slotSummary(ev(null,null),names),'event 1 slot 1: selected -; alternates (none sent)');
  assert.equal(detailLine({type:'draft-slots',at:'created',slots:'event 1 slot 1: selected u-hayley; alternates [u-hayley]'}),'draft slots (created): event 1 slot 1: selected u-hayley; alternates [u-hayley]');
  assert.equal(detailLine({type:'refused-save',seq:1,reason:'A draft save was refused: x.',slots:{before:'B',after:'A'}}),'save 1 REFUSED by the content check: A draft save was refused: x.; slots before: B; after: A');
  assert.equal(detailLine({type:'refused-save',seq:1,reason:'r',slots:{before:'B',after:null}}),'save 1 REFUSED by the content check: r; slots before: B; after: (unreadable)');
  assert.equal(detailLine({type:'save-checked',seq:2,events:['e'],slots:{before:'B',after:'A'}}),'save 2 passed the content check: e; slots before: B; after: A');
  assert.equal(detailLine({type:'save-checked',seq:2,events:['e']}),'save 2 passed the content check: e');
});

test('observing alternates is reachable only from the dry run, never with a kept draft or Send',async()=>{
  const {observeAlternatesArg}=require('../worker/booking-dry-run');
  assert.equal(observeAlternatesArg(['node','x','--plan-base64','e30=']),false);
  assert.equal(observeAlternatesArg(['node','x','--plan-base64','e30=','--observe-alternates']),true);
  const {dryRun}=require('../worker/booking-composer');
  await assert.rejects(dryRun({observeAlternates:true,keepOnSuccess:true}),/dry run only/);
  await assert.rejects(dryRun({observeAlternates:true,send:true}),/dry run only/);
  const src=require('fs').readFileSync(require('path').join(__dirname,'../worker/booking-compose.js'),'utf8');
  assert.doesNotMatch(src,/observeAlternates/,'the Slack-approved check never observes');
  const {detailLine}=require('../worker/booking-compose');
  assert.equal(detailLine({type:'observe',what:'invite preview recipients',candidate:['a@b.c'],interviewers:[['m@l.c']]}),'observe (invite preview recipients): {"candidate":["a@b.c"],"interviewers":[["m@l.c"]]}');
});
