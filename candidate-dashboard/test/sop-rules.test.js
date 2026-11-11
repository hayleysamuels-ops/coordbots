'use strict';
// Luminai Scheduling SOP rules (October 3, 2026): no onsite on Wednesdays,
// Gabrielle Struckell hosts Welcome when free, debriefs deferred until the
// onsite is confirmed, Sanjay Saraf's hours, and the LinkedIn header source.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {proposeCalendarSchedule}=require('../src/scheduling/full-calendar-schedule');
const {proposeFullSchedule}=require('../src/scheduling/full-schedule');
const {loadRules}=require('../src/scheduling/rules');
const {createBookingFacts}=require('../src/scheduling/booking-facts');

const now=Date.parse('2026-09-21T00:00Z');
const G={userId:'g',name:'Gabrielle Struckell'},K={userId:'k',name:'Keshav Malhotra'};
// 2026-09-30 is a Wednesday, 2026-10-01 a Thursday. Pacific wall time, PDT.
const at=(day,h,m=0)=>new Date(Date.parse(`${day}T00:00Z`)+((h+7)*60+m)*60000).toISOString();
const session=(id,minutes,eligible,title='Session '+id,extra={})=>({sessionId:id,interviewId:'i'+id,title,durationMinutes:minutes,assignmentVerified:true,requiredCount:1,eligibleInterviewers:eligible,...extra});
function calendar(person,{busy=[],sessions}){
  const rows=[{start:at('2026-09-30',0),end:at('2026-10-02',0)}];
  return {userId:person.userId,verified:true,coverageVerified:true,workingHoursSource:'assumed',hoursSource:'override',hoursLabel:'set for this person',checkedAt:now,
    coverage:[{start:at('2026-09-30',0),end:at('2026-10-02',0)}],busy,sessionWorkingWindows:Object.fromEntries(sessions.map(s=>[s.sessionId,rows])),limits:{dailyLimit:null,weeklyLimit:null}};
}
const WED={days:['wed'],timezone:'America/Los_Angeles',reason:'Luminai works from home on Wednesdays.'};
const both=[{start:'2026-09-30T09:00',end:'2026-09-30T17:00'},{start:'2026-10-01T09:00',end:'2026-10-01T17:00'}];

test('no agenda is proposed on an excluded weekday, in either preview',()=>{
  const s=[session('1',60,[G],'Welcome')];
  const r=proposeCalendarSchedule({sessions:s,windows:both,timezone:'America/Los_Angeles',now,calendars:[calendar(G,{sessions:s})],advisory:true,excludedWeekdays:WED});
  assert.ok(r.proposals.length>0);
  assert.ok(r.proposals.every(p=>p.start.startsWith('2026-10-01')),'an agenda landed on Wednesday');
  const u=proposeFullSchedule({sessions:s.map(x=>({...x,eligibleInterviewers:[{name:G.name}]})),windows:both,timezone:'America/Los_Angeles',now,excludedWeekdays:WED});
  assert.ok(u.proposals.length>0&&u.proposals.every(p=>p.start.startsWith('2026-10-01')));
});

test('availability only on an excluded weekday says so, instead of "too short"',()=>{
  const s=[session('1',60,[G],'Welcome')];
  const wedOnly=[both[0]];
  const r=proposeCalendarSchedule({sessions:s,windows:wedOnly,timezone:'America/Los_Angeles',now,calendars:[calendar(G,{sessions:s})],advisory:true,excludedWeekdays:WED});
  assert.equal(r.status,'no_calendar_fit');
  assert.deepEqual(r.diagnosis.unblock,[{kind:'weekday',days:['wed'],text:"The candidate's availability only holds the whole agenda on Wednesday, when no onsite is held (Luminai works from home on Wednesdays). Ask the candidate for another day."}]);
  const u=proposeFullSchedule({sessions:s.map(x=>({...x,eligibleInterviewers:[{name:G.name}]})),windows:wedOnly,timezone:'America/Los_Angeles',now,excludedWeekdays:WED});
  assert.equal(u.proposals.length,0);
  assert.match(u.reason,/^No agenda is proposed on Wednesday \(Luminai works from home on Wednesdays\), and the candidate's other availability doesn't hold it\./);
});

