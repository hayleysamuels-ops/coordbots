'use strict';
// The booking dry run as a worker command (worker/booking-dry-run.js): its two
// locks (the BOOKING_DRY_RUN variable and the application allowlist) must stop
// a run before the saved session is read or a browser starts.
//
// What may reach the booking robot: the dry run's command, and the worker's
// booking routes for the Slack-approved check (worker/booking-compose.js),
// which load nothing else of it. Nothing the dashboard runs may load it, and
// Send is permitted in one place only: the composer's single permit, armed
// once after the re-read, for exactly one Schedule click.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),path=require('path');
const {run,Stop}=require('../worker/booking-dry-run');

const root=path.join(__dirname,'..');
// A require or import of the robot's modules (mentions in comments are fine).
const LOADS_ROBOT=/\b(?:require|import)\s*\(\s*[^)]*booking-(?:composer|permit|dry-run|compose|locks)\b/;
const loadsRobot=file=>LOADS_ROBOT.test(fs.readFileSync(file,'utf8'));
const robotLoads=file=>[...fs.readFileSync(file,'utf8').matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]*booking-(?:composer|permit|dry-run|compose|locks)[^'"]*)['"]/g)].map(m=>m[1]);

test('only the worker\'s booking routes reach the robot, through the Slack-approved check; the dashboard never does',()=>{
  // The worker's own modules, other than the robot itself.
  const worker=fs.readdirSync(path.join(root,'worker')).filter(f=>f.endsWith('.js')&&!/^booking-(composer|permit|check|dry-run|compose|locks)\.js$/.test(f));
  assert.ok(worker.includes('server.js')&&worker.includes('booking-routes.js')&&worker.includes('bootstrap.js'));
  for(const f of worker){
    const loads=robotLoads(path.join(root,'worker',f));
    if(f==='booking-routes.js')assert.deepEqual([...new Set(loads)],['./booking-compose'],'the booking routes load only the Slack-approved check (compose, its delete, and the read-only send status)');
    else assert.ok(!loadsRobot(path.join(root,'worker',f)),`worker/${f} must not load the booking robot`);
  }
  // The check loads the composer and the locks, never the dry run's command.
  assert.deepEqual([...new Set(robotLoads(path.join(root,'worker/booking-compose.js')))].sort(),['./booking-composer','./booking-locks']);
  // The dashboard and its Slack handlers.
  const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):e.name.endsWith('.js')?[path.join(dir,e.name)]:[]);
  for(const f of walk(path.join(root,'src')))assert.ok(!loadsRobot(f),`${path.relative(root,f)} must not load the booking robot`);
  // The tripwire itself trips on a load.
  assert.ok(LOADS_ROBOT.test("const x=require('./booking-composer')")&&LOADS_ROBOT.test('require("../worker/booking-dry-run.js")')&&LOADS_ROBOT.test("require('./booking-compose')")&&!LOADS_ROBOT.test('// see booking-composer.js'));
  // The image still starts the HTTP worker, never the command.
  assert.match(fs.readFileSync(path.join(root,'worker/Dockerfile'),'utf8'),/CMD \["node", "worker\/bootstrap\.js"\]/);
});

