'use strict';
// Interviewer load (November 5): weekly counts from every Ashby schedule in
// Pacific weeks, the preference order's last resort, and load passing over
// the preference order past a gap of two, said on the post.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {weekKey,countInterviewLoad,createScheduleSync}=require('../src/interviewer-load');
const {proposeCalendarSchedule}=require('../src/scheduling/full-calendar-schedule');
const {describeLoadOverride,loadWeekLabel}=require('../src/scheduling/flags');

const PT='America/Los_Angeles';

test('a week runs Monday to Sunday in the named zone, keyed by its Monday',()=>{
  // Sunday Nov 8, 23:30 PST is Monday 07:30 UTC: still the week of Nov 2 in Pacific.
  assert.equal(weekKey(Date.parse('2026-11-09T07:30Z'),PT),'2026-11-02');
  assert.equal(weekKey(Date.parse('2026-11-09T07:30Z'),'UTC'),'2026-11-09');
  assert.equal(weekKey(Date.parse('2026-11-09T08:00Z'),PT),'2026-11-09');
  // Across a month end, and on the Monday itself.
  assert.equal(weekKey(Date.parse('2026-12-02T20:00Z'),PT),'2026-11-30');
  assert.equal(weekKey(Date.parse('2026-11-30T08:00Z'),PT),'2026-11-30');
});

const ev=(start,people,extra={})=>({startTime:start,endTime:start,interviewId:extra.interviewId||'int-1',interviewers:people.map(([id,fb])=>({id,firstName:id,lastName:'',isFeedbackRequired:fb}))});
test('counts skip cancelled schedules, the schedule being booked, and whatever `counts` refuses',()=>{
  const schedules=[
    {id:'s1',status:'Scheduled',interviewEvents:[ev('2026-11-04T18:00Z',[['a',true],['g',false]]),ev('2026-11-10T18:00Z',[['a',true]])]},
    {id:'s2',status:'Cancelled',interviewEvents:[ev('2026-11-04T19:00Z',[['a',true]])]},
    {id:'s3',status:'Scheduled',interviewEvents:[ev('2026-11-05T19:00Z',[['a',true]])]},
  ];
  const rows=countInterviewLoad(schedules,{timeZone:PT,excludeScheduleIds:['s3'],counts:(e,i)=>i.isFeedbackRequired!==false});
  assert.deepEqual(Object.fromEntries(rows.get('a').weeks),{'2026-11-02':1,'2026-11-09':1});
  assert.equal(rows.has('g'),false,'hosting without feedback never counts');
  assert.deepEqual(Object.fromEntries(countInterviewLoad(schedules,{timeZone:PT}).get('g').weeks),{'2026-11-02':1});
});

test('every schedule is read once, then only changes through the sync token; an expired token reads everything again',async()=>{
  const now=Date.parse('2026-11-05T12:00Z'),calls=[];
  const old={id:'old',status:'Complete',interviewEvents:[{...ev('2026-09-01T18:00Z',[['a',false]],{interviewId:'w'}),endTime:'2026-09-01T18:30Z'}]};
  const booked={id:'booked',status:'Scheduled',interviewEvents:[{...ev('2026-11-10T18:00Z',[['a',true]]),endTime:'2026-11-10T19:00Z'}]};
  let pages=[[{results:[old],moreDataAvailable:true,nextCursor:'c1'},{results:[booked],moreDataAvailable:false,syncToken:'t1'}]];
  const fetchPage=async body=>{calls.push(body);if(body.syncToken==='expired')throw new Error('interviewSchedule.list -> ["sync_token_expired"]');return pages[0].shift();};
  const sync=createScheduleSync({fetchPage,now:()=>now,log:{warn(){}}});
  // Created months ago (before any lookback window), booked for next week: kept.
  assert.deepEqual((await sync.schedules()).map(s=>s.id),['booked']);
  assert.deepEqual(calls,[{limit:100},{limit:100,cursor:'c1'}]);
  // History survives pruning: hosting Welcome ("w") gave no feedback.
  assert.equal(sync.feedbackHistory('w','a'),false);
  assert.equal(sync.feedbackHistory('w','b'),false);
  assert.equal(sync.feedbackHistory('int-1','b'),true);
  assert.equal(sync.feedbackHistory('never','a'),null);
  // Incremental: the cancellation arrives through the token.
  pages=[[{results:[{...booked,status:'Cancelled'}],moreDataAvailable:false,syncToken:'expired'}]];
  const after=await sync.schedules();
  assert.deepEqual([calls.at(-1),after[0].status],[{limit:100,syncToken:'t1'},'Cancelled']);
  pages=[[{results:[booked],moreDataAvailable:false,syncToken:'t2'}]];
  assert.deepEqual((await sync.schedules()).map(s=>s.status),['Scheduled']);
  assert.deepEqual(calls.slice(-2),[{limit:100,syncToken:'expired'},{limit:100}]);
});

