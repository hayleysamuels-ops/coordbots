'use strict';
// The worker's schedule-template reader: a genuine mismatch lists every
// difference; a read failure names its cause; repeated titles match in order;
// a page-level container isn't mistaken for a second event.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {readPlan}=require('../worker/plan-reader');
const slot=names=>`Slot #1 —\n${names.length} Eligible Matches\nSpecific Employees:\n${names.length} Employees\n${names.join('\nOR ')}\nAdd Interviewer Slot`;
// blocks: { title: [{ duration, top, names, bare }] }, as the page would report
// them; events is the number of event rows (interview dropdown plus duration).
// A bare block is a collapsed event: Ashby's "Configure: Interviewers | Room"
// control, with its slots not yet on the page.
const waits=[];
function page({blocks,events,errors={},unknown=[]}){
  return {
    getByRole:(role,q)=>({waitFor:async()=>{if(q.name==='Events'&&errors.events)throw Object.assign(Error('Timeout 15000ms exceeded.'),{name:'TimeoutError'});}}),
    waitForFunction:async(fn,arg,opts)=>{
      if(arg===null&&errors.calculating)throw Object.assign(Error('Timeout 30000ms exceeded.'),{name:'TimeoutError'});
      if(Array.isArray(arg)){waits.push(opts.timeout);if(!arg.includes(events))throw Object.assign(Error(`Timeout ${opts.timeout}ms exceeded.`),{name:'TimeoutError'});}
    },
    waitForTimeout:async()=>{},
    evaluate:async(fn,arg)=>arg===undefined?(errors.errorPage?'Something went wrong':'Events'):arg.loading?!!errors.loading:arg.rows?events:arg.unknown?unknown
      :(blocks[arg.title]||[]).map(b=>({text:b.bare?`${arg.title}\nConfigure: Interviewers | Room`:slot(b.names||['Pat Doe']),duration:b.duration,top:b.top,slots:!b.bare})),
  };
}
const plan=sessions=>({activities:[{sessions:sessions.map(([title,durationMinutes],i)=>({sessionId:'s'+i,interviewId:'i'+i,title,durationMinutes}))}]});

test('a matching template is read, with repeated titles paired in page order',async()=>{
  const r=await readPlan(page({events:3,blocks:{Welcome:[{duration:15,top:0}],'One on One':[{duration:30,top:100,names:['Ana Silva']},{duration:30,top:200,names:['Ben Ode']}]}}),plan([['Welcome',15],['One on One',30],['One on One',30]]));
  assert.deepEqual(r.sessions.map(s=>[s.title,s.eligibleInterviewers[0].name]),[['Welcome','Pat Doe'],['One on One','Ana Silva'],['One on One','Ben Ode']]);
});

