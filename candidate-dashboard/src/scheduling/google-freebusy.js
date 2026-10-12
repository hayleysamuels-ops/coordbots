'use strict';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
// Why a calendar couldn't be read, from Google's per-calendar `errors` (or its
// absence from the reply). Google documents notFound, internalError,
// groupTooBig and tooManyCalendarsRequested, and says more may come. It does
// NOT say what an unshared calendar returns: notFound covers "no such
// calendar", and reportedly also "not shared with this account", so the two
// can't be told apart from the free/busy reply. `kind` is what the coordinator
// should do about it; `transient` means trying again may work.
const UNREADABLE={
  not_found_or_not_shared:{transient:false},
  google_error:{transient:true},
  incomplete:{transient:true},
  request_rejected:{transient:false},
  unrecognised:{transient:false},
};
function classify(row){
  if(!row)return {kind:'incomplete',reason:'missing from the reply'};
  const reason=row.errors?.length?String(row.errors[0]?.reason||'unknown'):null;
  if(reason==='notFound')return {kind:'not_found_or_not_shared',reason};
  if(reason==='internalError'||reason==='backendError')return {kind:'google_error',reason};
  if(reason==='groupTooBig'||reason==='tooManyCalendarsRequested')return {kind:'request_rejected',reason};
  if(reason)return {kind:'unrecognised',reason};
  if(!Array.isArray(row.busy))return {kind:'incomplete',reason:'no busy list'};
  return null;
}
// One line per unreadable calendar. `nameFor` turns a calendar ID into the
// interviewer's name where the caller knows it; `account` is the connected
// Google account the calendars must be shared with.
function describeUnreadable(list,{total,account,nameFor=id=>id}){
  const who=u=>{const name=nameFor(u.calendarId);return name&&name!==u.calendarId?`${name} (${u.calendarId})`:u.calendarId;};
  const to=account||'the connected Google account';
  const line=u=>{switch(u.kind){
    case 'not_found_or_not_shared':return `${who(u)}: Google found no calendar it will show to ${to}. Either it isn't shared with that account, or the address isn't a Google calendar. Google's reply doesn't say which. Check the address in Ashby, then ask for free/busy to be shared with ${to}.`;
    case 'google_error':return `${who(u)}: temporary Google error (${u.reason}). Try again in a few minutes. If it keeps happening for this person only, check their sharing too: Google may report a sharing problem this way.`;
    case 'incomplete':return `${who(u)}: Google's reply was incomplete (${u.reason}). Try again.`;
    case 'request_rejected':return `${who(u)}: Google rejected the request itself (${u.reason}). This is a fault in the check, not in the calendar.`;
    default:return `${who(u)}: Google returned "${u.reason}", which this check doesn't recognise. Nothing was assumed about this calendar.`;
  }};
  const head=`Couldn't read ${list.length} of ${total} interviewer calendar${total===1?'':'s'}, so no times were proposed. No one was treated as free or busy.`;
  return [head,...list.map(u=>'• '+line(u))].join('\n');
}
function unreadableError(list,{total,account,nameFor}){
  // 409 when the coordinator has something to fix; 503 when retrying may be enough.
  const status=list.every(u=>UNREADABLE[u.kind]?.transient)?503:409;
  return Object.assign(Error(describeUnreadable(list,{total,account,nameFor})),{status,unreadable:list,total,account});
}
// Parses one reply. Calendars that can't be read are collected, not failed one
// at a time, so a single refusal names every one of them. A reply that's
// malformed as a whole (wrong range, groups, bad intervals) still fails outright.
function parseFreeBusy(data,{calendarIds,start,end,checkedAt}){
  if(data?.kind!=='calendar#freeBusy'||Date.parse(data.timeMin)!==start||Date.parse(data.timeMax)!==end||!data.calendars||Object.keys(data.groups||{}).length)fail(503,'Google did not return complete coverage for the requested calendars.');
  const rows=[],unreadable=[];
  for(const id of calendarIds){
    const row=Object.hasOwn(data.calendars,id)?data.calendars[id]:null;
    const problem=classify(row);
    if(problem){unreadable.push({calendarId:id,...problem});continue;}
    const busy=row.busy.map(b=>{const from=Date.parse(b.start),until=Date.parse(b.end);if(!Number.isFinite(from)||!Number.isFinite(until)||until<=from)fail(503,'Google returned an invalid busy interval.');return {start:Math.max(start,from),end:Math.min(end,until)};}).filter(b=>b.end>b.start).map(b=>({start:new Date(b.start).toISOString(),end:new Date(b.end).toISOString()}));
    rows.push({calendarId:id,busy,coverage:[{start:new Date(start).toISOString(),end:new Date(end).toISOString()}],coverageVerified:true,checkedAt,source:'google-calendar-freebusy'});
  }
  return {rows,unreadable};
}
// Request-level failures (the whole call, not one calendar).
const RATE_LIMITED=new Set(['rateLimitExceeded','userRateLimitExceeded','quotaExceeded','dailyLimitExceeded']);
function requestFailure(status,body,account){
  const reason=body?.error?.errors?.[0]?.reason||body?.error?.status||null;
  if(status===429||(status===403&&RATE_LIMITED.has(reason)))return [503,'Google is limiting how fast calendars can be read. Try again in a minute. No availability was confirmed.'];
  if(status===401)return [409,`Google Calendar authorization for ${account||'the connected account'} has expired or was revoked. Reconnect it on the Google Calendar page.`];
  if(status===403)return [409,`Google refused calendar access for ${account||'the connected account'}${reason?` (${reason})`:''}. Reconnect it on the Google Calendar page; if that doesn't help, check the Google Cloud project's Calendar API access.`];
  return [503,`Google Calendar is temporarily unavailable (HTTP ${status}). Try again. No availability was confirmed.`];
}
function createGoogleFreeBusy({connection,request=fetch,now=()=>Date.now()}){
  return {async read({calendarIds,timeMin,timeMax}){
    if(!Array.isArray(calendarIds)||!calendarIds.length||calendarIds.length>200||calendarIds.some(id=>typeof id!=='string'||!id.includes('@')||id.length>254))fail(422,'Valid server-resolved calendar IDs are required.');
    const ids=[...new Set(calendarIds)],start=Date.parse(timeMin),end=Date.parse(timeMax),startedAt=now();
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||start<startedAt||end-start>42*86400000)fail(422,'Calendar checks require a future range of no more than six weeks.');
    const authorization=await connection.access();
    const account=connection.status?.().account||null;
    const results=[],unreadable=[];
    for(let offset=0;offset<ids.length;offset+=50){
      const batch=ids.slice(offset,offset+50);
      let response,data;try{response=await request('https://www.googleapis.com/calendar/v3/freeBusy',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+authorization.token,'Content-Type':'application/json'},body:JSON.stringify({timeMin:new Date(start).toISOString(),timeMax:new Date(end).toISOString(),timeZone:'UTC',calendarExpansionMax:50,items:batch.map(id=>({id}))})});data=await response.json().catch(()=>null);}catch(_){fail(503,'Google Calendar could not be reached. Try again. No availability was confirmed.');}
      if(!response.ok){const [status,message]=requestFailure(response.status,data,account);fail(status,message);}
      const parsed=parseFreeBusy(data,{calendarIds:batch,start,end,checkedAt:startedAt});
      results.push(...parsed.rows);unreadable.push(...parsed.unreadable);
    }
    if(!connection.isCurrent(authorization.connectionId))fail(409,'The Google connection changed during this check. Read calendars again.');
    if(unreadable.length)throw unreadableError(unreadable,{total:ids.length,account});
    return results;
  }};
}
module.exports={createGoogleFreeBusy,parseFreeBusy,describeUnreadable,unreadableError};
