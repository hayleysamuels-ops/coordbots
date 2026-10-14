'use strict';
// The Slack-approved check: the booking composer (booking-composer.js) run in
// the worker for an approved schedule, from the dashboard's signed `compose`
// request (booking-routes.js). It composes the schedule as the saved Ashby
// account and stops at "Schedule", which is never clicked: Send isn't a
// permitted write (booking-permit.js). On success the draft is left in Ashby
// for a person to open and send; any refusal deletes it.
//
// `discard` deletes a draft a check left, for the dashboard's sweep.
//
// Locks, checked before the session is read or a browser starts:
//   - BOOKING_COMPOSE must be "on" in the worker's variables (the off switch);
//   - the plan must be for an application in booking-locks.js.
// When either is shut, the result is `skipped` with the reason: the
// coordinator books by hand, as before the check existed.
const {checkPlan,Stop}=require('./booking-locks');

const DEADLINE_MS=240000;

function skipped(reason){return {status:'skipped',reason};}

// Everything the run depends on is passed in, so the locks can be tested
// without a session or a browser.
async function prepare({env,plan,loadSession,clientId,expectedIdentity,now}){
  if(env.BOOKING_COMPOSE!=='on')return {skip:skipped('The Ashby check is switched off on the scheduling worker (BOOKING_COMPOSE).')};
  try{checkPlan(plan,{now});}
  catch(e){if(e instanceof Stop)return {skip:skipped(e.message)};throw e;}
  const saved=loadSession();
  if(!saved||saved.clientId!==clientId||saved.expectedIdentity!==expectedIdentity||!saved.storageState)
    throw Object.assign(Error(`No saved Ashby session for ${expectedIdentity}. Reconnect Ashby on the connection page.`),{status:409});
  return {saved};
}

// One browser for one task, closed afterwards. Navigation stays on Ashby; the
// composer registers the write guard and its permits after this route, so
// they run before it. Past the deadline the browser is closed, which stops
// the task wherever it is; the caller reports that as uncertain.
async function withBrowser({chromium,saved,isolation},task){
  const browser=await chromium.launch({headless:true,chromiumSandbox:isolation==='sandbox'});
  let timer;
  try{
    const context=await browser.newContext({storageState:saved.storageState,acceptDownloads:false,serviceWorkers:'block',viewport:{width:1400,height:950}});
    context.setDefaultTimeout(30000);
    await context.route('**/*',route=>{
      if(route.request().isNavigationRequest()){
        try{if(new URL(route.request().url()).origin!=='https://app.ashbyhq.com')return route.abort();}catch(_){return route.abort();}
      }
      return route.continue();
    });
    const page=await context.newPage();
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{browser.close().catch(()=>{});reject(Object.assign(Error('The Ashby check ran past its deadline and was stopped.'),{deadline:true}));},DEADLINE_MS);});
    return await Promise.race([task({context,page}),deadline]);
  }finally{clearTimeout(timer);await browser.close().catch(()=>{});}
}

async function compose({env,payload,chromium,loadSession,clientId,expectedIdentity,now=Date.now(),log=()=>{},composer=require('./booking-composer')}){
  const plan=payload?.plan,supersedeDraftId=payload?.supersedeDraftId??null;
  if(supersedeDraftId!==null&&!/^[0-9a-f-]{36}$/i.test(String(supersedeDraftId)))throw Object.assign(Error('The earlier draft reference isn\'t a draft ID.'),{status:422});
  const ready=await prepare({env,plan,loadSession,clientId,expectedIdentity,now});
  if(ready.skip)return ready.skip;
  const isolation=env.ASHBY_BROWSER_ISOLATION||'sandbox';
  if(!['sandbox','container'].includes(isolation))throw Object.assign(Error('Unknown browser isolation configuration.'),{status:503});
  // Draft IDs as they're learned, so a deadline can still name the draft.
  let draftId=null;
  const note=e=>{if(e.draftId)draftId=e.draftId;log(e);};
  try{
    return await withBrowser({chromium,saved:ready.saved,isolation},({context,page})=>
      composer.dryRun({context,page,plan,log:note,expectedIdentity,checkExistingDrafts:true,supersedeDraftId,keepOnSuccess:true}));
  }catch(e){
    if(e.deadline)return {mode:'compose',status:'uncertain',reason:e.message,draftId,cleanup:{deleted:false,reason:'the check was stopped before it could delete its draft'}};
    throw e;
  }
}

async function discard({env,payload,chromium,loadSession,clientId,expectedIdentity,now=Date.now(),log=()=>{},composer=require('./booking-composer')}){
  const plan=payload?.plan,draftId=payload?.draftId;
  if(!/^[0-9a-f-]{36}$/i.test(String(draftId||'')))throw Object.assign(Error('The draft reference isn\'t a draft ID.'),{status:422});
  // Deleting is allowed after the interview has passed, so the plan's times
  // aren't checked against now; everything else about it is.
  const ready=await prepare({env,plan,loadSession,clientId,expectedIdentity,now:0});
  if(ready.skip)return ready.skip;
  const isolation=env.ASHBY_BROWSER_ISOLATION||'sandbox';
  try{
    return await withBrowser({chromium,saved:ready.saved,isolation},({context,page})=>composer.discardDraft({context,page,plan,draftId,log,expectedIdentity}));
  }catch(e){
    if(e.deadline)return {deleted:false,draftId,reason:e.message};
    throw e;
  }
}

module.exports={compose,discard,DEADLINE_MS};
