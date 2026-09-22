"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {trackerSuggestions}=require("../lib/scheduling/tracker-suggestions");
test("schedule proposals reuse the tracker partner, desk and laptop suggester",()=>{
 const candidate={id:"test",name:"Test Tess",values:{position:"FDE",driName:"",desk:"TBD",computer:"TBD",location:"SF"}};
 const result=trackerSuggestions(candidate,[candidate],{startDate:"2026-09-22",endDate:"2026-09-22"},new Date("2026-09-18T12:00:00Z"));
 assert.equal(result.partner.ok,true);assert.ok(result.partner.value.startsWith("FDE-"));
 assert.equal(result.desk.ok,true);assert.ok(result.desk.value.startsWith("SF-Desk"));
 assert.equal(result.laptop.ok,true);assert.ok(result.laptop.value.startsWith("SF-Poetic"));
});
test("confirmed tracker assignments are retained instead of being re-suggested",()=>{
 const candidate={id:"test",values:{position:"FDE",driName:"FDE-Liam",desk:"SF-Desk 1",computer:"SF-Poetic 1",location:"SF"}};
 assert.deepEqual(trackerSuggestions(candidate,[candidate],{startDate:"2026-09-22",endDate:"2026-09-22"},new Date("2026-09-18T12:00:00Z")),{});
});
