'use strict';
const fail=message=>{throw Object.assign(Error(message),{status:409});};
const normalize=s=>String(s||'').replace(/\s+/g,' ').replace(/\s*,\s*$/,'').trim();
function parseInterviewerPanel(text,eligible){
  const content=text.slice(text.indexOf('Current Interviewer'));
  if(!text.includes('Current Interviewer')||/loading|calculating/i.test(content))fail('Ashby has not finished loading interviewer conflicts.');
  return eligible.map(person=>{
    const escaped=person.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const re=new RegExp('(?:^|\\n)'+escaped+'(?:\\n|\\s)+([^\\s]+@[^\\s]+)','g');
    const matches=[...content.matchAll(re)];
    if(matches.length!==1)return {...person,status:'unknown',reason:'Could not uniquely read this interviewer’s calendar assessment.'};
    const match=matches[0],tail=content.slice(match.index);
    const nextIdentity=tail.slice(match[0].length).search(/\n[^\n]+\n[^\s]+@[^\s]+/);
    const card=nextIdentity<0?tail:tail.slice(0,match[0].length+nextIdentity);
    const conflict=card.match(/\bConflicts\b([\s\S]*?)(?:Select Interviewer|Consider Alternate|$)/);
    return {...person,email:match[1],status:conflict?'conflict':'unknown',reason:conflict?normalize(conflict[1])||'Ashby reports a calendar conflict.':'No explicit conflict text was found. Complete calendar coverage is not yet verified.'};
  });
}
async function readFullCalendar(page,input){
  const base='https://app.ashbyhq.com/schedules/drafts/'+input.draftId;
  if(!Array.isArray(input.sessions)||!input.sessions.length)fail('Load the current interview plan first.');
  await page.getByPlaceholder('Set date to view...',{exact:true}).waitFor({state:'visible',timeout:15000});
  async function snapshot(){
    return page.evaluate(()=>({dates:[...document.querySelectorAll('input[placeholder="Set interview date..."]')].map(e=>e.value),starts:[...document.querySelectorAll('input[placeholder="Start..."]')].map(e=>e.value),ends:[...document.querySelectorAll('input[placeholder="End..."]')].map(e=>e.value),links:[...document.querySelectorAll('a[href]')].filter(e=>/\/events\/[^/]+\/interviewers\/0$/.test(new URL(e.href).pathname)).map(e=>({href:e.href,count:e.textContent.trim()}))}));
  }
  await page.getByPlaceholder('Set interview date...',{exact:true}).first().waitFor({state:'visible',timeout:15000});
  await page.waitForFunction(n=>[...document.querySelectorAll('a[href]')].filter(e=>/\/events\/[^/]+\/interviewers\/0$/.test(new URL(e.href).pathname)).length===n,input.sessions.length,{timeout:20000}).catch(()=>fail('Ashby has not finished loading the interviewer calendar links. No scheduling action was taken.'));
  const before=await snapshot();
  if(['dates','starts','ends','links'].some(k=>before[k].length!==input.sessions.length))fail('The draft layout could not be verified ('+['dates','starts','ends','links'].map(k=>k+': '+before[k].length).join(', ')+'). No scheduling action was taken.');
  const results=[];
  for(let index=0;index<input.sessions.length;index++){
    const session=input.sessions[index],link=before.links[index],url=new URL(link.href,base);
    if(url.origin!=='https://app.ashbyhq.com'||!url.pathname.startsWith('/schedules/drafts/'+input.draftId+'/events/'))fail('Invalid interviewer calendar link.');
    // Read-only navigation to the existing draft's interviewer assessment.
    await page.goto(url.href,{waitUntil:'domcontentloaded'});
    await page.getByRole('heading',{name:new RegExp('^Interviewer 1,')}).waitFor({state:'visible',timeout:15000});
    const title=normalize(await page.getByRole('heading',{name:new RegExp('^Interviewer 1,')}).innerText()).replace(/^Interviewer 1,\s*/,'');
    if(title!==normalize(session.title))fail('The draft interviews no longer match the current plan order.');
    await page.getByText('Current Interviewer',{exact:true}).waitFor({state:'visible',timeout:15000});
    // Wait for each eligible name or the explicit empty-alternatives result.
    // Missing names remain unknown, never available.
    await page.getByPlaceholder('Filter by name or email').or(page.getByText('No interviewers to select from.',{exact:true})).first().waitFor({state:'visible',timeout:15000});
    const body=await page.locator('body').innerText();
    const interviewers=parseInterviewerPanel(body,session.eligibleInterviewers);
    results.push({sessionId:session.sessionId,title:session.title,date:before.dates[index],start:before.starts[index],end:before.ends[index],interviewers});
  }
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.getByPlaceholder('Set date to view...',{exact:true}).waitFor({state:'visible',timeout:15000});
  await page.getByPlaceholder('Set interview date...',{exact:true}).first().waitFor({state:'visible',timeout:15000});
  await page.waitForFunction(n=>[...document.querySelectorAll('a[href]')].filter(e=>/\/events\/[^/]+\/interviewers\/0$/.test(new URL(e.href).pathname)).length===n,input.sessions.length,{timeout:20000});
  if(JSON.stringify(await snapshot())!==JSON.stringify(before))fail('The saved draft changed during calendar inspection. Read it again.');
  return {events:results,availabilityVerified:false,bookingEnabled:false,source:'ashby-draft-interviewer-conflicts',reason:'Calendar conflicts shown by Ashby for this saved draft. A missing conflict is not yet proof of availability; no invitations were sent.'};
}
module.exports={readFullCalendar,parseInterviewerPanel};
