'use strict';
const fail=message=>{throw Object.assign(Error(message),{status:409});};
function parseAssignment(text){
  text=text.replace(/Specific\s+Employees\s*:/g,'Specific Employees:').replace(/(\d+)\s+Employees?/g,'$1 Employees').replace(/Add\s+Interviewer\s+Slot/g,'Add Interviewer Slot').replace(/Search\s+for\s+user\s*\.\.\./g,'Search for user...').replace(/Select\s+matcher\s*\.\.\./g,'Select matcher...').replace(/\bis\s*\n\s*/g,'is ');
  const matches=[...text.matchAll(/(\d+)\s*Eligible\s*Match(?:es)?/g)];
  if(matches.length!==1||!/^Slot\s*#1\b/m.test(text))fail('This interview requires an unsupported interviewer-slot rule. Review it in Ashby.');
  const count=Number(matches[0][1]);
  const lines=text.split('\n').map(s=>s.trim()).filter(Boolean);
  let names;
  const employees=lines.findIndex(s=>/^\d+ Employees?$/.test(s));
  if(lines.some(s=>/^Specific Employees:?$/.test(s))&&employees>=0){names=lines.slice(employees+1,lines.indexOf('Add Interviewer Slot')).map(s=>s.replace(/^OR\s+/,''));}
  else {
    // Advanced employee matcher: only the explicit employee-identity list is supported.
    const start=lines.findIndex(s=>/^is\s+/.test(s)),end=lines.indexOf('Search for user...');
    if(!/Employee's Employee/.test(text)||start<0||end<=start)fail('The advanced interviewer rule needs review in Ashby.');
    names=lines.slice(start,end).filter(s=>!['Search for user...','is'].includes(s)).map(s=>s.replace(/^is\s+/,''));
  }
  names=[...new Set(names.filter(s=>s&&!/^OR$/.test(s)))];
  if(!count||names.length!==count||names.some(n=>!/^\p{L}[\p{L} .’'\-]+$/u.test(n)))fail('The complete eligible interviewer list could not be read.');
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
  // Give every event time to render. If the template has a different number of
  // events this never settles; that's a mismatch, counted below, not a read failure.
  try{await page.waitForFunction(count=>[...document.querySelectorAll('button')].filter(b=>/^\d+\s*Eligible\s*Match(?:es)?$/.test(b.innerText.trim())).length===count,sessions.length,{timeout:10000});}catch(e){if(!timedOut(e))throw e;}
  // Every block that holds one duration box, an "Eligible Match" count and Slot #1,
  // reached from a leaf whose text is the title. Only innermost blocks count: a
  // page-level container that happens to enclose one event (say, reached from a
  // stage heading with the same name as the session) isn't a second event.
  const blocksFor=title=>page.evaluate(title=>{
    const found=new Set();
    for(const leaf of [...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.textContent.trim()===title&&e.getBoundingClientRect().width)){
      let e=leaf;for(let k=0;e&&k<25;k++,e=e.parentElement){const text=e.innerText||'',durations=[...e.querySelectorAll('input')].filter(x=>x.type==='number'||x.getAttribute('role')==='spinbutton');if(durations.length===1&&/Eligible\s*Match/.test(text)&&/Slot\s*#1/.test(text)){found.add(e);break;}if(durations.length>1)break;}
    }
    const blocks=[...found].filter(b=>![...found].some(o=>o!==b&&b.contains(o)));
    return blocks.map(b=>({text:b.innerText,duration:Number([...b.querySelectorAll('input')].find(x=>x.type==='number'||x.getAttribute('role')==='spinbutton').value),top:b.getBoundingClientRect().top+window.scrollY})).sort((a,b)=>a.top-b.top);
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
  const events=await page.getByRole('button',{name:'Add Interviewer Slot',exact:true}).count();
  if(events!==sessions.length)issues.push(`the template has ${events} interview${events===1?'':'s'} and the plan has ${sessions.length}`);
  if(issues.length)throw Object.assign(Error(`The schedule template doesn't match the published plan: ${issues.join('; ')}. Update the template in Ashby, or reload the plan if it just changed.`),{status:409,kind:'mismatch',issues});
  return {sessions:sessions.map(s=>({...s,...parseAssignment(matched.get(s).text)})),source:'ashby_schedule_template',bookingEnabled:false};
}
module.exports={readPlan,parseAssignment};