test('a mismatch names every difference: missing, repeated, duration, order and count',async()=>{
  const p=page({events:4,blocks:{Welcome:[{duration:15,top:300}],'Technical Interviw':[{duration:45,top:100}],'HM Screen':[{duration:30,top:0},{duration:30,top:50}]}});
  const e=await readPlan(p,plan([['Welcome',15],['Technical Interviw',60],['HM Screen',30],['Lunch',30],['Conversation',30]])).then(()=>null,x=>x);
  assert.equal(e.status,409);
  assert.equal(e.kind,'mismatch');
  assert.deepEqual(e.issues,[
    '"Technical Interviw" is 45 minutes in the template but 60 in the plan',
    '"HM Screen" appears 2 times in the template but 1 time in the plan',
    '"Lunch" isn\'t in the template',
    '"Conversation" isn\'t in the template',
    'the order differs: the template has "Technical Interviw" before "Welcome"',
    'the template has 4 interviews and the plan has 5',
  ]);
  assert.match(e.message,/^The schedule template doesn't match the published plan: /);
});

test('read failures say what failed, and are never reported as a mismatch',async()=>{
  const ok={events:1,blocks:{Welcome:[{duration:15,top:0}]}};
  for(const [errors,pattern] of [[{events:true},/Events section never loaded/],[{events:true,errorPage:true},/Ashby showed an error page/],[{loading:true},/still loading the interviewer slots after 1 second /]]){
    const e=await readPlan(page({...ok,errors}),plan([['Welcome',15]]),{budgetMs:1000}).then(()=>null,x=>x);
    assert.equal(e.status,503,String(pattern));
    assert.equal(e.kind,'read');
    assert.match(e.message,pattern);
  }
});

test('rows are counted as events, so a collapsed event still counts, after a 30-second wait',async()=>{
  waits.length=0;
  const e=await readPlan(page({events:1,blocks:{'Recruiter Screen':[{duration:30,top:0,bare:true}]}}),plan([['Recruiter Screen',30]])).then(()=>null,x=>x);
  assert.deepEqual(waits,[30000]);
  // Not a mismatch, and not "no interviewers": without the write guard the
  // reader won't expand anything, so nothing is clicked.
  assert.equal(e.status,503);
  assert.equal(e.kind,'read');
  assert.match(e.message,/showed its events collapsed, and expanding them needs the write guard, which isn't active\. Nothing was clicked\./);
  assert.doesNotMatch(e.message,/No interviewers are configured|Add the interviewers/);
});

test('a template with no event rows is a read failure, not a 0-interview mismatch',async()=>{
  const e=await readPlan(page({events:0,blocks:{}}),plan([['Recruiter Screen',30]])).then(()=>null,x=>x);
  assert.equal(e.status,503);
  assert.equal(e.kind,'read');
  assert.match(e.message,/no event rows appeared within 30 seconds/);
});

test('a real mismatch is reported before missing interviewers',async()=>{
  const e=await readPlan(page({events:2,blocks:{'Recruiter Screen':[{duration:30,top:0,bare:true}],Extra:[{duration:15,top:50}]}}),plan([['Recruiter Screen',45]])).then(()=>null,x=>x);
  assert.equal(e.kind,'mismatch');
  assert.deepEqual(e.issues,['"Recruiter Screen" is 30 minutes in the template but 45 in the plan','the template has 2 interviews and the plan has 1']);
});

// A stage's activities are separate schedules: the template is one of them.
const stage=(...activities)=>({activities:activities.map(([title,sessions],a)=>({id:'a'+a,title,sessions:sessions.map(([t,d],i)=>({sessionId:`s${a}.${i}`,interviewId:`i${a}.${i}`,title:t,durationMinutes:d}))}))});
const r1=stage(['R1 Tech Interview Schedule',[['R1 Technical Interview (Roomba)',60]]],['Applied AI Interview Schedule',[['Applied AI Interview',60]]]);

test('a template that is one of the stage\'s activities is read as that activity',async()=>{
  for(const [title,id] of [['R1 Technical Interview (Roomba)','a0'],['Applied AI Interview','a1']]){
    const r=await readPlan(page({events:1,blocks:{[title]:[{duration:60,top:0}]}}),r1);
    assert.equal(r.activityId,id);assert.deepEqual(r.sessions.map(s=>s.title),[title]);
  }
  // An onsite with a separate pre-onsite chat: the main loop's template.
  const onsite=stage(['Onsite Interview Schedule',[['Welcome',15],['System Design',60]]],['Pre Onsite Chat Schedule',[['Pre Onsite Chat',30]]]);
  const r=await readPlan(page({events:2,blocks:{Welcome:[{duration:15,top:0}],'System Design':[{duration:60,top:100}]}}),onsite);
  assert.equal(r.activityId,'a0');assert.equal(r.activityTitle,'Onsite Interview Schedule');
});

test('a stale template still refuses, and says what it has, including an interview in no activity',async()=>{
  // An interview the plan doesn't have at all.
  let e=await readPlan(page({events:1,blocks:{},unknown:[{title:'Coding - URL Shortener',duration:60,top:0}]}),r1).then(()=>null,x=>x);
  assert.equal(e.status,409);assert.equal(e.kind,'mismatch');
  assert.match(e.message,/doesn't match any of this stage's 2 activities\. The template has "Coding - URL Shortener" \(60 min\), not in this stage's plan\./);
  assert.match(e.message,/"R1 Tech Interview Schedule": "R1 Technical Interview \(Roomba\)" isn't in the template/);
  assert.deepEqual(e.issues,['"R1 Tech Interview Schedule": "R1 Technical Interview (Roomba)" isn\'t in the template','"Applied AI Interview Schedule": "Applied AI Interview" isn\'t in the template']);
  // A known interview plus an extra one: the extra still refuses.
  e=await readPlan(page({events:2,blocks:{'Applied AI Interview':[{duration:60,top:0}]},unknown:[{title:'Take-home review',duration:30,top:100}]}),r1).then(()=>null,x=>x);
  assert.equal(e.kind,'mismatch');
  assert.match(e.message,/The template has "Applied AI Interview" \(60 min\), "Take-home review" \(30 min\), not in this stage's plan\./);
  assert.match(e.message,/"Applied AI Interview Schedule": the template has 2 interviews and the plan has 1/);
  // A wrong duration on the right interview.
  e=await readPlan(page({events:1,blocks:{'Applied AI Interview':[{duration:45,top:0}]}}),r1).then(()=>null,x=>x);
  assert.match(e.message,/"Applied AI Interview Schedule": "Applied AI Interview" is 45 minutes in the template but 60 in the plan/);
});

test('a template two activities both fit is refused, not guessed',async()=>{
  const twins=stage(['First',[['Chat',30]]],['Second',[['Chat',30]]]);
  const e=await readPlan(page({events:1,blocks:{Chat:[{duration:30,top:0}]}}),twins).then(()=>null,x=>x);
  assert.equal(e.status,409);assert.equal(e.kind,'ambiguous');assert.match(e.message,/matches 2 activities in this stage \("First", "Second"\)/);
});
