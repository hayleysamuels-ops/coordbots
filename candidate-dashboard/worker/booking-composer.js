'use strict';
// Booking through Ashby's scheduling UI. The dry run (booking-dry-run.js)
// composes up to Schedule, never clicks it, and deletes the draft. The
// Slack-approved check (booking-compose.js) leaves the composed draft for a
// person to send and deletes it on any refusal; or, only where every Send lock
// is open and the post announced it (`send`), it clicks Schedule once itself.
// On this layout that click is the send (seen October 20: it fires
// ApiScheduleInterviewScheduleFromDraft with no dialog or menu), so Send is a
// single permit, armed just before that click, after a fresh re-read of the
// draft equals the approval. After the click nothing is retried or refused.
//
// Fail closed: every control is found by exact role and name and must appear
// exactly once, or the run refuses. Every draft save is checked on content
// before it may leave the browser. After each action, dialogs are checked:
// a short allowlist may be confirmed, anything else stops the run.
//
// ⚠️ The scheduling card's Actions menu puts "Manual Schedule" between items
// that email the candidate ("Send Direct Booking Link", "Request Candidate
// Availability"). Exact-name matching here and the write guard are both
// load-bearing; neither may be relaxed.
const {guardWrites,classify}=require('./template-guard');
const {installBookingPermits,installPermit,saveBudget,ORIGIN,OP}=require('./booking-permit');
const {classifyInviteStatus,DRAFT_READ_OP,draftReadCopy,draftShape,draftsIn,normalizeDraft,maskAgendaItem,agendaFromList,checkFinal,formats,savedField,composerZone,checkInviteDropdowns,partitionPreviews,checkInvitePreview,checkInterviewerInvitePreviews,checkConfirmationEmail,classifyDialog,emailsIn}=require('./booking-check');

class Refusal extends Error{constructor(step,message){super(message);this.step=step;this.status=409;}}
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// Dialogs that are part of the page, not warnings: the candidate panel, which
// Ashby names after the candidate ("Candidate profile" only while loading).
const structuralDialogs=plan=>new Set(['Candidate profile',plan.candidate.name]);
// Writes Ashby attempts on its own that the guard blocks and the run ignores,
// by exact operation name: one GraphQL mutation alone, never batched with
// another write (which still stops the run). Still blocked; nothing reaches Ashby.
//   ApiUpdateDraftScheduleCalendarSettings: never permitted (booking-permit.js).
//   ApiCreateRealtimeToken: Ashby's live-update token, requested on page load
//     since October 29 (first seen 17:31 UTC; the 00:52 run that day booked
//     without it). Every websocket is already cut (template-guard.js), so the
//     token would have nothing to connect to.
const EXPECTED_BLOCKED=new Set(['ApiUpdateDraftScheduleCalendarSettings','ApiCreateRealtimeToken']);
const expectedBlock=b=>!!b.ashby&&!!b.mutation&&[...EXPECTED_BLOCKED].some(n=>b.summary===`POST /api/graphql mutation ${n}`);

// Ashby's start-up must finish before navigating inside the app: navigating
// mid-startup leaves the candidate panel on "There was a problem with the
// network connection" (seen 7 times in 10). `settled()` waits until at least
// one GraphQL response has completed since `mark()`, none is in flight, and
// it has been quiet for a second.
function networkWatch(page,{sleep,wait}){
  let inflight=0,finished=0,lastChange=Date.now(),since=0;
  const gql=r=>r.url().startsWith(ORIGIN+'/api/graphql');
  page.on('request',r=>{if(gql(r)){inflight++;lastChange=Date.now();}});
  for(const ev of ['requestfinished','requestfailed'])page.on(ev,r=>{if(gql(r)){inflight=Math.max(0,inflight-1);finished++;lastChange=Date.now();}});
  return {inflight:()=>inflight,mark(){since=finished;},async settled(){const d=Date.now()+wait;while(Date.now()<d){if(finished>since&&inflight===0&&Date.now()-lastChange>=1000)return true;await sleep(200);}return false;},
    // Nothing in flight and a second of quiet, whether or not anything new loaded.
    async quiet(){const d=Date.now()+wait;while(Date.now()<d){if(inflight===0&&Date.now()-lastChange>=1000)return true;await sleep(200);}return false;}};
}
const NETWORK_ERROR=/problem with the network connection/;
// Open the candidate's application panel. Read-only: it navigates and reads,
// never clicks. One retry if Ashby's own network error appears; a second
// failure is a refusal.
// Once Ashby has settled it must still be signed in (a session Ashby rejects
// renders the app, then moves to /signin about 3 seconds later), and with
// `expectedIdentity` it must show exactly that account (its header button,
// as connection.js checks).
const SIGNED_OUT=/^\/(?:signin|login|sign-in)\b/;
async function openApplication(page,plan,{refuse,sleep,go,net,T,expectedIdentity}){
  for(let attempt=1;attempt<=2;attempt++){
    net.mark();
    if(attempt===1){await page.goto(ORIGIN+'/home/upcoming',{waitUntil:'domcontentloaded'});
      await page.getByRole('link',{name:'Pipeline',exact:true}).waitFor({state:'visible',timeout:T.wait});}
    else await go('/home/upcoming');
    const settled=await net.settled();
    if(SIGNED_OUT.test(new URL(page.url()).pathname))refuse('Ashby signed the saved session out. Reconnect Ashby on the connection page, then try again.');
    if(!settled)refuse('Ashby didn\'t finish loading.');
    if(expectedIdentity){
      const me=page.getByRole('button',{name:expectedIdentity,exact:true});
      await me.first().waitFor({state:'visible',timeout:T.wait}).catch(()=>{});
      if(await me.count()!==1)refuse(`Ashby isn't signed in as ${expectedIdentity}.`);
    }
    await go(`/jobs/${plan.jobId}/candidate-pipeline/active/right-side/candidates/${plan.candidateId}/applications/${plan.applicationId}/feed`);
    const panel=page.getByRole('dialog',{name:plan.candidate.name,exact:true});
    const d=Date.now()+T.wait;
    while(Date.now()<d){
      const n=await panel.count();
      if(n>1)refuse(`Expected exactly one candidate panel for ${plan.candidate.name}; found ${n}.`);
      if(n===1&&(await panel.innerText()).includes(plan.candidate.email))return {panel,attempts:attempt};
      if(NETWORK_ERROR.test(await page.locator('[role="dialog"]').first().innerText().catch(()=>'')))break;
      await sleep(250);
    }
  }
  refuse(`Couldn't open ${plan.candidate.name}'s application: Ashby showed a network error or the panel never showed ${plan.candidate.email}, twice.`);
}

