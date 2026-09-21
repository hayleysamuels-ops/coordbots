'use strict';
const {instant}=require('../src/scheduling/booking-planner');
const fail=message=>{throw Object.assign(Error(message),{status:409});};
function parseCalendar({date,timezone,interviewer,blocks,draftBlocks}){
  const match=String(date).match(/(?:\w+,\s*)?(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})/);
  if(!match)fail('The displayed calendar date could not be verified.');
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const day=`${match[3]}-${String(months.indexOf(match[1])+1).padStart(2,'0')}-${match[2].padStart(2,'0')}`;
  try{new Intl.DateTimeFormat('en-US',{timeZone:timezone}).format();}catch(_){fail('The interviewer timezone could not be verified.');}
  if(!timezone||!Array.isArray(blocks)||!blocks.length)fail('The calendar is empty or has not finished loading.');
  function interval(text){
    const m=text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*[–-]\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s+([A-Z]{2,5})\s*$/i);
    if(!m)fail('A calendar block could not be read; no free times can be inferred.');
    const wall=(h,min,ampm)=>`${day}T${String(Number(h)%12+(ampm.toUpperCase()==='PM'?12:0)).padStart(2,'0')}:${min}`;
    const start=instant(wall(m[1],m[2],m[3]),timezone),end=instant(wall(m[4],m[5],m[6]),timezone);
    if(end<=start)fail('Overnight calendar blocks require further verification.');
    const zone=new Intl.DateTimeFormat('en-US',{timeZone:timezone,timeZoneName:'short'}).formatToParts(start).find(p=>p.type==='timeZoneName').value;
    if(zone!==m[7].toUpperCase())fail('The calendar time label does not match the interviewer timezone.');
    return {start:new Date(start).toISOString(),end:new Date(end).toISOString()};
  }
  const events=blocks.map(interval);
  // Draft overlays are kept occupied until their event identity is verified.
  // Never remove a block merely because its title resembles the draft title.
  return {date:day,timezone,interviewer,observedBusy:events,draftOverlayCount:draftBlocks.length,
    coverageVerified:false,workingHoursVerified:false,availabilityVerified:false,
    issues:['This is the displayed day only; complete calendar coverage and working hours are not yet verified.','Unsent draft overlays remain included in occupied time.'],bookingEnabled:false};
}
async function readCalendar(page,{interviewer}){
  const name=interviewer.name;
  try { await page.getByRole('heading',{name,exact:true}).first().waitFor({state:'visible',timeout:15000}); }
  catch (_) { fail('The requested interviewer calendar is not displayed in the saved draft.'); }
  let date;
  try { date=await page.getByPlaceholder('Set date to view...',{exact:true}).inputValue({timeout:5000}); }
  catch (_) { fail('The calendar date control could not be read.'); }
  const data=await page.evaluate(({name})=>{
    const headings=[...document.querySelectorAll('h3')];
    const anchor=headings.find(h=>h.innerText.trim()==='Current Schedule');
    if(!anchor)return null;
    const y=anchor.getBoundingClientRect().top;
    const headers=headings.filter(h=>Math.abs(h.getBoundingClientRect().top-y)<12).map(h=>({name:h.innerText.trim(),x:h.getBoundingClientRect().left+h.getBoundingClientRect().width/2,h})).sort((a,b)=>a.x-b.x);
    const target=headers.filter(h=>h.name===name);if(target.length!==1)return null;
    let timezone=null;
    for(let p=target[0].h.parentElement;p&&p.tagName!=='BODY';p=p.parentElement){if(p.querySelectorAll('h3').length>1)break;const m=p.innerText.match(/\b([A-Za-z_]+\/[A-Za-z_ /]+?)\s*\(GMT[+-]/);if(m){timezone=m[1].trim().replace(/ /g,'_');break;}}
    const groups=new Map(headers.map(h=>[h.name,[]]));
    for(const b of document.querySelectorAll('button')){const rect=b.getBoundingClientRect();if(!rect.width||!rect.height||rect.top<=y||!b.querySelector('h2'))continue;const text=b.innerText.replace(/\s+/g,' ').trim();if(!/\d{1,2}:\d{2}\s*(AM|PM)/i.test(text))continue;const x=rect.left+rect.width/2;const nearest=headers.slice().sort((a,c)=>Math.abs(a.x-x)-Math.abs(c.x-x))[0];groups.get(nearest.name).push(text);}
    return {timezone,blocks:groups.get(name),draftBlocks:groups.get('Current Schedule')||[]};
  },{name});
  if(!data)fail('The interviewer calendar column could not be identified.');
  return parseCalendar({date,...data,interviewer});
}
module.exports={readCalendar,parseCalendar};
