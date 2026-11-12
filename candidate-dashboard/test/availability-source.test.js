'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {normalizeSubmission,createAvailabilitySource,notPending,notPendingText}=require('../src/scheduling/availability-source');
const now=Date.parse('2026-09-21T12:00:00Z'),id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const submission=()=>({complete:true,timezone:'America/New_York',windows:[{start:'2026-09-28T13:00:00Z',end:'2026-09-28T21:00:00Z'},{start:'2026-09-29T13:00:00Z',end:'2026-09-29T21:00:00Z'}]});
test('submission windows preserve absolute time and produce local form values',()=>{const r=normalizeSubmission(submission(),now);assert.equal(r.localWindows[0].start,'2026-09-28T09:00');assert.equal(r.windows[1].end,'2026-09-29T21:00:00.000Z');});
test('incomplete or offset-free submissions cannot silently become availability',()=>{for(const delta of [{complete:false},{timezone:'bad'},{windows:[{start:'2026-09-28T09:00',end:'2026-09-28T17:00'}]}])assert.throws(()=>normalizeSubmission({...submission(),...delta},now));});
test('past submissions are counted but never reused as future availability',()=>{const d=submission();d.windows.push({start:'2026-09-19T13:00:00Z',end:'2026-09-19T21:00:00Z'});d.windows.push(d.windows[0]);const r=normalizeSubmission(d,now);assert.equal(r.expiredCount,1);assert.equal(r.windows.length,2);});
function fixture(){const schedule={id:id(2),applicationId:id(1),status:'CandidateAvailabilitySubmitted',interviewStageId:id(4),updatedAt:'2026-09-21T12:00:00Z'};const app={id:id(1),status:'Active',candidate:{id:id(3),name:'Candidate'},currentInterviewStage:{id:id(4)}};const flags={};let inspection;const source=createAvailabilitySource({key:'test',clientId:'client',now:()=>now,inspect:async input=>{inspection=input;if(flags.changed)schedule.status='Scheduled';return {...submission(),applicationId:id(1),candidateId:flags.wrongCandidate?id(99):id(3),scheduleId:id(2)};},request:async(url,opts)=>{const body=JSON.parse(opts.body);assert.equal(body.applicationId,id(1));return {ok:true,json:async()=>({success:true,results:url.endsWith('application.info')?app:[schedule]})};}});return {source,flags,app,schedule,inspection:()=>inspection};}
test('fresh request binding supplies server identities and revalidates after reading',async()=>{const f=fixture(),r=await f.source.load({applicationId:id(1),scheduleId:id(2),candidateId:id(99)});assert.equal(r.source,'ashby_submission');assert.equal(f.inspection().candidateId,id(3));assert.equal(r.bookingEnabled,false);});
test('wrong candidate, changed request, archived application and old stage fail closed',async()=>{for(const mutation of [f=>f.flags.wrongCandidate=true,f=>f.flags.changed=true,f=>f.app.status='Archived',f=>f.schedule.interviewStageId=id(99)]){const f=fixture();mutation(f);await assert.rejects(()=>f.source.load({applicationId:id(1),scheduleId:id(2)}));}});
test('requests() names what happened to schedules that aren\'t pending: status and stage, nothing else',async()=>{const f=fixture();f.schedule.status='Scheduled';const r=await f.source.requests(id(1));assert.deepEqual(r.requests,[]);assert.deepEqual(r.others,[{scheduleId:id(2),stageId:id(4),status:'Scheduled'}]);});
test('a request that isn\'t pending is refused with the cause and what to do, never "choose a current pending schedule"',()=>{
  const base={stageId:id(4),requests:[]};
  const why=(other,stageId)=>notPending({...base,others:other?[{scheduleId:id(2),stageId:id(4),...other}]:[]},id(2),stageId);
  assert.match(why({status:'Scheduled'}),/already been booked in Ashby \(its status there is Scheduled\).*don't schedule it\. Check the booked time in Ashby/);
  assert.match(why({status:'Complete'}),/already been booked/);
  assert.match(why({status:'Cancelled'}),/cancelled in Ashby.*send them a new availability request/);
  assert.match(why({status:'WaitingOnCandidateAvailability'}),/no longer waiting to be scheduled.*WaitingOnCandidateAvailability.*post a fresh option from booking review/);
  assert.match(why({status:'CandidateAvailabilitySubmitted',stageId:id(9)}),/moved to another stage/);
  assert.match(why(null,id(9)),/moved to another stage/,'the stage changed between the plan read and the request read');
  assert.match(why(null),/no longer pending in Ashby.*if this interview has been booked there, nothing more is needed/);
  assert.match(notPending({stageId:id(4),requests:[]},id(2)),/no longer pending/,'an older result without others');
});
test('load() of a request booked meanwhile says so, and carries why for the Schedule button\'s wording',async()=>{const f=fixture();f.schedule.status='Scheduled';
  await assert.rejects(()=>f.source.load({applicationId:id(1),scheduleId:id(2)}),e=>{assert.equal(e.status,409);assert.deepEqual(e.notPending,{kind:'booked',status:'Scheduled'});assert.match(e.message,/^This interview has already been booked in Ashby/);return true;});
  assert.match(notPendingText({kind:'cancelled',status:'Cancelled'},'approval'),/^This interview request was cancelled in Ashby, so this approval wasn't composed and nothing was made in Ashby\. If the candidate still needs/);
  assert.match(notPendingText({kind:'stage'},'approval'),/moved to another stage.*so this approval wasn't composed/);
});
test('scheduleState(): where one request stands, names only, and an application that isn\'t Active is an answer, not a refusal',async()=>{
  const f=fixture();Object.assign(f.schedule,{status:'Scheduled',scheduledBy:{id:id(7),firstName:'Pat',lastName:'Coordinator',email:'pat@example-agency.com'},
    interviewEvents:[{startTime:'2026-11-17T17:00:00.000Z',endTime:'2026-11-17T17:30:00.000Z',interviewers:[{id:id(8),firstName:'Dana',lastName:'Example',email:'dana@example-client.com'}]}]});
  const s=await f.source.scheduleState(id(1),id(2));
  assert.deepEqual(s,{applicationStatus:'Active',stageId:id(4),schedule:{status:'Scheduled',stageId:id(4),scheduledBy:'Pat Coordinator',events:[{start:'2026-11-17T17:00:00.000Z',end:'2026-11-17T17:30:00.000Z',interviewers:['Dana Example']}]}});
  assert.doesNotMatch(JSON.stringify(s),/@/,'no emails');
  f.app.status='Archived';assert.equal((await f.source.scheduleState(id(1),id(2))).applicationStatus,'Archived');
  assert.equal((await f.source.scheduleState(id(1),id(5))).schedule,null);
  await assert.rejects(()=>f.source.scheduleState('not-an-id',id(2)),e=>e.status===422);
});
