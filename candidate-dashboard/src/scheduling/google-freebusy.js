'use strict';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
function parseFreeBusy(data,{calendarIds,start,end,checkedAt}){
  if(data?.kind!=='calendar#freeBusy'||Date.parse(data.timeMin)!==start||Date.parse(data.timeMax)!==end||!data.calendars||Object.keys(data.groups||{}).length)fail(503,'Google did not return complete coverage for the requested calendars.');
  return calendarIds.map(id=>{
    const row=Object.hasOwn(data.calendars,id)?data.calendars[id]:null;
    if(!row||!Array.isArray(row.busy)||(row.errors?.length))fail(409,'At least one interviewer calendar is inaccessible or incomplete. Check calendar-sharing permissions.');
    const busy=row.busy.map(b=>{const from=Date.parse(b.start),until=Date.parse(b.end);if(!Number.isFinite(from)||!Number.isFinite(until)||until<=from)fail(503,'Google returned an invalid busy interval.');return {start:Math.max(start,from),end:Math.min(end,until)};}).filter(b=>b.end>b.start).map(b=>({start:new Date(b.start).toISOString(),end:new Date(b.end).toISOString()}));
    return {calendarId:id,busy,coverage:[{start:new Date(start).toISOString(),end:new Date(end).toISOString()}],coverageVerified:true,checkedAt,source:'google-calendar-freebusy'};
  });
}
function createGoogleFreeBusy({connection,request=fetch,now=()=>Date.now()}){
  return {async read({calendarIds,timeMin,timeMax}){
    if(!Array.isArray(calendarIds)||!calendarIds.length||calendarIds.length>200||calendarIds.some(id=>typeof id!=='string'||!id.includes('@')||id.length>254))fail(422,'Valid server-resolved calendar IDs are required.');
    const ids=[...new Set(calendarIds)],start=Date.parse(timeMin),end=Date.parse(timeMax),startedAt=now();
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||start<startedAt||end-start>42*86400000)fail(422,'Calendar checks require a future range of no more than six weeks.');
    const authorization=await connection.access();
    const results=[];
    for(let offset=0;offset<ids.length;offset+=50){
      const batch=ids.slice(offset,offset+50);
      let response,data;try{response=await request('https://www.googleapis.com/calendar/v3/freeBusy',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+authorization.token,'Content-Type':'application/json'},body:JSON.stringify({timeMin:new Date(start).toISOString(),timeMax:new Date(end).toISOString(),timeZone:'UTC',calendarExpansionMax:50,items:batch.map(id=>({id}))})});data=await response.json();}catch(_){fail(503,'Google Calendar could not be reached. No availability was confirmed.');}
      if(!response.ok)fail(response.status===401||response.status===403?409:503,'Google Calendar access could not be verified. Reconnect or check access with your administrator.');
      results.push(...parseFreeBusy(data,{calendarIds:batch,start,end,checkedAt:startedAt}));
    }
    if(!connection.isCurrent(authorization.connectionId))fail(409,'The Google connection changed during this check. Read calendars again.');
    return results;
  }};
}
module.exports={createGoogleFreeBusy,parseFreeBusy};
