'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {bookingRoutes}=require('../src/scheduling/booking-routes');
async function fixture(t){let approvals=0,executions=0;const app=express();app.use(express.json());app.use((req,res,next)=>{if(req.get('X-Test-User')==='coordinator')req.schedulingUser={id:'coordinator',canApprove:true};next();});app.use('/booking',bookingRoutes({clientId:'a',facts:{load:async input=>({applicationId:input.applicationId,availabilityVerified:false})},inspectDraft:async payload=>payload,inspectCalendar:async payload=>payload,store:{list:async()=>[{id:'a',clientId:'a'},{id:'b',clientId:'b'}],get:async()=>({state:'scheduled'})},engine:{draft:async()=>({state:'draft'}),approve:async()=>{approvals++;return{id:'a'};},execute:async()=>{executions++;},reject:async()=>({state:'rejected'})}}));const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});t.after(()=>new Promise(resolve=>server.close(resolve)));return {url:`http://127.0.0.1:${server.address().port}/booking`,counts:()=>({approvals,executions})};}
const headers={'X-Test-User':'coordinator','X-Scheduling-Request':'1','Content-Type':'application/json'};
test('booking data requires coordinator authentication and remains client scoped',async t=>{const f=await fixture(t);assert.equal((await fetch(f.url)).status,403);const r=await fetch(f.url,{headers});assert.deepEqual((await r.json()).drafts,[{id:'a',clientId:'a'}]);});
test('cross-site approval cannot dispatch an invitation',async t=>{const f=await fixture(t);const r=await fetch(f.url+'/a/approve',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'});assert.equal(r.status,403);assert.deepEqual(f.counts(),{approvals:0,executions:0});});
test('drafting never dispatches; explicit approval dispatches once',async t=>{const f=await fixture(t);await fetch(f.url+'/drafts',{method:'POST',headers,body:'{}'});assert.deepEqual(f.counts(),{approvals:0,executions:0});const r=await fetch(f.url+'/a/approve',{method:'POST',headers,body:'{}'});assert.equal(r.status,200);assert.deepEqual(f.counts(),{approvals:1,executions:1});});

test('details lookup is coordinator-only and never dispatches',async t=>{const f=await fixture(t);assert.equal((await fetch(f.url+'/details',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);const r=await fetch(f.url+'/details',{method:'POST',headers,body:JSON.stringify({applicationId:'test'})});assert.deepEqual(await r.json(),{applicationId:'test',availabilityVerified:false});assert.deepEqual(f.counts(),{approvals:0,executions:0});});

test('draft inspection ignores client-supplied candidate identity',async t=>{const f=await fixture(t);const r=await fetch(f.url+'/inspect-draft',{method:'POST',headers,body:JSON.stringify({applicationId:'test',candidateId:'spoofed',candidateName:'spoofed',draftId:'draft'})});assert.equal(r.status,200);assert.deepEqual(await r.json(),{draftId:'draft',applicationId:'test'});assert.deepEqual(f.counts(),{approvals:0,executions:0});});

test('calendar inspection authenticates and ignores client-supplied interviewer identity',async t=>{const f=await fixture(t);const body=JSON.stringify({applicationId:'test',candidateId:'spoofed',interviewer:{name:'spoofed',email:'spoofed@example.com'},draftId:'draft'});assert.equal((await fetch(f.url+'/inspect-calendar',{method:'POST',headers:{'Content-Type':'application/json'},body})).status,403);const r=await fetch(f.url+'/inspect-calendar',{method:'POST',headers,body});assert.equal(r.status,200);const data=await r.json();assert.equal(data.draftId,'draft');assert.equal(data.applicationId,'test');assert.equal(data.workingHoursOverride,null);assert.equal(data.suggestions.bookingEnabled,false);assert.deepEqual(data.suggestions.slots,[]);assert.deepEqual(f.counts(),{approvals:0,executions:0});});

test('submitted availability is refreshed server-side and client windows cannot replace it',async t=>{
  let received,imports=0;const app=express();app.use(express.json());app.use((req,res,next)=>{req.schedulingUser={id:'coordinator',canApprove:true};next();});
  app.use('/booking',bookingRoutes({availability:{load:async()=>{imports++;return {stageId:'stage',source:'ashby_submission',scheduleId:'request',revision:'revision',checkedAt:1,timezone:'Etc/UTC',windows:[{start:'2026-09-28T13:00:00Z',end:'2026-09-28T21:00:00Z'}],localWindows:[{start:'2026-09-28T13:00',end:'2026-09-28T21:00'}]};}},facts:{load:async input=>{received=input;return {stageId:'stage',sourceFingerprint:'facts'};}}}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/booking/details`,{method:'POST',headers,body:JSON.stringify({applicationId:'app',scheduleId:'request',availabilitySource:'ashby',timezone:'wrong',windows:[{start:'wrong',end:'wrong'}]})});
  assert.equal(response.status,200);assert.equal(imports,1);assert.equal(received.timezone,'Etc/UTC');assert.equal(received.windows[0].start,'2026-09-28T13:00');assert.equal((await response.json()).candidateAvailability.source,'ashby_submission');
});

test('full schedule re-reads trusted plan and availability and never dispatches',async t=>{
 const sessions=[{sessionId:'s',interviewId:'i',title:'Welcome',durationMinutes:15}],plan={applicationId:'app',candidateId:'candidate',stageId:'stage',templateRevision:'v1',activities:[{sessions}]};let calls=0,dispatches=0;
 const app=express();app.use(express.json());app.use((req,res,next)=>{if(req.get('X-Test-User')==='coordinator')req.schedulingUser={id:'coordinator',canApprove:true};next();});
 app.use('/booking',bookingRoutes({rules:{get:()=>({placementFor:()=>[]})},facts:{application:async()=>plan},availability:{requests:async()=>({stageId:'stage',requests:[{scheduleId:'request',updatedAt:'version'}]}),load:async()=>({stageId:'stage',timezone:'UTC',localWindows:[{start:'2099-01-01T10:00',end:'2099-01-01T11:00'}]})},inspectPlan:async input=>{calls++;assert.equal(input.candidateId,'candidate');return {...input,sessions:sessions.map(s=>({...s,assignmentVerified:true,requiredCount:1,eligibleInterviewers:[{name:'Plan Interviewer'}]}))};},engine:{execute:()=>dispatches++}}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));const url=`http://127.0.0.1:${server.address().port}/booking/suggest-full-schedule`;
 const body=JSON.stringify({applicationId:'app',scheduleId:'request',candidateId:'spoof',availabilitySource:'ashby',windows:[{start:'wrong',end:'wrong'}],sessions:[{interviewer:'spoof'}]});
 assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,403);assert.equal(calls,0);
 const r=await fetch(url,{method:'POST',headers,body});assert.equal(r.status,200);const result=await r.json();assert.equal(result.proposals[0].events[0].interviewer.name,'Plan Interviewer');assert.equal(result.bookingEnabled,false);assert.equal(dispatches,0);
});

// A stage's activities are separate schedules (R1's two interview types; an
// onsite's pre-onsite chat): the plan is checked against the template's own
// activity, and only that one is carried on.
test('the full plan uses the activity the template belongs to',async t=>{
 const roomba=[{sessionId:'s0',interviewId:'i0',title:'R1 Technical Interview (Roomba)',durationMinutes:60}],applied=[{sessionId:'s1',interviewId:'i1',title:'Applied AI Interview',durationMinutes:60}];
 const plan={applicationId:'app',candidateId:'candidate',stageId:'stage',templateRevision:'v1',activities:[{id:'a0',title:'R1 Tech Interview Schedule',sessions:roomba},{id:'a1',title:'Applied AI Interview Schedule',sessions:applied}]};
 let observed;
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.schedulingUser={id:'coordinator',canApprove:true};next();});
 app.use('/booking',bookingRoutes({facts:{application:async()=>plan},availability:{requests:async()=>({stageId:'stage',requests:[{scheduleId:'request',updatedAt:'version'}]})},inspectPlan:async input=>({...input,...observed})}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const load=()=>fetch(`http://127.0.0.1:${server.address().port}/booking/full-plan`,{method:'POST',headers,body:JSON.stringify({applicationId:'app',scheduleId:'request'})});
 observed={activityId:'a1',sessions:applied};
 let r=await load();assert.equal(r.status,200);let body=await r.json();
 assert.equal(body.activityId,'a1');assert.deepEqual(body.activities.map(a=>a.id),['a1']);assert.deepEqual(body.sessions.map(s=>s.title),['Applied AI Interview']);
 // The worker's sessions must still be exactly that activity's.
 observed={activityId:'a1',sessions:roomba};
 r=await load();assert.equal(r.status,409);assert.match((await r.json()).error,/no longer match the published plan/);
 // An activity the plan doesn't have, or a worker that didn't say which, on a two-activity stage.
 observed={activityId:'gone',sessions:applied};
 r=await load();assert.equal(r.status,409);assert.match((await r.json()).error,/activity isn't in the published plan/);
 observed={sessions:applied};
 r=await load();assert.equal(r.status,409);assert.match((await r.json()).error,/didn't say which one the template is\. Update the scheduling worker\./);
});

// Alternatives (scheduling-rules sessions.alternatives): the worker leaves out
// the coding interview the template doesn't have, and the dashboard checks it.
test('the full plan carries one of a job\'s alternatives and refuses both',async t=>{
 const {parseRules}=require('../src/scheduling/rules');
 const doc=JSON.parse(JSON.stringify(require('../scheduling-rules/luminai.json')));
 const rules={get:()=>parseRules(doc,'luminai')};
 const s=(i,title,d)=>({sessionId:'s'+i,interviewId:'i'+i,title,durationMinutes:d});
 const onsite=[s(0,'Welcome',15),s(1,'Coding - Roomba',60),s(2,'URL Shortner',60),s(3,'Solution Decomp',60)];
 const plan={applicationId:'app',candidateId:'candidate',stageId:'stage',templateRevision:'v1',jobId:'009c1c4e-152b-44f0-bcb1-0879f8287b62',activities:[{id:'a0',title:'Onsite Interview Schedule',sessions:onsite}]};
 let observed,sent;
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.schedulingUser={id:'coordinator',canApprove:true};next();});
 app.use('/booking',bookingRoutes({rules,facts:{application:async()=>plan},availability:{requests:async()=>({stageId:'stage',requests:[{scheduleId:'request',updatedAt:'version'}]})},inspectPlan:async input=>{sent=input;return {...input,...observed};}}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const load=async()=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/booking/full-plan`,{method:'POST',headers,body:JSON.stringify({applicationId:'app',scheduleId:'request'})});return {status:r.status,body:await r.json()};};
 // Either one alone: carried, the other out of the plan and the activity.
 for(const [kept,out] of [[1,2],[2,1]]){
  observed={activityId:'a0',sessions:onsite.filter((_,i)=>i!==out),alternativesLeftOut:[onsite[out]]};
  const r=await load();assert.equal(r.status,200,JSON.stringify(r.body));
  assert.deepEqual(sent.alternatives,[{label:'coding interviews',titles:['Coding - Roomba','URL Shortner']}]);
  assert.deepEqual(r.body.sessions.map(x=>x.title),['Welcome',onsite[kept].title,'Solution Decomp']);
  assert.deepEqual(r.body.activities[0].sessions.map(x=>x.title),['Welcome',onsite[kept].title,'Solution Decomp']);
  assert.deepEqual(r.body.alternativesLeftOut,[onsite[out].title]);
 }
 // Both: a worker without the rule matches a template that has both. Refused.
 observed={activityId:'a0',sessions:onsite};
 let r=await load();assert.equal(r.status,409);
 assert.equal(r.body.error,'Both coding interviews are in the template ("Coding - Roomba" and "URL Shortner"), and only one should run. Remove the one this candidate isn\'t taking from the schedule\'s template in Ashby, then load the plan again. Nothing was booked.');
 // Neither, or something left out that no rule covers: refused.
 observed={activityId:'a0',sessions:[onsite[0],onsite[3]],alternativesLeftOut:[onsite[1],onsite[2]]};
 r=await load();assert.equal(r.status,409);assert.match(r.body.error,/^None of the coding interviews \("Coding - Roomba", "URL Shortner"\) is in the template/);
 observed={activityId:'a0',sessions:[onsite[0],onsite[1]],alternativesLeftOut:[onsite[2],onsite[3]]};
 r=await load();assert.equal(r.status,409);assert.match(r.body.error,/no alternatives rule covers/);
 // A job with no rule: every interview required, as before.
 plan.jobId='837cc1e9-15ed-4f07-8755-51ee29f4ea39';
 observed={activityId:'a0',sessions:onsite};
 r=await load();assert.equal(r.status,200);assert.deepEqual(sent.alternatives,[]);assert.equal(r.body.sessions.length,4);assert.deepEqual(r.body.alternativesLeftOut,[]);
 observed={activityId:'a0',sessions:onsite.filter((_,i)=>i!==2),alternativesLeftOut:[onsite[2]]};
 r=await load();assert.equal(r.status,409);assert.match(r.body.error,/no alternatives rule covers/);
});