// What a screen holds, for the log when the run arrives at one it may not
// recognise, or stops on it: every control (role or tag, type, accessible
// name, visible text, and its checked, disabled, expanded, selected and
// hidden states), the headings, and whether anything is still loading. Never field
// values or editable text: inputs give their type and name only, and an
// editor its length. Capped so a log line stays readable.
async function screenSnapshot(page,net){
  const snap=await page.evaluate(()=>{
    const clip=(v,n=60)=>String(v||'').replace(/\s+/g,' ').trim().slice(0,n);
    const visible=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden';};
    const sel='button,a[href],input,select,textarea,[contenteditable="true"],[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="radio"],[role="tab"],[role="combobox"],[role="menuitem"],[role="option"],[role="textbox"]';
    const all=[...document.querySelectorAll(sel)];
    // Hidden controls are kept and marked: a styled checkbox is often a
    // zero-size input behind its label, and that's the one a lookup finds.
    const controls=all.slice(0,150).map(el=>{
      const c={el:el.tagName.toLowerCase()};
      const role=el.getAttribute('role');if(role)c.role=role;
      if(el.type&&el.tagName!=='BUTTON'&&el.tagName!=='A')c.type=el.type;
      const name=el.getAttribute('aria-label')||(el.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)?.innerText||'').join(' ').trim()||(el.labels&&el.labels[0]?.innerText)||el.getAttribute('placeholder')||el.getAttribute('title')||'';
      if(name)c.name=clip(name);
      if(el.isContentEditable)c.editorLength=(el.innerText||'').length;
      else if(!['INPUT','SELECT','TEXTAREA'].includes(el.tagName)){const t=clip(el.innerText);if(t&&t!==c.name)c.text=t;}
      if(el.tagName==='A')c.path=(el.getAttribute('href')||'').split(/[?#]/)[0].slice(0,80);
      const checked=el.type==='checkbox'||el.type==='radio'?el.checked:el.getAttribute('aria-checked');if(checked!=null&&checked!==undefined)c.checked=checked===true||checked==='true'?true:checked===false||checked==='false'?false:checked;
      if(el.disabled||el.getAttribute('aria-disabled')==='true')c.disabled=true;
      for(const a of ['aria-expanded','aria-selected','aria-pressed'])if(el.hasAttribute(a))c[a.slice(5)]=el.getAttribute(a);
      if(!visible(el))c.hidden=true;
      return c;
    });
    const loadingText=(document.body.innerText.match(/\bLoading\b[^\n]{0,30}/gi)||[]).slice(0,5);
    return {path:location.pathname,controls,controlsTotal:all.length,
      headings:[...document.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible).map(h=>clip(h.innerText,80)).filter(Boolean).slice(0,30),
      loading:{ariaBusy:document.querySelectorAll('[aria-busy="true"]').length,progressbars:document.querySelectorAll('[role="progressbar"]').length,
        spinners:document.querySelectorAll('[class*="spinner" i],[class*="loading" i],[class*="skeleton" i]').length,text:loadingText}};
  });
  if(net)snap.loading.graphqlInFlight=net.inflight();
  return snap;
}

// The Calendar Invites settings, as booking-check.js checkInviteDropdowns
// reads them: the dropdown buttons (those with aria-expanded) between the
// "Calendar Invites and Notifications" and "Candidate Invite" headings, in
// page order, by their text. Reads only; nothing is opened.
async function readInviteSettings(page){
  return page.evaluate(()=>{
    const text=el=>(el.innerText||'').replace(/\s+/g,' ').trim();
    const headings=[...document.querySelectorAll('h1,h2,h3,h4,[role="heading"]')];
    const exactly=t=>headings.filter(h=>text(h)===t);
    const starts=exactly('Calendar Invites and Notifications'),ends=exactly('Candidate Invite'),manageHeadings=exactly('Manage Candidate Invites').length;
    if(starts.length!==1||ends.length!==1)return {start:starts.length===1,end:ends.length===1,manageHeadings,dropdowns:[]};
    const [start,end]=[starts[0],ends[0]];
    const between=el=>(start.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING)&&(el.compareDocumentPosition(end)&Node.DOCUMENT_POSITION_FOLLOWING);
    const dropdowns=[...document.querySelectorAll('button[aria-expanded],[role="button"][aria-expanded],[role="combobox"]')].filter(between).map(text);
    return {start:true,end:true,manageHeadings,dropdowns};
  });
}

// Where each invite preview sits, for booking-check.js partitionPreviews:
// the "Candidate Invite" and "Interviewer Invites" headings (any level, by
// exact text) and, for each preview in `previews`, whether it comes before
// the first heading, between them, or after the second. Reads only.
async function readPreviewSections(page,previews){
  const headings=await page.evaluate(()=>{
    const text=el=>(el.innerText||'').replace(/\s+/g,' ').trim();
    document.querySelectorAll('[data-booking-section]').forEach(el=>el.removeAttribute('data-booking-section'));
    const all=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')];
    const c=all.filter(h=>text(h)==='Candidate Invite'),i=all.filter(h=>/^Interviewer Invites?$/.test(text(h)));
    if(c.length===1)c[0].setAttribute('data-booking-section','candidate');
    if(i.length===1)i[0].setAttribute('data-booking-section','interviewer');
    return {candidateHeadings:c.length,interviewerHeadings:i.length,
      ordered:c.length===1&&i.length===1&&!!(c[0].compareDocumentPosition(i[0])&Node.DOCUMENT_POSITION_FOLLOWING)};
  });
  const where=[];
  if(headings.candidateHeadings===1&&headings.interviewerHeadings===1)
    for(let k=0;k<await previews.count();k++)where.push(await previews.nth(k).evaluate(el=>{
      const after=h=>!!(h.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING);
      return after(document.querySelector('[data-booking-section="interviewer"]'))?'interviewer':after(document.querySelector('[data-booking-section="candidate"]'))?'candidate':'before';
    }));
  return {...headings,where};
}

// The schedule's page in Ashby, read for its invite status (booking-check.js
// classifyInviteStatus): reached in-app, once loaded; headings, the lines
// that mention invites or sending, and the visible buttons. Reads only.
async function inviteStatusOnPage(page,plan,{go,net,sleep}){
  net.mark();await go(`/schedules/${plan.interviewScheduleId}`);await net.settled();await sleep(1500);
  const seen=await page.evaluate(()=>{
    const visible=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;};
    return {path:location.pathname,
      headings:[...document.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible).map(h=>h.innerText.replace(/\s+/g,' ').trim()).filter(Boolean).slice(0,30),
      lines:(document.body.innerText||'').split('\n').map(l=>l.trim()).filter(l=>/invit|\bsent\b|pending|calendar/i.test(l)).slice(0,40),
      buttons:[...document.querySelectorAll('button,[role="button"]')].filter(visible).map(b=>b.innerText.replace(/\s+/g,' ').trim()).filter(Boolean).slice(0,80)};
  });
  if(seen.path!==`/schedules/${plan.interviewScheduleId}`)return {state:'unknown',evidence:[`the schedule's page didn't open (${seen.path})`]};
  return classifyInviteStatus(seen);
}

// Waiting and finding, shared by the run and by deleting a draft on its own.
// The rule (Hayley, 2026-10-20, after the fourth false conclusion from an early
// read): no screen is read before Ashby has finished loading it. `ready()`
// waits until nothing is in flight and it has been quiet for a second, within
// the usual wait, or refuses. Every in-app navigation (`go`) ends with it, and
// so does every action (the run's `after`), so whatever is read next is read
// from a settled screen.
function helpers(page,T,refuse){
  const sleep=ms=>page.waitForTimeout(ms);
  const net=networkWatch(page,{sleep,wait:T.wait});
  async function ready(what){
    await sleep(T.settle);
    if(!await net.quiet())refuse(`Ashby didn't finish loading ${what} (${net.inflight()} request${net.inflight()===1?'':'s'} still in flight), so nothing on it was read.`);
  }
  async function one(locator,what){
    const deadline=Date.now()+T.wait;let n=0;
    while(Date.now()<deadline){n=await locator.count();if(n===1)return locator;if(n>1)refuse(`Expected exactly one ${what}; found ${n}.`);await sleep(250);}
    refuse(`Couldn't find ${what}.`);
  }
  async function until(fn,what,ms=T.wait){const d=Date.now()+ms;while(Date.now()<d){if(await fn())return;await sleep(250);}refuse(`Timed out waiting for ${what}.`);}
  async function go(path){await page.evaluate(u=>{history.pushState({},'',u);dispatchEvent(new PopStateEvent('popstate'));},path);await ready(path);}
  return {sleep,one,until,go,net,ready};
}
const replied=json=>!!json&&!(json.errors&&json.errors.length);
// A draft's own link, recorded with its ID wherever a draft may be left, so
// every left draft comes with the way to it.
const draftUrl=id=>id?`${ORIGIN}/schedules/drafts/${id}`:null;