test('Welcome goes to the preferred host while free, and to a colleague only when the host is not',()=>{
  const day=['2026-10-01'];
  const s=[session('1',15,[K,G],'Welcome',{preferredUserIds:['g']})];
  const run=(busy,advisory=true)=>proposeCalendarSchedule({sessions:s,windows:[both[1]],timezone:'America/Los_Angeles',now,calendars:[calendar(G,{busy,sessions:s}),calendar(K,{sessions:s})],advisory,limit:1});
  // Free: Gabrielle, though Keshav is listed first in Ashby.
  assert.equal(run([]).proposals[0].events[0].interviewer.name,'Gabrielle Struckell');
  // Busy at 9:00: Keshav takes it at 9:00 rather than the agenda moving.
  const busy=[{start:at(day[0],9),end:at(day[0],10)}];
  const r=run(busy);
  assert.deepEqual([r.proposals[0].start,r.proposals[0].events[0].interviewer.name,r.proposals[0].flagCount],[at(day[0],9),'Keshav Malhotra',0]);
  // Strict mode: preferred first too.
  assert.equal(run([],false).proposals[0].events[0].interviewer.name,'Gabrielle Struckell');
});

test('the preferred host is used, flagged, only when nobody else is free',()=>{
  const day='2026-10-01';
  const s=[session('1',15,[K,G],'Welcome',{preferredUserIds:['g']})];
  const allBusy=[{start:at(day,0),end:at(day,23)}];
  const r=proposeCalendarSchedule({sessions:s,windows:[both[1]],timezone:'America/Los_Angeles',now,calendars:[calendar(G,{busy:allBusy,sessions:s}),calendar(K,{busy:allBusy,sessions:s})],advisory:true,limit:1});
  assert.equal(r.proposals[0].events[0].interviewer.name,'Gabrielle Struckell');
  assert.equal(r.proposals[0].flagCount,1);
});

test('Luminai\'s rules: WFH Wednesdays, lunch starting 12:00–13:00 and ending by 13:30 Pacific, Gabrielle for Welcome, deferred debriefs, Sanjay 07:00–17:00 Pacific, Joe Penn\'s and Kesava\'s accounts, the FDE coding alternatives',()=>{
  const r=loadRules({clientId:'luminai',log:{log(){},warn(){}}}).get();
  assert.equal(r.rulesRevision,13);
  assert.deepEqual(r.placementFor('Lunch/Coffee').map(w=>[w.earliestStart,w.latestStart,w.latestEnd,w.timezone]),[['12:00','13:00','13:30','America/Los_Angeles']]);
  // Each FDE job's two coding interviews, spelled as Ashby has them on that job.
  assert.deepEqual(['5ba29c75-1b89-4ffc-8f58-5db207afc527','009c1c4e-152b-44f0-bcb1-0879f8287b62','85218d8e-1de8-47ef-9ac9-f6b2067f89aa','837cc1e9-15ed-4f07-8755-51ee29f4ea39'].map(j=>r.alternativesFor(j).map(g=>[g.label,...g.titles])),
    [[['coding interviews','Coding - Roomba','Coding - URL Shortner']],[['coding interviews','Coding - Roomba','URL Shortner']],[['coding interviews','Coding - Roomba','URL Shortener']],[]]);
  // The three Applied AI jobs' two technical interviews (revision 13), matching
  // Ashby's names, which end in a space.
  const AAI=[['technical interviews','Applied AI Interview (Spreadsheet Parsing)','System Design (Virtual)']];
  assert.deepEqual(['1c17da55-d9b4-47d1-aac7-8076af6c834a','329773a3-940e-49dd-9771-f99ab49ac0e8','6f2b26ad-b064-4ec9-bad5-bbedf75acb5a'].map(j=>r.alternativesFor(j).map(g=>[g.label,...g.titles])),[AAI,AAI,AAI]);
  assert.equal(r.alternativeKey('Applied AI Interview (Spreadsheet Parsing) '),r.alternativeKey('applied ai interview (spreadsheet parsing)'));
  assert.equal(r.alternativeKey('System Design (Virtual) '),r.alternativeKey('System Design (Virtual)'));
  assert.equal(r.alternativeKey(' Coding — Roomba '),r.alternativeKey('coding - roomba'));
  assert.deepEqual([r.identityFor('Joe Penn'),r.identityFor(' joe  penn '),r.identityFor('Mary Petrino')],['joe@luminai.com','joe@luminai.com',null]);
  assert.deepEqual([r.identityFor('Kesava Kirupa Dinakaran'),r.identityFor('kesava  kirupa dinakaran')],['kesava@luminai.com','kesava@luminai.com']);
  assert.deepEqual([r.agenda.excludedWeekdays.days,r.agenda.excludedWeekdays.timezone],[['wed'],'America/Los_Angeles']);
  const G1={first:['gabrielle@luminai.com'],last:[]};
  assert.deepEqual([r.preferenceFor('Welcome'),r.preferenceFor('  welcome '),r.preferenceFor('Welcome Lunch')],[G1,G1,{first:[],last:[]}]);
  // FDE's Re Engineering Tech Screen only: Ariel first, Anisha last resort.
  const FDE='5ba29c75-1b89-4ffc-8f58-5db207afc527';
  assert.deepEqual(r.preferenceFor('Re Engineering Tech Screen',FDE),{first:['ariel@luminai.com'],last:['anisha@luminai.com']});
  assert.deepEqual(r.preferenceFor('Re Engineering Tech Screen','009c1c4e-152b-44f0-bcb1-0879f8287b62'),{first:[],last:[]});
  assert.deepEqual(r.interviewerLoad,{timezone:'America/Los_Angeles',overrideGap:2,notCounted:[{match:'contains',value:'Lunch'}],reason:r.interviewerLoad.reason});
  assert.deepEqual([r.loadCounts('Lunch'),r.loadCounts('Lunch/Coffee'),r.loadCounts('Welcome'),r.loadCounts('Coding - Roomba')],[false,false,true,true]);
  assert.deepEqual(r.debriefs,{afterOnsiteConfirmed:true,meetingHoursExempt:true});
  assert.deepEqual(r.meetingHoursFor('sanjay@luminai.com'),{hours:{timezone:'America/Los_Angeles',days:['mon','tue','wed','thu','fri'],start:'07:00',end:'17:00'},source:'override'});
});

