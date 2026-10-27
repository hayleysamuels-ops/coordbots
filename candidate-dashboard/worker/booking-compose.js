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
const {checkPlan,Stop,sendBlocked}=require('./booking-locks');

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

// One line per check in the worker's log: when it starts, and what it did,
// with every draft it made or deleted. IDs, steps and reasons only, never page
// contents. `proposalId` is the dashboard's draft, which names the Slack post.
const ID=/^[0-9a-f-]{36}$/i;
const short=v=>String(v??'').replace(/\s+/g,' ').trim().slice(0,300);
const clause=v=>short(v).replace(/\.$/,'');// a reason inside a line
function composeOutcome(r){
  const made=r.draftId?`draft ${r.draftId} created`:'no draft created';
  const kept=r.send?.attempted?'kept (a send was attempted)':r.cleanup?.kept?'kept for a person to send':r.cleanup?.deleted?'deleted':r.draftId?`NOT deleted (${short(r.cleanup?.reason||'no reason given')}); delete it by hand`:'';
  const replaced=r.superseded?.draftId?`; earlier draft ${r.superseded.draftId} ${r.superseded.deleted?'deleted':'NOT deleted'}`:'';
  const zone=r.displayZone?`; composer zone ${r.displayZone}`:'';
  const writes=r.writes?`; ${r.writes.saves} save${r.writes.saves===1?'':'s'}${r.writes.refusedSaves?`, ${r.writes.refusedSaves} refused`:''}`:'';
  const sendReply=r.send?.reply?`Ashby answered HTTP ${r.send.reply.status}${r.send.reply.accepted?', accepted':`, not accepted${r.send.reply.errors?.length?`: ${r.send.reply.errors.join('; ')}`:''}`}`:r.send?.blockedByGuard?'the write guard blocked it, so it never reached Ashby':'no answer from Ashby';
  const head=r.status==='composed'?`composed${r.sendSkipped?` (not sent: ${clause(r.sendSkipped)})`:''}`:r.status==='sent'?`SENT by clicking Schedule once (${sendReply})`
    :r.status==='send_uncertain'?`SEND UNCERTAIN after clicking Schedule once (${sendReply}); not retried`
    :r.status==='skipped'?`skipped: ${clause(r.reason)}`:`${r.status}${r.step?` at "${short(r.step)}"`:''}: ${clause(r.reason)}`;
  const publish=r.send?.publish?`; invites: ${r.send.publish.reply?`publish answered HTTP ${r.send.publish.reply.status}${r.send.publish.reply.accepted?', accepted':', not accepted'}`:r.send.publish.blockedByGuard?`publish BLOCKED by the guard (variables: ${short(r.send.publish.variables||'none seen')})`:'no publish seen'}`:'';
  const invites=r.invites?`; Ashby shows the invites ${r.invites.state.toUpperCase()}`:'';
  const ce=r.send?.confirmationEmail;
  const email=!ce?'':!ce.expected?'; confirmation email off':`; confirmation email ${ce.reply?.accepted?'SENT (Ashby accepted it)':ce.blockedByGuard?`NOT sent, blocked by the guard (variables: ${short(ce.variables||'none seen')})`:ce.reply?`NOT sent (Ashby answered HTTP ${ce.reply.status})`:'NOT seen being sent'}`;
  return `${head}; ${made}${kept?`, ${kept}`:''}${replaced}${zone}${writes}${publish}${invites}${email}`;
}

