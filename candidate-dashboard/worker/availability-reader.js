'use strict';
// Reads a candidate's submitted availability from Ashby's Candidate
// Availability page, one week at a time, for six weeks.
//
// The grid, as measured on the live page (October 2, 2026). Class names are
// "_<name>_<build hash>_<n>" and the hash changes with every build, so
// everything here matches by prefix ("_grid_", "_column_", ...) or by role,
// never by a full class name:
//   _grid_ > _headerRow_ (day headers: "Sun 27", dated from the week picker)
//          > button._expander_          "Show 12 AM – 6 AM" / "Hide …"
//          > _bodyRow_ > _body_ > _column_[role=group] ×7
//                aria-label "Availability for Thursday Oct 8"
//                > _block_ per submitted window,
//                  aria-label "Thursday Oct 8 11:00 AM – 5:00 PM",
//                  with its own Remove button (never clicked)
//          > button._expander_._bottom_ "Show 8 PM – 12 AM" / "Hide …"
// Each week opens collapsed to 6 AM–8 PM. Both expanders are clicked first
// (only while they say "Show", under the write guard) so no window is hidden.
//
// The hour scale is 48px an hour and linear: every interior hour label sits
// exactly on the line. The first and last labels are clamped 8px inward,
// which is why 6 AM–7 AM measured 40px; once 8 PM stopped being the last label
// it moved exactly onto its line. So positions come from the column (height
// divided by the hours shown), never from the edge labels.
//
// A window's times come from the block's own label. Its position in the
// column must agree with them, or the read refuses: a misread scale would
// otherwise shift every window by the same amount and still look consistent.
const {instant}=require('../src/scheduling/booking-planner');
const fail=message=>{throw Object.assign(Error(message),{status:409});};
const POSITION_TOLERANCE_PX=3; // a block is drawn 1px short of its height for its border

// In the page. Ready once the grid has its 7 day columns and nothing is loading.
function gridReady(){
  const grid=[...document.querySelectorAll('div')].find(e=>[...e.classList].some(c=>c.startsWith('_grid_'))&&e.getBoundingClientRect().width);
  if(!grid||/Loading|Fetching/.test(grid.innerText||''))return false;
  return [...grid.querySelectorAll('[role=group]')].filter(e=>[...e.classList].some(c=>c.startsWith('_column_'))).length===7;
}