// `respond` is for tests only: a stand-in for Ashby's replies to permitted writes.
// `onRefusal(page)` runs before cleanup when the run stops (local debugging).
// `expectedIdentity` is the Ashby account the run must be signed in as.
// For the Slack-approved check (booking-compose.js), not the dry run:
//   `checkExistingDrafts` refuses before creating a draft if the schedule
//     already has one, other than `supersedeDraftId` (the dashboard's earlier
//     draft for this schedule), which is deleted first;
//   `keepOnSuccess` leaves the composed draft in Ashby for a person to send.
//     Any refusal still deletes it.
//   `send` (booking-compose.js sets it only when every lock is open and the
//     approved plan says `send: true`): click Schedule once, with one permit.
// `beforeSend` (booking-compose.js, with `send` only): the send gate
//   (send-gate.js), called once every other lock is open, just before the
//   click; null lets the click go ahead (the send is then counted), anything
//   else is {reason} and the draft is left for a person.
// `observeAlternates` (booking-dry-run.js --observe-alternates only): lets a
// slot's alternates narrow (checkSave), logs unapproved alternates left at the
// end instead of refusing (checkFinal), and logs each eligible interviewer's
// row on Ashby's interviewer page and every invite preview's recipients
// (`observe` events). Never with a kept draft or Send.
async function dryRun({context,page,plan,log=()=>{},timing={},respond,onRefusal,expectedIdentity,checkExistingDrafts=false,supersedeDraftId=null,keepOnSuccess=false,send=false,beforeSend=null,observeAlternates=false}){
  if(observeAlternates&&(keepOnSuccess||send))throw new Error('Observing alternates is for the dry run only: never with a kept draft or Send.');
  const T={settle:700,short:1500,wait:15000,...timing};
  const events=[];const note=e=>{events.push(e);log(e);};
  const guard=await guardWrites(context,{warn:m=>note({type:'blocked',ashby:!!guard.blocked[guard.blocked.length-1]?.ashby,detail:m.replace('[write-guard] ','')})});
  const state={};
  const budget=saveBudget(plan);
  const permits=await installBookingPermits(context,{plan,state,log:note,observeAlternates,maxSaves:budget.limit,...(respond?{respond}:{})});
  // The earlier draft's delete: that draft only, once, and only while armed.
  const superseding={armed:false,discarded:undefined};
  if(supersedeDraftId)await installPermit(context,{op:OP.discard,max:1,log:note,capture:true,...(respond?{respond}:{}),
    bound:v=>superseding.armed&&v.draftInterviewScheduleId===supersedeDraftId,onResponse:json=>{superseding.discarded=replied(json);}});
  // Send: one ApiScheduleInterviewScheduleFromDraft, for this schedule and this
  // run's draft only, and only while armed, which is just before the one click
  // (step 6). Installed only when `send` is set; otherwise Send stays blocked
  // by the write guard like any other write.
  const sending={armed:false,reply:undefined,mismatch:null};
  if(send&&keepOnSuccess)await installPermit(context,{op:OP.send,max:1,log:note,...(respond?{respond}:{}),
    bound:v=>{
      if(!sending.armed)return false;
      if(v.interviewScheduleId===plan.interviewScheduleId&&v.draftInterviewScheduleId===state.draftId)return true;
      sending.mismatch=Object.keys(v||{}).sort().join(', ')||'(no variables)';return false;
    },
    onResponse:(json,status)=>{sending.reply={status,accepted:replied(json),errors:(json?.errors||[]).map(e=>String(e.message).slice(0,200)).slice(0,3)};}});
  // Ashby's second write on that click, which publishes the calendar invites:
  // once, while armed (with Send, until Ashby has tried it), and only if its
  // variables name this schedule or this draft. Its variable names are kept
  // for the log; a request that doesn't name either stays blocked by the
  // guard, and the invites show as pending.
  const publishing={armed:false,reply:undefined,variables:null};
  if(send&&keepOnSuccess)await installPermit(context,{op:OP.publish,max:1,log:note,...(respond?{respond}:{}),
    bound:v=>{
      if(!publishing.armed)return false;
      publishing.variables=Object.keys(v||{}).sort().join(', ')||'(no variables)';
      const t=JSON.stringify(v||{});
      return t.includes(plan.interviewScheduleId)||(!!state.draftId&&t.includes(state.draftId));
    },
    onResponse:(json,status)=>{publishing.reply={status,accepted:replied(json),errors:(json?.errors||[]).map(e=>String(e.message).slice(0,200)).slice(0,3)};}});
  // Ashby's third write on that click when the confirmation email is on: it
  // sends the candidate's confirmation email. Same rule as the publish: once,
  // while armed with Send, only if its variables name this schedule or draft,
  // with their names logged. Its answer is what the report says about the
  // email; nothing else is taken as proof it was sent.
  const emailing={armed:false,reply:undefined,variables:null};
  if(send&&keepOnSuccess)await installPermit(context,{op:OP.confirmationEmail,max:1,log:note,...(respond?{respond}:{}),
    bound:v=>{
      if(!emailing.armed)return false;
      emailing.variables=Object.keys(v||{}).sort().join(', ')||'(no variables)';
      const t=JSON.stringify(v||{});
      return t.includes(plan.interviewScheduleId)||(!!state.draftId&&t.includes(state.draftId));
    },
    onResponse:(json,status)=>{emailing.reply={status,accepted:replied(json),errors:(json?.errors||[]).map(e=>String(e.message).slice(0,200)).slice(0,3)};}});
  // Ashby's own read of this run's draft, recorded as the composer loads it,
  // so it can be repeated just before Schedule (step 5): Ashby's
  // ApiGetDraftSchedule, a read as the write guard counts one (classify), one
  // operation, with this draft at data.draftInterviewSchedule (draftReadCopy;
  // seen October 20). Every GraphQL exchange that mentions the
  // draft is also summarised, by structure only, for the log if no read is
  // found (`draftMentions`).
  const draftReads=[],draftMentions=[];
  page.on('response',async res=>{
    try{
      const req=res.request();
      if(!state.draftId||req.method()!=='POST'||!req.url().startsWith(ORIGIN+'/api/graphql'))return;
      const body=req.postData()||'';
      const text=await res.text().catch(()=>'');
      if(!body.includes(state.draftId)&&!text.includes(state.draftId))return;
      let ops=null;try{ops=JSON.parse(body);}catch(_){}
      const list=Array.isArray(ops)?ops:ops?[ops]:[];
      let json=null;try{json=JSON.parse(text);}catch(_){}
      const read=classify({method:'POST',url:req.url(),postData:body}).allow===true;
      if(draftMentions.length<30)draftMentions.push({operations:list.map(o=>o?.operationName||'(unnamed)').slice(0,5),read,batched:Array.isArray(ops),
        queryText:list.some(o=>typeof o?.query==='string'),persisted:list.some(o=>!!o?.extensions?.persistedQuery),
        idInRequest:body.includes(state.draftId),status:res.status(),response:json?draftShape(json,state.draftId):'not JSON'});
      if(read&&!Array.isArray(ops)&&ops?.operationName===DRAFT_READ_OP&&json?.data?.draftInterviewSchedule?.id===state.draftId)draftReads.push({operationName:ops.operationName,body,headers:req.headers()});
    }catch(_){}
  });
  let step='start';
  const refuse=m=>{throw new Refusal(step,m);};
  const {sleep,one,until,go,net,ready}=helpers(page,T,refuse);
  // After every action: let Ashby react, then check dialogs, refused saves and
  // any write the guard blocked that it shouldn't have needed to.
  let seenRefusals=0,seenBlocked=0;
  async function after(action){
    await action();await ready(`the screen after "${step}"`);
    for(const d of await page.locator('[role="dialog"],[role="alertdialog"]').all()){
      // Read without waiting (a warning may have no heading), the way the
      // browser names it: aria-label, then aria-labelledby, then a heading.
      const name=await d.evaluate(el=>el.getAttribute('aria-label')||(el.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)?.innerText||'').join(' ').trim()||el.querySelector('h1,h2,h3')?.innerText||'');
      if(structuralDialogs(plan).has((name||'').trim()))continue;
      const text=(await d.innerText()).replace(/\s+/g,' ').trim();
      note({type:'dialog',text:text.slice(0,300)});
      const verdict=classifyDialog(text);
      if(verdict.action!=='confirm')refuse(verdict.reason);
      await (await one(d.getByRole('button',{name:verdict.button,exact:true}),`"${verdict.button}" in the dialog`)).click();await sleep(T.settle);
    }
    if(state.refusals.length>seenRefusals)refuse(state.refusals[state.refusals.length-1]);
    const unexpected=guard.blocked.slice(seenBlocked).filter(b=>b.ashby&&!expectedBlock(b));
    seenBlocked=guard.blocked.length;
    if(unexpected.some(b=>b.summary.endsWith(' '+OP.save))&&permits.save.count>=budget.limit)refuse(`Ashby needed more than the ${budget.limit} draft saves this plan allows (${budget.sessions} session${budget.sessions===1?'':'s'}, ${budget.slots} interviewer slot${budget.slots===1?'':'s'}); the save over the limit was blocked.`);
    if(unexpected.length)refuse(`Ashby tried a write the booking doesn't permit: ${unexpected.map(b=>b.summary).join('; ')}.`);
    seenRefusals=state.refusals.length;
  }
  const report={mode:keepOnSuccess?'compose':'dry-run',status:'refused',step:null,reason:null,draftId:null,checks:[],wouldSend:null,cleanup:null};
  const pass=(name,detail)=>{report.checks.push({name,ok:true,...(detail?{detail}:{})});note({type:'check',name,...(detail?.draftId?{draftId:detail.draftId}:{})});};
  try{
    // 0. The plan's draft saves must fit under the ceiling before anything
    // opens, so a booking never runs out partway (saveBudget).
    step='check the save budget';
    if(budget.limit>budget.ceiling)refuse(`This plan could need ${budget.limit} draft saves (${budget.sessions} sessions, ${budget.slots} interviewer slots), over the booking's ceiling of ${budget.ceiling}. Nothing was opened in Ashby.`);
    pass(`save budget: ${budget.limit} for ${budget.sessions} session${budget.sessions===1?'':'s'} and ${budget.slots} interviewer slot${budget.slots===1?'':'s'}`);
    // 1. Ashby's shell, then the application inside the app. A cold load of a
    // deep URL shows an error page under the guard.
    step='open the application';
    const opened=await openApplication(page,plan,{refuse,sleep,go,net,T,expectedIdentity});
    if(expectedIdentity)pass(`signed in as ${expectedIdentity}`);
    pass('candidate panel shows the approved candidate',opened.attempts>1?{attempts:opened.attempts}:undefined);
    // Before the Slack-approved check makes a draft, the schedule must have
    // none, so nobody can send the wrong one.
    if(checkExistingDrafts){
      step='check the schedule\'s drafts';
      let {ids,how}=await listDrafts(page,plan,{one,go,T});
      note({type:'drafts-check',how,count:ids.length});
      if(supersedeDraftId&&ids.includes(supersedeDraftId)){
        const r=await deleteDraft(page,plan,supersedeDraftId,{arm:()=>{superseding.armed=true;},done:()=>superseding.discarded},{one,go,sleep,T});
        if(!r.deleted)refuse(`Couldn't delete the earlier draft the dashboard composed for this schedule: ${r.reason}.`);
        report.superseded={draftId:supersedeDraftId,deleted:true};
        ({ids,how}=await listDrafts(page,plan,{one,go,T}));
        note({type:'drafts-check',how,count:ids.length,after:'deleting the earlier draft'});
      }else if(supersedeDraftId)report.superseded={draftId:supersedeDraftId,deleted:false,reason:'it was no longer in Ashby'};
      if(ids.length)refuse(`This schedule already has ${ids.length===1?'a draft':`${ids.length} drafts`} in Ashby that the dashboard didn't make. Send or delete ${ids.length===1?'it':'them'} in Ashby first.`);
      pass('the schedule has no other drafts');
      // Back to the application the way the run began.
      await openApplication(page,plan,{refuse,sleep,go,net,T,expectedIdentity});
    }
    // 2. Start a manual schedule from the scheduling card. Ashby shows it two
    // ways, and exactly one must be present:
    //   availability submitted: a "Start Manual Schedule" button (beside a bare
    //     "Schedule" button, which is never clicked);
    //   waiting on availability: Actions, then "Manual Schedule" (between
    //     items that email the candidate).
    step='open Manual Schedule';
    const heading=await one(page.getByRole('heading',{name:plan.activityTitle,exact:true}),`the "${plan.activityTitle}" card`);
    await until(async()=>(await heading.locator('xpath=ancestor::*[.//button[normalize-space(.)="Start Manual Schedule" or normalize-space(.)="Actions"]][1]').count())>0,`the "${plan.activityTitle}" card's scheduling controls`);
    const card=heading.locator('xpath=ancestor::*[.//button[normalize-space(.)="Start Manual Schedule" or normalize-space(.)="Actions"]][1]');
    const startManual=card.getByRole('button',{name:'Start Manual Schedule',exact:true}),actions=card.getByRole('button',{name:'Actions',exact:true});
    const [startCount,actionCount]=[await startManual.count(),await actions.count()];
    if(startCount+actionCount!==1)refuse(`Expected exactly one way to start a manual schedule on the "${plan.activityTitle}" card; found ${startCount} "Start Manual Schedule" and ${actionCount} "Actions".`);
    if(startCount){await after(()=>startManual.click());pass('started from "Start Manual Schedule" (availability submitted)');}
    else{
      await after(()=>actions.click());
      const menu=await one(page.getByRole('menu',{name:'Actions'}),'the Actions menu');
      const manual=await one(menu.getByRole('menuitem',{name:'Manual Schedule',exact:true}),'"Manual Schedule" in the Actions menu');
      await after(()=>manual.click());pass('started from Actions > "Manual Schedule" (waiting on availability)');
    }
    await until(()=>!!state.draftId||!!state.baselineError,'Ashby to create the draft');
    report.draftId=state.draftId;
    if(state.baselineError)refuse(state.baselineError.message);
    pass('draft created and matches the approved agenda',{draftId:state.draftId});
    await until(async()=>new URL(page.url()).pathname===`/schedules/drafts/${state.draftId}`,'the draft composer');
    // 3. The composer: identity, time zone, then each session's date, times and interviewers.
    step='compose';
    await one(page.getByRole('heading',{level:1,name:`Scheduling ${plan.candidate.name} ${plan.job.title} ${plan.stage.title} Unsaved`,exact:true}),'the composer heading for this candidate, job and stage');
    pass('composer is for the approved candidate, job and stage');
    const starts=page.getByRole('combobox',{name:'Start...',exact:true}),ends=page.getByRole('combobox',{name:'End...',exact:true}),dates=page.getByRole('textbox',{name:'Set interview date...',exact:true});
    // The session editor renders a moment after the heading on a new draft.
    for(const [loc,what] of [[starts,'Start fields'],[ends,'End fields'],[dates,'date fields']]){
      const d=Date.now()+T.wait;while(Date.now()<d&&await loc.count()<plan.sessions.length)await sleep(250);
      if(await loc.count()!==plan.sessions.length)refuse(`The composer has ${await loc.count()} ${what}, but ${plan.sessions.length} session${plan.sessions.length===1?' was':'s were'} approved.`);
    }
    // The draft's zone (a per-draft dropdown in Ashby). It needn't be the
    // plan's (the candidate's availability zone): the approved instants are converted into it, and
    // `shown` is the plan as Ashby displays it, for typing and for reading
    // previews back. The approval itself, and every save check, stay instants.
    step='read the composer\'s time zone';
    const zoneButtons=page.getByRole('button',{name:'Select a timezone',exact:true});
    {const d=Date.now()+T.wait;while(Date.now()<d&&!(await zoneButtons.count()))await sleep(250);}
    try{state.zone=composerZone(await zoneButtons.allInnerTexts());}catch(e){refuse(e.message);}
    const shown={...plan,timeZone:state.zone};
    report.displayZone=state.zone;
    pass(`composer shows times in ${state.zone}${state.zone===plan.timeZone?'':`; the approved times are entered in it (the candidate's availability is in ${plan.timeZone})`}`);
    // Each session's editor, found by its event ID, never by position: Ashby
    // re-sorts the editors by time as they change (seen October 13: setting
    // session 1 to 1pm moved session 2's 9:30am editor above it). The editor
    // is the nearest ancestor of that event's slot link that holds a Start
    // field, and it must hold exactly one date, Start and End field. It's
    // found again before every edit.
    async function editor(eventId,what){
      // The slot links can render a moment after the fields; wait for them.
      let tag,deadline=Date.now()+T.wait;
      do{tag=await page.evaluate(({draftId,eventId})=>{
        const link=document.querySelector(`a[href="/schedules/drafts/${draftId}/events/${eventId}/interviewers/0"]`);
        if(!link)return {error:'no slot link'};
        const named=(el,n)=>el.getAttribute('aria-label')===n||el.getAttribute('placeholder')===n;
        const fields=(root,n)=>[...root.querySelectorAll('input,textarea,[role="combobox"],[role="textbox"]')].filter(el=>named(el,n));
        let box=link.parentElement;while(box&&!fields(box,'Start...').length)box=box.parentElement;
        if(!box)return {error:'no editor around the slot link'};
        const found={start:fields(box,'Start...'),end:fields(box,'End...'),date:fields(box,'Set interview date...')};
        if(Object.values(found).some(f=>f.length!==1))return {error:`its editor has ${found.date.length} date, ${found.start.length} Start and ${found.end.length} End fields`};
        for(const k of Object.keys(found)){document.querySelectorAll(`[data-booking-${k}]`).forEach(el=>el.removeAttribute(`data-booking-${k}`));found[k][0].setAttribute(`data-booking-${k}`,eventId);}
        return {ok:true};
      },{draftId:state.draftId,eventId});if(!tag.ok)await sleep(250);}while(!tag.ok&&Date.now()<deadline);
      if(!tag.ok)refuse(`Couldn't find the editor for ${what}: ${tag.error}.`);
      // The tagged elements must be the same ones the accessibility tree names.
      const get=(role,name,k)=>one(page.getByRole(role,{name,exact:true}).and(page.locator(`[data-booking-${k}="${eventId}"]`)),`${what}'s ${name.replace('...','')} field`);
      return {date:await get('textbox','Set interview date...','date'),start:await get('combobox','Start...','start'),end:await get('combobox','End...','end')};
    }
    // Option text is the time, then for End fields the length ("1:30pm 4h").
    const timeOption=want=>page.getByRole('option',{name:new RegExp(`^${esc(want)}(?: [0-9].*)?$`)});
    for(let i=0;i<plan.sessions.length;i++){
      const s=plan.sessions[i],a=formats(s.start,shown.timeZone),b=formats(s.end,shown.timeZone),eventId=state.last[i].id,what=`session ${i+1} ("${s.title}")`;
      step=`compose ${what}`;
      // Still the same zone. Its abbreviation is today's, whatever this
      // session's date (composerZone).
      try{if(composerZone(await zoneButtons.allInnerTexts())!==state.zone)refuse(`The composer's time zone changed from ${state.zone} while composing.`);}
      catch(e){if(e instanceof Refusal)throw e;refuse(`${e.message} (at ${what})`);}
      const wantDate=a.shortDate.replace(/, \d{4}$/,'');// "Tue, Oct 20"
      // Every field is read back before the next action, typed or not: the
      // page's field must show the approved value and the last save Ashby
      // accepted must hold it. No retry; a field that doesn't read back within
      // the usual wait refuses. October 28: session 6's date and Start were
      // typed, no save ever carried them, and the log said "entered" from the
      // intended values; its End matched the page's field but not the draft.
      async function readBack(k,want){
        let shows,saved;const deadline=Date.now()+T.wait;
        for(;;){
          shows=await (await editor(eventId,what))[k].inputValue();
          saved=savedField(k,state.last[i],s,shown.timeZone);
          if(shows===want&&saved.ok)return {page:shows,saved:saved.value};
          if(Date.now()>=deadline)break;
          await sleep(250);
        }
        refuse(`${what}'s ${k==='date'?'date':k==='start'?'Start':'End'} didn't read back as ${want}: the page shows "${shows}" and the last save Ashby accepted has ${saved.value} (${state.saves} save${state.saves===1?'':'s'} accepted, the last ${state.lastSaveAt?`${((Date.now()-state.lastSaveAt)/1000).toFixed(1)}s ago`:'never'}).`);
      }
      // What was entered, for the log: each field as read back from the page
      // and the last accepted save, and whether it had to be typed.
      const typed={type:'typed',session:i+1,title:s.title,zone:a.zone,approved:`${s.start}–${s.end}`};
      {const {date}=await editor(eventId,what);
        const t=await date.inputValue()!==wantDate;
        if(t)await after(async()=>{await date.click();await date.fill(wantDate);await page.keyboard.press('Enter');});
        typed.date={typed:t,...await readBack('date',wantDate)};}
      for(const [k,want] of [['start',a.lower],['end',b.lower]]){
        const field=(await editor(eventId,what))[k];
        const t=await field.inputValue()!==want;
        if(t)await after(async()=>{await field.click();await field.fill(want);
          const option=await one(timeOption(want),`the "${want}" option for ${what}'s ${k}`);await option.click();});
        typed[k]={typed:t,...await readBack(k,want)};
      }
      note(typed);
      for(let j=0;j<s.interviewers.length;j++){
        const p=s.interviewers[j];
        if(state.last[i].slots[j].selected===p.userId)continue;
        step=`select ${p.name} for "${s.title}"`;
        const eventId=state.last[i].id;
        await after(async()=>(await one(page.locator(`a[href="/schedules/drafts/${state.draftId}/events/${eventId}/interviewers/${j}"]`),`interviewer slot ${j+1} of "${s.title}"`)).click());
        await one(page.getByRole('heading',{name:`Interviewer ${j+1}, ${s.title}`,exact:true}),`the "Interviewer ${j+1}, ${s.title}" page`);
        // Eligible list only: the row showing this person's name and email, and
        // its own "Select Interviewer". Never Ashby's free "Search for a user...",
        // which can pick anyone regardless of the interview's template.
        const buttons=page.getByRole('button',{name:'Select Interviewer',exact:true});
        await until(async()=>await buttons.count()>0,'the eligible interviewers list');
        const rows=await buttons.evaluateAll((els,{name,email})=>els.map(b=>{
          // The row: the nearest ancestor holding this button and no other.
          let row=b.parentElement;
          while(row&&row.querySelectorAll('button').length&&[...row.querySelectorAll('button')].filter(x=>x.innerText.trim()==='Select Interviewer').length===1&&row.parentElement&&[...row.parentElement.querySelectorAll('button')].filter(x=>x.innerText.trim()==='Select Interviewer').length===1)row=row.parentElement;
          const text=(row?.innerText||'').replace(/\s+/g,' ');
          return text.includes(name)&&text.includes(email);
        }),{name:p.name,email:p.email});
        // Observing: every eligible row as Ashby shows it (name, email,
        // conflicts), found as the pick finds them, before the pick.
        if(observeAlternates)note({type:'observe',what:`interviewer page, slot ${j+1} of "${s.title}", before choosing ${p.name}`,
          rows:await buttons.evaluateAll(els=>els.map(b=>{
            let row=b.parentElement;
            while(row&&row.querySelectorAll('button').length&&[...row.querySelectorAll('button')].filter(x=>x.innerText.trim()==='Select Interviewer').length===1&&row.parentElement&&[...row.parentElement.querySelectorAll('button')].filter(x=>x.innerText.trim()==='Select Interviewer').length===1)row=row.parentElement;
            return (row?.innerText||'').replace(/\s+/g,' ').trim().slice(0,200);})),
          page:(await page.locator('body').innerText().catch(()=>'')).split('\n').map(l=>l.trim()).filter(l=>/current interviewer|conflict|busy|consider alternate/i.test(l)).slice(0,12)});
        const matches=rows.map((m,k)=>m?k:-1).filter(k=>k>=0);
        if(matches.length!==1)refuse(matches.length?`${p.name} (${p.email}) appears ${matches.length} times in the eligible list for "${s.title}".`:`${p.name} (${p.email}) isn't an eligible interviewer for "${s.title}" in Ashby. Only people the interview's template allows can be booked.`);
        await after(()=>buttons.nth(matches[0]).click());
        await until(()=>state.last[i].slots[j].selected===p.userId,`Ashby to save ${p.name} into the slot`);
        // Ashby may return to the schedule by itself after a pick.
        if(new URL(page.url()).pathname.includes('/interviewers/'))await after(async()=>(await one(page.getByRole('link',{name:'Back to Schedule',exact:true}),'"Back to Schedule"')).click());
      }
    }
    step='check the composed draft';
    await sleep(T.short);
    {const {strayAlternates}=checkFinal(state.last,plan,{observeAlternates,created:state.created});
      if(strayAlternates.length)note({type:'observe',what:'unapproved alternates left in the composed draft (allowed only while observing)',strayAlternates});}
    pass('final draft save equals the approval exactly',{saves:state.saves});
    // 4. Communications: invites and the candidate email must say what was approved.
    step='configure communications';
    // Ashby's requests are counted from just before the click, so the screen
    // can be read only once it has finished loading.
    net.mark();
    // The way from the composer to its communications (October 20: the
    // "Configure Communications" button is gone; a "Communications" link to
    // this draft's /communication is in its place, beside a generic "Next").
    // The link is used only when the old button is absent and exactly one such
    // link is present; the old button only when it's the one way shown.
    // Anything else refuses. Either must then reach the Calendar Invites screen.
    {
      const oldButton=page.getByRole('button',{name:'Configure Communications',exact:true});
      const link=page.getByRole('link',{name:'Communications',exact:true}).and(page.locator(`a[href="/schedules/drafts/${state.draftId}/communication"]`));
      const [olds,links]=[await oldButton.count(),await link.count()];
      if(olds===0&&links===1){await after(()=>link.click());pass('opened communications from the composer\'s "Communications" link');}
      else if(olds===1&&links===0)await after(()=>oldButton.click());
      else refuse(`Expected one way from the composer to its communications: no "Configure Communications" button and exactly one "Communications" link to this draft; found ${olds} button${olds===1?'':'s'} and ${links} link${links===1?'':'s'}.`);
    }
    await until(async()=>new URL(page.url()).pathname===`/schedules/drafts/${state.draftId}/communication/calendar-invites`,'the Calendar Invites screen');
    // Settled before anything on it is read (October 20: the one-session
    // screen was read with 2 requests in flight and 24 spinners): at least one
    // request finished since the click, none in flight, and a second of quiet,
    // within the usual wait. A screen that never settles refuses.
    if(!await net.settled())refuse(`Ashby didn't finish loading the Calendar Invites screen (${net.inflight()} request${net.inflight()===1?'':'s'} still in flight), so its settings weren't read.`);
    // What the screen holds once settled, before anything is looked for on it.
    note({type:'screen',at:'arrived',...await screenSnapshot(page,net).catch(e=>({error:e.message}))});
    // Two layouts (October 2026): checkboxes on a one-session schedule,
    // dropdowns on TEST's six-session Onsite. Whichever appears is checked;
    // both, or neither within the wait, refuses.
    // "Send Interviewer Invite" for one session, "...Invites" for several.
    const candidateBox=page.getByRole('checkbox',{name:'Send Candidate Invite',exact:true}),interviewerBox=page.getByRole('checkbox',{name:/^Send Interviewer Invites?$/});
    let settings={dropdowns:[]},boxes=0;
    {const d=Date.now()+T.wait;while(Date.now()<d){boxes=await candidateBox.count()+await interviewerBox.count();settings=await readInviteSettings(page);if(boxes||settings.dropdowns.length)break;await sleep(250);}}
    if(boxes&&settings.dropdowns.length)refuse(`The Calendar Invites screen shows both invite checkboxes and invite dropdowns (${settings.dropdowns.map(t=>`"${t}"`).join(', ')}).`);
    if(boxes){
      for(const [box,name] of [[candidateBox,'Send Candidate Invite'],[interviewerBox,'Send Interviewer Invite(s)']])
        if(!(await (await one(box,`"${name}"`)).isChecked()))refuse(`"${name}" is off; it must be on.`);
      pass('candidate and interviewer invites are on (checkboxes)');
    }else if(settings.dropdowns.length){
      try{checkInviteDropdowns(settings,plan.sessions.length);}catch(e){refuse(e.message);}
      pass(plan.sessions.length===1?'candidate and interviewer invites are on (both "Send calendar invites"; one session, no per-block setting)':'candidate and interviewer invites are on (both "Send calendar invites", and "Send one invite per block")');
    }else refuse('Couldn\'t find the invite settings: neither the "Send Candidate Invite" checkbox nor the "Send calendar invites" dropdowns.');
    // Previews: whose each one is comes from where it sits, by document order
    // (partitionPreviews): the candidate's single combined invite between the
    // "Candidate Invite" and "Interviewer Invites" headings, then one per
    // session for interviewers.
    const previews=page.getByRole('tabpanel',{name:'Preview'});
    // Ashby draws the previews after the screen opens: read until their
    // content is present (bounded by T.wait), then check that read. If it
    // never fills in, the checks below refuse, naming what was missing.
    let candidate=null;
    const readPreviews=async()=>{
      const sections=await readPreviewSections(page,previews);
      let parts;try{parts=partitionPreviews(sections,plan.sessions.length);}catch(e){return {layout:e.message};}
      candidate=previews.nth(parts.candidate);
      // The agenda's top-level items, each as text (a name may sit in a nested
      // list): the first list that opens with a session line. Lines between
      // sessions (a break, lunch) stay in, for agendaFromList to accept or refuse.
      const agendaItems=await candidate.evaluate(panel=>{
        const list=[...panel.querySelectorAll('ul,ol')].find(l=>l.children.length&&/^\s*\d{1,2}:\d\d [AP]M - /.test(l.children[0].innerText));
        return list?[...list.children].map(li=>li.innerText):[];
      });
      const candidateText=await candidate.innerText();
      const interviewerTexts=[];for(const k of parts.interviewers)interviewerTexts.push(await previews.nth(k).innerText());
      return {agendaItems,candidateText,interviewerTexts};
    };
    const present=r=>!r.layout&&agendaFromList(r.agendaItems).sessions.length===plan.sessions.length&&r.candidateText.trim()&&r.interviewerTexts.every(t=>t.trim());
    // Twice the usual wait: on October 20 the previews drew only after 15s.
    let read;const readBy=Date.now()+2*T.wait;
    while(!present(read=await readPreviews())&&Date.now()<readBy)await sleep(250);
    if(read.layout)refuse(read.layout);
    const agenda=agendaFromList(read.agendaItems);
    // The lines between sessions, unmasked: break and lunch labels, logged on
    // every run that has them so what Ashby puts in gaps is known, not guessed.
    if(agenda.lines.length)note({type:'agenda-between',lines:agenda.lines});
    // An agenda that still can't be read: log its shape for the fix, never
    // its names (maskAgendaItem). Only on this failure.
    if(agenda.sessions.length!==plan.sessions.length&&candidate){
      const shape=await candidate.evaluate(panel=>({
        lists:[...panel.querySelectorAll('ul,ol')].slice(0,6).map(l=>({items:l.children.length,first:[...l.children].slice(0,8).map(li=>li.innerText.trim())})),
        lines:(panel.innerText||'').split('\n').filter(l=>/\d{1,2}:\d\d/.test(l)).length})).catch(e=>({error:e.message}));
      for(const l of shape.lists||[])l.first=l.first.map(maskAgendaItem);
      note({type:'agenda-shape',...shape});
    }
    // Content checks fail as refusals, naming what differs.
    if(observeAlternates)note({type:'observe',what:'invite preview recipients',candidate:emailsIn(read.candidateText||''),interviewers:read.interviewerTexts.map(t=>emailsIn(t))});
    try{checkInvitePreview(read.candidateText,shown,read.agendaItems);}catch(e){refuse(e.message);}
    pass('candidate invite preview shows the approved date, agenda and only the candidate');
    try{checkInterviewerInvitePreviews(read.interviewerTexts,shown);}catch(e){refuse(e.message);}
    pass('each session\'s interviewer invite goes to exactly its approved interviewers');
    step='candidate confirmation email';
    // On or Off in the communications list. Off is accepted and reported (the
    // Slack message says no confirmation email will be sent); the robot never
    // turns it on. On is opened and checked.
    const emailLink=await one(page.getByRole('link',{name:/^Candidate Confirmation Email (On|Off)$/}),'"Candidate Confirmation Email On" or "Off"');
    const emailState=/Off$/.test(((await emailLink.getAttribute('aria-label'))||(await emailLink.innerText())).replace(/\s+/g,' ').trim())?'off':'on';
    report.confirmationEmail=emailState;
    let from=null;
    if(emailState==='off')pass('candidate confirmation email is OFF for this schedule in Ashby: no confirmation email will be sent to the candidate');
    else{
      await after(()=>emailLink.click());
      if(!(await (await one(page.getByRole('checkbox',{name:'Send Candidate Confirmation Email',exact:true}),'"Send Candidate Confirmation Email"')).isChecked()))refuse('"Send Candidate Confirmation Email" is off; it must be on.');
      await until(()=>state.lastRefreshAt>state.lastSaveAt,'the candidate email preview to refresh after the last draft save');
      await sleep(T.short);
      // By structure. Each field is a <label> ("Subject"; its "*" is drawn by
      // CSS) in a wrapper, followed by the field's content: for the subject an
      // editable box (template placeholders render as chips inside it), for the
      // sender a button.
      const field=async(name,inner,what)=>{
        const label=await one(page.locator('label').filter({hasText:new RegExp(`^${name}$`)}),`the email's "${name}" label`);
        return one(label.locator(`xpath=../following-sibling::div[1]//${inner}`),what);
      };
      const subject=(await (await field('Subject','*[@contenteditable="true"]','the email\'s subject')).innerText()).replace(/\s+/g,' ').trim();
      const body=await (await one(page.getByRole('combobox',{name:'Rich text editor',exact:true}),'the email body')).innerText();
      if(!subject)refuse('Couldn\'t read the confirmation email\'s subject.');
      try{checkConfirmationEmail({subject,body},shown);}catch(e){refuse(e.message);}
      from=(await (await field('From','button','the email\'s sender')).innerText()).replace(/\s+/g,' ').trim()||null;
      if(!from||!/<[^>]+@[^>]+>/.test(from))refuse('Couldn\'t read who the confirmation email is from.');
      pass('candidate confirmation email is fresh and shows the approved date and times',{from});
    }
    // 5. A fresh read of the draft from Ashby, compared with the approval by
    // exact time, interview and interviewer, immediately before Schedule. It
    // repeats Ashby's own read of this draft (recorded as the composer loaded
    // it; a read, so the write guard lets it through). It runs on every
    // check, sending or not; anything unfamiliar refuses.
    step='re-read the draft';
    const lastRead=draftReads.at(-1);
    if(!lastRead){
      // Which exchanges mentioned the draft, and in what shape (no values).
      note({type:'draft-mentions',count:draftMentions.length,mentions:draftMentions});
      refuse('Couldn\'t find Ashby\'s own read of this draft to repeat, so it can\'t be checked again before Schedule.');
    }
    // The browser sets these itself; the rest are Ashby's own request headers.
    const headers=Object.fromEntries(Object.entries(lastRead.headers).filter(([k])=>!/^(?::|host$|cookie$|content-length$|origin$|referer$|user-agent$|accept-encoding$|connection$|sec-)/i.test(k)));
    const reread=await page.evaluate(async({body,headers})=>{
      const r=await fetch('/api/graphql',{method:'POST',headers,body,credentials:'include'});
      return {status:r.status,json:await r.json().catch(()=>null)};
    },{body:lastRead.body,headers}).catch(e=>({error:e.message}));
    if(reread.error||reread.status!==200)refuse(`Ashby didn't answer the re-read of this draft (${reread.error||`HTTP ${reread.status}`}).`);
    let rereadDraft;try{rereadDraft=draftReadCopy(reread.json,state.draftId);}catch(e){refuse(e.message);}
    try{checkFinal(normalizeDraft(rereadDraft),plan,{observeAlternates,created:state.created});}catch(e){refuse(`The draft as Ashby has it now doesn't match the approval: ${e.message}`);}
    pass(`draft re-read from Ashby (${lastRead.operationName}) just before Schedule, and it equals the approval exactly`);
    // 6. The Schedule button. On this layout clicking it sends at once.
    step='find Schedule';
    await ready('the screen before Schedule');
    const schedule=await one(page.getByRole('button',{name:'Schedule',exact:true}),'the Schedule button');
    if(!(await schedule.isEnabled()))refuse('The Schedule button is disabled.');
    report.wouldSend={op:OP.send,interviewScheduleId:plan.interviewScheduleId,draftInterviewScheduleId:state.draftId,from,
      sessions:state.last.map((e,i)=>({title:e.title,start:new Date(e.start).toISOString(),end:new Date(e.end).toISOString(),interviewers:plan.sessions[i].interviewers.map(x=>x.email)}))};
    // Every lock again, here: the announced plan, then the send gate (the
    // switch itself was checked by booking-compose.js).
    let notSending=!(send&&keepOnSuccess)?null:plan.send!==true?'The approved post didn\'t say it would send.':null;
    // Then the send gate: the send locks again, Ashby read again, and the
    // daily cap. Without a gate nothing is sent.
    if(send&&keepOnSuccess&&!notSending){
      step='send gate';
      let gate;
      try{gate=beforeSend?await beforeSend(plan):{reason:'No send gate was given.'};}catch(e){gate={reason:`The send gate failed: ${String(e.message).slice(0,200)}`};}
      if(gate){notSending=gate.reason;if(gate.cap)report.sendCap=gate.cap;}
      else pass('Ashby read again just before sending matches the approval, and the send is counted against the daily cap');
    }
    if(!(send&&keepOnSuccess)||notSending){
      if(notSending){report.sendSkipped=notSending;note({type:'send-skipped',reason:notSending});}
      pass(`Schedule button found and enabled (not clicked: ${keepOnSuccess?'left for a person to send':'dry run'})`);
      report.status=keepOnSuccess?'composed':'dry_run_complete';
    }else{
      // The one click. From here nothing is retried and nothing is refused:
      // the send may have happened, so whatever follows is reported.
      step='send';
      report.send={attempted:true,at:new Date().toISOString(),pathBefore:new URL(page.url()).pathname};
      const blockedBefore=guard.blocked.length;
      sending.armed=true;publishing.armed=true;emailing.armed=true;
      try{
        try{await schedule.click();}catch(e){report.send.clickError=String(e.message).slice(0,200);}
        const blockedOp=op=>guard.blocked.slice(blockedBefore).some(x=>x.summary.endsWith(' '+op));
        const sendBlockedByGuard=()=>blockedOp(OP.send),publishSettled=()=>publishing.reply!==undefined||blockedOp(OP.publish);
        // The confirmation email is only sent when it's on.
        const emailExpected=report.confirmationEmail==='on',emailSettled=()=>!emailExpected||emailing.reply!==undefined||blockedOp(OP.confirmationEmail);
        // Every write: the booking, then (after its reply) the invites and the email.
        const until30=Date.now()+30000;
        while(Date.now()<until30&&!((sending.reply!==undefined||sendBlockedByGuard())&&publishSettled()&&emailSettled()))await sleep(250);
        sending.armed=false;publishing.armed=false;emailing.armed=false;
        await sleep(T.short);
        report.send.reply=sending.reply||null;
        report.send.blockedByGuard=sendBlockedByGuard();
        report.send.publish={reply:publishing.reply||null,blockedByGuard:blockedOp(OP.publish),variables:publishing.variables};
        report.send.confirmationEmail={expected:emailExpected,reply:emailing.reply||null,blockedByGuard:blockedOp(OP.confirmationEmail),variables:emailing.variables};
        if(sending.mismatch)report.send.unmatchedVariables=sending.mismatch;
        report.send.attemptedWrites=guard.blocked.slice(blockedBefore).filter(x=>x.ashby).map(x=>x.summary);
        report.send.pathAfter=new URL(page.url()).pathname;
        // Dialogs are read, never answered.
        report.send.dialogs=(await page.locator('[role="dialog"],[role="alertdialog"]').allInnerTexts().catch(()=>[]))
          .map(t=>t.replace(/\s+/g,' ').trim().slice(0,300)).filter(t=>t&&!structuralDialogs(plan).has(t));
        note({type:'send',...report.send});
        note({type:'screen',at:'after-send',...await screenSnapshot(page,net).catch(e=>({error:e.message}))});
        // What Ashby shows for the invites: never claimed sent without this.
        report.invites=await inviteStatusOnPage(page,plan,{go,net,sleep}).catch(e=>({state:'unknown',evidence:[`couldn't read the schedule's page: ${String(e.message).slice(0,120)}`]}));
        note({type:'invites',...report.invites});
      }catch(e){report.send.reportError=String(e.message).slice(0,200);}
      finally{sending.armed=false;publishing.armed=false;emailing.armed=false;}
      if(!report.invites)report.invites={state:'unknown',evidence:['not read']};
      report.status=report.send.reply?.accepted?'sent':'send_uncertain';
      pass(report.status==='sent'?'Schedule clicked once and Ashby accepted the send':'Schedule clicked once; Ashby\'s answer to the send wasn\'t a clear acceptance (reported, not retried)');
    }
  }catch(e){
    report.step=e.step||step;report.reason=e.message;
    if(!(e instanceof Refusal))report.status='error';
    // Wherever it stopped: what the screen holds now (structure only).
    note({type:'screen',at:'refused',step:report.step,...await screenSnapshot(page,net).catch(err=>({error:err.message}))});
    // Where it stopped, without page contents: the path, dialog names, and
    // whether Ashby was showing one of its own error states.
    report.pageState=await page.evaluate(()=>({path:location.pathname,
      dialogs:[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].map(d=>d.getAttribute('aria-label')||(d.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)?.innerText||'').join(' ').trim()||d.querySelector('h1,h2,h3')?.innerText||'(unnamed)').map(n=>n.slice(0,60)),
      // The calendar-settings toast is Ashby reacting to a write the guard
      // blocks on purpose, so it isn't counted as a page error.
      ashbyError:(document.body.innerText.split('\n').filter(l=>!/Couldn.t save calendar settings/.test(l)).join('\n').match(/Something went wrong|problem with the network connection|Page not found/)||[null])[0]})).catch(()=>null);
    if(onRefusal)await onRefusal(page).catch(()=>{});
  }finally{
    report.draftId=state.draftId||report.draftId;
    // After a send attempt the draft is never deleted, and a run that ended in
    // an unexpected error after the click is still a possible send.
    if(report.send?.attempted&&!['sent','send_uncertain'].includes(report.status))report.status='send_uncertain';
    report.cleanup=!state.draftId?{deleted:false,reason:'no draft was created'}
      :report.send?.attempted?{deleted:false,kept:true,draftId:state.draftId,reason:'a send was attempted'}
      :keepOnSuccess&&report.status==='composed'?{deleted:false,kept:true,draftId:state.draftId}
      :await discard(page,plan,state,{one,go,sleep,T}).catch(e=>({deleted:false,reason:e.message}));
    // A draft left behind: what the screen held when the delete gave up.
    if(state.draftId&&!report.cleanup.deleted&&!report.cleanup.absent&&!report.cleanup.kept)note({type:'screen',at:'cleanup failed',...await screenSnapshot(page,net).catch(err=>({error:err.message}))});
    report.draftUrl=draftUrl(state.draftId);
    report.writes={saves:state.saves,refusedSaves:state.refusals?.length||0};
    report.blocked=[...new Set(guard.blocked.filter(b=>b.ashby).map(b=>b.summary))];
  }
  return report;
}

