'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {tentativeSuggestions}=require('../src/scheduling/calendar-suggestions');
const now=Date.parse('2026-09-21T12:00:00Z');
const w=(day,start,end)=>({start:`2026-09-${day}T${start}:00Z`,end:`2026-09-${day}T${end}:00Z`});
function input(){return {now,facts:{durationMinutes:15,windows:[w(22,'17:00','23:00'),w(23,'17:00','23:00')],interviewerLimits:{dailyLimit:2,weeklyLimit:null}},override:{windows:[w(22,'17:00','21:00'),w(23,'17:00','21:00')]},calendar:{checkedAt:now,timezone:'America/New_York',viewTimezone:'America/Los_Angeles',days:[{date:'2026-09-22'},{date:'2026-09-23'}],observedBusy:[w(22,'17:00','17:30'),w(23,'17:00','18:00')]}};}
test('tentative suggestions respect busy blocks and working hours on both days without enabling booking',()=>{const r=tentativeSuggestions(input());assert.equal(r.slots.length,6);assert.equal(r.slots[0].start,'2026-09-22T17:30:00.000Z');assert.equal(r.slots[3].start,'2026-09-23T18:00:00.000Z');assert.equal(r.status,'needs_review');assert.equal(r.bookingEnabled,false);assert.ok(r.checks.includes('Current daily and weekly interview counts'));});
test('missing days, stale reads, absent working hours and invalid intervals produce no suggestions',()=>{for(const mutate of [i=>i.calendar.days.pop(),i=>i.calendar.checkedAt-=120001,i=>i.override=null,i=>i.calendar.observedBusy=[{start:'bad',end:'bad'}],i=>i.facts.interviewerLimits.dailyLimit=0]){const i=input();mutate(i);assert.deepEqual(tentativeSuggestions(i).slots,[]);}});
test('confirmed hours do not override conflicts or allow a slot past their end',()=>{const i=input();i.override.windows=[w(22,'17:10','17:40')];assert.deepEqual(tentativeSuggestions(i).slots,[]);});

test('cross-zone midnight ambiguity does not produce tentative times',()=>{const i=input();i.facts.windows=[w(23,'05:00','06:00')];assert.deepEqual(tentativeSuggestions(i).slots,[]);});
