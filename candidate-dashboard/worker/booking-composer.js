'use strict';
// Booking through Ashby's scheduling UI, up to the "Schedule" click, which is
// never made. The dry run (booking-dry-run.js) then deletes the draft; the
// Slack-approved check (booking-compose.js) leaves it for a person to send,
// and deletes it on any refusal. Nothing is sent: Send isn't a permitted write
// (booking-permit.js), and this file never clicks Schedule.
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
const {guardWrites}=require('./template-guard');
const {installBookingPermits,installPermit,ORIGIN,OP}=require('./booking-permit');
const {checkFinal,formats,checkInvitePreview,checkInterviewerInvitePreviews,checkConfirmationEmail,classifyDialog}=require('./booking-check');

class Refusal extends Error{constructor(step,message){super(message);this.step=step;this.status=409;}}
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// Dialogs that are part of the page, not warnings: the candidate panel, which
// Ashby names after the candidate ("Candidate profile" only while loading).
const structuralDialogs=plan=>new Set(['Candidate profile',plan.candidate.name]);
// Writes Ashby attempts on its own that the guard blocks and the run ignores.
const EXPECTED_BLOCKED=new Set(['ApiUpdateDraftScheduleCalendarSettings']);

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
  return {mark(){since=finished;},async settled(){const d=Date.now()+wait;while(Date.now()<d){if(finished>since&&inflight===0&&Date.now()-lastChange>=1000)return true;await sleep(200);}return false;}};
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

// Waiting and finding, shared by the run and by deleting a draft on its own.
function helpers(page,T,refuse){
  const sleep=ms=>page.waitForTimeout(ms);
  async function one(locator,what){
    const deadline=Date.now()+T.wait;let n=0;
    while(Date.now()<deadline){n=await locator.count();if(n===1)return locator;if(n>1)refuse(`Expected exactly one ${what}; found ${n}.`);await sleep(250);}
    refuse(`Couldn't find ${what}.`);
  }
  async function until(fn,what,ms=T.wait){const d=Date.now()+ms;while(Date.now()<d){if(await fn())return;await sleep(250);}refuse(`Timed out waiting for ${what}.`);}
  async function go(path){await page.evaluate(u=>{history.pushState({},'',u);dispatchEvent(new PopStateEvent('popstate'));},path);await sleep(T.short);}
  return {sleep,one,until,go};
}
const replied=json=>!!json&&!(json.errors&&json.errors.length);