test('Send is one permit, in the composer only, armed once after the re-read, for exactly one Schedule click',()=>{
  const read=f=>fs.readFileSync(path.join(root,'worker',f),'utf8');
  // No other worker file permits Send, by constant or by name.
  for(const f of fs.readdirSync(path.join(root,'worker')).filter(f=>f.endsWith('.js')&&f!=='booking-composer.js')){
    const src=read(f);
    assert.doesNotMatch(src,/op\s*:\s*OP\.send\b/,`worker/${f} must not permit Send`);
    assert.doesNotMatch(src,/op\s*:\s*['"]ApiScheduleInterviewScheduleFromDraft['"]/,`worker/${f} must not permit Send`);
  }
  const composer=read('booking-composer.js');
  // Exactly one Send permit: installed only when `send` is set (and only in
  // the Slack-approved check), at most once, and usable only while armed and
  // for this schedule and this run's draft. (`wouldSend={op:OP.send,...}` only
  // names it in the report.)
  const permits=composer.match(/(?<!wouldSend=\{)op\s*:\s*OP\.send\b/g)||[];
  assert.equal(permits.length,1,'one Send permit');
  assert.match(composer,/if\(send&&keepOnSuccess\)await installPermit\(context,\{op:OP\.send,max:1,/);
  assert.match(composer,/if\(!sending\.armed\)return false;\s*if\(v\.interviewScheduleId===plan\.interviewScheduleId&&v\.draftInterviewScheduleId===state\.draftId\)return true;/);
  assert.doesNotMatch(composer,/ApiScheduleInterviewScheduleFromDraft['"]\s*[,}]/,'never by name');
  // Armed exactly once, after the re-read passed and in the send branch, right
  // before the one Schedule click; disarmed after.
  assert.equal((composer.match(/sending\.armed=true/g)||[]).length,1,'armed in one place');
  const reread=composer.indexOf("step='re-read the draft';"),passReread=composer.indexOf('just before Schedule, and it equals the approval exactly'),
    branch=composer.indexOf("step='send';"),arm=composer.indexOf('sending.armed=true'),click=composer.indexOf('schedule.click()');
  assert.ok(reread>0&&reread<passReread&&passReread<branch&&branch<arm&&arm<click,'re-read, then the send branch, then arm, then click');
  assert.match(composer.slice(composer.indexOf('const notSending='),branch),/plan\.send!==true\?'The approved post didn\\'t say it would send\.':sendBlocked\(plan,\{BOOKING_SEND:'on'\}\)/,'every lock is checked again in the composer');
  // One click on Schedule, ever; nothing after it is clicked, answered or retried.
  assert.equal((composer.match(/schedule\.click\(/g)||[]).length,1,'exactly one click on Schedule');
  assert.doesNotMatch(composer,/schedule\.(?:press|tap|dispatchEvent|dblclick)\(/);
  const after=composer.slice(click,composer.indexOf("report.status=report.send.reply?.accepted?'sent':'send_uncertain';"));
  assert.ok(after.length>0);
  assert.equal((after.match(/\.click\(/g)||[]).length,1,'nothing else is clicked after Schedule');
  assert.doesNotMatch(after,/refuse\(|Confirm|Submit|keyboard\.press/,'nothing after the click is refused, confirmed or pressed');
  // A send attempt keeps the draft.
  assert.match(composer,/report\.send\?\.attempted\?\{deleted:false,kept:true,draftId:state\.draftId,reason:'a send was attempted'\}/);
});

// The First Round plan that passed locally on October 13, moved into the future.
const plan={jobId:'837cc1e9-15ed-4f07-8755-51ee29f4ea39',candidateId:'fc88f24e-d59b-4e58-aa51-f0e94b1a32da',applicationId:'8dfd8f14-83c4-41f8-aaf1-416b75cb0892',
  interviewScheduleId:'18599066-1d55-493a-8c2f-1e970b04f86c',timeZone:'America/Denver',candidate:{name:'TEST',email:'hayleysamuels511@gmail.com'},
  job:{title:'TEST'},stage:{title:'First Round'},activityTitle:'First Round Interview Schedule',
  sessions:[{title:'First Round',interviewId:'8b357d3b-5bff-41a6-896f-94da41ddd08c',start:'2099-10-15T19:00:00.000Z',end:'2099-10-15T19:30:00.000Z',
      interviewers:[{userId:'c251f667-e04c-403a-8c70-4cbc8fc3f435',name:'Hayley Samuels',email:'hayley@luminai.com'}]},
    {title:'First Round',interviewId:'2edf27b9-b916-4264-9219-28f3ba29b2e4',start:'2099-10-15T19:30:00.000Z',end:'2099-10-15T20:00:00.000Z',
      interviewers:[{userId:'4a8a726c-adce-4653-8874-3828c8f4e4a2',name:'Mary Petrino',email:'mary@luminai.com'}]}]};
const argv=p=>['node','worker/booking-dry-run.js','--plan-base64',Buffer.from(JSON.stringify(p)).toString('base64')];
const env={BOOKING_DRY_RUN:'on',SCHEDULING_CLIENT_ID:'luminai',ASHBY_EXPECTED_IDENTITY:'Anna Example',ASHBY_BROWSER_ISOLATION:'container'};
const session={clientId:'luminai',expectedIdentity:'Anna Example',storageState:{cookies:[],origins:[]}};

// A browser and composer that record what happened; nothing is launched for real.
function fakes(){
  const seen={launched:null,sessionReads:0,routes:0,timeout:null,closed:false,composer:null};
  const context={setDefaultTimeout:ms=>{seen.timeout=ms;},route:async()=>{seen.routes++;},newPage:async()=>({})};
  const chromium={launch:async o=>{seen.launched=o;return {newContext:async()=>context,close:async()=>{seen.closed=true;}};}};
  const composer={dryRun:async o=>{seen.composer=o;return {status:'dry_run_complete'};}};
  const loadSession=()=>{seen.sessionReads++;return session;};
  return {seen,deps:{chromium,composer,loadSession}};
}
const refused=async(promise,pattern)=>assert.rejects(promise,e=>e instanceof Stop&&pattern.test(e.message));

test('off unless BOOKING_DRY_RUN is exactly "on": no session read, no browser',async()=>{
  for(const value of [undefined,'','true','1','ON','on ']){
    const {seen,deps}=fakes();
    await refused(run({env:{...env,BOOKING_DRY_RUN:value},argv:argv(plan),...deps}),/booking dry run is off/);
    assert.equal(seen.sessionReads,0);assert.equal(seen.launched,null);
  }
});

test('only the allowlisted application, with its own job, candidate, email and schedules',async()=>{
  const cases=[
    [{...plan,applicationId:'00000000-0000-4000-8000-000000000000'},/isn't one the booking robot may use/],
    [{...plan,jobId:'00000000-0000-4000-8000-000000000000'},/job, candidate or candidate email doesn't match/],
    [{...plan,candidateId:'00000000-0000-4000-8000-000000000000'},/job, candidate or candidate email doesn't match/],
    [{...plan,candidate:{name:'TEST',email:'someone@example.com'}},/job, candidate or candidate email doesn't match/],
    [{...plan,interviewScheduleId:'00000000-0000-4000-8000-000000000000'},/scheduling activity isn't one of its application's/],
  ];
  for(const [p,pattern] of cases){
    const {seen,deps}=fakes();
    await refused(run({env,argv:argv(p),...deps}),pattern);
    assert.equal(seen.sessionReads,0);assert.equal(seen.launched,null);
  }
});

test('incomplete, past or soon plans are refused',async()=>{
  const soon=structuredClone(plan);soon.sessions[0].start=new Date(Date.now()+5*60000).toISOString();soon.sessions[0].end=new Date(Date.now()+35*60000).toISOString();
  const overlap=structuredClone(plan);overlap.sessions[1].start='2099-10-15T19:15:00.000Z';
  const noOne=structuredClone(plan);noOne.sessions[1].interviewers=[];
  for(const [a,pattern] of [[argv(soon),/Session 1 starts less than 15 minutes from now/],[argv(overlap),/Sessions 1 and 2 overlap/],
    [argv(noOne),/Session 2 has no fully identified interviewers/],[argv({...plan,timeZone:'MST'}),/IANA zone/],
    [['node','x','--plan-base64','not json'],/isn't base64-encoded JSON/],[['node','x'],/Usage/]]){
    const {seen,deps}=fakes();
    await refused(run({env,argv:a,...deps}),pattern);assert.equal(seen.launched,null);
  }
});

test('a saved session for another client or account is refused before a browser starts',async()=>{
  for(const saved of [null,{...session,clientId:'other'},{...session,expectedIdentity:'Someone Else'},{...session,storageState:null}]){
    const {seen,deps}=fakes();
    await refused(run({env,argv:argv(plan),...deps,loadSession:()=>saved}),/No saved Ashby session for Anna Example/);
    assert.equal(seen.launched,null);
  }
});

test('with both locks open: the worker\'s isolation, the saved session, the expected account, and the browser closed',async()=>{
  const {seen,deps}=fakes();
  const report=await run({env,argv:argv(plan),...deps});
  assert.equal(report.status,'dry_run_complete');
  assert.deepEqual(seen.launched,{headless:true,chromiumSandbox:false});
  assert.equal(seen.sessionReads,1);assert.equal(seen.routes,1);assert.equal(seen.timeout,30000);
  assert.equal(seen.composer.expectedIdentity,'Anna Example');assert.deepEqual(seen.composer.plan,plan);
  assert.equal(seen.closed,true);
});

test('the Calendar Invites settings are read only once Ashby has finished loading the screen',()=>{
  const composer=fs.readFileSync(path.join(root,'worker','booking-composer.js'),'utf8');
  const step=composer.indexOf("step='configure communications';"),mark=composer.indexOf('net.mark();',step),click=composer.indexOf('"Configure Communications"',step),
    settled=composer.indexOf('if(!await net.settled())refuse(',step),read=composer.indexOf('settings=await readInviteSettings(page)',step);
  assert.ok(step>0&&step<mark&&mark<click&&click<settled&&settled<read,'mark, click, settle (or refuse), then read');
  assert.match(composer.slice(settled,read),/Ashby didn't finish loading the Calendar Invites screen/);
});
