'use strict';
const fail=message=>{throw Object.assign(Error(message),{status:409});};
function parseAssignment(text){
  text=text.replace(/Specific\s+Employees\s*:/g,'Specific Employees:').replace(/(\d+)\s+Employees?/g,'$1 Employees').replace(/Add\s+Interviewer\s+Slot/g,'Add Interviewer Slot').replace(/Search\s+for\s+user\s*\.\.\./g,'Search for user...').replace(/Select\s+matcher\s*\.\.\./g,'Select matcher...').replace(/is\s*\n\s*/g,'is ');
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
async function readPlan(page,input){
  const sessions=input.activities?.flatMap(a=>a.sessions)||[];
  if(!sessions.length||sessions.length>30)fail('The current interview plan could not be verified.');
  await page.getByRole('heading',{name:'Events',exact:true}).waitFor({state:'visible',timeout:15000});
  await page.waitForFunction(count=>[...document.querySelectorAll('button')].filter(b=>/^\d+\s*Eligible\s*Match(?:es)?$/.test(b.innerText.trim())).length===count&&!document.body.innerText.includes('Calculating matches...'),sessions.length,{timeout:30000});
  const rows=[];
  for(const session of sessions){
    const row=await page.evaluate(title=>{
      const els=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.textContent.trim()===title&&e.getBoundingClientRect().width);
      const blocks=[];for(const leaf of els){let e=leaf;for(let k=0;e&&k<25;k++,e=e.parentElement){const text=e.innerText||'',inputs=[...e.querySelectorAll('input')];const durations=inputs.filter(x=>x.type==='number'||x.getAttribute('role')==='spinbutton');if(durations.length===1&&/Eligible\s*Match/.test(text)&&/Slot\s*#1/.test(text)){blocks.push({text,duration:Number(durations[0].value)});break;}if(durations.length>1)break;}}
      return blocks.length===1?blocks[0]:null;
    },session.title.trim());
    if(!row||row.duration!==session.durationMinutes)fail('The schedule template differs from the published plan or could not be read.');
    rows.push({...session,...parseAssignment(row.text)});
  }
  const count=await page.getByRole('button',{name:'Add Interviewer Slot',exact:true}).count();
  if(count!==sessions.length)fail('The template has extra interviews. Reload and review the full plan.');
  return {sessions:rows,source:'ashby_schedule_template',bookingEnabled:false};
}
module.exports={readPlan,parseAssignment};