// In the page. Returns the week's days and blocks, or {error} saying exactly
// what didn't match. Self-contained: Playwright runs it by its source.
function collectBlocks(){
  const pre=(e,n)=>[...e.classList].some(c=>c.startsWith(`_${n}_`));
  const DAYS=['SUN','MON','TUE','WED','THU','FRI','SAT'],MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const iso=ms=>new Date(ms).toISOString().slice(0,10);
  const grid=[...document.querySelectorAll('div')].find(e=>pre(e,'grid')&&e.getBoundingClientRect().width);
  if(!grid)return {error:'there is no availability grid on the page'};
  const leaves=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.getBoundingClientRect().width);
  const zones=[...new Set(leaves.map(e=>e.textContent.trim()).filter(t=>/^[A-Za-z_]+\/[A-Za-z_]+(?:[ /][A-Za-z_]+)*$/.test(t)).map(t=>t.replace(/ /g,'_')))];
  if(zones.length!==1)return {error:`expected one timezone label, found ${zones.length?zones.join(', '):'none'}`};
  // Day headers: "Sun 27" dated from the week picker ("Sep 27, 2026"), or the
  // older "SUN 9/27/2026". Each must match its weekday, and the seven must be
  // consecutive days.
  let picked=null;
  const p=(document.querySelector('input[placeholder="Set date to view..."]')?.value||'').trim().match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/);
  if(p&&MONTHS.includes(p[1].toLowerCase()))picked=Date.UTC(Number(p[3]),MONTHS.indexOf(p[1].toLowerCase()),Number(p[2]),12);
  const found=leaves.filter(e=>grid.contains(e)).map(e=>({e,m:e.textContent.trim().match(/^(SUN|MON|TUE|WED|THU|FRI|SAT)\s+(?:(\d{1,2})\/(\d{1,2})\/(\d{4})|(\d{1,2}))$/i)})).filter(x=>x.m).sort((a,b)=>a.e.getBoundingClientRect().x-b.e.getBoundingClientRect().x);
  if(found.length!==7)return {error:`expected 7 day headers, found ${found.length}`};
  const dates=[];
  for(const {m} of found){
    const weekday=DAYS.indexOf(m[1].toUpperCase());
    if(m[2]){const ms=Date.UTC(Number(m[4]),Number(m[2])-1,Number(m[3]),12);if(new Date(ms).getUTCDay()!==weekday)return {error:`the header "${m[0]}" isn't that weekday`};dates.push(iso(ms));continue;}
    if(picked===null)return {error:'the week picker\'s date could not be read, so the day headers can\'t be dated'};
    const matches=[];for(let d=-7;d<=7;d++){const t=new Date(picked+d*86400000);if(t.getUTCDate()===Number(m[5])&&t.getUTCDay()===weekday)matches.push(iso(t.getTime()));}
    if(matches.length!==1)return {error:`the header "${m[0]}" doesn't match the week picker (${p?p[0]:'none'})`};
    dates.push(matches[0]);
  }
  for(let i=1;i<7;i++)if(Date.parse(dates[i])-Date.parse(dates[i-1])!==86400000)return {error:`the day headers aren't consecutive days (${dates.join(', ')})`};
  // Hour labels down the side, outside the day columns.
  const columns=[...grid.querySelectorAll('[role=group]')].filter(e=>pre(e,'column')).sort((a,b)=>a.getBoundingClientRect().x-b.getBoundingClientRect().x);
  if(columns.length!==7)return {error:`expected 7 day columns, found ${columns.length}`};
  const hour=t=>{const m=t.match(/^(\d{1,2})\s*(AM|PM)$/i);return m?Number(m[1])%12+(m[2].toUpperCase()==='PM'?12:0):null;};
  const labels=[...grid.querySelectorAll('*')].filter(e=>e.children.length===0&&!columns.some(c=>c.contains(e))&&hour((e.textContent||'').trim())!==null)
    .map(e=>({h:hour(e.textContent.trim()),y:e.getBoundingClientRect().top})).sort((a,b)=>a.y-b.y);
  if(labels.length<3)return {error:`expected hour labels beside the columns, found ${labels.length}`};
  const startHour=labels[0].h,endHour=labels.at(-1).h===0&&labels.length>1?24:labels.at(-1).h;
  const colHeight=columns[0].getBoundingClientRect().height,pxPerHour=colHeight/(endHour-startHour);
  // Linearity, measured rather than assumed: interior labels must be exactly
  // one hour apart at the column's scale. The end labels are clamped inward.
  const inner=labels.slice(1,-1);
  for(let i=1;i<inner.length;i++){if(inner[i].h-inner[i-1].h!==1||Math.abs(inner[i].y-inner[i-1].y-pxPerHour)>1)return {error:`the hour scale isn't linear: ${inner[i-1].h}:00 to ${inner[i].h}:00 is ${Math.round(inner[i].y-inner[i-1].y)}px, against ${pxPerHour.toFixed(1)}px an hour from the column`};}
  const days=columns.map((c,i)=>{
    const r=c.getBoundingClientRect();
    const blocks=[...c.querySelectorAll('*')].filter(e=>pre(e,'block')).map(b=>{const br=b.getBoundingClientRect();
      return {label:(b.getAttribute('aria-label')||b.innerText||'').replace(/\s+/g,' ').trim(),top:br.top-r.top,height:br.height};});
    return {date:dates[i],label:c.getAttribute('aria-label')||'',height:r.height,blocks};
  });
  return {timezone:zones[0],startHour,endHour,pxPerHour,days};
}

