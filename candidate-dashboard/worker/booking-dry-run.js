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
//   railway ssh -s scheduling-worker -- node worker/booking-dry-run.js --plan-base64 <plan> [--observe-alternates]
//
// <plan> is the approved agenda as base64 JSON (worker/booking-check.js has
// its shape; src/scheduling/booking-plan.js builds it from a preview option).
// Base64 so the plan survives the remote shell's quoting.
//
// Two locks, both checked before the session is read or a browser starts:
//   - BOOKING_DRY_RUN must be "on" in the worker's variables. It is unset by
//     default; set it for a test window and remove it afterwards.
//   - The plan's job and stage must be on the worker's BOOKING_COMPOSE_JOBS
//     (booking-locks.js).
//
// The run has a deadline: past it, the command exits 124 and says the draft
// may not have been deleted.
const DEADLINE_SECONDS=240;
const {checkPlan,Stop,stop}=require('./booking-locks');

function checkFlag(env){
  if(env.BOOKING_DRY_RUN!=='on')stop('The booking dry run is off. Set BOOKING_DRY_RUN=on on the scheduling worker for the test window.');
}

function readPlanArg(argv){
  const i=argv.indexOf('--plan-base64');
  if(i<0||!argv[i+1])stop('Usage: node worker/booking-dry-run.js --plan-base64 <base64 JSON plan>');
  if(argv[i+1].length>64*1024)stop('The plan is too large.');
  try{return JSON.parse(Buffer.from(argv[i+1],'base64').toString('utf8'));}
  catch(_){stop('The plan isn\'t base64-encoded JSON.');}
}

// --observe-alternates: let a slot's alternates narrow, and log what Ashby does
// with them (booking-composer.js). Dry run only; the draft is still deleted.
const observeAlternatesArg=argv=>argv.includes('--observe-alternates');

// Everything the run depends on is passed in, so the locks can be tested
// without a session or a browser. Returns the composer's report.
async function run({env,argv,chromium,loadSession,now=Date.now,log=()=>{},composer=require('./booking-composer')}){
  checkFlag(env);
  const plan=checkPlan(readPlanArg(argv),{now:now(),env});
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
    return await composer.dryRun({context,page,plan,log,expectedIdentity,observeAlternates:observeAlternatesArg(argv)});
  }finally{await browser.close().catch(()=>{});}
}

if(require.main===module){
  let draftId=null;
  setTimeout(()=>{
    console.error(`[booking-dry-run] timed out after ${DEADLINE_SECONDS}s. The draft ${draftId?draftId+' ':''}may not have been deleted: check the schedule's Drafts page (left sidebar, under SCHEDULES).`);
    process.exit(124);
  },DEADLINE_SECONDS*1000).unref();
  // A shell in the container is root. Run as the worker's own user, as
  // bootstrap.js does, before reading the session or starting Chrome.
  if(process.getuid&&process.getuid()===0){process.setgroups([]);process.setgid(1000);process.setuid(1000);}
  // Progress without page contents: step outcomes, permitted writes, checks.
  const log=e=>{if(e.draftId)draftId=e.draftId;if(['permitted','response','refused-save','save-checked','draft-slots','observe','uncertain','check','dialog'].includes(e.type))console.error('[booking-dry-run]',JSON.stringify(e));};
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

module.exports={run,checkFlag,checkPlan,readPlanArg,observeAlternatesArg,Stop};
