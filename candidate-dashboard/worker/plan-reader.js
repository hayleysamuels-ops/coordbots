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
  text=text.replace(/Specific\s+Employees\s*:/g,'Specific Employees:').replace(/(\d+)\s+Employees?/g,'$1 Employees').replace(/Add\s+Interviewer\s+Slot/g,'Add Interviewer Slot').replace(/Search\s+for\s+user\s*\.\.\./g,'Search for user...').replace(/Select\s+matcher\s*\.\.\./g,'Select matcher...').replace(/(\d+)\s*Eligible\s*Match(es)?/g,'$1 Eligible Match$2').replace(/\bis\s*\n\s*/g,'is ');
  const lines=text.split('\n').map(s=>s.trim()).filter(Boolean);
  const name=quote(title).slice(1,-1);
  const refuse=(found,fix)=>fail(`"${name}": ${found}, which isn't supported. ${fix}`);
  const namedFix='Only named interviewers are supported: use Specific Employees in the template.';
  const slotStarts=lines.map((s,i)=>/^Slot\s*#\d+\b/.test(s)?i:-1).filter(i=>i>=0);
  if(!slotStarts.length)refuse(`no interviewer slot could be found (Ashby shows ${quote(lines.slice(1,4).join(' · ')||'nothing')})`,namedFix);
  if(slotStarts.length>1)refuse(`it has ${slotStarts.length} interviewer slots, so it needs ${slotStarts.length} interviewers on the panel`,'Only single-interviewer events are supported: use one slot that lists every eligible interviewer.');
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
  if(!count||names.length!==count)fail(`"${name}": Slot #1 says ${count} eligible match${count===1?'':'es'} but ${names.length} name${names.length===1?' was':'s were'} read from it. Check the slot in Ashby, then load the plan again.`);
  return {requiredCount:1,eligibleInterviewers:names.map(name=>({name})),assignmentVerified:true};
}
// A read failure (Ashby didn't load what we need) is a different thing from a
// mismatch (Ashby loaded, and the template differs from the published plan).
// Read failures are 503s naming the cause; mismatches are one 409 listing every
// difference found: missing, repeated, wrong duration, out of order, extra.
const readFail=message=>{throw Object.assign(Error(message),{status:503,kind:'read'});};
const timedOut=e=>e?.name==='TimeoutError'||/Timeout \d+ms exceeded/.test(e?.message||'');
async function step(work,message){try{return await work();}catch(e){if(timedOut(e))readFail(message);throw e;}}

async function readPlan(page,input){
  const sessions=input.activities?.flatMap(a=>a.sessions)||[];
  if(!sessions.length||sessions.length>30)fail('The current interview plan could not be verified.');
  const errorPage=async()=>/Something went wrong|An error occurred|Page not found/i.test(await page.evaluate(()=>document.body.innerText.slice(0,4000)).catch(()=>''));
  await step(()=>page.getByRole('heading',{name:'Events',exact:true}).waitFor({state:'visible',timeout:15000}),'The schedule template page opened, but its Events section never loaded. Ashby may be slow or showing an error; try again.').catch(async e=>{if(await errorPage())readFail('Ashby showed an error page instead of the schedule template. Try again, or open it in Ashby.');throw e;});
  await step(()=>page.waitForFunction(()=>!document.body.innerText.includes('Calculating matches...'),null,{timeout:30000}),'Ashby was still calculating interviewer matches after 30 seconds. Try again.');
  // An event row is an interview-name dropdown and its duration field. Count
  // those, not "Add Interviewer Slot" buttons: an event with no interviewers
  // configured has no slot button but is still an event. Wait up to 30 seconds
  // for every row to render; a different number that settles is a mismatch,
  // counted below, but a page with no rows at all is a read failure.
  const countRows=()=>[...document.querySelectorAll('input')].filter(x=>(x.type==='number'||x.getAttribute('role')==='spinbutton')&&x.getBoundingClientRect().width).length;
  try{await page.waitForFunction(count=>[...document.querySelectorAll('input')].filter(x=>(x.type==='number'||x.getAttribute('role')==='spinbutton')&&x.getBoundingClientRect().width).length===count,sessions.length,{timeout:30000});}catch(e){if(!timedOut(e))throw e;}
  const rows=await page.evaluate(countRows,{rows:true});
  if(!rows)readFail("The schedule template's Events section loaded, but no event rows appeared within 30 seconds. Ashby may be slow; try again, or open the template in Ashby.");
  // The row for a title: the smallest block that holds the title and exactly one
  // duration field. Only innermost blocks count: a page-level container that
  // happens to enclose one event (say, reached from a stage heading with the
  // same name as the session) isn't a second event.
  const blocksFor=title=>page.evaluate(title=>{
    const durations=e=>[...e.querySelectorAll('input')].filter(x=>x.type==='number'||x.getAttribute('role')==='spinbutton');
    const found=new Set();
    for(const leaf of [...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.textContent.trim()===title&&e.getBoundingClientRect().width)){
      let e=leaf;for(let k=0;e&&k<25;k++,e=e.parentElement){const n=durations(e).length;if(n===1){found.add(e);break;}if(n>1)break;}
    }
    const blocks=[...found].filter(b=>![...found].some(o=>o!==b&&b.contains(o)));
    return blocks.map(b=>{const text=b.innerText||'';return {text,duration:Number(durations(b)[0].value),top:b.getBoundingClientRect().top+window.scrollY,
      slots:/Slot\s*#1/.test(text)||/Eligible\s*Match/.test(text)};}).sort((a,b)=>a.top-b.top);
  },title);
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
  // | Room" is the control that expands it, and the slots aren't on the page
  // until it's opened. Whether the editor shows them expanded depends on Ashby's
  // UI state, so this is a read failure; it says nothing about the template.
  const collapsed=placed.filter(s=>!matched.get(s).slots).map(s=>`"${s.title.trim()}"`);
  if(collapsed.length)readFail(`Ashby's schedule template showed ${collapsed.length===placed.length?'every event':collapsed.join(', ')} collapsed, so the interviewer slots weren't on the page and couldn't be read. This doesn't mean the template has no interviewers. Try again; if it keeps happening, check the eligible interviewers in Ashby.`);
  // Every unsupported slot is reported at once, not just the first.
  const read=[],refused=[];
  for(const s of sessions){try{read.push({...s,...parseAssignment(matched.get(s).text,s.title)});}catch(e){if(e.status!==409)throw e;refused.push(e.message);}}
  if(refused.length)throw Object.assign(Error(refused.join(' ')),{status:409,kind:'unsupported_slot',issues:refused});
  return {sessions:read,source:'ashby_schedule_template',bookingEnabled:false};
}
module.exports={readPlan,parseAssignment};