// In Node. Turns one week's collected blocks into windows, checking each
// block's label against its day and against its position in the column.
function parseBlocks({timezone,startHour,endHour,pxPerHour,days}){
  try{if(!timezone)throw Error();new Intl.DateTimeFormat('en-US',{timeZone:timezone}).format();}catch(_){fail('The availability display timezone could not be verified.');}
  if(!Array.isArray(days)||days.length!==7)fail('The availability week could not be read completely.');
  if(startHour!==0||endHour!==24)fail(`The availability grid showed only ${startHour}:00 to ${endHour}:00 after its hours were expanded, so windows outside that range could be missing.`);
  const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],WEEKDAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const minutes=(h,m,ap)=>{let x=Number(h)%12+(ap.toUpperCase()==='PM'?12:0);return x*60+Number(m);};
  const wall=(date,mins)=>mins===1440?new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10)+'T00:00':`${date}T${String(Math.floor(mins/60)).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`;
  const windows=[];
  for(const day of days){
    const d=new Date(day.date+'T12:00:00Z'),name=`${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    if(day.label&&!day.label.endsWith(name))fail(`The availability column "${day.label}" doesn't match its header date (${day.date}).`);
    for(const b of day.blocks){
      const m=b.label.match(/^(?:(\w+) (\w{3}) (\d{1,2}) )?(\d{1,2}):(\d{2}) (AM|PM) [–-] (\d{1,2}):(\d{2}) (AM|PM)/i);
      if(!m)fail(`An availability block on ${name} couldn't be read ("${b.label.slice(0,60)}").`);
      if(m[1]&&`${m[1]} ${m[2]} ${Number(m[3])}`!==name)fail(`An availability block in ${name}'s column is labelled for ${m[1]} ${m[2]} ${m[3]}.`);
      const start=minutes(m[4],m[5],m[6]);let end=minutes(m[7],m[8],m[9]);if(end===0)end=1440;
      if(end<=start)fail(`An availability block on ${name} ends before it starts ("${b.label.slice(0,60)}").`);
      const top=(start/60-startHour)*pxPerHour,height=(end-start)/60*pxPerHour;
      if(Math.abs(b.top-top)>POSITION_TOLERANCE_PX||Math.abs(b.height-height)>POSITION_TOLERANCE_PX)
        fail(`An availability block on ${name} is labelled "${b.label.slice(0,60)}" but drawn at ${Math.round(b.top)}px, ${Math.round(b.height)}px tall, where that time would be ${Math.round(top)}px, ${Math.round(height)}px tall. The grid may have changed; check it in Ashby.`);
      windows.push({start:new Date(instant(wall(day.date,start),timezone)).toISOString(),end:new Date(instant(wall(day.date,end),timezone)).toISOString()});
    }
  }
  return {timezone,windows,start:days[0].date,end:days[6].date};
}

// What the page holds under the day headers when a week can't be read, for the
// worker log. Class names are reduced to their prefix name ("_column_sochl_142"
// becomes "column"), so no build hash reaches the log or Step 3.
function describeGrid(){
  const short=e=>[...e.classList].map(c=>c.match(/^_([A-Za-z]+)_/)?.[1]||c).slice(0,2).join('.');
  const name=e=>{const c=short(e),role=e.getAttribute('role');return e.tagName.toLowerCase()+(c?'.'+c:'')+(role?`[role=${role}]`:'');};
  const leaves=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.getBoundingClientRect().width);
  const headers=leaves.map(e=>e.textContent.trim()).filter(t=>/^(SUN|MON|TUE|WED|THU|FRI|SAT)\b/i.test(t));
  const grid=[...document.querySelectorAll('div')].find(e=>[...e.classList].some(c=>c.startsWith('_grid_'))&&e.getBoundingClientRect().width);
  const picker=document.querySelector('input[placeholder="Set date to view..."]')?.value||'none';
  return `${headers.length} day header${headers.length===1?'':'s'} (${headers.slice(0,8).join(', ')||'none'}); week picker shows "${picker}"; ${grid?`grid ${name(grid)} with children ${[...grid.children].map(name).join(', ')}`:'no grid'}`;
}