// The draft IDs listed on the schedule's Drafts page. Reached in-app, through
// the schedule first (a cold draft URL errors).
// `how` says which way the read went: 'tab' (the Drafts page was read) or
// 'none' (no Drafts page, on a plainly loaded schedule: draftsTab).
async function listDrafts(page,plan,{one,go,T}){
  await go(`/schedules/${plan.interviewScheduleId}`);await go(`/schedules/${plan.interviewScheduleId}/drafts`);
  if((await draftsTab(page,plan,{one,T})).none)return {ids:[],how:'none'};
  return {how:'tab',ids:await page.locator('a[href^="/schedules/drafts/"]').evaluateAll(links=>[...new Set(links.map(a=>a.getAttribute('href').split('/')[3]).filter(Boolean))])};
}

// The schedule's Drafts page, from a fresh load of the app, never from wherever
// the run stopped (October 28: from a composer stuck on "Saving...", changing
// the route in-app never showed the tab, and the draft was left). A fresh load
// also leaves the draft, so opening a communications screen again can't
// refresh it. Leaving a page with unsaved edits may ask first; leaving is the
// point, so that one question is accepted. A second fresh load if neither
// the tab nor a plainly empty schedule shows (draftsTab); then it refuses.
async function openDraftsTab(page,plan,{one,go,T}){
  for(let attempt=1;;attempt++){
    const leave=d=>{if(d.type()==='beforeunload')d.accept().catch(()=>{});};
    page.on('dialog',leave);
    try{await page.goto(ORIGIN+'/home/upcoming',{waitUntil:'domcontentloaded'});}finally{page.off('dialog',leave);}
    await page.getByRole('link',{name:'Pipeline',exact:true}).waitFor({state:'visible',timeout:T.wait});
    await go(`/schedules/${plan.interviewScheduleId}`);await go(`/schedules/${plan.interviewScheduleId}/drafts`);
    try{return await draftsTab(page,plan,{one,T});}
    catch(e){if(attempt>=2||!(e instanceof Refusal))throw e;}
  }
}