test('debrief ids and the candidate\'s LinkedIn come from Ashby, and are never guessed',async()=>{
  const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  let social=[{type:'LinkedIn',url:'https://www.linkedin.com/in/example'}];
  const reader=createBookingFacts({key:'k',clientId:'c',request:async(url,options)=>{const endpoint=url.split('/').pop(),body=JSON.parse(options.body);
    const results=endpoint==='interview.list'?[{id:id(1),isDebrief:true},{id:id(2),isDebrief:false}]:endpoint==='candidate.info'?{id:body.id,socialLinks:social}:null;
    return {ok:true,json:async()=>({success:true,results,moreDataAvailable:false})};}});
  assert.deepEqual([...await reader.debriefInterviewIds()],[id(1)]);
  assert.equal(await reader.candidateLinkedIn(id(3)),'https://www.linkedin.com/in/example');
  social=[{type:'LinkedIn',url:'https://evil.example/linkedin.com'}];
  assert.equal(await reader.candidateLinkedIn(id(3)),null);
  social=[];
  assert.equal(await reader.candidateLinkedIn(id(3)),null);
});

test('interviewer identity overrides need a name, a lowercase email and a reason, once per name',()=>{
  const {parseRules}=require('../src/scheduling/rules');
  const doc=change=>{const d=JSON.parse(JSON.stringify(require('../scheduling-rules/luminai.json')));change(d.interviewerIdentities.overrides);return d;};
  const ok={email:'x@luminai.com',reason:'Two accounts on purpose.'};
  for(const [change,pattern] of [
    [o=>{o[' joe penn']=ok;},/two interviewer identity overrides for " joe penn"/],
    [o=>{o['Ann Lee']={...ok,email:'Ann@luminai.com'};},/"Ann Lee" must give a lowercase email/],
    [o=>{o['Ann Lee']={email:'ann@luminai.com'};},/"Ann Lee" needs a reason/],
    [o=>{o['  ']=ok;},/needs a name/]]){
    assert.throws(()=>parseRules(doc(change),'luminai'),e=>e.status===503&&pattern.test(e.message));
  }
  // Optional: rules without the section have no overrides.
  const d=doc(()=>{});delete d.interviewerIdentities;
  assert.equal(parseRules(d,'luminai').identityFor('Joe Penn'),null);
});

