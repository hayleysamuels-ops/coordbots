'use strict';
const {instant}=require('../src/scheduling/booking-planner');
const fail=message=>{throw Object.assign(Error(message),{status:409});};
function parseGrid({timezone,columns}){
  try{if(!timezone)throw Error();new Intl.DateTimeFormat('en-US',{timeZone:timezone}).format();}catch(_){fail('The availability display timezone could not be verified.');}
  if(!Array.isArray(columns)||columns.length!==7)fail('The availability week could not be read completely.');
  const windows=[];
  for(const column of columns){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(column.date)||column.selected.length!==96||column.selected.some(v=>typeof v!=='boolean'))fail('The availability grid layout changed. Review it in Ashby.');
    const wall=quarter=>{if(quarter===96)return new Date(Date.parse(column.date+'T12:00:00Z')+86400000).toISOString().slice(0,10)+'T00:00';return column.date+'T'+String(Math.floor(quarter/4)).padStart(2,'0')+':'+String(quarter%4*15).padStart(2,'0');};
    for(let i=0;i<96;i++){if(!column.selected[i])continue;const start=i;while(i+1<96&&column.selected[i+1])i++;windows.push({start:new Date(instant(wall(start),timezone)).toISOString(),end:new Date(instant(wall(i+1),timezone)).toISOString()});}
  }
  return {timezone,windows,start:columns[0].date,end:columns[6].date};
}
// What the page held when the grid couldn't be read, for the refusal and the
// worker log: day headers, timezone labels, grid cells per column.
function describeGrid(){
  const leaves=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.getBoundingClientRect().width);
  const headers=leaves.map(e=>e.textContent.trim()).filter(t=>/^(SUN|MON|TUE|WED|THU|FRI|SAT)\b/i.test(t));
  const zones=[...new Set(leaves.map(e=>e.textContent.trim()).filter(t=>/^[A-Za-z_]+\/[A-Za-z_]+(?:[ /][A-Za-z_]+)*$/.test(t)))];
  const slices=[...document.querySelectorAll('[class*="_slice_"]')].filter(e=>e.getBoundingClientRect().width>0);
  const classes=[...new Set([...document.querySelectorAll('[class]')].flatMap(e=>[...e.classList]).filter(c=>/slice|selected|cell|slot/i.test(c)))].slice(0,8);
  return `${headers.length} day header${headers.length===1?'':'s'} (${headers.slice(0,8).join(', ')||'none'}); timezone labels: ${zones.join(', ')||'none'}; ${slices.length} grid cells${classes.length?`; grid-like classes: ${classes.join(', ')}`:''}`;
}
function collectGrid(){
  const leaves=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.getBoundingClientRect().width);
  const headers=leaves.map(e=>({e,m:e.textContent.trim().match(/^(SUN|MON|TUE|WED|THU|FRI|SAT)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})$/i)})).filter(x=>x.m).sort((a,b)=>a.e.getBoundingClientRect().x-b.e.getBoundingClientRect().x);
  if(headers.length!==7)return null;
  const zones=[...new Set(leaves.map(e=>e.textContent.trim()).filter(t=>/^[A-Za-z_]+\/[A-Za-z_]+(?:[ /][A-Za-z_]+)*$/.test(t)).map(t=>t.replace(/ /g,'_')))];
  if(zones.length!==1)return null;
  const slices=[...document.querySelectorAll('[class*="_slice_"]')].filter(e=>e.getBoundingClientRect().width>0);
  const columns=headers.map(({e,m})=>{const x=e.getBoundingClientRect().x,w=e.getBoundingClientRect().width;const cells=slices.filter(s=>{const r=s.getBoundingClientRect();return Math.abs(r.x-x)<2&&Math.abs(r.width-w)<2;}).sort((a,b)=>a.getBoundingClientRect().y-b.getBoundingClientRect().y);return {date:`${m[4]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`,selected:cells.map(s=>[...s.classList].some(c=>c.startsWith('_selected_')))};});
  if(columns.some(c=>c.selected.length!==96))return null;
  return {timezone:zones[0],columns};
}
async function readAvailability(page){
  // Every wait that can run out names what didn't load; none surfaces as the
  // generic "could not read" from the worker.
  const step=async(work,message)=>{try{return await work();}catch(e){if(e?.name==='TimeoutError'||/Timeout \d+ms exceeded/.test(e?.message||''))fail(message);throw e;}};
  await step(()=>page.getByRole('heading',{name:'Candidate Availability',exact:true}).waitFor({state:'visible',timeout:15000}),"Ashby's Candidate Availability page didn't load within 15 seconds. Try again.");
  const dateControl=page.getByPlaceholder('Set date to view...',{exact:true});
  await step(()=>dateControl.waitFor({state:'visible',timeout:15000}),"The availability page loaded, but its week picker didn't appear within 15 seconds. Try again.");
  if(await page.getByRole('checkbox',{name:'Show All Availability?',exact:true}).isChecked())fail('Select availability for this request only.');
  const weeks=[];let expected=null;
  for(let week=0;week<6;week++){
    await page.waitForTimeout(1000);
    await step(()=>page.getByText('Fetching...',{exact:true}).waitFor({state:'hidden',timeout:15000}),`Ashby was still fetching week ${week+1} of the availability after 15 seconds. Try again.`);
    let data;try{const handle=await page.waitForFunction(collectGrid,null,{timeout:15000});data=await handle.jsonValue();}
    catch(_){const seen=await page.evaluate(describeGrid).catch(()=>'nothing readable');console.warn(`[availability-reader] Week ${week+1} grid unreadable: ${seen}`);
      fail(`The submitted-availability grid for week ${week+1} couldn't be read: the reader needs 7 day headers, one timezone label and 96 cells per day, and found ${seen}.`);}
    const parsed=parseGrid(data);
    if(expected&&parsed.start!==expected)fail('The availability week did not finish changing.');
    if(weeks.length&&parsed.timezone!==weeks[0].timezone)fail('The availability timezone changed while reading.');
    weeks.push(parsed);
    if(week===5)break;
    const old=await dateControl.inputValue();
    const nextIndex=await page.evaluate(()=>{const input=document.querySelector('input[placeholder="Set date to view..."]');if(!input)return -1;const r=input.getBoundingClientRect(),buttons=[...document.querySelectorAll('button')];const adjacent=buttons.map((e,index)=>({r:e.getBoundingClientRect(),index})).filter(b=>b.r.width&&b.r.x>=r.right&&b.r.x<r.right+110&&Math.abs(b.r.y+b.r.height/2-r.y-r.height/2)<15).sort((a,b)=>a.r.x-b.r.x);return adjacent.length>=2?adjacent[1].index:-1;});
    if(nextIndex<0)fail('The next availability week control could not be identified.');
    expected=new Date(Date.parse(parsed.start+'T12:00:00Z')+7*86400000).toISOString().slice(0,10);
    await page.locator('button').nth(nextIndex).click();
    await step(()=>page.waitForFunction(old=>document.querySelector('input[placeholder="Set date to view..."]')?.value!==old,old,{timeout:5000}),`The availability page didn't move to week ${week+2} within 5 seconds. Try again.`);
  }
  return {complete:true,timezone:weeks[0].timezone,windows:weeks.flatMap(w=>w.windows),scope:{start:weeks[0].start,end:weeks.at(-1).end},notes:'',bookingEnabled:false};
}
module.exports={readAvailability,parseGrid,collectGrid,describeGrid};