// A composer event as a log line, for the ones worth reading afterwards:
// each session's entered times, each save's check and Ashby's answer, and
// the communications screen's controls (as JSON, which is what resolves an
// unrecognised screen). Other events return null.
function detailLine(e){
  const field=f=>f?`${f.value}${f.typed?'':' (already set)'}`:'?';
  switch(e.type){
    case 'typed':return `session ${e.session} ("${short(e.title)}") entered: ${field(e.date)}, ${field(e.start)} – ${field(e.end)} ${e.zone}; approved ${e.approved}`;
    case 'save-checked':return `save ${e.seq} passed the content check: ${e.events.join('; ')}${e.slots?`; slots before: ${e.slots.before}; after: ${e.slots.after}`:''}`;
    case 'refused-save':return `save ${e.seq} REFUSED by the content check: ${short(e.reason)}${e.slots?`; slots before: ${e.slots.before}; after: ${e.slots.after??'(unreadable)'}`:''}`;
    case 'draft-slots':return `draft slots (${e.at}): ${e.slots}`;
    case 'save-result':return `save ${e.seq} ${e.accepted?'accepted by Ashby':`NOT accepted by Ashby (HTTP ${e.status}${e.errors?.length?`: ${e.errors.join('; ')}`:''})`}`;
    case 'screen':{const {type,at,...rest}=e;return rest.note?`screen (${at}): ${rest.note}`:`screen (${at}): ${JSON.stringify(rest)}`;}
    case 'dialog':return `dialog: ${short(e.text)}`;
    case 'send-skipped':return `not sending: ${short(e.reason)}`;
    case 'invites':return `invites on the schedule's page: ${e.state.toUpperCase()} (${(e.evidence||[]).map(short).join(' | ')||'nothing shown'})`;
    case 'draft-mentions':{const {type,...rest}=e;return `no draft read found; the requests that mentioned the draft (structure only): ${JSON.stringify(rest)}`;}
    case 'send':{const {type,...rest}=e;return `send: ${JSON.stringify(rest)}`;}
    case 'agenda-shape':{const {type,...rest}=e;return `candidate invite agenda unreadable, its shape (letters masked): ${JSON.stringify(rest)}`;}
    case 'send-recipients':return e.allowed?'send recipients: all on the send allowlist':`send recipients: outside the send allowlist: ${e.outside.join(', ')} (reported only; nothing is sent)`;
    default:return null;
  }
}

async function compose({env,payload,chromium,loadSession,clientId,expectedIdentity,now=Date.now(),log=()=>{},say=console.log,composer=require('./booking-composer')}){
  const plan=payload?.plan,supersedeDraftId=payload?.supersedeDraftId??null;
  const tag=`[booking] Ashby check${ID.test(String(payload?.proposalId||''))?` for ${payload.proposalId}`:''}`;
  say(`${tag} started: application ${short(plan?.applicationId)}, schedule ${short(plan?.interviewScheduleId)}, ${plan?.sessions?.length??0} session(s), plan zone ${short(plan?.timeZone)}${supersedeDraftId?`, replacing draft ${short(supersedeDraftId)}`:''}`);
  // Draft IDs as they're learned, so a deadline can still name the draft.
  // The steps worth reading afterwards are logged as they happen.
  let draftId=null;
  const note=e=>{if(e.draftId)draftId=e.draftId;log(e);const line=detailLine(e);if(line)say(`${tag} ${line}`);};
  try{
    if(supersedeDraftId!==null&&!ID.test(String(supersedeDraftId)))throw Object.assign(Error('The earlier draft reference isn\'t a draft ID.'),{status:422});
    const ready=await prepare({env,plan,loadSession,clientId,expectedIdentity,now});
    if(ready.skip){say(`${tag} ${composeOutcome(ready.skip)}`);return ready.skip;}
    // Send only when the approved post announced it (plan.send, covered by the
    // approval's digest) and every lock is open now (booking-locks.js).
    const sendReason=plan.send!==true?null:sendBlocked(plan,env);
    const send=plan.send===true&&!sendReason;
    if(plan.send===true)say(`${tag} ${send?'send: every lock is open; Schedule will be clicked once':`send announced but not happening: ${short(sendReason)}`}`);
    const isolation=env.ASHBY_BROWSER_ISOLATION||'sandbox';
    if(!['sandbox','container'].includes(isolation))throw Object.assign(Error('Unknown browser isolation configuration.'),{status:503});
    const result=await withBrowser({chromium,saved:ready.saved,isolation},({context,page})=>
      composer.dryRun({context,page,plan,log:note,expectedIdentity,checkExistingDrafts:true,supersedeDraftId,keepOnSuccess:true,send}));
    say(`${tag} ${composeOutcome(result)}`);
    return result;
  }catch(e){
    if(e.deadline){
      const result={mode:'compose',status:'uncertain',reason:e.message,draftId,cleanup:{deleted:false,reason:'the check was stopped before it could delete its draft'}};
      say(`${tag} ${composeOutcome(result)}`);
      return result;
    }
    say(`${tag} didn't run to a result: ${clause(e.message)}${draftId?`; draft ${draftId} was created and may still be in Ashby`:'; no draft created'}`);
    throw e;
  }
}