// `respond` is for tests only: a stand-in for Ashby's replies to permitted writes.
// `onRefusal(page)` runs before cleanup when the run stops (local debugging).
// `expectedIdentity` is the Ashby account the run must be signed in as.
// For the Slack-approved check (booking-compose.js), not the dry run:
//   `checkExistingDrafts` refuses before creating a draft if the schedule
//     already has one, other than `supersedeDraftId` (the dashboard's earlier
//     draft for this schedule), which is deleted first;
//   `keepOnSuccess` leaves the composed draft in Ashby for a person to send.
//     Any refusal still deletes it.
async function dryRun({context,page,plan,log=()=>{},timing={},respond,onRefusal,expectedIdentity,checkExistingDrafts=false,supersedeDraftId=null,keepOnSuccess=false}){
  const T={settle:700,short:1500,wait:15000,...timing};
  const events=[];const note=e=>{events.push(e);log(e);};
  const guard=await guardWrites(context,{warn:m=>note({type:'blocked',detail:m.replace('[write-guard] ','')})});
  const state={};
  await installBookingPermits(context,{plan,state,log:note,...(respond?{respond}:{})});
  // The earlier draft's delete: that draft only, once, and only while armed.
  const superseding={armed:false,discarded:undefined};
  if(supersedeDraftId)await installPermit(context,{op:OP.discard,max:1,log:note,...(respond?{respond}:{}),
    bound:v=>superseding.armed&&v.draftInterviewScheduleId===supersedeDraftId,onResponse:json=>{superseding.discarded=replied(json);}});
  let step='start';
  const refuse=m=>{throw new Refusal(step,m);};
  const {sleep,one,until,go}=helpers(page,T,refuse);
  const net=networkWatch(page,{sleep,wait:T.wait});
  // After every action: let Ashby react, then check dialogs, refused saves and
  // any write the guard blocked that it shouldn't have needed to.
  let seenRefusals=0,seenBlocked=0;
  async function after(action){
    await action();await sleep(T.settle);
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
    const unexpected=guard.blocked.slice(seenBlocked).filter(b=>b.ashby&&!(b.mutation&&[...EXPECTED_BLOCKED].some(n=>b.summary.endsWith(' '+n))));
    seenBlocked=guard.blocked.length;
    if(unexpected.length)refuse(`Ashby tried a write the booking doesn't permit: ${unexpected.map(b=>b.summary).join('; ')}.`);
    seenRefusals=state.refusals.length;
  }
  const report={mode:keepOnSuccess?'compose':'dry-run',status:'refused',step:null,reason:null,draftId:null,checks:[],wouldSend:null,cleanup:null};
  const pass=(name,detail)=>{report.checks.push({name,ok:true,...(detail?{detail}:{})});note({type:'check',name,...(detail?.draftId?{draftId:detail.draftId}:{})});};
  try{
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
      let ids=await listDrafts(page,plan,{one,go});
      if(supersedeDraftId&&ids.includes(supersedeDraftId)){
        const r=await deleteDraft(page,plan,supersedeDraftId,{arm:()=>{superseding.armed=true;},done:()=>superseding.discarded},{one,go,sleep,T});
        if(!r.deleted)refuse(`Couldn't delete the earlier draft the dashboard composed for this schedule: ${r.reason}.`);
        report.superseded={draftId:supersedeDraftId,deleted:true};
        ids=await listDrafts(page,plan,{one,go});
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
      const s=plan.sessions[i],a=formats(s.start,plan.timeZone),b=formats(s.end,plan.timeZone),eventId=state.last[i].id,what=`session ${i+1} ("${s.title}")`;
      step=`compose ${what}`;
      // The zone button can render a moment after the fields. A mismatch names
      // what Ashby shows, since that's the only way to tell a wrong account
      // zone from a different label for the right one.
      const zoneButtons=page.getByRole('button',{name:'Select a timezone',exact:true});
      {const d=Date.now()+T.wait;while(Date.now()<d&&!(await zoneButtons.count()))await sleep(250);}
      const zones=zoneButtons.filter({hasText:new RegExp(`^${esc(a.zone)}$`)});
      if(!(await zones.count())){
        const shown=[...new Set((await zoneButtons.allInnerTexts()).map(t=>t.replace(/\s+/g,' ').trim().slice(0,40)))].slice(0,3);
        refuse(`The composer shows times in ${shown.length?shown.map(t=>`"${t}"`).join(', '):'no time zone (there\'s no "Select a timezone" button)'}, not ${a.zone}; the account's time zone must match the plan's (${plan.timeZone}).`);
      }
      const wantDate=a.shortDate.replace(/, \d{4}$/,'');// "Tue, Oct 20"
      {const {date}=await editor(eventId,what);
        if(await date.inputValue()!==wantDate)await after(async()=>{await date.click();await date.fill(wantDate);await page.keyboard.press('Enter');});}
      for(const [k,want] of [['start',a.lower],['end',b.lower]]){
        const field=(await editor(eventId,what))[k];
        if(await field.inputValue()===want)continue;
        await after(async()=>{await field.click();await field.fill(want);
          const option=await one(timeOption(want),`the "${want}" option for ${what}'s ${k}`);await option.click();});
      }
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
    checkFinal(state.last,plan);
    pass('final draft save equals the approval exactly',{saves:state.saves});
    // 4. Communications: invites and the candidate email must say what was approved.
    step='configure communications';
    await after(async()=>(await one(page.getByRole('button',{name:'Configure Communications',exact:true}),'"Configure Communications"')).click());
    await until(async()=>new URL(page.url()).pathname===`/schedules/drafts/${state.draftId}/communication/calendar-invites`,'the Calendar Invites screen');
    // "Send Interviewer Invite" for one session, "...Invites" for several.
    const interviewerBox=page.getByRole('checkbox',{name:/^Send Interviewer Invites?$/});
    for(const [box,name] of [[page.getByRole('checkbox',{name:'Send Candidate Invite',exact:true}),'Send Candidate Invite'],[interviewerBox,'Send Interviewer Invite(s)']])
      if(!(await (await one(box,`"${name}"`)).isChecked()))refuse(`"${name}" is off; it must be on.`);
    pass('candidate and interviewer invites are on');
    // Previews: the candidate's first, then one per session for interviewers.
    const previews=page.getByRole('tabpanel',{name:'Preview'});
    // Ashby draws the previews after the screen opens: read until their
    // content is present (bounded by T.wait), then check that read. If it
    // never fills in, the checks below refuse, naming what was missing.
    const readPreviews=async()=>{
      const n=await previews.count();if(n!==1+plan.sessions.length)return {n};
      // The agenda's top-level items, each as text (a name may sit in a nested list).
      const agendaItems=await previews.nth(0).evaluate(panel=>{
        const list=[...panel.querySelectorAll('ul,ol')].find(l=>[...l.children].length&&[...l.children].every(li=>/^\s*\d{1,2}:\d\d [AP]M - /.test(li.innerText)));
        return list?[...list.children].map(li=>li.innerText):[];
      });
      const candidateText=await previews.nth(0).innerText();
      const interviewerTexts=[];for(let k=1;k<=plan.sessions.length;k++)interviewerTexts.push(await previews.nth(k).innerText());
      return {n,agendaItems,candidateText,interviewerTexts};
    };
    const present=r=>r.agendaItems?.length===plan.sessions.length&&r.candidateText.trim()&&r.interviewerTexts.every(t=>t.trim());
    let read;const readBy=Date.now()+T.wait;
    while(!present(read=await readPreviews())&&Date.now()<readBy)await sleep(250);
    if(read.n!==1+plan.sessions.length)refuse(`Expected a candidate invite preview and ${plan.sessions.length} interviewer invite preview${plan.sessions.length===1?'':'s'}; found ${read.n} previews.`);
    const order=await page.getByRole('heading',{level:2}).allInnerTexts();
    const ci=order.indexOf('Candidate Invite'),ii=order.findIndex(h=>/^Interviewer Invites?$/.test(h));
    if(ci<0||ii<ci)refuse('Couldn\'t tell the candidate invite from the interviewer invites.');
    checkInvitePreview(read.candidateText,plan,read.agendaItems);
    pass('candidate invite preview shows the approved date, agenda and only the candidate');
    checkInterviewerInvitePreviews(read.interviewerTexts,plan);
    pass('each session\'s interviewer invite goes to exactly its approved interviewers');
    step='candidate confirmation email';
    await after(async()=>(await one(page.getByRole('link',{name:'Candidate Confirmation Email On',exact:true}),'"Candidate Confirmation Email On"')).click());
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
    checkConfirmationEmail({subject,body},plan);
    const from=(await (await field('From','button','the email\'s sender')).innerText()).replace(/\s+/g,' ').trim()||null;
    if(!from||!/<[^>]+@[^>]+>/.test(from))refuse('Couldn\'t read who the confirmation email is from.');
    pass('candidate confirmation email is fresh and shows the approved date and times',{from});
    // 5. The Schedule button: found, and never clicked in a dry run.
    step='find Schedule';
    const schedule=await one(page.getByRole('button',{name:'Schedule',exact:true}),'the Schedule button');
    if(!(await schedule.isEnabled()))refuse('The Schedule button is disabled.');
    report.wouldSend={op:OP.send,interviewScheduleId:plan.interviewScheduleId,draftInterviewScheduleId:state.draftId,from,
      sessions:state.last.map((e,i)=>({title:e.title,start:new Date(e.start).toISOString(),end:new Date(e.end).toISOString(),interviewers:plan.sessions[i].interviewers.map(x=>x.email)}))};
    pass(`Schedule button found and enabled (not clicked: ${keepOnSuccess?'left for a person to send':'dry run'})`);
    report.status=keepOnSuccess?'composed':'dry_run_complete';
  }catch(e){
    report.step=e.step||step;report.reason=e.message;
    if(!(e instanceof Refusal))report.status='error';
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
    report.cleanup=!state.draftId?{deleted:false,reason:'no draft was created'}
      :keepOnSuccess&&report.status==='composed'?{deleted:false,kept:true,draftId:state.draftId}
      :await discard(page,plan,state,{one,go,sleep,T}).catch(e=>({deleted:false,reason:e.message}));
    report.writes={saves:state.saves,refusedSaves:state.refusals?.length||0};
    report.blocked=[...new Set(guard.blocked.filter(b=>b.ashby).map(b=>b.summary))];
  }
  return report;
}

// The draft IDs listed on the schedule's Drafts tab. Reached in-app, through
// the schedule first (a cold draft URL errors).
async function listDrafts(page,plan,{one,go}){
  await go(`/schedules/${plan.interviewScheduleId}`);await go(`/schedules/${plan.interviewScheduleId}/drafts`);
  await one(page.getByRole('heading',{name:'Draft Schedules',exact:true}),'the Drafts tab');
  return page.locator('a[href^="/schedules/drafts/"]').evaluateAll(links=>[...new Set(links.map(a=>a.getAttribute('href').split('/')[3]).filter(Boolean))]);
}

// Delete one draft from the schedule's Drafts tab: the single button beside
// the single link to this exact draft. `permit.arm()` lets the delete through
// (for this draft only), and `permit.done()` says whether Ashby accepted it.
// Then confirm it's gone. With `allowAbsent`, a draft that isn't listed is
// reported as absent rather than refused.
async function deleteDraft(page,plan,draftId,permit,{one,go,sleep,T,allowAbsent=false}){
  // Leave the draft (opening a communications screen again would refresh it).
  await go(`/schedules/${plan.interviewScheduleId}`);await go(`/schedules/${plan.interviewScheduleId}/drafts`);
  await one(page.getByRole('heading',{name:'Draft Schedules',exact:true}),'the Drafts tab');
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

// Delete a draft the Slack-approved check left in Ashby (the dashboard's sweep):
// open the application, then delete exactly that draft. Its only permitted
// write is that one delete; a draft no longer listed (sent, or deleted by a
// person) is reported as absent. Never throws: the result says what happened.
async function discardDraft({context,page,plan,draftId,log=()=>{},timing={},respond,expectedIdentity}){
  const T={settle:700,short:1500,wait:15000,...timing};
  const guard=await guardWrites(context,{warn:m=>log({type:'blocked',detail:m.replace('[write-guard] ','')})});
  const flag={armed:false,discarded:undefined};
  await installPermit(context,{op:OP.discard,max:1,log,...(respond?{respond}:{}),
    bound:v=>flag.armed&&v.draftInterviewScheduleId===draftId,onResponse:json=>{flag.discarded=replied(json);}});
  let step='open the application';
  const refuse=m=>{throw new Refusal(step,m);};
  const h=helpers(page,T,refuse);
  try{
    await openApplication(page,plan,{refuse,sleep:h.sleep,go:h.go,net:networkWatch(page,{sleep:h.sleep,wait:T.wait}),T,expectedIdentity});
    step='delete the draft';
    return await deleteDraft(page,plan,draftId,{arm:()=>{flag.armed=true;},done:()=>flag.discarded},{...h,T,allowAbsent:true});
  }catch(e){return {deleted:false,draftId,step,reason:e.message};}
  finally{log({type:'blocked-summary',blocked:[...new Set(guard.blocked.filter(b=>b.ashby).map(b=>b.summary))]});}
}

module.exports={dryRun,discardDraft,openApplication,networkWatch,Refusal};