// The Drafts page, or plain evidence that the schedule has no drafts. Drafts
// is a link in the schedule's left sidebar, under SCHEDULES (Current / Drafts /
// Template), at /schedules/<id>/drafts. Whether Ashby ever hides it with no
// drafts is unconfirmed: the October 29 report of a missing Drafts tab was
// the sidebar link looked for across the top of the page, and at 00:52 that
// day the page showed its heading with none. So a missing heading is "no
// drafts" only on a schedule page that is plainly loaded and well: its Current
// and Template links showing, no Drafts link, no draft link anywhere, not
// "Saving...", and no
// Ashby error (the network is already quiet: go() waits for that). Anything
// else is the real failure (October 28: a composer stuck on "Saving..."), and
// the refusal says what was wrong. Returns {none:true} or {tab:true}.
async function draftsTab(page,plan,{one,T}){
  const heading=page.getByRole('heading',{name:'Draft Schedules',exact:true});
  if(await heading.waitFor({state:'visible',timeout:T.wait}).then(()=>true,()=>false)){await one(heading,'the Drafts page');return {tab:true};}
  const shown=await page.evaluate(id=>{
    const visible=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden';};
    const link=p=>[...document.querySelectorAll(`a[href="${p}"]`)].some(visible);
    const heads=[...document.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible).map(h=>h.innerText.replace(/\s+/g,' ').trim());
    return {path:location.pathname,current:link(`/schedules/${id}`),template:link(`/schedules/${id}/template`),drafts:link(`/schedules/${id}/drafts`),
      draftLinks:document.querySelectorAll('a[href^="/schedules/drafts/"]').length,saving:heads.some(h=>/Saving\.\.\./.test(h)),
      error:(document.body.innerText.match(/Something went wrong|problem with the network connection|Page not found/)||[null])[0]};
  },plan.interviewScheduleId);
  const why=noDraftsWhy(shown,plan.interviewScheduleId);
  if(!why.length)return {none:true};
  throw new Refusal('the Drafts page',`Couldn't find the schedule's Drafts page (left sidebar, under SCHEDULES): ${why.join('; ')}.`);
}
// What stops a page without the Drafts heading counting as "no drafts" (empty: it does).
function noDraftsWhy(s,scheduleId){
  const why=[];
  if(!String(s.path||'').startsWith(`/schedules/${scheduleId}`))why.push(`the page is ${s.path}, not this schedule`);
  if(!s.current||!s.template)why.push('the schedule\'s Current and Template links (left sidebar, under SCHEDULES) aren\'t showing');
  if(s.drafts)why.push('the Drafts link is in the sidebar but its page didn\'t show');
  if(s.draftLinks)why.push(`${s.draftLinks} draft link${s.draftLinks===1?' is':'s are'} on the page`);
  if(s.saving)why.push('Ashby shows "Saving..."');
  if(s.error)why.push(`Ashby shows "${s.error}"`);
  return why;
}