test('an alternatives rule needs a job ID, a label, two or more different interviews and a reason, each interview in one rule per job',()=>{
  const {parseRules}=require('../src/scheduling/rules');
  const job='5ba29c75-1b89-4ffc-8f58-5db207afc527';
  const doc=rule=>{const d=JSON.parse(JSON.stringify(require('../scheduling-rules/luminai.json')));d.sessions.alternatives=rule;return d;};
  const ok={jobId:job,label:'coding interviews',interviews:['A','B'],reason:'One per candidate.'};
  assert.deepEqual(parseRules(doc([ok]),'luminai').alternativesFor(job.toUpperCase()),[{label:'coding interviews',titles:['A','B']}]);
  assert.deepEqual(parseRules(doc(undefined),'luminai').alternativesFor(job),[]);
  for(const [rule,pattern] of [[{...ok,jobId:'FDE'},/lowercase Ashby job ID/],[{...ok,label:' '},/needs a label/],[{...ok,interviews:['A']},/two or more different/],[{...ok,interviews:['Coding - A','coding — a']},/two or more different/],[{...ok,reason:''},/needs a reason/]])
    assert.throws(()=>parseRules(doc([rule]),'luminai'),pattern);
  assert.throws(()=>parseRules(doc([ok,{...ok,interviews:['b','C']}]),'luminai'),/"b" is in two alternatives rules for job/);
  assert.throws(()=>parseRules(doc({}),'luminai'),/sessions.alternatives must be a list/);
});

test('a start window\'s latest end is optional, a time, and later than its earliest start',()=>{
  const {parseRules}=require('../src/scheduling/rules');
  const doc=change=>{const d=JSON.parse(JSON.stringify(require('../scheduling-rules/luminai.json')));change(d.sessions.placementWindows[0]);return d;};
  for(const change of [w=>{w.latestEnd='1:30pm';},w=>{w.latestEnd='12:00';},w=>{w.latestEnd='11:00';}])
    assert.throws(()=>parseRules(doc(change),'luminai'),/needs a latest end later than its earliest start/);
  assert.equal(parseRules(doc(w=>{delete w.latestEnd;}),'luminai').placementFor('Lunch')[0].latestEnd,undefined);
});

test('a preference rule may name a job, a last resort or both lists, never someone twice; interviewer load is optional and checked',()=>{
  const {parseRules}=require('../src/scheduling/rules');
  const FDE='5ba29c75-1b89-4ffc-8f58-5db207afc527',OTHER='009c1c4e-152b-44f0-bcb1-0879f8287b62';
  const doc=change=>{const d=JSON.parse(JSON.stringify(require('../scheduling-rules/luminai.json')));change(d);return d;};
  const withRules=list=>doc(d=>{d.sessions.preferredInterviewers=list;});
  // A job's own rule replaces an all-jobs rule for that session; other jobs keep the all-jobs rule.
  const r=parseRules(withRules([{match:'exact',value:'Screen',emails:['x@luminai.com']},{match:'exact',value:'Screen',jobId:FDE,lastResort:['z@luminai.com']}]),'luminai');
  assert.deepEqual([r.preferenceFor('Screen',FDE),r.preferenceFor('Screen',OTHER),r.preferenceFor('Screen')],[{first:[],last:['z@luminai.com']},{first:['x@luminai.com'],last:[]},{first:['x@luminai.com'],last:[]}]);
  for(const [rule,pattern] of [
    [{match:'exact',value:'S',jobId:'FDE',emails:['x@luminai.com']},/isn't a lowercase Ashby job ID/],
    [{match:'exact',value:'S'},/must be lowercase emails, first or last resort/],
    [{match:'exact',value:'S',emails:[],lastResort:[]},/must be lowercase emails/],
    [{match:'exact',value:'S',emails:['X@luminai.com']},/must be lowercase emails/],
    [{match:'exact',value:'S',emails:['x@luminai.com'],lastResort:['x@luminai.com']},/list someone twice/]])
    assert.throws(()=>parseRules(withRules([rule]),'luminai'),pattern);
  const load=change=>doc(d=>change(d.interviewerLoad));
  for(const [change,pattern] of [[l=>{l.timezone='Mars/Base';},/valid time zone/],[l=>{l.overrideGap=0;},/overrideGap/],[l=>{l.notCounted=[{match:'starts',value:'Lunch'}];},/notCounted/],[l=>{l.reason=' ';},/needs a reason/]])
    assert.throws(()=>parseRules(load(change),'luminai'),pattern);
  const off=parseRules(doc(d=>{delete d.interviewerLoad;}),'luminai');
  assert.deepEqual([off.interviewerLoad,off.loadCounts('Lunch')],[null,true]);
});
