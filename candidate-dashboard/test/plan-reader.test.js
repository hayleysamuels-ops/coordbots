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
function page({blocks,events,errors={}}){
  return {
    getByRole:(role,q)=>({waitFor:async()=>{if(q.name==='Events'&&errors.events)throw Object.assign(Error('Timeout 15000ms exceeded.'),{name:'TimeoutError'});}}),
    waitForFunction:async(fn,arg,opts)=>{
      if(arg===null&&errors.calculating)throw Object.assign(Error('Timeout 30000ms exceeded.'),{name:'TimeoutError'});
      if(typeof arg==='number'){waits.push(opts.timeout);if(events!==arg)throw Object.assign(Error(`Timeout ${opts.timeout}ms exceeded.`),{name:'TimeoutError'});}
    },
    waitForTimeout:async()=>{},
    evaluate:async(fn,arg)=>arg===undefined?(errors.errorPage?'Something went wrong':'Events'):arg.loading?!!errors.loading:arg.rows?events
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
