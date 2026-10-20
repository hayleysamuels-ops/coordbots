'use strict';
// Booking's permitted writes, installed in front of the write guard
// (template-guard.js), which stays on throughout and blocks everything else.
// Playwright runs the most recently registered route first, so these see each
// request before the guard; anything they don't permit falls back to it.
//
// Each permit lets through a POST to Ashby's GraphQL endpoint carrying exactly
// one operation, the named mutation, at most `max` times, and only when
// `bound(variables)` accepts it. Observed sequence (handoff, October 12-13):
//   ApiCreateTemplateDraftScheduleForInterviewSchedule  once, this schedule
//   ApiUpdateDraftSchedule                              this draft; content-checked
//   ApiRefreshDraftInterviewScheduleCandidateConfirmationEmailPreview   this draft
//   ApiDeleteDraftInterviewSchedule                     this draft, during cleanup only
// Send (ApiScheduleInterviewScheduleFromDraft) is not on this list, so the dry
// run cannot send. ApiCancelInterviewScheduleProcess ("Delete Activity") and
// ApiUpdateDraftScheduleCalendarSettings are never permitted.
const {normalizeDraft,checkBaseline,checkSave}=require('./booking-check');
const ORIGIN='https://app.ashbyhq.com';
const OP={create:'ApiCreateTemplateDraftScheduleForInterviewSchedule',save:'ApiUpdateDraftSchedule',
  refresh:'ApiRefreshDraftInterviewScheduleCandidateConfirmationEmailPreview',discard:'ApiDeleteDraftInterviewSchedule',
  send:'ApiScheduleInterviewScheduleFromDraft',
  // Sent by Ashby right after a schedule is booked; it publishes the calendar
  // invites (October 20: blocked, the booking stood with "Pending invites").
  publish:'ApiPublishPendingCalendarUpdates'};

function parsedOps(body){try{const p=JSON.parse(body||'');return Array.isArray(p)?p:[p];}catch(_){return null;}}
function isMutation(o){return typeof o?.query==='string'&&/^\s*mutation\b/.test(o.query.replace(/#[^\n]*/g,''));}

// One permitted operation. `respond(route)` sends it: the network by default,
// returning {response}; tests pass a stand-in returning {status,json}. Whatever `bound` returns for a request (truthy to
// permit it) is handed to `onResponse(json, status, verdict)` with that
// request's reply, so overlapping requests never share state.
async function installPermit(context,{origin=ORIGIN,op,max=1,bound,respond=async route=>({response:await route.fetch()}),onResponse=()=>{},log=()=>{}}){
  let count=0;
  await context.route('**/*',async route=>{
    const r=route.request();
    if(count>=max||r.method()!=='POST')return route.fallback();
    let u;try{u=new URL(r.url());}catch(_){return route.fallback();}
    if(u.origin!==origin||u.pathname!=='/api/graphql')return route.fallback();
    const ops=parsedOps(r.postData());
    if(!ops||ops.length!==1||ops[0].operationName!==op||!isMutation(ops[0]))return route.fallback();
    const verdict=bound(ops[0].variables||{});
    if(!verdict)return route.fallback();
    count++;
    log({type:'permitted',op,use:count,of:max});
    let reply;
    try{reply=await respond(route);}
    catch(e){log({type:'uncertain',op,message:e.message});return route.abort('failed');}
    const status=reply.response?reply.response.status():reply.status;
    let json=reply.response?null:reply.json;
    if(reply.response){try{json=await reply.response.json();}catch(_){}}
    log({type:'response',op,status,errors:(json?.errors||[]).map(e=>e.message).slice(0,3)});
    try{await onResponse(json,status,verdict);}catch(e){log({type:'callback-failed',op,message:e.message});}
    return reply.response?route.fulfill({response:reply.response}):route.fulfill({status,contentType:'application/json',body:JSON.stringify(json)});
  });
  return {get count(){return count;}};
}

// A save as the log shows it: each event's times and selected interviewers.
const hm=ms=>Number.isFinite(ms)?new Date(ms).toISOString().slice(0,16)+'Z':'?';
const saveSummary=events=>events.map((e,i)=>`${i+1} ${hm(e.start)}–${hm(e.end).slice(11)} ${e.slots.map(s=>s.selected||'-').join('+')}`);

// The booking's permits, sharing one `state`:
//   draftId     set from the create response; until then, nothing draft-bound passes
//   last        the last accepted draft contents
//   refusals    every save refused on content, with the reason
//   cleanup     true only while the draft is being deleted
async function installBookingPermits(context,{plan,state,respond,log=()=>{},maxSaves=25,maxRefreshes=10}){
  Object.assign(state,{draftId:null,last:null,saves:0,lastSaveAt:0,lastRefreshAt:0,refusals:[],baselineError:null,cleanup:false,sent:0,lastSeq:0,zone:null,attempts:0});
  const forDraft=v=>!!state.draftId&&v.draftInterviewScheduleId===state.draftId;
  const ok=json=>json&&!(json.errors&&json.errors.length);
  const permits={};
  permits.create=await installPermit(context,{op:OP.create,max:1,respond,log,
    bound:v=>v.interviewScheduleId===plan.interviewScheduleId,
    onResponse:json=>{
      const d=json?.data?.draftInterviewSchedule;
      if(!ok(json)||typeof d?.id!=='string'){state.baselineError=Error('Ashby didn\'t return the new draft.');return;}
      state.draftId=d.id;// set first, so cleanup can delete it even if the check below fails
      try{const events=normalizeDraft(d.draftSchedule);checkBaseline(events,plan);state.last=events;}
      catch(e){state.baselineError=e;}
    }});
  // A save is permitted only if its content moves toward the approval. Its
  // contents become `last` once Ashby accepts it.
  permits.save=await installPermit(context,{op:OP.save,max:maxSaves,respond,log,
    bound:v=>{
      if(!forDraft(v)||!state.last||state.baselineError)return false;
      // Every save attempt is numbered once, passed or refused, for the log;
      // `seq` orders the replies.
      const attempt=++state.attempts;
      try{const next=normalizeDraft(v.draftSchedule);checkSave(state.last,next,plan,{compareRest:state.saves>0,timeZone:state.zone});
        const seq=++state.sent;log({type:'save-checked',seq:attempt,ok:true,events:saveSummary(next)});return {next,seq,attempt};}
      catch(e){state.refusals.push(e.message);log({type:'refused-save',seq:attempt,reason:e.message});return false;}
    },
    // Replies can arrive out of order; only the most recently sent accepted
    // save becomes the draft's current contents.
    onResponse:(json,status,verdict)=>{
      log({type:'save-result',seq:verdict.attempt,accepted:ok(json),status,...(ok(json)?{}:{errors:(json?.errors||[]).map(e=>String(e.message).slice(0,160)).slice(0,3)})});
      if(ok(json)){state.saves++;state.lastSaveAt=Date.now();if(verdict.seq>state.lastSeq){state.last=verdict.next;state.lastSeq=verdict.seq;}}}});
  permits.refresh=await installPermit(context,{op:OP.refresh,max:maxRefreshes,respond,log,bound:forDraft,
    onResponse:json=>{if(ok(json))state.lastRefreshAt=Date.now();}});
  permits.discard=await installPermit(context,{op:OP.discard,max:1,respond,log,
    bound:v=>state.cleanup&&forDraft(v),onResponse:json=>{state.discarded=ok(json);}});
  return permits;
}

module.exports={installPermit,installBookingPermits,parsedOps,isMutation,OP,ORIGIN};
