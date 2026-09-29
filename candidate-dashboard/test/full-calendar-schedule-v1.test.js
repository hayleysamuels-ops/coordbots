'use strict';
// Regression anchor: with minBreakMinutes 0 and maxGapMinutes 0, and option
// variety off, the solver must find exactly the agendas the original solver
// found (frozen in fixtures/full-calendar-schedule.v1.js). With variety on, the
// first agenda must still be identical. Compared across seeded random cases
// with busy time, per-session meeting hours and daily/weekly limits.
const {test}=require('node:test'),assert=require('node:assert/strict');
const v1=require('./fixtures/full-calendar-schedule.v1.js').proposeCalendarSchedule;
const {proposeCalendarSchedule}=require('../src/scheduling/full-calendar-schedule');

function rng(seed){return ()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};}
const now=Date.parse('2026-09-21T00:00Z'),day0=Date.parse('2026-09-28T13:00Z');
const iso=ms=>new Date(ms).toISOString();

function makeCase(seed){
  const r=rng(seed),pick=n=>Math.floor(r()*n);
  const people=['a','b','c','d'].slice(0,1+pick(4)).map(id=>({userId:id,name:id.toUpperCase()}));
  const sessions=Array.from({length:1+pick(4)},(_,i)=>{
    const eligible=people.filter(()=>r()<0.6);
    return {sessionId:'s'+i,interviewId:'i'+i,title:'S'+i,durationMinutes:15*(1+pick(4)),assignmentVerified:true,requiredCount:1,eligibleInterviewers:eligible.length?eligible:[people[pick(people.length)]]};
  });
  const windows=[{start:'2026-09-28T09:00',end:'2026-09-28T'+String(11+pick(7)).padStart(2,'0')+':00'}];
  if(r()<0.4)windows.push({start:'2026-09-29T09:00',end:'2026-09-29T15:00'});
  const cover=[{start:'2026-09-28T00:00:00Z',end:'2026-10-01T00:00:00Z'}];
  const calendars=people.map(p=>{
    const busy=Array.from({length:pick(4)},()=>{const s=day0+pick(96)*5*60000+(r()<0.3?24*3600000:0);return {start:iso(s),end:iso(s+(1+pick(12))*5*60000)};});
    const hours={};for(const s of sessions){const h0=day0+pick(4)*30*60000;hours[s.sessionId]=[{start:iso(h0),end:iso(h0+(4+pick(6))*3600000)},{start:iso(h0+24*3600000),end:iso(h0+30*3600000)}];}
    const limited=r()<0.3,daily=limited&&r()<0.5?1+pick(2):null,weekly=limited&&daily===null?1+pick(2):null;
    const c={userId:p.userId,verified:true,coverageVerified:true,workingHoursVerified:true,checkedAt:now,coverage:cover,busy,sessionWorkingWindows:hours,limits:{dailyLimit:daily,weeklyLimit:weekly}};
    if(daily!==null||weekly!==null)c.interviewLoad={verified:true,checkedAt:now,timezone:'America/New_York',days:{'2026-09-28':pick(2),'2026-09-29':pick(2)},weeks:[{start:'2026-09-27T00:00:00Z',end:'2026-10-04T00:00:00Z',count:pick(2)}]};
    return c;
  });
  return {sessions,windows,timezone:'America/New_York',now,calendars};
}
const comparable=result=>({status:result.status,proposals:result.proposals,availabilityVerified:result.availabilityVerified,calendarCheckedAt:result.calendarCheckedAt});

test('0/0 breaks reproduce the original solver exactly on 400 random cases',()=>{
  let fits=0,noFits=0;
  for(let seed=1;seed<=400;seed++){
    const input=makeCase(seed);let a,b,errA=null,errB=null;
    try{a=v1(input);}catch(e){errA=e.message;}
    try{b=proposeCalendarSchedule({...input,minBreakMinutes:0,maxGapMinutes:0,variety:false});}catch(e){errB=e.message;}
    assert.equal(errB,errA,`seed ${seed}: errors differ`);
    if(errA)continue;
    assert.deepEqual(comparable(b),comparable(a),`seed ${seed}`);
    const varied=proposeCalendarSchedule({...input,minBreakMinutes:0,maxGapMinutes:0});
    assert.deepEqual(varied.proposals[0],a.proposals[0],`seed ${seed}: variety changed the first option`);
    assert.equal(varied.status,a.status,`seed ${seed}: variety changed the status`);
    a.proposals.length?fits++:noFits++;
  }
  // The cases must exercise both outcomes, or the comparison proves little.
  assert.ok(fits>50&&noFits>50,`fits ${fits}, no fits ${noFits}`);
});
