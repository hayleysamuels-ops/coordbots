"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const html=fs.readFileSync(require("node:path").join(__dirname,"../public/index.html"),"utf8");
const D=require("../lib/dateday");
const DRI=require("../lib/dri-aliases");
// These tests exercise decisions, not browser layout. Browser QA covers the latter.
function source(name){
  const start=html.indexOf("  function "+name+"(");
  assert.ok(start>=0,name);
  const end=html.indexOf("\n  }",start)+4;
  assert.ok(end>start,name+" closes");
  return html.slice(start,end);
}
function model(candidates){
  return new Function("candidates","DATEDAY","DRI",`
    const get=(c,k)=>c.values[k]||"";
    const effective=get;
    const linkOf=c=>c.values.ashbyCandidateId||null;
    const driOf=c=>DRI.resolveDri(get(c,"driName"));
    const trialDay=c=>DATEDAY.parseDay(get(c,"startDate"));
    const trialEndDay=c=>DATEDAY.parseDay(get(c,"endDate"))||trialDay(c);
    const entryFor=id=>null;
    const fmtDate=s=>s;
    const byName=(a,b)=>a.name.localeCompare(b.name);
    const esc=s=>String(s);
    ${["duplicatePeers","resourceBlockers","compactBarSummary","queueItems","declineKey","declineTriage","declineSeverity","suggestionPriority"].map(source).join("\n")}
    return {duplicatePeers,resourceBlockers,compactBarSummary,queueItems,declineKey,declineTriage,declineSeverity,suggestionPriority};
  `)(candidates,D,DRI);
}
const row=(id,start,status="NOT STARTED",extra={})=>({id,name:id,values:{startDate:start,endDate:start,status,...extra}});
test("queue categories follow coordination order and keep overdue and undated work visible",()=>{
  const rows=[row("closing","2026-09-16","IN PROGRESS"),row("next","2026-09-20"),row("today","2026-09-17"),row("overdue","2026-09-16"),row("later","2026-10-01"),row("done","2026-09-16","DONE"),row("canceled","2026-09-17","CANCELED"),row("undated","")];
  const m=model(rows),q=m.queueItems(rows,20260917);
  assert.deepEqual(q.map(i=>i.c.id),["today","next","overdue","later","undated","closing"]);
  assert.deepEqual([...new Set(q.map(i=>i.group))],["Today / tomorrow","Next 72 hours","Blocked / needs review","Closing out"]);
  assert.equal(q[2].action,"Check trial status");
  assert.equal(q[0].action,"Resolve 3 resource gaps");
});
test("left rail orders five collapsible categories and remembers their state",()=>{
 const decline=html.indexOf('data-queue-group="declines"'),queue=html.indexOf('<div id="actionQueue"></div>');assert.ok(decline<queue);
 const render=source("renderActionQueue");for(const group of ["Today / tomorrow","Next 72 hours","Blocked / needs review","Closing out"])assert.ok(render.includes(group));
 assert.match(render,/<details class="queue-group"/);assert.match(html,/wt-action-queue-collapsed/);assert.match(html,/id="declineSummary"/);
});
test("calendar-day horizon survives month and DST boundaries",()=>{
  for(const [now,next,last] of [[20261031,"2026-11-01","2026-11-03"],[20260307,"2026-03-08","2026-03-10"],[20261231,"2027-01-01","2027-01-03"]]){
    const rows=[row("tomorrow",next),row("last",last)];
    const q=model(rows).queueItems(rows,now);
    assert.equal(q[0].group,"Today / tomorrow");assert.equal(q[1].group,"Next 72 hours");
  }
});
test("proposals never count as confirmed assignments or clear readiness gaps",()=>{
  const c=row("candidate","2026-09-17"),m=model([c]);
  const entry={c,sugg:{driName:{ok:true,value:"Advait Shroff"},desk:{ok:true,value:"SF-Desk 2"}}};
  const before=JSON.stringify(c),card=m.compactBarSummary(entry,[]);
  assert.match(card,/No main partner/);assert.match(card,/No desk/);assert.match(card,/2 proposals/);
  assert.doesNotMatch(card,/Advait Shroff|SF-Desk 2/);
  assert.equal(JSON.stringify(c),before);
});
test("no laptop needed is an answer, and conflicts stay visible",()=>{
  const c=row("candidate","2026-09-17","NOT STARTED",{computer:"No Laptop Needed",driName:"Sam Henderson",desk:"SF-Desk 1"});
  const m=model([c]);assert.deepEqual(m.resourceBlockers(c),[]);
  assert.deepEqual(m.resourceBlockers(c,{clash:{desk:true}}),["Desk conflict"]);
  assert.match(m.compactBarSummary({c,clash:{desk:true}},["Same desk recorded on another trial this day"]),/Same desk recorded/);
});
test("duplicate review detects matching links and normalized names without merging records",()=>{
  const a=row("a",""),b=row("b",""),c=row("c","",undefined,{ashbyCandidateId:"same"}),d=row("d","",undefined,{ashbyCandidateId:"same"});
  a.name="Kyro Kohan";b.name=" kyro  kohan ";const rows=[a,b,c,d];const m=model(rows),before=JSON.stringify(rows);
  assert.deepEqual(m.duplicatePeers(a),[b]);assert.deepEqual(m.duplicatePeers(c),[d]);assert.equal(JSON.stringify(rows),before);
});
test("decline handling is invalidated by a new date or different declining attendee",()=>{
  const c=row("c",""),m=model([c]);
  const event={eventId:"event",candidateId:"c",start:"2026-09-17T18:00:00Z",declines:[{email:"a@poetic.com"}]};
  c.coordination={owner:"Hayley",declines:{[m.declineKey(event)]:{handled:true,owner:"Coordinator"}}};
  assert.equal(m.declineTriage(event).state.handled,true);
  assert.equal(m.declineTriage({...event,start:"2026-09-18T18:00:00Z"}).state.handled,undefined);
  assert.equal(m.declineTriage({...event,declines:[{email:"b@poetic.com"}]}).state.handled,undefined);
  assert.equal(m.declineTriage({...event,candidateId:null}).owner,"Unassigned");
});
test("exact session times distinguish overdue and within 24h declines",()=>{
  const m=model([]),now=Date.parse("2026-09-17T12:00:00Z"),e={start:"2026-09-17T11:00:00Z",declines:[]};
  assert.match(m.declineSeverity(e,now),/Overdue/);
  assert.match(m.declineSeverity({...e,start:"2026-09-18T11:00:00Z"},now),/within 24h/);
  assert.match(m.declineSeverity({...e,start:"2026-09-20T11:00:00Z",declines:[{kind:"room"}]},now),/Blocked/);
});
test("unscheduled suggestions get a date task rather than invented priority context",()=>{
  const m=model([]);assert.equal(m.suggestionPriority({},Date.now()),"Needs a date");
  assert.equal(m.suggestionPriority({trialStart:"2026-09-16T12:00:00Z"},Date.parse("2026-09-17T12:00:00Z")),"Check trial outcome");
});
test("administration hides all bot and snapshot controls from coordination",()=>{
  const admin=html.slice(html.indexOf('<section id="adminView"'),html.indexOf('<div class="toast"'));
  assert.match(admin,/hidden/);for(const id of ["bots","importBtn","exportBtn"])assert.match(admin,new RegExp('id="'+id+'"'));
  assert.match(html,/if\(act==="expand"\)\{ selectCandidate\(id,t\)/);
  assert.match(html,/if\(act==="open"\)\{ selectCandidate\(id,t\)/);
  assert.match(html,/function togglePin\(bar\)\{ selectCandidate/);
});
test("bulk additions reject server failures without creating phantom candidates",async()=>{
  const make=new Function("fetch",`
    const API="/api",headers=()=>({}),uid=()=>"new",linkOf=c=>c.values.ashbyCandidateId;
    const candidates=[],me={email:"preview@example.invalid"},who="Preview";
    let selectedCandidateId=null;function ensurePanels(){}
    ${source("addSuggestedCandidate")}
    return {candidates,addSuggestedCandidate};
  `);
  const c={name:"Sample",ashbyCandidateId:"sample"};
  const bad=make(async()=>({ok:false,status:500}));await assert.rejects(bad.addSuggestedCandidate(c));assert.equal(bad.candidates.length,0);
  let writes=0;const good=make(async()=>{writes++;return {ok:true};});await good.addSuggestedCandidate(c);await good.addSuggestedCandidate(c);
  assert.equal(good.candidates.length,1);assert.equal(writes,1);
});
