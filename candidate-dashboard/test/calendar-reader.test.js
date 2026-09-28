'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {parseCalendar}=require('../worker/calendar-reader');
const input=()=>({date:'Tuesday, September 22, 2026',timezone:'America/New_York',interviewer:{name:'Mary',email:'mary@example.com'},blocks:['Busy, 10:00 AM – 1:00 PM EDT','Welcome, 1:15 PM – 1:30 PM EDT'],draftBlocks:['Welcome, 10:15 AM – 10:30 AM PDT']});
test('calendar observations use the interviewer timezone without claiming full coverage',()=>{const r=parseCalendar(input());assert.equal(r.observedBusy[0].start,'2026-09-22T14:00:00.000Z');assert.equal(r.observedBusy[0].end,'2026-09-22T17:00:00.000Z');assert.equal(r.availabilityVerified,false);assert.equal(r.bookingEnabled,false);assert.equal(r.observedBusy.length,2);});
test('empty, unrecognized and timezone-mismatched calendar views fail closed',()=>{for(const delta of [{blocks:[]},{date:'unknown'},{timezone:null},{blocks:['Busy, all day']},{blocks:['Busy, 10:00 AM – 1:00 PM PDT']}])assert.throws(()=>parseCalendar({...input(),...delta}));});
test('draft overlays are never silently removed from busy observations',()=>{const r=parseCalendar(input());assert.equal(r.draftOverlayCount,1);assert.equal(r.observedBusy[1].start,'2026-09-22T17:15:00.000Z');});