// What Ashby's schedule page shows for a booked schedule's invites, for the
// dashboard (booking-composer.js readInviteStatus). Read-only; allowed after
// the interview has passed, like a delete.
async function inviteStatus({env,payload,chromium,loadSession,clientId,expectedIdentity,log=()=>{},say=console.log,composer=require('./booking-composer')}){
  const plan=payload?.plan;
  const tag=`[booking] Invite status${ID.test(String(payload?.proposalId||''))?` for ${payload.proposalId}`:''}`;
  const ready=await prepare({env,plan,loadSession,clientId,expectedIdentity,now:0});
  if(ready.skip){say(`${tag}: not read (${clause(ready.skip.reason)})`);return ready.skip;}
  const isolation=env.ASHBY_BROWSER_ISOLATION||'sandbox';
  try{
    const r=await withBrowser({chromium,saved:ready.saved,isolation},({context,page})=>composer.readInviteStatus({context,page,plan,log,expectedIdentity}));
    say(`${tag}: ${r.state.toUpperCase()} (${(r.evidence||[]).map(short).join(' | ')||'nothing shown'})`);
    return {status:'read',invites:r};
  }catch(e){
    say(`${tag}: not read (${clause(e.message)})`);
    if(e.deadline)return {status:'read',invites:{state:'unknown',evidence:[e.message]}};
    throw e;
  }
}

// Whether an option would be sent if approved, for the dashboard at posting
// (it marks the plan `send: true` and words the Slack button). Read-only: no
// session, no browser. The plan must pass the compose locks too.
function sendStatus({env,payload,expectedIdentity}){
  const plan=payload?.plan;
  if(env.BOOKING_COMPOSE!=='on')return {sendOn:false,reason:'The Ashby check is switched off on the scheduling worker (BOOKING_COMPOSE).'};
  try{checkPlan(plan);}catch(e){if(e instanceof Stop)return {sendOn:false,reason:e.message};throw e;}
  const reason=sendBlocked(plan,env);
  return reason?{sendOn:false,reason}:{sendOn:true,as:expectedIdentity};
}

async function discard({env,payload,chromium,loadSession,clientId,expectedIdentity,now=Date.now(),log=()=>{},say=console.log,composer=require('./booking-composer')}){
  const plan=payload?.plan,draftId=payload?.draftId;
  const tag=`[booking] Unsent draft ${short(draftId)}${ID.test(String(payload?.proposalId||''))?` for ${payload.proposalId}`:''}`;
  const done=r=>{say(`${tag}: ${r.status==='skipped'?`not deleted, skipped: ${short(r.reason)}`:r.deleted?'deleted':r.absent?'already gone from Ashby':`NOT deleted (${short(r.reason||'no reason given')})`}`);return r;};
  say(`${tag}: deleting (schedule ${short(plan?.interviewScheduleId)})`);
  try{
    if(!ID.test(String(draftId||'')))throw Object.assign(Error('The draft reference isn\'t a draft ID.'),{status:422});
    // Deleting is allowed after the interview has passed, so the plan's times
    // aren't checked against now; everything else about it is.
    const ready=await prepare({env,plan,loadSession,clientId,expectedIdentity,now:0});
    if(ready.skip)return done(ready.skip);
    const isolation=env.ASHBY_BROWSER_ISOLATION||'sandbox';
    return done(await withBrowser({chromium,saved:ready.saved,isolation},({context,page})=>composer.discardDraft({context,page,plan,draftId,log,expectedIdentity})));
  }catch(e){
    if(e.deadline)return done({deleted:false,draftId,reason:e.message});
    say(`${tag}: NOT deleted (${short(e.message)})`);
    throw e;
  }
}

module.exports={compose,discard,inviteStatus,sendStatus,composeOutcome,detailLine,DEADLINE_MS};
