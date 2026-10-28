'use strict';
// The send gate (worker/send-gate.js): Ashby read again just before the
// robot's Send click, compared with the approval rather than trusted, and the
// daily cap. A reason never refuses: the draft is left for a person.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {createSendGate,readSendFacts,factsProblem,configProblem,capBlocked,takeSend,sendLogFile}=require('../worker/send-gate');

const APP='8dfd8f14-83c4-41f8-aaf1-416b75cb0892',JOB='837cc1e9-15ed-4f07-8755-51ee29f4ea39',CAND='fc88f24e-d59b-4e58-aa51-f0e94b1a32da';
const SCHED='199e1b3d-3f4f-4629-98a5-3ec323fd1206',STAGE='5e1b0e4c-0000-4000-8000-000000000001';
const HAYLEY='c251f667-e04c-403a-8c70-4cbc8fc3f435',MARY='a0000000-0000-4000-8000-000000000002';
const NOW=Date.parse('2099-10-14T12:00:00Z');
const plan={applicationId:APP,jobId:JOB,candidateId:CAND,interviewScheduleId:SCHED,stage:{title:'First Round'},candidate:{name:'TEST',email:'hayleysamuels511@gmail.com'},
  sessions:[{interviewers:[{userId:HAYLEY,name:'Hayley Samuels',email:'hayley@luminai.com'}]},{interviewers:[{userId:MARY,name:'Mary Petrino',email:'mary@luminai.com'},{userId:HAYLEY,name:'Hayley Samuels',email:'hayley@luminai.com'}]}]};
const facts=(over={})=>({
  application:{id:APP,status:'Active',job:{id:JOB},candidate:{id:CAND,primaryEmailAddress:{value:'HayleySamuels511@gmail.com'}},currentInterviewStage:{id:STAGE,title:'First Round'},...over.application},
  schedules:over.schedules||[{id:SCHED,applicationId:APP,interviewStageId:STAGE,status:'CandidateAvailabilitySubmitted',interviewEvents:[]}],
  users:over.users||{[HAYLEY]:{id:HAYLEY,email:'hayley@luminai.com',isEnabled:true},[MARY]:{id:MARY,email:'Mary@luminai.com',isEnabled:true}}});
const domains=['luminai.com'];
const problem=f=>factsProblem(plan,f,{domains,now:NOW});

test('Ashby matching the approval lets the send go ahead',()=>{
  assert.equal(problem(facts()),null);
  // Another schedule that's finished, cancelled or only requested doesn't stop it.
  const others=[{id:'x1',status:'Complete',interviewEvents:[{endTime:'2099-10-01T00:00:00Z'}]},{id:'x2',status:'Cancelled',interviewEvents:[]},{id:'x3',status:'Scheduled',interviewEvents:[{endTime:'2099-10-13T00:00:00Z'}]}];
  assert.equal(problem(facts({schedules:[...facts().schedules,...others]})),null);
});