// In the page. Every element in each day column with its position, fill, text
// and labels, plus the hour labels and expanders. Logged when a week can't be
// read, so the next fix starts from the markup.
function measureGrid(){
  const pre=(e,name)=>[...e.classList].some(c=>c.startsWith(`_${name}_`));
  const names=e=>[...e.classList].map(c=>c.match(/^_([A-Za-z]+)_/)?.[1]||c).join('.');
  const grid=[...document.querySelectorAll('div')].find(e=>pre(e,'grid')&&e.getBoundingClientRect().width);
  if(!grid)return 'no _grid_ element';
  const columns=[...grid.querySelectorAll('[role=group]')].filter(e=>pre(e,'column'));
  const g=grid.getBoundingClientRect();
  const labelOf=e=>[e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('aria-expanded')!==null?`expanded=${e.getAttribute('aria-expanded')}`:null].filter(Boolean).join(' ');
  const expanders=[...grid.querySelectorAll('button')].filter(e=>pre(e,'expander')).map(b=>`button.${names(b)} "${(b.innerText||'').replace(/\s+/g,' ').trim().slice(0,40)}"${labelOf(b)?` [${labelOf(b)}]`:''}${b.disabled?' disabled':''}`);
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

// Shows all 24 hours by clicking each expander that still says "Show", under
// the write guard. Only a button inside the grid whose class starts
// "_expander_" is clicked: never a block's Remove button, a submit button or
// a disabled one, never while a field has focus, and never without the guard.
// Returns null when every hour is showing, or why it couldn't be.
async function showAllHours(page,guard){
  const editableFocused=()=>{const a=document.activeElement;return !!a&&(a.isContentEditable||['INPUT','SELECT','TEXTAREA'].includes(a.tagName));};
  for(let attempt=0;attempt<2;attempt++){
    const handle=await page.evaluateHandle(()=>{
      const grid=[...document.querySelectorAll('div')].find(e=>[...e.classList].some(c=>c.startsWith('_grid_'))&&e.getBoundingClientRect().width);
      const b=grid&&[...grid.querySelectorAll('button')].find(b=>[...b.classList].some(c=>c.startsWith('_expander_'))&&/^Show\b/.test((b.innerText||'').trim()));
      if(!b)return 'none';
      if(b.disabled)return 'an hour-range expander is disabled';
      if(b.form&&b.type==='submit')return 'an hour-range expander would submit a form';
      return b;
    });
    const el=handle.asElement();
    if(!el){const why=await handle.jsonValue();return why==='none'?null:why;}
    if(!guard)return 'the hidden hours need an expander clicked, and the write guard isn\'t active, so nothing was clicked';
    if(await page.evaluate(editableFocused))return 'a field had the cursor, so the hour-range expanders weren\'t clicked';
    const text=(await el.innerText()).trim();
    guard.expanding();
    await el.click({timeout:5000});
    if(await page.evaluate(editableFocused))fail('Showing the availability grid\'s hidden hours put the cursor in a field, so reading stopped. Nothing was saved: writes are blocked while the page is open.');
    try{await page.waitForFunction(t=>{const grid=[...document.querySelectorAll('div')].find(e=>[...e.classList].some(c=>c.startsWith('_grid_'))&&e.getBoundingClientRect().width);return !!grid&&![...grid.querySelectorAll('button')].some(b=>(b.innerText||'').trim()===t);},text,{timeout:3000});}
    catch(_){return `clicking "${text}" didn't show those hours`;}
    const blocked=guard.problem();
    if(blocked)fail(`Ashby tried to send a change while the availability grid was being read (${blocked.summary}), and it was blocked. Nothing was saved.`);
  }
  return null;
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
  // covers them. The read fails only if no week at all can be read. A week
  // that reads but contradicts itself (a block whose label and position
  // disagree) fails the whole read: that's a misread, not a gap.
  const weeks=[],unread=[];let anchor=null;
  for(let week=0;week<6;week++){
    await page.waitForTimeout(1000);
    await step(()=>page.getByText('Fetching...',{exact:true}).waitFor({state:'hidden',timeout:15000}),`Ashby was still fetching week ${week+1} of the availability after 15 seconds. Try again.`);
    const shown=await dateControl.inputValue().catch(()=>'');
    const skip=async reason=>{console.warn(`[availability-reader] Week ${week+1} (${shown}) not read: ${reason}. Page: ${await page.evaluate(describeGrid).catch(()=>'nothing readable')}`);
      console.warn(`[availability-reader] Week ${week+1} grid measured: ${await page.evaluate(measureGrid).catch(e=>'measuring failed: '+e.message)}`);
      unread.push({week:week+1,shown,reason});};
    // 15 seconds for the first week; once a week has failed, 5 for each later
    // one, so six unreadable weeks still finish inside the dashboard's
    // 120-second limit for this read (booking-worker-client.js).
    let ready=true;try{await page.waitForFunction(gridReady,null,{timeout:unread.length?5000:15000});}catch(_){ready=false;}
    if(!ready)await skip('its grid of 7 day columns didn\'t load');
    else{
      const hidden=await showAllHours(page,guard);
      if(hidden)await skip(hidden);
      else{
        const data=await page.evaluate(collectBlocks);
        if(data.error)await skip(data.error);
        else{
          const parsed=parseBlocks(data);
          // Weeks advance by exactly seven days from the last one read, so a click
          // that didn't land can't pass for the next week.
          const expected=anchor&&new Date(Date.parse(anchor.start+'T12:00:00Z')+7*(week-anchor.week)*86400000).toISOString().slice(0,10);
          if(expected&&parsed.start!==expected)fail('The availability week did not finish changing.');
          if(weeks.length&&parsed.timezone!==weeks[0].timezone)fail('The availability timezone changed while reading.');
          weeks.push(parsed);anchor={start:parsed.start,week};
        }
      }
    }
    if(week===5)break;
    const old=await dateControl.inputValue();
    const nextIndex=await page.evaluate(()=>{const input=document.querySelector('input[placeholder="Set date to view..."]');if(!input)return -1;const r=input.getBoundingClientRect(),buttons=[...document.querySelectorAll('button')];const adjacent=buttons.map((e,index)=>({r:e.getBoundingClientRect(),index})).filter(b=>b.r.width&&b.r.x>=r.right&&b.r.x<r.right+110&&Math.abs(b.r.y+b.r.height/2-r.y-r.height/2)<15).sort((a,b)=>a.r.x-b.r.x);return adjacent.length>=2?adjacent[1].index:-1;});
    if(nextIndex<0)fail('The next availability week control could not be identified.');
    await page.locator('button').nth(nextIndex).click();
    await step(()=>page.waitForFunction(old=>document.querySelector('input[placeholder="Set date to view..."]')?.value!==old,old,{timeout:5000}),`The availability page didn't move to week ${week+2} within 5 seconds. Try again.`);
  }
  if(!weeks.length)fail(`None of the 6 weeks of submitted availability could be read, so it isn't known whether the candidate has any. Week 1 (${unread[0].shown||'first week'}): ${unread[0].reason}.`);
  return {complete:true,timezone:weeks[0].timezone,windows:weeks.flatMap(w=>w.windows),scope:{start:weeks[0].start,end:weeks.at(-1).end},
    unreadWeeks:unread.map(({week,shown})=>({week,shown})),notes:'',bookingEnabled:false};
}
module.exports={readAvailability,parseBlocks,collectBlocks,gridReady,showAllHours,describeGrid,measureGrid};