test('the post\'s wording: who was suggested over whom, with both counts',()=>{
  const o={chosen:{name:'Keshav Malhotra',count:0},over:{name:'Ariel Perez Chavez',count:2},weekLabel:'this week'};
  assert.equal(describeLoadOverride(o),'Keshav Malhotra suggested over Ariel Perez Chavez — Ariel has 2 interviews this week, Keshav has 0.');
  assert.equal(describeLoadOverride({...o,over:{name:'Yun Feng',count:1}}),'Keshav Malhotra suggested over Yun Feng — Yun has 1 interview this week, Keshav has 0.');
  const thu=Date.parse('2026-11-05T20:00Z');
  assert.equal(loadWeekLabel('2026-11-02',PT,thu),'this week');
  assert.equal(loadWeekLabel('2026-11-09',PT,thu),'the week of Mon, Nov 9');
});

// The solver: FDE's Re Engineering Tech Screen as revision 12 sets it.
const now=Date.parse('2026-11-05T00:00Z');
const at=(h,m=0)=>new Date(Date.parse('2026-11-10T00:00Z')+((h+8)*60+m)*60000).toISOString();// Tue Nov 10, PST
const A={userId:'a',name:'Ariel Perez Chavez'},Y={userId:'y',name:'Yun Feng'},K={userId:'k',name:'Keshav Malhotra'},N={userId:'n',name:'Anisha Tandon'};
const screen=(extra={})=>({sessionId:'1',interviewId:'i1',title:'Re Engineering Tech Screen',durationMinutes:60,assignmentVerified:true,requiredCount:1,eligibleInterviewers:[A,Y,K,N],preferredUserIds:['a'],lastResortUserIds:['n'],...extra});
function calendar(person,sessions,busy=[]){
  const rows=[{start:at(0),end:at(23)}];
  return {userId:person.userId,verified:true,coverageVerified:true,workingHoursSource:'assumed',hoursSource:'override',hoursLabel:'set',checkedAt:now,
    coverage:rows,busy,sessionWorkingWindows:Object.fromEntries(sessions.map(s=>[s.sessionId,rows])),limits:{dailyLimit:null,weeklyLimit:null}};
}
const WEEK='2026-11-09';
function run({sessions=[screen()],busy={},weeks=null,people=[A,Y,K,N]}={}){
  const r=proposeCalendarSchedule({sessions,windows:[{start:'2026-11-10T09:00',end:'2026-11-10T17:00'}],timezone:PT,now,limit:1,advisory:true,
    calendars:people.map(p=>calendar(p,sessions.filter(s=>s.eligibleInterviewers.includes(p)),busy[p.userId]||[])),
    interviewerLoad:weeks&&{timezone:PT,overrideGap:2,weeks:Object.fromEntries(Object.entries(weeks).map(([id,n])=>[id,{[WEEK]:n}]))}});
  return r.proposals[0];
}
const who=p=>p.events.map(e=>e.interviewer.name);
const allDay=[{start:at(0),end:at(23)}];

test('Ariel first, then Yun and Keshav, Anisha only when all three are busy',()=>{
  assert.deepEqual(who(run()),['Ariel Perez Chavez']);
  assert.deepEqual(who(run({busy:{a:allDay}})),['Yun Feng']);
  assert.deepEqual(who(run({busy:{a:allDay,y:allDay}})),['Keshav Malhotra']);
  const last=run({busy:{a:allDay,y:allDay,k:allDay}});
  assert.deepEqual([who(last),last.flagCount],[['Anisha Tandon'],0]);
  // Everyone busy: Ariel, flagged, never the last resort first.
  assert.deepEqual(who(run({busy:{a:allDay,y:allDay,k:allDay,n:allDay}})),['Ariel Perez Chavez']);
});

