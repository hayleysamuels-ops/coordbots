'use strict';
// The booking dry run (booking-composer.js) inside the scheduling worker, with
// the saved Ashby session: every step up to "Schedule", which is never
// clicked, then the draft is deleted. Nothing is sent: Send isn't a permitted
// write (booking-permit.js).
//
// A command, not a route. Nothing in the worker's HTTP server loads this file
// (test/booking-dry-run-worker.test.js enforces that), so neither the
// dashboard nor Slack can reach it. It runs only from a shell in the worker
// container:
//
//   railway ssh -s scheduling-worker -- node worker/booking-dry-run.js --plan-base64 <plan>
//
// <plan> is the approved agenda as base64 JSON (worker/booking-check.js has
// its shape; src/scheduling/booking-plan.js builds it from a preview option).
// Base64 so the plan survives the remote shell's quoting.
//
// Two locks, both checked before the session is read or a browser starts:
//   - BOOKING_DRY_RUN must be "on" in the worker's variables. It is unset by
//     default; set it for a test window and remove it afterwards.
//   - The plan must be for an application listed below, with that
//     application's job, candidate, email and schedules. Adding one takes a
//     commit.
//
// The run has a deadline: past it, the command exits 124 and says the draft
// may not have been deleted.
const DEADLINE_SECONDS=240;
const NOTICE_MINUTES=15;

// The TEST candidate on the TEST job: its Initial Screen and First Round
// scheduling activities.
const ALLOWED_APPLICATIONS={
  '8dfd8f14-83c4-41f8-aaf1-416b75cb0892':{
    jobId:'837cc1e9-15ed-4f07-8755-51ee29f4ea39',
    candidateId:'fc88f24e-d59b-4e58-aa51-f0e94b1a32da',
    candidateEmail:'hayleysamuels511@gmail.com',
    interviewScheduleIds:['69ffae5a-240c-4d06-8b45-f9826dbf5623','18599066-1d55-493a-8c2f-1e970b04f86c'],
  },
};

class Stop extends Error{constructor(message,code=2){super(message);this.code=code;}}
const stop=(message,code)=>{throw new Stop(message,code);};
const isUuid=v=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const isText=v=>typeof v==='string'&&v.trim().length>0;
const isInstant=v=>typeof v==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v));

function checkFlag(env){
  if(env.BOOKING_DRY_RUN!=='on')stop('The booking dry run is off. Set BOOKING_DRY_RUN=on on the scheduling worker for the test window.');
}

// The plan must be complete, for an allowed application, and in the future.
function checkPlan(plan,{now=Date.now()}={}){
  if(!plan||typeof plan!=='object'||Array.isArray(plan))stop('The plan isn\'t a JSON object.');
  const allowed=ALLOWED_APPLICATIONS[plan.applicationId];
  if(!allowed)stop(`Application ${String(plan.applicationId).slice(0,40)} isn't one the dry run may use.`);
  if(plan.jobId!==allowed.jobId||plan.candidateId!==allowed.candidateId||String(plan.candidate?.email||'').toLowerCase()!==allowed.candidateEmail)
    stop('The plan\'s job, candidate or candidate email doesn\'t match its application.');
  if(!allowed.interviewScheduleIds.includes(plan.interviewScheduleId))stop('The plan\'s scheduling activity isn\'t one of its application\'s.');
  for(const [what,v] of [['candidate name',plan.candidate?.name],['job title',plan.job?.title],['stage title',plan.stage?.title],['scheduling activity',plan.activityTitle]])
    if(!isText(v))stop(`The plan has no ${what}.`);
  try{new Intl.DateTimeFormat('en-US',{timeZone:plan.timeZone});}catch(_){stop('The plan\'s time zone isn\'t a valid IANA zone.');}
  if(typeof plan.timeZone!=='string'||!plan.timeZone.includes('/'))stop('The plan\'s time zone must be an IANA zone such as America/Denver.');
  if(!Array.isArray(plan.sessions)||!plan.sessions.length)stop('The plan has no sessions.');
  plan.sessions.forEach((s,i)=>{
    const label=`Session ${i+1}`;
    if(!isText(s?.title)||!isUuid(s.interviewId))stop(`${label} has no interview.`);
    if(!isInstant(s.start)||!isInstant(s.end)||Date.parse(s.end)<=Date.parse(s.start))stop(`${label} doesn't have exact start and end times.`);
    if(Date.parse(s.start)<now+NOTICE_MINUTES*60000)stop(`${label} starts less than ${NOTICE_MINUTES} minutes from now.`);
    if(i&&Date.parse(s.start)<Date.parse(plan.sessions[i-1].end))stop(`Sessions ${i} and ${i+1} overlap.`);
    if(!Array.isArray(s.interviewers)||!s.interviewers.length||!s.interviewers.every(x=>isUuid(x?.userId)&&isText(x.name)&&/^\S+@\S+\.\S+$/.test(x.email||'')))
      stop(`${label} has no fully identified interviewers.`);
  });
  return plan;
}