test('each mismatch with Ashby stops the send, and says what differs',()=>{
  const cases=[
    [{application:{status:'Archived'}},/the application is Archived/],
    [{application:{job:{id:'other'}}},/on a different job/],
    [{application:{candidate:{id:'other',primaryEmailAddress:{value:'hayleysamuels511@gmail.com'}}}},/for a different candidate/],
    [{application:{candidate:{id:CAND,primaryEmailAddress:{value:'old@example.com'}}}},/primary email in Ashby is old@example.com, not hayleysamuels511@gmail.com/],
    [{application:{candidate:{id:CAND}}},/has no primary email in Ashby/],
    [{schedules:[]},/isn't among the application's schedules/],
    [{schedules:[{id:SCHED,applicationId:'other',interviewStageId:STAGE,status:'NeedsScheduling'}]},/belongs to another application/],
    [{schedules:[{id:SCHED,applicationId:APP,interviewStageId:'old-stage',status:'NeedsScheduling'}]},/isn't in the application's current stage/],
    [{application:{currentInterviewStage:{id:STAGE,title:'Onsite'}}},/current stage is Onsite, not First Round/],
    [{schedules:[{id:SCHED,applicationId:APP,interviewStageId:STAGE,status:'Cancelled'}]},/has been booked before \(Ashby shows it Cancelled\)/],
    [{schedules:[{id:SCHED,applicationId:APP,interviewStageId:STAGE,status:'Scheduled'}]},/has been booked before/],
    [{schedules:[{id:SCHED,applicationId:APP,interviewStageId:STAGE,status:'NeedsScheduling',interviewEvents:[{id:'e'}]}]},/has been booked before \(Ashby shows it NeedsScheduling, with 1 interview\)/],
    [{schedules:[...facts().schedules,{id:'x',status:'Scheduled',interviewEvents:[{endTime:'2099-10-20T00:00:00Z'}]}]},/already has another schedule booked for the future/],
    [{users:{[HAYLEY]:{id:HAYLEY,email:'hayley@luminai.com'}}},/Mary Petrino isn't an Ashby user/],
    [{users:{...facts().users,[MARY]:{id:MARY,email:'mary@luminai.com',isEnabled:false}}},/Mary Petrino's Ashby account is disabled/],
    [{users:{...facts().users,[MARY]:{id:MARY,email:'mary.p@luminai.com',isEnabled:true}}},/Mary Petrino's email in Ashby is mary.p@luminai.com, not mary@luminai.com/],
  ];
  for(const [over,pattern] of cases){
    const r=problem(facts(over));
    assert.match(r,/^Ashby, read again just before sending, doesn't match the approval: /);
    assert.match(r,pattern,JSON.stringify(over));
  }
  assert.match(problem({...facts(),application:{id:'other'}}),/didn't return this application/);
});

test('every interviewer must be on the client\'s interviewer domains, matched exactly',()=>{
  const external={...plan,sessions:[{interviewers:[{userId:HAYLEY,name:'Hayley Samuels',email:'hayley@luminai.com.evil.io'}]}]};
  const f=facts({users:{[HAYLEY]:{id:HAYLEY,email:'hayley@luminai.com.evil.io',isEnabled:true}}});
  assert.match(factsProblem(external,f,{domains,now:NOW}),/hayley@luminai.com.evil.io isn't on an interviewer domain \(luminai.com\)/);
  assert.match(factsProblem(plan,facts(),{domains:['carrara.is'],now:NOW}),/hayley@luminai.com isn't on an interviewer domain/);
});

test('the read asks Ashby for the application, every page of its schedules, and each interviewer once, with the read key',async()=>{
  const asked=[];
  const request=async(url,o)=>{
    const body=JSON.parse(o.body),endpoint=url.replace('https://api.ashbyhq.com/','');asked.push([endpoint,body]);
    assert.equal(o.headers.Authorization,'Basic '+Buffer.from('rk:').toString('base64'));
    const f=facts();
    const results=endpoint==='application.info'?f.application:endpoint==='user.info'?f.users[body.userId]
      :body.cursor?[]:f.schedules;
    return {ok:true,status:200,json:async()=>({success:true,results,...(endpoint==='interviewSchedule.list'&&!body.cursor?{moreDataAvailable:true,nextCursor:'c2'}:{})})};
  };
  const got=await readSendFacts({key:'rk',plan,request});
  assert.deepEqual(asked.map(a=>a[0]),['application.info','interviewSchedule.list','interviewSchedule.list','user.info','user.info']);
  assert.deepEqual(asked[3][1],{userId:HAYLEY});assert.deepEqual(asked[4][1],{userId:MARY});
  assert.equal(problem(got),null);
  const failing=async()=>({ok:false,status:401,json:async()=>({success:false,errors:['invalid key']})});
  await assert.rejects(readSendFacts({key:'rk',plan,request:failing}),/application.info couldn't be read \(HTTP 401: invalid key\)/);
});

test('the gate needs its read key, domains and cap configured; missing any, nothing is sent',()=>{
  const full={ASHBY_READ_API_KEY:'rk',BOOKING_INTERVIEWER_DOMAINS:'luminai.com',BOOKING_SEND_DAILY_CAP:'10'};
  assert.equal(configProblem(full),null);
  assert.match(configProblem({...full,ASHBY_READ_API_KEY:' '}),/ASHBY_READ_API_KEY/);
  assert.match(configProblem({...full,BOOKING_INTERVIEWER_DOMAINS:''}),/BOOKING_INTERVIEWER_DOMAINS/);
  for(const cap of [undefined,'0','-1','ten','1.5'])assert.match(configProblem({...full,BOOKING_SEND_DAILY_CAP:cap}),/BOOKING_SEND_DAILY_CAP/);
  assert.equal(sendLogFile({ASHBY_SESSION_FILE:'/data/ashby/session.enc'}),'/data/ashby/send-log.json');
  assert.equal(sendLogFile({}),null);
});

const tmpLog=()=>path.join(fs.mkdtempSync(path.join(os.tmpdir(),'send-gate-')),'send-log.json');
const capEnv={BOOKING_SEND_DAILY_CAP:'2'};

test('the daily cap: sends in the last 24 hours count; at the cap the send is skipped, with one channel notice',()=>{
  const file=tmpLog(),hour=3600000;
  assert.equal(capBlocked({file,env:capEnv,now:NOW}),null,'no log yet: empty');
  assert.equal(takeSend({file,env:capEnv,interviewScheduleId:'s1',now:NOW}),null);
  assert.equal(takeSend({file,env:capEnv,interviewScheduleId:'s2',now:NOW+hour}),null);
  const first=takeSend({file,env:capEnv,interviewScheduleId:'s3',now:NOW+2*hour});
  assert.match(first.reason,/daily send cap is reached \(2 sends in the last 24 hours; the cap is 2\)\. The next send is allowed after Oct 15, 12:00 UTC\./);
  assert.equal(first.firstAtCap,true);assert.equal(first.resetsAt,'2099-10-15T12:00:00.000Z');
  assert.equal(takeSend({file,env:capEnv,interviewScheduleId:'s3',now:NOW+3*hour}).firstAtCap,false,'one notice for this stretch');
  assert.match(capBlocked({file,env:capEnv,now:NOW+3*hour}),/cap is reached/);
  // The first send drops out after 24 hours.
  assert.equal(takeSend({file,env:capEnv,interviewScheduleId:'s4',now:NOW+24*hour+1}),null);
  const log=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.deepEqual(log.sends.map(s=>s.interviewScheduleId),['s2','s4']);
  // Reached again later: a new stretch, a new notice.
  assert.equal(takeSend({file,env:capEnv,interviewScheduleId:'s5',now:NOW+24*hour+2}).firstAtCap,true);
});

test('an unreadable send log is treated as full, never as empty',()=>{
  const file=tmpLog();fs.writeFileSync(file,'{not json');
  assert.match(takeSend({file,env:capEnv,interviewScheduleId:'s1',now:NOW}).reason,/send log couldn't be read/);
  assert.match(capBlocked({file,env:capEnv,now:NOW}),/send log couldn't be read/);
  assert.match(capBlocked({file:null,env:capEnv,now:NOW}),/nowhere to keep its send log/);
});

test('the gate: the send locks, then the read, then the cap; only a send that passes the read is counted',async()=>{
  const file=tmpLog();
  const jobs=JSON.stringify({[JOB]:'all'});
  const env={BOOKING_SEND:'on',BOOKING_SEND_JOBS:jobs,BOOKING_COMPOSE_JOBS:jobs,ASHBY_READ_API_KEY:'rk',BOOKING_INTERVIEWER_DOMAINS:'luminai.com',BOOKING_SEND_DAILY_CAP:'1',BOOKING_SEND_LOG_FILE:file};
  let f=facts();
  const request=async(url,o)=>{const body=JSON.parse(o.body),endpoint=url.split('/').pop();
    return {ok:true,status:200,json:async()=>({success:true,results:endpoint==='application.info'?f.application:endpoint==='user.info'?f.users[body.userId]:f.schedules})};};
  const gate=createSendGate({env,request,now:()=>NOW});
  // The send locks first, before Ashby is read.
  let reads=0;const counting=async(...a)=>{reads++;return request(...a);};
  assert.match((await createSendGate({env:{...env,BOOKING_SEND:'off'},request:counting})(plan)).reason,/switched off/);
  assert.match((await createSendGate({env:{...env,BOOKING_SEND_JOBS:undefined},request:counting})(plan)).reason,/isn't opted in \(BOOKING_SEND_JOBS\)/);
  assert.equal(reads,0);
  f=facts({application:{status:'Archived'}});
  assert.match((await gate(plan)).reason,/application is Archived/);
  assert.equal(fs.existsSync(file),false,'a mismatch isn\'t counted');
  f=facts();
  assert.equal(await gate(plan),null);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).sends.length,1,'counted before the click');
  const capped=await gate(plan);
  assert.match(capped.reason,/cap is reached/);assert.equal(capped.cap.firstAtCap,true);assert.equal(capped.cap.cap,1);
  const down=createSendGate({env,request:async()=>{throw Error('ECONNRESET');},now:()=>NOW});
  assert.match((await down(plan)).reason,/^Ashby couldn't be read again just before sending: Ashby's application.info couldn't be read \(ECONNRESET\)\.$/);
  assert.match((await createSendGate({env:{...env,ASHBY_READ_API_KEY:''},request})(plan)).reason,/ASHBY_READ_API_KEY/);
});
