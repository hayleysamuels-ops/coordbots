'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {parseInterviewerPanel}=require('../worker/full-calendar-reader');
const people=[{name:'First Person'},{name:'Second Person'}];
test('calendar conflicts stay attached to the matching interviewer',()=>{const r=parseInterviewerPanel('Current Interviewer\nConsider Alternate\nFirst Person\nfirst@example.com 6:00 AM – 6:15 AM PDT\nConflicts Unavailable (Ashby Meeting Hours)\nSelect Interviewer\nSecond Person\nsecond@example.com 6:00 AM – 6:15 AM PDT\nSelect Interviewer',people);assert.equal(r[0].status,'conflict');assert.match(r[0].reason,/Meeting Hours/);assert.equal(r[1].status,'unknown');});
test('missing explicit conflicts never proves complete free time',()=>{assert.equal(parseInterviewerPanel('Current Interviewer\nFirst Person first@example.com 11:15 AM – 11:45 AM PDT\nConsider Alternate\nNo interviewers to select from.',people)[0].status,'unknown');assert.equal(parseInterviewerPanel('Current Interviewer\nNo interviewers to select from.',people)[0].status,'unknown');});
test('incomplete loading is rejected',()=>{assert.throws(()=>parseInterviewerPanel('Current Interviewer\nLoading',people));assert.throws(()=>parseInterviewerPanel('Calendar',people));});
const {readFullCalendar}=require('../worker/full-calendar-reader');
function fixture(changed=false){
 const draftId='183bb8bb-ff6a-4d33-a7bf-a533ba631462',base='https://app.ashbyhq.com/schedules/drafts/'+draftId;
 let reads=0;const visits=[];
 const locator={waitFor:async()=>{},first(){return this;},or(){return this;},innerText:async()=> 'Interviewer 1, Welcome'};
 const page={getByPlaceholder:()=>locator,getByRole:()=>locator,getByText:()=>locator,waitForFunction:async()=>{},goto:async url=>visits.push(url),evaluate:async()=>({dates:['Mon, Sep 28'],starts:[changed&&reads++?'10:00am':'9:00am'],ends:['9:15am'],links:[{href:base+'/events/event/interviewers/0',count:'1'}]}),locator:()=>({innerText:async()=> 'Current Interviewer\nFirst Person\nfirst@example.com 6:00 AM – 6:15 AM PDT\nConflicts Unavailable (Ashby Meeting Hours)\nSelect Interviewer'})};
 return {page,visits,input:{draftId,sessions:[{sessionId:'s',title:'Welcome',eligibleInterviewers:[people[0]]}]}};
}
test('full draft inspection reads each panel and returns to the unchanged draft',async()=>{const f=fixture();const r=await readFullCalendar(f.page,f.input);assert.equal(r.events[0].interviewers[0].status,'conflict');assert.equal(r.availabilityVerified,false);assert.equal(r.bookingEnabled,false);assert.equal(f.visits.length,2);assert.match(f.visits[0],/interviewers\/0$/);assert.match(f.visits[1],new RegExp(f.input.draftId+'$'));});
test('changed draft times invalidate the whole inspection',async()=>{const f=fixture(true);await assert.rejects(readFullCalendar(f.page,f.input),/changed during calendar inspection/);});
