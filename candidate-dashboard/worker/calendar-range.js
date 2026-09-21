'use strict';
const {readCalendar}=require('./calendar-reader');
const fail=message=>{throw Object.assign(Error(message),{status:409});};
function requestedDates(windows,timezone){
  if(!Array.isArray(windows)||!windows.length)fail('Candidate availability is required for calendar checks.');
  let format;try{format=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});}catch(_){fail('A calendar view timezone is required.');}
  const day=ms=>{const p=Object.fromEntries(format.formatToParts(ms).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;};
  const dates=new Set();
  for(const w of windows){const start=Date.parse(w.start),end=Date.parse(w.end);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>86400000)fail('Invalid calendar window.');dates.add(day(start));dates.add(day(end-1));}
  if(dates.size>5)fail('Check up to five calendar dates at a time.');
  return [...dates].sort();
}
function dateLabel(day){const [y,m,d]=day.split('-').map(Number),date=new Date(Date.UTC(y,m-1,d));const suffix=d%100>=11&&d%100<=13?'th':({1:'st',2:'nd',3:'rd'}[d%10]||'th');return 'Choose '+new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'long'}).format(date)+', '+new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'long'}).format(date)+` ${d}${suffix}, ${y}`;}
async function readCalendarRange(page,input,{readDay=readCalendar}={}){
  const dateControl=page.getByPlaceholder('Set date to view...',{exact:true});
  const mode=page.getByRole('checkbox',{name:'Multi-Day Schedule',exact:true});
  const originalDate=await dateControl.inputValue(),originalMode=await mode.isChecked();
  const draftDates=async()=>Promise.all((await page.getByPlaceholder('Set interview date...',{exact:true}).all()).map(e=>e.inputValue()));
  await page.getByPlaceholder('Set interview date...',{exact:true}).first().waitFor({state:'visible',timeout:15000});
  const before=JSON.stringify(await draftDates());
  if(before==='[]')fail('The existing interview dates could not be verified.');
  async function select(day){
    await dateControl.click();
    const option=page.getByLabel(dateLabel(day),{exact:true});
    if(await option.count()!==1)fail('That date is outside the displayed calendar month. Check a shorter range.');
    await option.click();
  }
  let first,results=[];
  try{
    first=await readDay(page,input);
    if(!first.viewTimezone)fail('The calendar view timezone could not be identified.');
    const dates=requestedDates(input.windows,first.viewTimezone);
    if(dates.some(d=>d.slice(0,7)!==first.date.slice(0,7)))fail('Calendar inspection currently supports dates in the displayed month.');
    // In single-day mode these controls MOVE interviews. Multi-day mode must
    // be enabled before changing only the calendar view, and dates are checked.
    await mode.check();
    for(const day of dates){
      if(!(await mode.isChecked()))fail('Multi-day view is required to preserve interview dates.');
      if(day!==first.date||results.length){await select(day);}
      const r=day===first.date&&!results.length?first:await readDay(page,input);
      if(r.date!==day||r.viewTimezone!==first.viewTimezone)fail('The requested calendar day could not be verified.');
      if(JSON.stringify(await draftDates())!==before)fail('The saved interview dates changed. Review the draft in Ashby.');
      results.push(r);
    }
    return {interviewer:input.interviewer,timezone:first.timezone,viewTimezone:first.viewTimezone,dates,days:results,observedBusy:results.flatMap(r=>r.observedBusy),coverageVerified:false,workingHoursVerified:false,availabilityVerified:false,bookingEnabled:false,issues:['Observed calendar blocks only; complete coverage and interview counts still require review.']};
  }finally{
    // Restore the view BEFORE restoring single-day mode. Never navigate dates
    // after switching back, because that would move the saved interviews.
    if(first&&await dateControl.inputValue()!==originalDate)await select(first.date);
    if(JSON.stringify(await draftDates())!==before)fail('The saved interview dates changed. Review the draft in Ashby.');
    if(!originalMode)await mode.uncheck();
  }
}
module.exports={requestedDates,dateLabel,readCalendarRange};
