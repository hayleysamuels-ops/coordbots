'use strict';
// The worker's schedule-template reader: a genuine mismatch lists every
// difference; a read failure names its cause; repeated titles match in order;
// a page-level container isn't mistaken for a second event.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {readPlan}=require('../worker/plan-reader');
const slot=names=>`Slot #1 —\n${names.length} Eligible Matches\nSpecific Employees:\n${names.length} Employees\n${names.join('\nOR ')}\nAdd Interviewer Slot`;
// blocks: { title: [{ duration, top, names }] }, as the page would report them.
function page({blocks,events,errors={}}){
  return {
    getByRole:(role,q)=>({waitFor:async()=>{if(q.name==='Events'&&errors.events)throw Object.assign(Error('Timeout 15000ms exceeded.'),{name:'TimeoutError'});},count:async()=>events}),
    waitForFunction:async(fn,arg)=>{if(arg===null&&errors.calculating)throw Object.assign(Error('Timeout 30000ms exceeded.'),{name:'TimeoutError'});},
    evaluate:async(fn,arg)=>arg===undefined?(errors.errorPage?'Something went wrong':'Events'):(blocks[arg]||[]).map(b=>({text:slot(b.names||['Pat Doe']),duration:b.duration,top:b.top})),
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
  for(const [errors,pattern] of [[{events:true},/Events section never loaded/],[{events:true,errorPage:true},/Ashby showed an error page/],[{calculating:true},/still calculating interviewer matches/]]){
    const e=await readPlan(page({...ok,errors}),plan([['Welcome',15]])).then(()=>null,x=>x);
    assert.equal(e.status,503,String(pattern));
    assert.equal(e.kind,'read');
    assert.match(e.message,pattern);
  }
});