// Delete one draft from the schedule's Drafts page: the single button beside
// the single link to this exact draft. `permit.arm()` lets the delete through
// (for this draft only), and `permit.done()` says whether Ashby accepted it.
// Then confirm it's gone. With `allowAbsent`, a draft that isn't listed is
// reported as absent rather than refused.
async function deleteDraft(page,plan,draftId,permit,{one,go,sleep,T,allowAbsent=false}){
  // A schedule plainly showing no drafts: there's nothing to delete.
  if((await openDraftsTab(page,plan,{one,go,T})).none)return {deleted:false,absent:true,draftId};
  const links=page.locator(`a[href="/schedules/drafts/${draftId}"]`);
  if(allowAbsent&&!(await links.count()))return {deleted:false,absent:true,draftId};
  const link=await one(links,'the link to this draft');
  const button=await one(link.locator('xpath=..').locator('> button'),'the delete button beside this draft');
  permit.arm();
  await button.click();
  const d=Date.now()+T.wait;while(Date.now()<d&&permit.done()===undefined)await sleep(250);
  if(!permit.done())return {deleted:false,reason:'Ashby didn\'t confirm the delete',draftId};
  await go(`/schedules/${plan.interviewScheduleId}`);await go(`/schedules/${plan.interviewScheduleId}/drafts`);
  const left=await page.locator(`a[href="/schedules/drafts/${draftId}"]`).count();
  return left?{deleted:false,reason:'the draft is still listed after deleting',draftId}:{deleted:true,draftId};
}