test('load two or more past the lightest free person passes over the preference order, and says so',()=>{
  // Ariel 2, Yun 2, Keshav 0: Keshav, over Ariel.
  const p=run({weeks:{a:2,y:2,k:0,n:0}});
  assert.deepEqual(who(p),['Keshav Malhotra']);
  assert.deepEqual(p.events[0].loadOverrides,[{week:WEEK,timezone:PT,chosen:{userId:'k',name:'Keshav Malhotra',count:0},over:{userId:'a',name:'Ariel Perez Chavez',count:2}}]);
  // A gap of one: the preference order stands, nothing said.
  const q=run({weeks:{a:1,y:1,k:0}});
  assert.deepEqual([who(q),q.events[0].loadOverrides],[['Ariel Perez Chavez'],undefined]);
  // A last resort is never brought forward by load, however light.
  assert.deepEqual(who(run({weeks:{a:3,y:3,k:3,n:0}})),['Ariel Perez Chavez']);
  // Only free people are compared: Keshav busy, so Ariel stands against Yun alone.
  assert.deepEqual(who(run({weeks:{a:2,y:1,k:0},busy:{k:allDay}})),['Ariel Perez Chavez']);
  // Ariel busy: Yun is first in order, and load passes Yun over for Keshav.
  const r=run({weeks:{a:0,y:2,k:0},busy:{a:allDay}});
  assert.deepEqual([who(r),r.events[0].loadOverrides[0].over.name],[['Keshav Malhotra'],'Yun Feng']);
  // Counts from another week don't count.
  assert.deepEqual(who(proposeCalendarSchedule({sessions:[screen()],windows:[{start:'2026-11-10T09:00',end:'2026-11-10T17:00'}],timezone:PT,now,limit:1,advisory:true,
    calendars:[A,Y,K,N].map(x=>calendar(x,[screen()])),interviewerLoad:{timezone:PT,overrideGap:2,weeks:{a:{'2026-11-02':5}}}}).proposals[0]),['Ariel Perez Chavez']);
});

test('the proposal\'s own sessions count, unless they don\'t count for that person',()=>{
  // Keshav alone can take session 1; Ariel (2) against Keshav (0 + session 1).
  const first={sessionId:'0',interviewId:'i0',title:'Coding',durationMinutes:60,assignmentVerified:true,requiredCount:1,eligibleInterviewers:[K]};
  const counted=run({sessions:[first,screen({eligibleInterviewers:[A,K],lastResortUserIds:[]})],weeks:{a:2,k:0},people:[A,K]});
  assert.deepEqual([who(counted),counted.events[1].loadOverrides],[['Keshav Malhotra','Ariel Perez Chavez'],undefined]);
  // Session 1 doesn't count for Keshav (hosting, or Lunch): Keshav is at 0, so Keshav again.
  const exempt=run({sessions:[{...first,loadExemptUserIds:['k']},screen({eligibleInterviewers:[A,K],lastResortUserIds:[]})],weeks:{a:2,k:0},people:[A,K]});
  assert.deepEqual(who(exempt),['Keshav Malhotra','Keshav Malhotra']);
  assert.equal(exempt.events[1].loadOverrides[0].chosen.count,0);
});

test('a panel slot is balanced the same way, naming the slot\'s override',()=>{
  const panel={sessionId:'1',interviewId:'i1',title:'Case Study',durationMinutes:60,assignmentVerified:true,requiredCount:2,eligibleInterviewers:[A,Y,K],
    slots:[{eligibleInterviewers:[A,K]},{eligibleInterviewers:[Y]}],preferredUserIds:['a']};
  const p=run({sessions:[panel],weeks:{a:2,k:0,y:5},people:[A,Y,K]});
  assert.deepEqual(p.events[0].interviewers.map(x=>x.name),['Keshav Malhotra','Yun Feng']);
  assert.deepEqual(p.events[0].loadOverrides.map(o=>[o.chosen.name,o.over.name]),[['Keshav Malhotra','Ariel Perez Chavez']]);
  // Someone on the panel in another slot is never said to be passed over.
  const both={...panel,eligibleInterviewers:[Y,K],slots:[{eligibleInterviewers:[Y,K]},{eligibleInterviewers:[Y]}],preferredUserIds:['y']};
  const q=run({sessions:[both],weeks:{y:5,k:0},people:[Y,K]});
  assert.deepEqual([q.events[0].interviewers.map(x=>x.name),q.events[0].loadOverrides],[['Keshav Malhotra','Yun Feng'],undefined]);
});

test('without interviewer load, nothing changes',()=>{
  assert.deepEqual(who(run({weeks:null})),['Ariel Perez Chavez']);
  assert.throws(()=>proposeCalendarSchedule({sessions:[screen()],windows:[{start:'2026-11-10T09:00',end:'2026-11-10T17:00'}],timezone:PT,now,calendars:[A,Y,K,N].map(x=>calendar(x,[screen()])),interviewerLoad:{timezone:PT,overrideGap:0,weeks:{}}}),/Invalid interviewer load/);
});