function readPlanArg(argv){
  const i=argv.indexOf('--plan-base64');
  if(i<0||!argv[i+1])stop('Usage: node worker/booking-dry-run.js --plan-base64 <base64 JSON plan>');
  if(argv[i+1].length>64*1024)stop('The plan is too large.');
  try{return JSON.parse(Buffer.from(argv[i+1],'base64').toString('utf8'));}
  catch(_){stop('The plan isn\'t base64-encoded JSON.');}
}

// Everything the run depends on is passed in, so the locks can be tested
// without a session or a browser. Returns the composer's report.
async function run({env,argv,chromium,loadSession,now=Date.now,log=()=>{},composer=require('./booking-composer')}){
  checkFlag(env);
  const plan=checkPlan(readPlanArg(argv),{now:now()});
  const clientId=env.SCHEDULING_CLIENT_ID,expectedIdentity=env.ASHBY_EXPECTED_IDENTITY;
  if(!clientId||!expectedIdentity)stop('The worker has no client or expected Ashby identity configured.');
  const saved=loadSession();
  if(!saved||saved.clientId!==clientId||saved.expectedIdentity!==expectedIdentity||!saved.storageState)
    stop(`No saved Ashby session for ${expectedIdentity}. Reconnect Ashby on the connection page first.`);
  const isolation=env.ASHBY_BROWSER_ISOLATION||'sandbox';
  if(!['sandbox','container'].includes(isolation))stop('Unknown browser isolation configuration.');
  const browser=await chromium.launch({headless:true,chromiumSandbox:isolation==='sandbox'});
  try{
    const context=await browser.newContext({storageState:saved.storageState,acceptDownloads:false,serviceWorkers:'block',viewport:{width:1400,height:950}});
    // No browser call waits longer than this; the composer bounds its own waits.
    context.setDefaultTimeout(30000);
    // Navigation stays on Ashby. Registered first, so the write guard and the
    // permits (registered by the composer) run before it.
    await context.route('**/*',route=>{
      if(route.request().isNavigationRequest()){
        try{if(new URL(route.request().url()).origin!=='https://app.ashbyhq.com')return route.abort();}catch(_){return route.abort();}
      }
      return route.continue();
    });
    const page=await context.newPage();
    return await composer.dryRun({context,page,plan,log,expectedIdentity});
  }finally{await browser.close().catch(()=>{});}
}

if(require.main===module){
  let draftId=null;
  setTimeout(()=>{
    console.error(`[booking-dry-run] timed out after ${DEADLINE_SECONDS}s. The draft ${draftId?draftId+' ':''}may not have been deleted: check the schedule's Drafts tab.`);
    process.exit(124);
  },DEADLINE_SECONDS*1000).unref();
  // A shell in the container is root. Run as the worker's own user, as
  // bootstrap.js does, before reading the session or starting Chrome.
  if(process.getuid&&process.getuid()===0){process.setgroups([]);process.setgid(1000);process.setuid(1000);}
  // Progress without page contents: step outcomes, permitted writes, checks.
  const log=e=>{if(e.draftId)draftId=e.draftId;if(['permitted','response','refused-save','uncertain','check','dialog'].includes(e.type))console.error('[booking-dry-run]',JSON.stringify(e));};
  (async()=>{
    // Loaded only here, so the locks above are checked without them in tests.
    const {chromium}=require('playwright');
    const {createVault}=require('./session-vault');
    const env=process.env;
    const report=await run({env,argv:process.argv,chromium,log,
      loadSession:()=>{if(!env.ASHBY_SESSION_FILE)stop('The worker has no session volume configured.');return createVault(env.ASHBY_SESSION_FILE,env.ASHBY_SESSION_KEY).load();}});
    console.log(JSON.stringify(report,null,2));
    process.exit(report.status==='dry_run_complete'&&report.cleanup?.deleted?0:1);
  })().catch(e=>{console.error('[booking-dry-run]',e instanceof Stop?e.message:'failed: '+e.message);process.exit(e instanceof Stop?e.code:1);});
}

module.exports={run,checkFlag,checkPlan,readPlanArg,ALLOWED_APPLICATIONS,Stop};