// Delete the run's draft, with the discard permitted only now and only for it.
async function discard(page,plan,state,h){
  return deleteDraft(page,plan,state.draftId,{arm:()=>{state.cleanup=true;},done:()=>state.discarded},h);
}

// The invite status of a booked schedule, for the dashboard (a send that
// wasn't confirmed, or a robot send recorded without this evidence). Read
// only: no permits, every write blocked. Never throws: unknown on failure.
async function readInviteStatus({context,page,plan,log=()=>{},timing={},expectedIdentity}){
  const T={settle:700,short:1500,wait:15000,...timing};
  const guard=await guardWrites(context,{warn:m=>log({type:'blocked',ashby:!!guard.blocked[guard.blocked.length-1]?.ashby,detail:m.replace('[write-guard] ','')})});
  const refuse=m=>{throw new Refusal('read invite status',m);};
  const h=helpers(page,T,refuse),net=h.net;
  try{
    await openApplication(page,plan,{refuse,sleep:h.sleep,go:h.go,net,T,expectedIdentity});
    return await inviteStatusOnPage(page,plan,{go:h.go,net,sleep:h.sleep});
  }catch(e){return {state:'unknown',evidence:[`couldn't read the schedule's page: ${String(e.message).slice(0,120)}`]};}
  finally{log({type:'blocked-summary',blocked:[...new Set(guard.blocked.filter(b=>b.ashby).map(b=>b.summary))]});}
}

