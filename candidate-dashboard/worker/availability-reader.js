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
// What the page holds under the day headers, for the refusal and the worker log:
// what's there, not only what's missing. For the first and last day of the week
// (a past day may render differently from a future one) it reports:
//   - the header's own element and its parents;
//   - the column, the smallest ancestor of the header reaching well below it:
//     its child count and the child element types and classes;
//   - every element under the header's centre line, by type and class, any size;
//   - leaf boxes of cell size (4-40px tall) there, and their background colours.
function describeGrid(){
  const leaves=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.getBoundingClientRect().width);
  const headerEls=leaves.filter(e=>/^(SUN|MON|TUE|WED|THU|FRI|SAT)\b/i.test(e.textContent.trim()));
  const headers=headerEls.map(e=>e.textContent.trim());
  const zones=[...new Set(leaves.map(e=>e.textContent.trim()).filter(t=>/^[A-Za-z_]+\/[A-Za-z_]+(?:[ /][A-Za-z_]+)*$/.test(t)))];
  const picker=document.querySelector('input[placeholder="Set date to view..."]')?.value||'none';
  const name=e=>{const c=(e.getAttribute('class')||'').trim().split(/\s+/).filter(Boolean).slice(0,2).join('.');const role=e.getAttribute('role');return e.tagName.toLowerCase()+(c?'.'+c:'')+(role?`[role=${role}]`:'');};
  const tally=list=>{const m=new Map();for(const e of list){const k=name(e);m.set(k,(m.get(k)||0)+1);}return [...m].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,n])=>`${k} ×${n}`).join(', ')||'none';};
  const under=el=>{
    const h=el.getBoundingClientRect(),cx=h.x+h.width/2;
    const chain=[];for(let e=el,k=0;e&&k<4;e=e.parentElement,k++)chain.push(name(e));
    let column=el;while(column.parentElement&&column.getBoundingClientRect().bottom<h.bottom+h.height*3)column=column.parentElement;
    const below=[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.top>=h.bottom&&r.width>0&&r.left<=cx&&r.right>=cx;});
    const cellish=below.filter(e=>{const r=e.getBoundingClientRect();return r.height>=4&&r.height<=40&&!e.querySelector('*');});
    const fills=new Map();for(const c of cellish){const f=getComputedStyle(c).backgroundColor;fills.set(f,(fills.get(f)||0)+1);}
    return `"${el.textContent.trim()}": header ${chain.join(' < ')}; column ${name(column)} with ${column.children.length} children (${tally([...column.children])}) and ${column.querySelectorAll('*').length} descendants; ${below.length} elements below its centre (${tally(below)}); ${cellish.length} cell-sized leaves${cellish.length?` (fills ${[...fills].map(([f,n])=>`${f} ×${n}`).join(', ')})`:''}`;
  };
  const days=headerEls.length?[...new Set([headerEls[0],headerEls[headerEls.length-1]])].map(under).join(' | '):'no day header to measure under';
  const slices=[...document.querySelectorAll('[class*="_slice_"]')].filter(e=>e.getBoundingClientRect().width>0).length;
  return `${headers.length} day header${headers.length===1?'':'s'} (${headers.slice(0,8).join(', ')||'none'}); week picker shows "${picker}"; timezone labels: ${zones.join(', ')||'none'}; ${slices} cells with the class the reader expects; under the headers: ${days}`;
}
// The current grid, found by class-name prefix only: Ashby's class names are
// "_column_<build hash>_<n>", and the hash changes with every build.
//   _grid_ > _headerRow_ (day headers)
//          > button._expander_          (top: earlier hours?)
//          > _bodyRow_ > _body_ > _column_[role=group] ×7 (one per day)
//          > button._expander_._bottom_ (bottom: later hours?)
// What marks a selected time inside a column isn't known yet, so this measures
// it: every element in each day column with its position in the column, fill,
// text and labels, plus the hour labels beside the columns and the expanders.
function measureGrid(){
  const pre=(e,name)=>[...e.classList].some(c=>c.startsWith(`_${name}_`));
  const names=e=>[...e.classList].map(c=>c.match(/^_([A-Za-z]+)_/)?.[1]||c).join('.');
  const grid=[...document.querySelectorAll('div')].find(e=>pre(e,'grid')&&e.getBoundingClientRect().width);
  if(!grid)return 'no _grid_ element';
  const columns=[...grid.querySelectorAll('[role=group]')].filter(e=>pre(e,'column'));
  const g=grid.getBoundingClientRect();
  const labelOf=e=>[e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('aria-expanded')!==null?`expanded=${e.getAttribute('aria-expanded')}`:null].filter(Boolean).join(' ');
  const expanders=[...grid.querySelectorAll('button')].filter(e=>pre(e,'expander')).map(b=>`button.${names(b)} "${(b.innerText||'').replace(/\s+/g,' ').trim().slice(0,40)}"${labelOf(b)?` [${labelOf(b)}]`:''}${b.disabled?' disabled':''}`);
  // Hour labels: short time-like text inside the grid but outside the day columns.
  const times=[...grid.querySelectorAll('*')].filter(e=>e.children.length===0&&!columns.some(c=>c.contains(e))&&/^\d{1,2}(:\d{2})?\s*(AM|PM|am|pm)?$|^\d{1,2}\s*(AM|PM|am|pm)$/.test((e.textContent||'').trim()))
    .map(e=>`${e.textContent.trim()}@${Math.round(e.getBoundingClientRect().top-g.top)}`);
  const day=c=>{
    const r=c.getBoundingClientRect(),items=[...c.querySelectorAll('*')];
    const shown=items.filter(e=>{const s=getComputedStyle(e);return e.getBoundingClientRect().height>0&&(s.backgroundColor!=='rgba(0, 0, 0, 0)'||(e.innerText||'').trim()||e.getAttribute('aria-label')||e.getAttribute('title'));})
      .map(e=>{const b=e.getBoundingClientRect(),st=e.getAttribute('style')||'';return `${e.tagName.toLowerCase()}.${names(e)}@${Math.round(b.top-r.top)}+${Math.round(b.height)}${getComputedStyle(e).backgroundColor!=='rgba(0, 0, 0, 0)'?` fill ${getComputedStyle(e).backgroundColor}`:''}${(e.innerText||'').trim()?` "${e.innerText.replace(/\s+/g,' ').trim().slice(0,40)}"`:''}${labelOf(e)?` [${labelOf(e)}]`:''}${/top|height/.test(st)?` style "${st.slice(0,60)}"`:''}`;});
    return `${c.getAttribute('aria-label')||'(no label)'} height ${Math.round(r.height)}, ${items.length} descendants: ${shown.slice(0,12).join('; ')||'nothing with a fill or text'}`;
  };
  return `${columns.length} day columns; hour labels: ${times.join(', ')||'none found'}; expanders: ${expanders.join(' | ')||'none'}; columns: ${columns.map(day).join(' || ')}`;
}
function collectGrid(){
  const leaves=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.getBoundingClientRect().width);
  // Day headers come in two forms. The older "SUN 9/27/2026" carries its own
  // date. The current "Sun 27" carries only the day of the month, so its date
  // comes from the week picker ("Sep 27, 2026"): each header takes the one date
  // within a week of the picker whose day of the month and weekday both match,
  // and the seven must then be consecutive days. Anything else is unreadable.
  const DAYS=['SUN','MON','TUE','WED','THU','FRI','SAT'],MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const found=leaves.map(e=>({e,m:e.textContent.trim().match(/^(SUN|MON|TUE|WED|THU|FRI|SAT)\s+(?:(\d{1,2})\/(\d{1,2})\/(\d{4})|(\d{1,2}))$/i)})).filter(x=>x.m).sort((a,b)=>a.e.getBoundingClientRect().x-b.e.getBoundingClientRect().x);
  if(found.length!==7)return null;
  const iso=ms=>new Date(ms).toISOString().slice(0,10);
  let picked=null;
  const p=(document.querySelector('input[placeholder="Set date to view..."]')?.value||'').trim().match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/);
  if(p&&MONTHS.includes(p[1].toLowerCase()))picked=Date.UTC(Number(p[3]),MONTHS.indexOf(p[1].toLowerCase()),Number(p[2]),12);
  const headers=[];
  for(const {e,m} of found){
    const weekday=DAYS.indexOf(m[1].toUpperCase());
    if(m[2]){const ms=Date.UTC(Number(m[4]),Number(m[2])-1,Number(m[3]),12);if(new Date(ms).getUTCDay()!==weekday||new Date(ms).getUTCDate()!==Number(m[3]))return null;headers.push({e,date:iso(ms)});continue;}
    if(picked===null)return null;
    const matches=[];for(let d=-7;d<=7;d++){const ms=picked+d*86400000,t=new Date(ms);if(t.getUTCDate()===Number(m[5])&&t.getUTCDay()===weekday)matches.push(ms);}
    if(matches.length!==1)return null;
    headers.push({e,date:iso(matches[0])});
  }
  for(let i=1;i<7;i++)if(Date.parse(headers[i].date)-Date.parse(headers[i-1].date)!==86400000)return null;
  const zones=[...new Set(leaves.map(e=>e.textContent.trim()).filter(t=>/^[A-Za-z_]+\/[A-Za-z_]+(?:[ /][A-Za-z_]+)*$/.test(t)).map(t=>t.replace(/ /g,'_')))];
  if(zones.length!==1)return null;
  const slices=[...document.querySelectorAll('[class*="_slice_"]')].filter(e=>e.getBoundingClientRect().width>0);
  const columns=headers.map(({e,date})=>{const x=e.getBoundingClientRect().x,w=e.getBoundingClientRect().width;const cells=slices.filter(s=>{const r=s.getBoundingClientRect();return Math.abs(r.x-x)<2&&Math.abs(r.width-w)<2;}).sort((a,b)=>a.getBoundingClientRect().y-b.getBoundingClientRect().y);return {date,selected:cells.map(s=>[...s.classList].some(c=>c.startsWith('_selected_')))};});
  if(columns.some(c=>c.selected.length!==96))return null;
  return {timezone:zones[0],columns};
}
// Works out what the two expanders do: each is clicked once, under the write
// guard, and the hour labels and column heights are measured before and after.
// Only a button inside the grid whose class starts "_expander_" is clicked:
// never a form field or submit button, never with an editable field focused.
// Without the guard nothing is clicked. A blocked write stops the read.
async function exploreExpanders(page,guard){
  if(!guard){console.warn('[availability-reader] Expanders not explored: no write guard.');return;}
  guard.expanding();
  const editableFocused=()=>{const a=document.activeElement;return !!a&&(a.isContentEditable||['INPUT','SELECT','TEXTAREA'].includes(a.tagName));};
  const span=()=>{const grid=[...document.querySelectorAll('div')].find(e=>[...e.classList].some(c=>c.startsWith('_grid_'))&&e.getBoundingClientRect().width);if(!grid)return 'no grid';
    const col=[...grid.querySelectorAll('[role=group]')].find(e=>[...e.classList].some(c=>c.startsWith('_column_')));
    const t=[...grid.querySelectorAll('*')].filter(e=>e.children.length===0&&!(col&&col.closest('[class*="_body_"]')?.contains(e))&&/^\d{1,2}(:\d{2})?\s*(AM|PM|am|pm)$/.test((e.textContent||'').trim())).map(e=>e.textContent.trim());
    return `hours ${t[0]||'?'} to ${t.at(-1)||'?'} (${t.length} labels), column height ${col?Math.round(col.getBoundingClientRect().height):'?'}`;};
  for(const which of ['top','bottom']){
    const handle=await page.evaluateHandle(which=>{
      const grid=[...document.querySelectorAll('div')].find(e=>[...e.classList].some(c=>c.startsWith('_grid_'))&&e.getBoundingClientRect().width);
      const buttons=grid?[...grid.querySelectorAll('button')].filter(b=>[...b.classList].some(c=>c.startsWith('_expander_'))):[];
      const b=buttons.find(b=>[...b.classList].some(c=>c.startsWith('_bottom_'))===(which==='bottom'));
      if(!b)return 'not found';if(b.disabled)return 'disabled';if(b.form&&b.type==='submit')return 'would submit a form';
      return b;
    },which);
    const el=handle.asElement();
    if(!el){console.warn(`[availability-reader] ${which} expander not clicked: ${await handle.jsonValue()}`);continue;}
    if(await page.evaluate(editableFocused)){console.warn('[availability-reader] Expanders not explored: a field had focus.');return;}
    const before=await page.evaluate(span);
    await el.click({timeout:5000});await page.waitForTimeout(800);
    if(await page.evaluate(editableFocused)){console.warn(`[availability-reader] Clicking the ${which} expander put the cursor in a field; stopped.`);fail('Reading the availability grid put the cursor in a field, so reading stopped. Nothing was saved: writes are blocked while the page is open.');}
    console.warn(`[availability-reader] ${which} expander: before ${before}; after ${await page.evaluate(span)}; now measured: ${await page.evaluate(measureGrid)}`);
    const blocked=guard.problem();
    if(blocked)fail(`Ashby tried to send a change while the availability grid was being read (${blocked.summary}), and it was blocked. Nothing was saved.`);
  }
}
async function readAvailability(page,input,{guard=null}={}){
  // Every wait that can run out names what didn't load; none surfaces as the
  // generic "could not read" from the worker.
  const step=async(work,message)=>{try{return await work();}catch(e){if(e?.name==='TimeoutError'||/Timeout \d+ms exceeded/.test(e?.message||''))fail(message);throw e;}};
  await step(()=>page.getByRole('heading',{name:'Candidate Availability',exact:true}).waitFor({state:'visible',timeout:15000}),"Ashby's Candidate Availability page didn't load within 15 seconds. Try again.");
  const dateControl=page.getByPlaceholder('Set date to view...',{exact:true});
  await step(()=>dateControl.waitFor({state:'visible',timeout:15000}),"The availability page loaded, but its week picker didn't appear within 15 seconds. Try again.");
  if(await page.getByRole('checkbox',{name:'Show All Availability?',exact:true}).isChecked())fail('Select availability for this request only.');
  // A week that can't be read is skipped, not fatal: its availability is
  // unknown, and the result says which weeks those are, so "none found" never
  // covers them. The read fails only if no week at all can be read.
  const weeks=[],unread=[];let anchor=null,explored=false;
  for(let week=0;week<6;week++){
    await page.waitForTimeout(1000);
    await step(()=>page.getByText('Fetching...',{exact:true}).waitFor({state:'hidden',timeout:15000}),`Ashby was still fetching week ${week+1} of the availability after 15 seconds. Try again.`);
    const shown=await dateControl.inputValue().catch(()=>'');
    // 15 seconds for the first week; once a week has failed, 5 for each later
    // one, so six unreadable weeks still finish inside the dashboard's
    // 120-second limit for this read (booking-worker-client.js).
    let data=null;try{const handle=await page.waitForFunction(collectGrid,null,{timeout:unread.length?5000:15000});data=await handle.jsonValue();}
    catch(_){const seen=await page.evaluate(describeGrid).catch(()=>'nothing readable');console.warn(`[availability-reader] Week ${week+1} grid unreadable: ${seen}`);
      console.warn(`[availability-reader] Week ${week+1} grid measured: ${await page.evaluate(measureGrid).catch(e=>'measuring failed: '+e.message)}`);
      if(!explored){explored=true;await exploreExpanders(page,guard);}
      unread.push({week:week+1,shown,reason:`The reader needs 7 consecutive day headers ("Sun 27", dated from the week picker), one timezone label and 96 cells per day, and found ${seen}.`});}
    if(data){
      const parsed=parseGrid(data);
      // Weeks advance by exactly seven days from the last one read, so a click
      // that didn't land can't pass for the next week.
      const expected=anchor&&new Date(Date.parse(anchor.start+'T12:00:00Z')+7*(week-anchor.week)*86400000).toISOString().slice(0,10);
      if(expected&&parsed.start!==expected)fail('The availability week did not finish changing.');
      if(weeks.length&&parsed.timezone!==weeks[0].timezone)fail('The availability timezone changed while reading.');
      weeks.push(parsed);anchor={start:parsed.start,week};
    }
    if(week===5)break;
    const old=await dateControl.inputValue();
    const nextIndex=await page.evaluate(()=>{const input=document.querySelector('input[placeholder="Set date to view..."]');if(!input)return -1;const r=input.getBoundingClientRect(),buttons=[...document.querySelectorAll('button')];const adjacent=buttons.map((e,index)=>({r:e.getBoundingClientRect(),index})).filter(b=>b.r.width&&b.r.x>=r.right&&b.r.x<r.right+110&&Math.abs(b.r.y+b.r.height/2-r.y-r.height/2)<15).sort((a,b)=>a.r.x-b.r.x);return adjacent.length>=2?adjacent[1].index:-1;});
    if(nextIndex<0)fail('The next availability week control could not be identified.');
    await page.locator('button').nth(nextIndex).click();
    await step(()=>page.waitForFunction(old=>document.querySelector('input[placeholder="Set date to view..."]')?.value!==old,old,{timeout:5000}),`The availability page didn't move to week ${week+2} within 5 seconds. Try again.`);
  }
  if(!weeks.length)fail(`None of the 6 weeks of submitted availability could be read, so it isn't known whether the candidate has any. Week 1: ${unread[0].reason}`);
  return {complete:true,timezone:weeks[0].timezone,windows:weeks.flatMap(w=>w.windows),scope:{start:weeks[0].start,end:weeks.at(-1).end},
    unreadWeeks:unread.map(({week,shown})=>({week,shown})),notes:'',bookingEnabled:false};
}
module.exports={readAvailability,parseGrid,collectGrid,describeGrid,measureGrid,exploreExpanders};
