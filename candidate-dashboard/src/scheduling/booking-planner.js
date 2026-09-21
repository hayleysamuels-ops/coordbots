"use strict";
const fail = message => { throw Object.assign(new Error(message), {status:422}); };
// Convert a wall-clock input in an IANA zone without relying on the server's TZ.
// Ambiguous fall-back times and nonexistent spring-forward times require a new
// window rather than silently selecting a different instant.
function instant(local, timezone) {
  if(typeof local !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) fail('Enter a date and time for each availability window.');
  let formatter; try { formatter = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}); } catch (_) { fail('Choose a valid time zone.'); }
  const wall = Date.parse(local+'Z'); if(!Number.isFinite(wall))fail('Invalid availability date.');
  const format = ms => {const p=Object.fromEntries(formatter.formatToParts(ms).map(p=>[p.type,p.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;};
  const offsets=new Set();
  for(const delta of [-36,-12,0,12,36]){const t=wall+delta*3600000;offsets.add(Date.parse(format(t)+'Z')-t);}
  const candidates=[...offsets].map(o=>wall-o).filter(t=>format(t)===local);
  if(candidates.length!==1)fail('This time is ambiguous or does not exist because of daylight saving. Choose another window.');
  return candidates[0];
}
function windowsToInstants(windows,timezone,now=Date.now()) {
  if(!Array.isArray(windows)||!windows.length||windows.length>20)fail('Provide 1–20 candidate availability windows.');
  return windows.map(w=>{const start=instant(w.start,timezone),end=instant(w.end,timezone);if(start<=now||end<=start||end-start>24*3600000)fail('Availability must be future dated, with each window no longer than one day.');return {start,end};}).sort((a,b)=>a.start-b.start);
}
function proposeSlots({windows,timezone,durationMinutes,calendar,now=Date.now(),limit=5}) {
  if(!Number.isInteger(durationMinutes)||durationMinutes<5||durationMinutes>480)fail('A supported interview duration is required.');
  const candidate=windowsToInstants(windows,timezone,now);
  // Missing calendars, partial coverage, and missing working hours are never free.
  if(!calendar || calendar.verified!==true || !Number.isFinite(calendar.checkedAt) || calendar.checkedAt>now || now-calendar.checkedAt>60000 || !Array.isArray(calendar.busy) || !Array.isArray(calendar.workingWindows))fail('A current, complete interviewer calendar is required.');
  const intervals = rows => rows.map(r=>{const start=Date.parse(r.start),end=Date.parse(r.end);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)fail('Calendar intervals are invalid.');return {start,end};});
  const busy=intervals(calendar.busy),working=intervals(calendar.workingWindows),coverage=intervals(calendar.coverage || []);
  if(candidate.some(w=>!coverage.some(c=>c.start<=w.start&&c.end>=w.end)))fail('The calendar does not cover all requested availability.');
  const duration=durationMinutes*60000,step=5*60000,result=[],seen=new Set();
  for(const w of candidate){for(let start=Math.ceil(w.start/step)*step;start+duration<=w.end;start+=step){const end=start+duration;if(!working.some(r=>r.start<=start&&r.end>=end)||busy.some(r=>r.start<end&&r.end>start)||seen.has(start))continue;seen.add(start);result.push({start:new Date(start).toISOString(),end:new Date(end).toISOString()});if(result.length>=limit)return result;}}
  return result;
}
module.exports={instant,windowsToInstants,proposeSlots};