// Delete a draft the Slack-approved check left in Ashby (the dashboard's sweep):
// open the application, then delete exactly that draft. Its only permitted
// write is that one delete; a draft no longer listed (sent, or deleted by a
// person) is reported as absent. Never throws: the result says what happened.
async function discardDraft({context,page,plan,draftId,log=()=>{},timing={},respond,expectedIdentity}){
  const T={settle:700,short:1500,wait:15000,...timing};
  const guard=await guardWrites(context,{warn:m=>log({type:'blocked',ashby:!!guard.blocked[guard.blocked.length-1]?.ashby,detail:m.replace('[write-guard] ','')})});
  const flag={armed:false,discarded:undefined};
  await installPermit(context,{op:OP.discard,max:1,log,capture:true,...(respond?{respond}:{}),
    bound:v=>flag.armed&&v.draftInterviewScheduleId===draftId,onResponse:json=>{flag.discarded=replied(json);}});
  let step='open the application';
  const refuse=m=>{throw new Refusal(step,m);};
  const h=helpers(page,T,refuse);
  try{
    await openApplication(page,plan,{refuse,sleep:h.sleep,go:h.go,net:h.net,T,expectedIdentity});
    step='delete the draft';
    const r=await deleteDraft(page,plan,draftId,{arm:()=>{flag.armed=true;},done:()=>flag.discarded},{...h,T,allowAbsent:true});
    if(!r.deleted&&!r.absent)log({type:'screen',at:'cleanup failed',...await screenSnapshot(page,h.net).catch(err=>({error:err.message}))});
    return {...r,draftUrl:draftUrl(draftId)};
  }catch(e){
    log({type:'screen',at:'cleanup failed',step,...await screenSnapshot(page,h.net).catch(err=>({error:err.message}))});
    return {deleted:false,draftId,draftUrl:draftUrl(draftId),step,reason:e.message};
  }
  finally{log({type:'blocked-summary',blocked:[...new Set(guard.blocked.filter(b=>b.ashby).map(b=>b.summary))]});}
}

module.exports={dryRun,discardDraft,draftUrl,noDraftsWhy,expectedBlock,readInviteStatus,helpers,openApplication,networkWatch,screenSnapshot,readInviteSettings,readPreviewSections,Refusal};
