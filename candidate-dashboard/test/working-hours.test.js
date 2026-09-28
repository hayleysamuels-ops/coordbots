'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {workingHoursOverride}=require('../src/scheduling/working-hours');
const now=Date.parse('2026-09-21T12:00:00Z'),user={id:'coordinator',canApprove:true};
const input={timezone:'America/New_York',windows:[{start:'2026-09-22T09:00',end:'2026-09-22T17:00'}],enteredBy:'spoofed'};
test('working hour override uses authenticated actor and explicit timezone',()=>{const r=workingHoursOverride(input,user,now);assert.equal(r.enteredBy,'coordinator');assert.equal(r.source,'coordinator_override');assert.equal(r.windows[0].start,'2026-09-22T13:00:00.000Z');});
test('invalid or unauthorized overrides are refused',()=>{assert.throws(()=>workingHoursOverride(input,null,now));assert.throws(()=>workingHoursOverride({...input,timezone:'invalid'},user,now));assert.throws(()=>workingHoursOverride({...input,windows:[{start:'2026-09-22T17:00',end:'2026-09-22T09:00'}]},user,now));assert.equal(workingHoursOverride(null,user,now),null);});
