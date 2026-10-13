'use strict';
// Booking through Ashby's scheduling UI, as a dry run: every step up to the
// "Schedule" click, then the draft is deleted. Nothing is sent: Send isn't a
// permitted write (booking-permit.js), and this file never clicks Schedule.
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
const {installBookingPermits,ORIGIN,OP}=require('./booking-permit');
const {checkFinal,formats,checkInvitePreview,checkInterviewerInvitePreview,checkConfirmationEmail,classifyDialog}=require('./booking-check');

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
async function openApplication(page,plan,{refuse,sleep,go,net,T}){
  for(let attempt=1;attempt<=2;attempt++){
    net.mark();
    if(attempt===1){await page.goto(ORIGIN+'/home/upcoming',{waitUntil:'domcontentloaded'});
      await page.getByRole('link',{name:'Pipeline',exact:true}).waitFor({state:'visible',timeout:T.wait});}
    else await go('/home/upcoming');
    if(!(await net.settled()))refuse('Ashby didn\'t finish loading.');
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

// `respond` is for tests only: a stand-in for Ashby's replies to permitted writes.
// `onRefusal(page)` runs before cleanup when the run stops (local debugging).
async function dryRun({context,page,plan,log=()=>{},timing={},respond,onRefusal}){
  const T={settle:700,short:1500,wait:15000,...timing};
  const events=[];const note=e=>{events.push(e);log(e);};
  const guard=await guardWrites(context,{warn:m=>note({type:'blocked',detail:m.replace('[write-guard] ','')})});
  const state={};
  await installBookingPermits(context,{plan,state,log:note,...(respond?{respond}:{})});
  let step='start';
  const refuse=m=>{throw new Refusal(step,m);};
  const sleep=ms=>page.waitForTimeout(ms);
  async function one(locator,what){
    const deadline=Date.now()+T.wait;let n=0;
    while(Date.now()<deadline){n=await locator.count();if(n===1)return locator;if(n>1)refuse(`Expected exactly one ${what}; found ${n}.`);await sleep(250);}
    refuse(`Couldn't find ${what}.`);
  }
  async function until(fn,what,ms=T.wait){const d=Date.now()+ms;while(Date.now()<d){if(await fn())return;await sleep(250);}refuse(`Timed out waiting for ${what}.`);}
  async function go(path){await page.evaluate(u=>{history.pushState({},'',u);dispatchEvent(new PopStateEvent('popstate'));},path);await sleep(T.short);}
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
  const report={mode:'dry-run',status:'refused',step:null,reason:null,draftId:null,checks:[],wouldSend:null,cleanup:null};
  const pass=(name,detail)=>{report.checks.push({name,ok:true,...(detail?{detail}:{})});note({type:'check',name});};
  try{
    // 1. Ashby's shell, then the application inside the app. A cold load of a
    // deep URL shows an error page under the guard.
    step='open the application';
    const opened=await openApplication(page,plan,{refuse,sleep,go,net,T});
    pass('candidate panel shows the approved candidate',opened.attempts>1?{attempts:opened.attempts}:undefined);
    // 2. The scheduling card's Actions menu, then exactly "Manual Schedule".
    step='open Manual Schedule';
    const heading=await one(page.getByRole('heading',{name:plan.activityTitle,exact:true}),`the "${plan.activityTitle}" card`);
    const card=heading.locator('xpath=ancestor::*[.//button[normalize-space(.)="Actions"]][1]');
    const actions=await one(card.getByRole('button',{name:'Actions',exact:true}),'the card\'s Actions button');
    await after(()=>actions.click());
    const menu=await one(page.getByRole('menu',{name:'Actions'}),'the Actions menu');
    const manual=await one(menu.getByRole('menuitem',{name:'Manual Schedule',exact:true}),'"Manual Schedule" in the Actions menu');
    await after(()=>manual.click());
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
    for(let i=0;i<plan.sessions.length;i++){
      const s=plan.sessions[i],a=formats(s.start,plan.timeZone),b=formats(s.end,plan.timeZone);
      step=`compose "${s.title}"`;
      const zones=page.getByRole('button',{name:'Select a timezone',exact:true}).filter({hasText:new RegExp(`^${esc(a.zone)}$`)});
      if(!(await zones.count()))refuse(`The composer doesn't show times in ${a.zone}; the account's time zone must match the plan's (${plan.timeZone}).`);
      const wantDate=a.shortDate.replace(/, \d{4}$/,'');// "Tue, Oct 20"
      if(await dates.nth(i).inputValue()!==wantDate){await after(async()=>{await dates.nth(i).click();await dates.nth(i).fill(wantDate);await page.keyboard.press('Enter');});}
      for(const [field,want] of [[starts,a.lower],[ends,b.lower]]){
        if(await field.nth(i).inputValue()===want)continue;
        await after(async()=>{await field.nth(i).click();await field.nth(i).fill(want);
          const option=await one(page.getByRole('option',{name:want,exact:true}),`the "${want}" option`);await option.click();});
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
    for(const name of ['Send Candidate Invite','Send Interviewer Invite'])
      if(!(await (await one(page.getByRole('checkbox',{name,exact:true}),`"${name}"`)).isChecked()))refuse(`"${name}" is off; it must be on.`);
    pass('candidate and interviewer invites are on');
    const previews=page.getByRole('tabpanel',{name:'Preview'});
    if(await previews.count()!==2)refuse(`Expected the candidate and interviewer invite previews; found ${await previews.count()}.`);
    // Ashby lists the candidate invite first, then the interviewers'.
    const order=await page.getByRole('heading',{level:2}).allInnerTexts();
    if(order.indexOf('Candidate Invite')<0||order.indexOf('Interviewer Invite')<order.indexOf('Candidate Invite'))refuse('Couldn\'t tell the candidate invite from the interviewer invite.');
    checkInvitePreview(await previews.nth(0).innerText(),plan);
    pass('candidate invite preview shows the approved date, agenda and only the candidate');
    checkInterviewerInvitePreview(await previews.nth(1).innerText(),plan);
    pass('interviewer invite preview goes to exactly the approved interviewers');
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
    pass('Schedule button found and enabled (not clicked: dry run)');
    report.status='dry_run_complete';
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
    report.cleanup=state.draftId?await discard(page,plan,state,{one,go,sleep,T}).catch(e=>({deleted:false,reason:e.message})):{deleted:false,reason:'no draft was created'};
    report.writes={saves:state.saves,refusedSaves:state.refusals?.length||0};
    report.blocked=[...new Set(guard.blocked.filter(b=>b.ashby).map(b=>b.summary))];
  }
  return report;
}

// Delete the run's draft from the schedule's Drafts tab: the single button
// beside the single link to this exact draft, with the discard permitted only
// now and only for this draft. Then confirm it's gone.
async function discard(page,plan,state,{one,go,sleep,T}){
  state.cleanup=true;
  // Leave the draft (opening a communications screen again would refresh it).
  await go(`/schedules/${plan.interviewScheduleId}`);await go(`/schedules/${plan.interviewScheduleId}/drafts`);
  await one(page.getByRole('heading',{name:'Draft Schedules',exact:true}),'the Drafts tab');
  const link=await one(page.locator(`a[href="/schedules/drafts/${state.draftId}"]`),'the link to this draft');
  const button=await one(link.locator('xpath=..').locator('> button'),'the delete button beside this draft');
  await button.click();
  const d=Date.now()+T.wait;while(Date.now()<d&&state.discarded===undefined)await sleep(250);
  if(!state.discarded)return {deleted:false,reason:'Ashby didn\'t confirm the delete',draftId:state.draftId};
  await go(`/schedules/${plan.interviewScheduleId}`);await go(`/schedules/${plan.interviewScheduleId}/drafts`);
  const left=await page.locator(`a[href="/schedules/drafts/${state.draftId}"]`).count();
  return left?{deleted:false,reason:'the draft is still listed after deleting',draftId:state.draftId}:{deleted:true,draftId:state.draftId};
}

module.exports={dryRun,openApplication,networkWatch,Refusal};
