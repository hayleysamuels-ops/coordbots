'use strict';
const fail=message=>{throw Object.assign(Error(message),{status:409});};
// Ashby fills an interviewer slot from one of: Specific Employees (a named
// list, any one of whom takes it), Employees from Pool (an interviewer pool,
// optionally only qualified people or only trainees), a Hiring Team Role (the
// candidate's Recruiter, Hiring Manager, ..., or whoever moved them to this
// stage), or an Advanced matcher (conditions on employee attributes). Slots are
// ANDed: two slots means two interviewers. Supported: one slot, filled by
// Specific Employees or by an Advanced matcher that only names employees
// ("Employee's Employee is ..."). Everything else is refused by name, saying
// what was found and what to change.
const HIRING_ROLES=['Hiring Manager','Recruiter','Recruiting Coordinator','Sourcer'];
const quote=v=>`"${String(v).replace(/\s+/g,' ').trim().slice(0,80)}"`;
function parseAssignment(text,title='This interview'){
  text=text.replace(/Specific\s+Employees\s*:/g,'Specific Employees:').replace(/(\d+)\s+Employees?/g,'$1 Employees').replace(/Add\s+Interviewer\s+Slot/g,'Add Interviewer Slot').replace(/Search\s+for\s+user\s*\.\.\./g,'Search for user...').replace(/Select\s+matcher\s*\.\.\./g,'Select matcher...').replace(/(\d+)\s*Eligible\s*Match(es)?/g,'$1 Eligible Match$2').replace(/\bis\s*\n\s*/g,'is ').replace(/^Interviewers\s*\n\s*(\d+)$/m,'Interviewers $1').replace(/\b(All|Any)\s*\n\s*are\s+true\s*:/g,'$1 are true:');
  const lines=text.split('\n').map(s=>s.trim()).filter(Boolean);
  const name=quote(title).slice(1,-1);
  const refuse=(found,fix)=>fail(`"${name}": ${found}, which isn't supported. ${fix}`);
  const namedFix='Only named interviewers are supported: use Specific Employees in the template.';
  const slotStarts=lines.map((s,i)=>/^Slot\s*#\d+\b/.test(s)?i:-1).filter(i=>i>=0);
  if(!slotStarts.length)refuse(`no interviewer slot could be found (Ashby shows ${quote(lines.slice(1,4).join(' · ')||'nothing')})`,namedFix);
  if(slotStarts.length>1)refuse(`it has ${slotStarts.length} interviewer slots, so it needs ${slotStarts.length} interviewers on the panel`,'Only single-interviewer events are supported: use one slot that lists every eligible interviewer.');
  // Ashby heads the section "Interviewers N", N being its slot count.
  const heading=lines.map(l=>l.match(/^Interviewers (\d+)$/)).find(Boolean);
  if(heading&&Number(heading[1])!==slotStarts.length)fail(`"${name}": Ashby shows "Interviewers ${heading[1]}" but ${slotStarts.length} slot${slotStarts.length===1?' was':'s were'} read. Load the plan again; if it persists, check the event in Ashby.`);
  const slot=lines.slice(slotStarts[0]+1,lines.includes('Add Interviewer Slot')?lines.lastIndexOf('Add Interviewer Slot'):undefined);
  const slotText=slot.join('\n');
  const pool=slot.find(s=>/\bpools?\b/i.test(s));
  if(pool)refuse(`Slot #1 draws from an interviewer pool (Ashby shows ${quote(pool)})`,namedFix);
  const role=slot.find(s=>HIRING_ROLES.includes(s.replace(/[:.]$/,''))||/hiring\s+team/i.test(s)||/moved the candidate/i.test(s));
  if(role)refuse(/moved the candidate/i.test(role)?'Slot #1 goes to whoever moved the candidate to this stage':`Slot #1 is filled by the candidate's hiring team role (${quote(role)})`,namedFix);
  const matches=[...slotText.matchAll(/(\d+) Eligible Match(?:es)?/g)];
  if(matches.length!==1)refuse(`Slot #1 shows ${matches.length?`${matches.length} eligible-match counts`:'no eligible-match count'} (Ashby shows ${quote(slot.slice(0,3).join(' · '))})`,namedFix);
  const count=Number(matches[0][1]);
  let names;
  const employees=slot.findIndex(s=>/^\d+ Employees?$/.test(s));
  if(slot.includes('Specific Employees:')&&employees>=0){names=slot.slice(employees+1).map(s=>s.replace(/^OR\s+/,''));}
  else {
    // Advanced matcher: only conditions naming employees are supported.
    const attributes=[...new Set(slot.map(s=>s.match(/^Employee's\s+(.+)$/)?.[1]).filter(Boolean))];
    if(!attributes.length)refuse(`Slot #1 uses a rule the reader doesn't recognise (Ashby shows ${quote(slot.slice(1,4).join(' · '))})`,namedFix);
    const other=attributes.filter(a=>a!=='Employee');
    if(other.length)refuse(`Slot #1 uses an Advanced matcher on ${other.map(a=>`the employee's ${a.toLowerCase()}`).join(' and ')}`,'Only named interviewers are supported: use Specific Employees, or an Advanced matcher that only names employees ("Employee\'s Employee is ...").');
    if(slot.some(s=>/^Any are true:?$/i.test(s)))refuse('Slot #1 uses an Advanced matcher where any condition can match','Only conditions that all hold are supported: use Specific Employees, or "All are true" with "Employee\'s Employee is ...".');
    if(slot.some(s=>/^is not\b/i.test(s)))refuse('Slot #1 uses an Advanced matcher that excludes employees ("is not")','Only conditions naming who can take it are supported: use Specific Employees, or "Employee\'s Employee is ...".');
    const start=slot.findIndex(s=>/^is\s+/.test(s)),end=slot.indexOf('Search for user...');
    if(start<0||end<=start)refuse('Slot #1 uses an Advanced matcher whose employee list could not be read',namedFix);
    names=slot.slice(start,end).filter(s=>!['Search for user...','is'].includes(s)).map(s=>s.replace(/^is\s+/,''));
  }
  names=[...new Set(names.filter(s=>s&&!/^OR$/.test(s)&&s!=='Select matcher...'))];
  const bad=names.find(n=>!/^\p{L}[\p{L} .’'\-]+$/u.test(n));
  if(bad)fail(`"${name}": Slot #1 lists ${quote(bad)}, which doesn't read as an employee's name. Check the slot in Ashby.`);
  // Never loosened: a name that isn't a real eligible interviewer would go to
  // the solver and could be proposed for a real interview. The names read are
  // listed (and logged) so the stray one can be identified.
  if(!count||names.length!==count){
    const read=names.map(quote).join(', ')||'none';
    console.warn(`[plan-reader] "${name}" Slot #1: ${count} eligible, read ${names.length}: ${read}. Slot lines: ${slot.map(quote).join(' | ')}`);
    fail(`"${name}": Slot #1 says ${count} eligible match${count===1?'':'es'} but ${names.length} name${names.length===1?' was':'s were'} read from it (${read}). Check the slot in Ashby, then load the plan again.`);
  }
  return {requiredCount:1,eligibleInterviewers:names.map(name=>({name})),assignmentVerified:true};
}
// A read failure (Ashby didn't load what we need) is a different thing from a
// mismatch (Ashby loaded, and the template differs from the published plan).
// Read failures are 503s naming the cause; mismatches are one 409 listing every
// difference found: missing, repeated, wrong duration, out of order, extra.
const readFail=message=>{throw Object.assign(Error(message),{status:503,kind:'read'});};
const timedOut=e=>e?.name==='TimeoutError'||/Timeout \d+ms exceeded/.test(e?.message||'');
async function step(work,message){try{return await work();}catch(e){if(timedOut(e))readFail(message);throw e;}}

// Expanding a collapsed event is the only interaction the reader has with the
// template editor, a live client's configuration. Rules, each enforced here:
//   - The only element ever clicked is the "Interviewers" expander inside that
//     event's own row, and only if it's a link, button or tab: never an input,
//     select, text area, editable text, label or submit button, and never a
//     link that leaves this template.
//   - Nothing is typed and no key is pressed.
//   - Before each click nothing editable may have focus (a click moves focus,
//     and a blur can save). After each click, if Ashby has put focus in a field,
//     reading stops at once rather than click anything else.
//   - Without the write guard (template-guard.js) no click happens at all.
// After reading, every form field that was on the page beforehand must hold the
// value it started with, and every row its title and duration; the guard must
// have blocked nothing while expanding. Any difference fails the read.
const FOCUSED_EDITABLE=()=>{const a=document.activeElement;return !!a&&(a.isContentEditable||['INPUT','SELECT','TEXTAREA'].includes(a.tagName));};
const FIELD_VALUES=els=>els.map(e=>!e.isConnected?null:e.isContentEditable?e.textContent:(e.type==='checkbox'||e.type==='radio')?String(e.checked):e.value);
const stop=message=>readFail(`${message} Reading stopped before anything else was clicked, and no change could have been saved: every write is blocked while the template is open. Check the template in Ashby if in doubt.`);

// Waits until nothing on the page says it's loading, twice in a row half a
// second apart, or until the read's deadline, then names what was still loading.
const LOADING=()=>/Loading filters\.\.\.|Calculating matches\.\.\./.test(document.body.innerText);
async function settle(page,deadline,seconds,stillLoading){
  for(let quiet=0;quiet<2;){
    if(Date.now()>=deadline){const titles=await stillLoading();readFail(`Ashby was still loading the interviewer slots${titles.length?` for ${titles.join(', ')}`:''} after ${seconds} second${seconds===1?'':'s'} ("Loading filters..." or "Calculating matches..." was still showing). Try again; nothing was clicked or saved.`);}
    quiet=await page.evaluate(LOADING,{loading:true})?0:quiet+1;
    if(quiet<2)await page.waitForTimeout(Math.max(0,Math.min(500,deadline-Date.now())));
  }
}

async function expandEvents(page,byTitle,matched,blocksFor,guard,{deadline,seconds,titlesStillLoading}){
  if(!guard)readFail("Ashby's schedule template showed its events collapsed, and expanding them needs the write guard, which isn't active. Nothing was clicked.");
  const fields=await page.evaluateHandle(()=>[...document.querySelectorAll('input,select,textarea,[contenteditable="true"]')]);
  const before=await fields.evaluate(FIELD_VALUES);
  const rowsBefore=new Map();for(const title of byTitle.keys())rowsBefore.set(title,(await blocksFor(title)).map(b=>b.duration));
  guard.expanding();
  let clicks=0;
  events: for(const [title,group] of byTitle){
    for(let k=0;k<group.length;k++){
      if(guard.problem())break events;
      const current=(await blocksFor(title))[k];
      if(current?.slots){matched.set(group[k],current);continue;}
      // What the reader found in this event's stretch of the page instead of
      // slots: the same template has read with and without them minutes apart.
      console.warn(`[plan-reader] "${title}"${group.length>1?` (${k+1} of ${group.length})`:''} has no slots on the page; its stretch reads: ${current?current.text.split('\n').map(l=>l.replace(/\s+/g,' ').trim()).filter(Boolean).join(' | ').slice(0,1500):'(row not found)'}`);
      const handle=await page.evaluateHandle(({title,k})=>{
        const durations=e=>[...e.querySelectorAll('input')].filter(x=>x.type==='number'||x.getAttribute('role')==='spinbutton');
        const found=new Set();
        for(const leaf of [...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.textContent.trim()===title&&e.getBoundingClientRect().width)){
          let e=leaf;for(let n=0;e&&n<25;n++,e=e.parentElement){const c=durations(e).length;if(c===1){found.add(e);break;}if(c>1)break;}
        }
        const rows=[...found].filter(b=>![...found].some(o=>o!==b&&b.contains(o))).sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top);
        const row=rows[k];if(!row)return `its row could not be found again`;
        // What's in the row, for the refusal: every interactive element and every
        // piece of visible text, with its tag, role, accessible label and link.
        const describe=e=>{const role=e.getAttribute('role'),aria=e.getAttribute('aria-label')||e.getAttribute('title'),href=e.tagName==='A'&&e.getAttribute('href');let path='';if(href){try{path=new URL(e.href).pathname;}catch(_){path=href;}}
          return e.tagName.toLowerCase()+(role?`[role=${role}]`:'')+(e.getAttribute('tabindex')!==null?`[tabindex=${e.getAttribute('tabindex')}]`:'')+(path?`[href=${path}]`:'')+(aria?`[label="${aria.slice(0,40)}"]`:'')+` "${(e.innerText||e.value||'').replace(/\s+/g,' ').trim().slice(0,40)}"`;};
        const inventory=()=>{const seen=[...row.querySelectorAll('a,button,input,select,textarea,[role],[tabindex],[aria-label],[title],svg')].concat([...row.querySelectorAll('*')].filter(e=>e.children.length===0&&(e.innerText||'').trim()));
          return [...new Set(seen)].slice(0,25).map(describe).join('; ');};
        const labels=[...row.querySelectorAll('*')].filter(e=>(e.innerText||'').trim()==='Interviewers'&&![...e.children].some(c=>(c.innerText||'').trim()==='Interviewers'));
        if(labels.length!==1)return (labels.length?`it has ${labels.length} "Interviewers" controls`:`it has no "Interviewers" control`)+`. The row holds: ${inventory()}`;
        const target=labels[0].closest('a,button,[role="button"],[role="tab"],[role="link"]');
        const tag=e=>e.tagName.toLowerCase()+(e.getAttribute('role')?`[role=${e.getAttribute('role')}]`:'');
        if(!target||!row.contains(target))return `its "Interviewers" text isn't a link or button (${tag(labels[0])}). The row holds: ${inventory()}`;
        if(target.matches('input,select,textarea,label,[contenteditable="true"]')||target.isContentEditable)return `its "Interviewers" control is a form field (${tag(target)})`;
        if(target.tagName==='BUTTON'&&target.form&&target.type==='submit')return 'its "Interviewers" control would submit a form';
        if(target.tagName==='A'&&target.getAttribute('href')&&!target.getAttribute('href').startsWith('#')){
          const here=location.pathname.replace(/\/template\/.*$/,'/template');
          if(!new URL(target.href).pathname.startsWith(here))return `its "Interviewers" link leaves this template (${new URL(target.href).pathname})`;
        }
        return target;
      },{title,k});
      const element=handle.asElement();
      const label=`"${title}"${group.length>1?` (${k+1} of ${group.length})`:''}`;
      if(!element){
        const why=await handle.jsonValue();console.warn(`[plan-reader] ${label} not expanded: ${why}`);
        // Only an "Interviewers" pill means the section is hidden. Without one,
        // the section loaded and simply has no slot the reader can see.
        if(/^it has no "Interviewers" control/.test(why))readFail(`${label}: its interviewer section loaded, but no interviewer slot is on the page and there's no "Interviewers" control to show one. Nothing was clicked. Check the event in Ashby.`);
        stop(`${label} couldn't be expanded safely: ${why}.`);
      }
      if(await page.evaluate(FOCUSED_EDITABLE))stop(`A field in the template had the cursor before ${label} was expanded.`);
      await element.click({timeout:5000});clicks++;
      if(await page.evaluate(FOCUSED_EDITABLE))stop(`Expanding ${label} put the cursor in a field.`);
      // The expanded section loads like the rest of the page, within the same budget.
      await page.waitForTimeout(Math.max(0,Math.min(500,deadline-Date.now())));
      await settle(page,deadline,seconds,titlesStillLoading);
      const block=(await blocksFor(title))[k];
      if(!block?.slots)readFail(`${label} was expanded, but its interviewer slots didn't appear. Try again.`);
      matched.set(group[k],block);
    }
  }
  const blockedWrite=guard.problem();
  if(blockedWrite)stop(`Ashby tried to send a change while the template was being read (${blockedWrite.summary}), and it was blocked.`);
  const after=await fields.evaluate(FIELD_VALUES);
  const changed=before.filter((v,i)=>after[i]!==null&&after[i]!==v).length;
  if(changed)stop(`${changed} field${changed===1?'':'s'} in the template changed on the page while it was being read.`);
  for(const [title,durations] of rowsBefore){const now=(await blocksFor(title)).map(b=>b.duration);if(now.join()!==durations.join())stop(`"${title}" changed on the page while the template was being read.`);}
  const compared=after.filter(v=>v!==null).length;
  console.log(`[plan-reader] Expanded ${clicks} event${clicks===1?'':'s'}; ${compared} of ${before.length} fields unchanged${compared<before.length?' (the rest were re-rendered, so not compared)':''}; rows unchanged; writes blocked: ${guard.blocked.length}; sockets held closed: ${guard.sockets}.`);
}

async function readPlan(page,input,{guard=null,budgetMs=60000}={}){
  // One time budget for the whole read. Every wait takes what it needs from it,
  // so Step 2 returns within budgetMs however many events the template has.
  const deadline=Date.now()+budgetMs,seconds=Math.round(budgetMs/1000);
  const left=cap=>{const ms=Math.min(cap,deadline-Date.now());if(ms<=0)readFail(`Ashby's schedule template was still loading when the read's ${seconds} seconds ran out. Try again; nothing was clicked or saved.`);return ms;};
  const sessions=input.activities?.flatMap(a=>a.sessions)||[];
  if(!sessions.length||sessions.length>30)fail('The current interview plan could not be verified.');
  const errorPage=async()=>/Something went wrong|An error occurred|Page not found/i.test(await page.evaluate(()=>document.body.innerText.slice(0,4000)).catch(()=>''));
  await step(()=>page.getByRole('heading',{name:'Events',exact:true}).waitFor({state:'visible',timeout:left(15000)}),'The schedule template page opened, but its Events section never loaded. Ashby may be slow or showing an error; try again.').catch(async e=>{if(await errorPage())readFail('Ashby showed an error page instead of the schedule template. Try again, or open it in Ashby.');throw e;});
  // An event row is an interview-name dropdown and its duration field. Count
  // those, not "Add Interviewer Slot" buttons: an event with no interviewers
  // configured has no slot button but is still an event. Wait up to 30 seconds
  // for every row to render; a different number that settles is a mismatch,
  // counted below, but a page with no rows at all is a read failure.
  const countRows=()=>[...document.querySelectorAll('input')].filter(x=>(x.type==='number'||x.getAttribute('role')==='spinbutton')&&x.getBoundingClientRect().width).length;
  try{await page.waitForFunction(count=>[...document.querySelectorAll('input')].filter(x=>(x.type==='number'||x.getAttribute('role')==='spinbutton')&&x.getBoundingClientRect().width).length===count,sessions.length,{timeout:left(30000)});}catch(e){if(!timedOut(e))throw e;}
  const rows=await page.evaluate(countRows,{rows:true});
  if(!rows)readFail("The schedule template's Events section loaded, but no event rows appeared within 30 seconds. Ashby may be slow; try again, or open the template in Ashby.");
  // The row for a title: the smallest block that holds the title and exactly one
  // duration field. Only innermost blocks count: a page-level container that
  // happens to enclose one event (say, reached from a stage heading with the
  // same name as the session) isn't a second event.
  // An event's content is everything on the page from its row up to the next
  // event's row, in document order, not whatever happens to share a parent
  // with the row: on Ashby's live editor the slots ("Interviewers 1", "Slot #1
  // — 2 Eligible Matches", the names) sit outside the row's own block. Read
  // that first; an event only needs expanding if its stretch has no slots.
  const titles=[...new Set(sessions.map(s=>s.title.trim()))];
  const titlesStillLoading=async()=>{const out=[];for(const t of titles)for(const b of await blocksFor(t))if(b.loading)out.push(`"${t}"`);return out;};
  const blocksFor=title=>page.evaluate(({title,titles})=>{
    const durations=e=>[...e.querySelectorAll('input')].filter(x=>x.type==='number'||x.getAttribute('role')==='spinbutton');
    const rowsFor=t=>{
      const found=new Set();
      for(const leaf of [...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.textContent.trim()===t&&e.getBoundingClientRect().width)){
        let e=leaf;for(let k=0;e&&k<25;k++,e=e.parentElement){const n=durations(e).length;if(n===1){found.add(e);break;}if(n>1)break;}
      }
      return [...found].filter(b=>![...found].some(o=>o!==b&&b.contains(o)));
    };
    const all=[...new Set(titles.flatMap(rowsFor))].sort((a,b)=>a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING?-1:1);
    const events=all.filter(r=>!all.some(o=>o!==r&&r.contains(o)));
    const stretch=(row,next)=>{
      const range=document.createRange();range.setStartBefore(row);
      if(next)range.setEndBefore(next);else range.setEndAfter(document.body.lastChild||document.body);
      const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),lines=[];
      for(let n=walker.nextNode();n;n=walker.nextNode()){
        if(!range.intersectsNode(n)||(next&&next.contains(n)))continue;
        const t=n.textContent.trim(),p=n.parentElement;
        if(!t||!p||p.closest('script,style,noscript')||!p.getBoundingClientRect().width||getComputedStyle(p).visibility==='hidden')continue;
        lines.push(t);
      }
      return lines.join('\n');
    };
    const mine=new Set(rowsFor(title));
    return events.map((row,i)=>({row,i})).filter(({row})=>mine.has(row)).map(({row,i})=>{
      const text=stretch(row,events[i+1]);
      return {text,duration:Number(durations(row)[0].value),top:row.getBoundingClientRect().top+window.scrollY,slots:/Slot\s*#\d/.test(text)&&/Eligible\s*Match/.test(text),loading:/Loading filters\.\.\.|Calculating matches\.\.\./.test(text)};
    }).sort((a,b)=>a.top-b.top);
  },{title,titles});
  // Slots load after the page: "Loading filters..." first, then "Slot #1 —
  // Calculating matches...", then the eligible-match count. Wait once for the
  // page as a whole to stop loading, not per event.
  await settle(page,deadline,seconds,()=>titlesStillLoading());
  const issues=[],matched=new Map(),byTitle=new Map();
  for(const s of sessions){const t=s.title.trim();if(!byTitle.has(t))byTitle.set(t,[]);byTitle.get(t).push(s);}
  for(const [title,group] of byTitle){
    const blocks=await blocksFor(title);
    if(!blocks.length){issues.push(`"${title}" isn't in the template`);continue;}
    if(blocks.length!==group.length){issues.push(`"${title}" appears ${blocks.length} time${blocks.length===1?'':'s'} in the template but ${group.length} time${group.length===1?'':'s'} in the plan`);continue;}
    // Repeated titles pair up in page order, as the plan lists them.
    group.forEach((s,k)=>{const b=blocks[k];if(b.duration!==s.durationMinutes)issues.push(`"${title}"${group.length>1?` (${k+1} of ${group.length})`:''} is ${b.duration} minutes in the template but ${s.durationMinutes} in the plan`);matched.set(s,b);});
  }
  const placed=sessions.filter(s=>matched.has(s));
  for(let k=1;k<placed.length;k++)if(matched.get(placed[k]).top<matched.get(placed[k-1]).top){issues.push(`the order differs: the template has "${placed[k].title.trim()}" before "${placed[k-1].title.trim()}"`);break;}
  if(rows!==sessions.length)issues.push(`the template has ${rows} interview${rows===1?'':'s'} and the plan has ${sessions.length}`);
  if(issues.length)throw Object.assign(Error(`The schedule template doesn't match the published plan: ${issues.join('; ')}. Update the template in Ashby, or reload the plan if it just changed.`),{status:409,kind:'mismatch',issues});
  // An event without slot text is collapsed, not empty: "Configure: Interviewers
  // | Room" holds the expander, and the slots aren't on the page until it's
  // opened. Whether Ashby shows them expanded depends on per-user UI state, so
  // collapsed events are expanded here, under the safeguards in expandEvents.
  if(placed.some(s=>!matched.get(s).slots))await expandEvents(page,byTitle,matched,blocksFor,guard,{deadline,seconds,titlesStillLoading});
  // Every unsupported slot is reported at once, not just the first.
  const read=[],refused=[];
  for(const s of sessions){try{read.push({...s,...parseAssignment(matched.get(s).text,s.title)});}catch(e){if(e.status!==409)throw e;refused.push(e.message);}}
  if(refused.length)throw Object.assign(Error(refused.join(' ')),{status:409,kind:'unsupported_slot',issues:refused});
  return {sessions:read,source:'ashby_schedule_template',bookingEnabled:false};
}
module.exports={readPlan,parseAssignment};
