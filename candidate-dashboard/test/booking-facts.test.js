'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createBookingFacts}=require('../src/scheduling/booking-facts');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const now=Date.parse('2026-09-21T12:00:00Z');
const input={applicationId:id(1),interviewId:id(5),interviewerEmail:'mary@example.com',timezone:'America/Los_Angeles',windows:[{start:'2026-09-22T10:00',end:'2026-09-22T16:00'}]};
function setup(){
 const data={'application.info':{id:id(1),status:'Active',candidate:{id:id(2),name:'Test',primaryEmailAddress:{value:'test@example.com'}},job:{id:id(3),title:'Engineer'},currentInterviewStage:{id:id(4)}},'jobInterviewPlan.info':{stages:[{id:id(4),activities:[{id:id(6),interviews:[{interviewId:id(5),title:'Welcome',isSchedulable:true,interviewDurationMinutes:15}]}]}]},'user.interviewerSettings':{dailyLimit:2,weeklyLimit:null},'user.search':[{id:id(7),email:'mary@example.com',firstName:'Mary',isEnabled:true}]};
 const calls=[];
 const reader=createBookingFacts({key:'test-key',clientId:'client-a',now:()=>now,request:async(url,options)=>{const endpoint=url.split('/').at(-1);calls.push({endpoint,body:JSON.parse(options.body)});assert.equal(options.redirect,'error');return{ok:true,json:async()=>({success:true,results:data[endpoint]})};}});
 return{data,calls,reader};
}
test('reads exact identities and duration without claiming availability',async()=>{const s=setup(),f=await s.reader.load(input);assert.equal(f.clientId,'client-a');assert.equal(f.durationMinutes,15);assert.equal(f.interviewer.userId,id(7));assert.equal(f.windows[0].start,'2026-09-22T17:00:00.000Z');assert.equal(f.availabilityVerified,false);assert.deepEqual(s.calls.map(c=>c.endpoint),['application.info','jobInterviewPlan.info','user.search','user.interviewerSettings']);});
test('candidate or plan changes invalidate fingerprints',async()=>{const s=setup(),a=await s.reader.load(input);s.data['application.info'].candidate.primaryEmailAddress.value='new@example.com';const b=await s.reader.load(input);assert.notEqual(a.sourceFingerprint,b.sourceFingerprint);s.data['jobInterviewPlan.info'].stages[0].activities[0].interviews[0].interviewDurationMinutes=30;assert.notEqual(b.templateRevision,(await s.reader.load(input)).templateRevision);});
test('rejects changed stage and inactive or ambiguous interviewers',async()=>{const s=setup();s.data['application.info'].currentInterviewStage.id=id(99);await assert.rejects(()=>s.reader.load(input),/current stage/);s.data['application.info'].currentInterviewStage.id=id(4);s.data['user.search'][0].isEnabled=false;await assert.rejects(()=>s.reader.load(input),/active Ashby interviewer/);s.data['user.search'][0].isEnabled=true;s.data['user.search'].push({...s.data['user.search'][0],id:id(8)});await assert.rejects(()=>s.reader.load(input),/unique/);});
test('rejects a returned application for a different request',async()=>{const s=setup();s.data['application.info'].id=id(99);await assert.rejects(()=>s.reader.load(input),/no longer active/);assert.equal(s.calls.length,1);});
test('bad windows and identifiers cause no Ashby calls',async()=>{const s=setup();await assert.rejects(()=>s.reader.load({...input,applicationId:'bad'}),/Choose/);await assert.rejects(()=>s.reader.load({...input,windows:[{start:'2026-09-20T10:00',end:'2026-09-20T16:00'}]}),/future/);assert.equal(s.calls.length,0);});
test('direct application lookup loads active current plan without an issue-list entry',async()=>{const s=setup();const a=await s.reader.application(id(1));assert.equal(a.applicationId,id(1));assert.equal(a.activities[0].sessions[0].interviewId,id(5));assert.equal(s.calls.length,2);s.data['application.info'].status='Archived';await assert.rejects(()=>s.reader.application(id(1)),/not active/);});

test('changed interviewer limits invalidate the source fingerprint',async()=>{const s=setup();const a=await s.reader.load(input);assert.equal(a.interviewerLimits.dailyLimit,2);s.data['user.interviewerSettings'].dailyLimit=1;assert.notEqual(a.sourceFingerprint,(await s.reader.load(input)).sourceFingerprint);s.data['user.interviewerSettings']={};await assert.rejects(()=>s.reader.load(input),/limits could not be verified/);});
test('interviewer directory pagination resolves exact unique identities and rejects duplicate names',async()=>{let ambiguous=false;const reader=createBookingFacts({key:'key',clientId:'client',request:async(url,options)=>{const body=JSON.parse(options.body);return {ok:true,json:async()=>({success:true,results:body.cursor==='start'?[{id:id(10),firstName:'Mary',lastName:'Petrino',email:'mary@example.com',isEnabled:true}]:ambiguous?[{id:id(11),firstName:'Mary',lastName:'Petrino',email:'other@example.com',isEnabled:true}]:[],moreDataAvailable:body.cursor==='start',nextCursor:body.cursor==='start'?'next':undefined})};}});const sessions=[{assignmentVerified:true,eligibleInterviewers:[{name:'Mary Petrino'}]}];assert.equal((await reader.resolveInterviewers(sessions)).interviewers[0].email,'mary@example.com');ambiguous=true;await assert.rejects(reader.resolveInterviewers(sessions),/Mary Petrino is an eligible interviewer but matches 2 active Ashby accounts/);});

// Luminai's Lunch slot lists four people and Ashby counts three eligible:
// one listed person has left and their account is deactivated. They're dropped; the count holds exactly.
test('a listed interviewer with only a deactivated account is excluded, and the eligible count must then match exactly',async()=>{
  const people=[['Upasna','Madhok',true],['Former','Employee',false],['Kathryn','Wicks',true],['Ariel','Perez Chavez',true]];
  let directory=people,calls=[];
  const reader=createBookingFacts({key:'key',clientId:'client',request:async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);
    return {ok:true,json:async()=>({success:true,results:directory.filter(p=>body.includeDeactivated||p[2]).map(([firstName,lastName,isEnabled],i)=>({id:id(20+i),firstName,lastName,email:`${firstName}@example.com`,isEnabled})),moreDataAvailable:false})};}});
  const lunch=(eligibleCount,names=people.map(p=>`${p[0]} ${p[1]}`))=>[{title:'Lunch',assignmentVerified:true,eligibleCount,eligibleInterviewers:names.map(name=>({name}))}];
  const [s]=await reader.excludeDeactivated(lunch(3));
  assert.deepEqual(s.eligibleInterviewers.map(p=>p.name),['Upasna Madhok','Kathryn Wicks','Ariel Perez Chavez']);
  assert.deepEqual(s.excludedInterviewers,[{name:'Former Employee',reason:'deactivated in Ashby'}]);
  assert.equal(s.eligibleCount,undefined);
  assert.equal(calls[0].includeDeactivated,true);
  // Not loosened: if the active people still don't equal Ashby's count, refuse.
  await assert.rejects(reader.excludeDeactivated(lunch(2)),/Session 1 \("Lunch"\): Ashby shows 2 eligible but 3 of the listed interviewers are active \(Upasna Madhok, Kathryn Wicks, Ariel Perez Chavez; Former Employee is deactivated in Ashby\)/);
  // A listed name with no account at all is never silently dropped.
  await assert.rejects(reader.excludeDeactivated(lunch(3,['Upasna Madhok','Kathryn Wicks','Ariel Perez Chavez','Nobody Here'])),/Nobody Here is listed in the interviewer slot but has no Ashby account/);
  // Sessions whose counts already agreed are untouched, with no directory call.
  calls=[];const plain=[{title:'Welcome',assignmentVerified:true,eligibleInterviewers:[{name:'Upasna Madhok'}]}];
  assert.deepEqual(await reader.excludeDeactivated(plain),plain);assert.equal(calls.length,0);
});

test('an interviewer who can\'t be resolved is named, with the session and which case it hit',async()=>{
  let users=[];
  const reader=createBookingFacts({key:'key',clientId:'client',request:async()=>({ok:true,json:async()=>({success:true,results:users,moreDataAvailable:false})})});
  const sessions=[{assignmentVerified:true,title:'Initial',eligibleInterviewers:[{name:'Hayley Samuels'}]},{assignmentVerified:true,title:'First Round',eligibleInterviewers:[{name:'Mary Petrino'}]}];
  const hayley={id:id(10),firstName:'Hayley',lastName:'Samuels',email:'hayley@example.com',isEnabled:true};
  // No account by that name, or only a deactivated one.
  for(const list of [[hayley],[hayley,{id:id(11),firstName:'Mary',lastName:'Petrino',email:'mary@example.com',isEnabled:false}]]){
    users=list;
    await assert.rejects(reader.resolveInterviewers(sessions),{status:409,message:'Session 2 ("First Round"): Mary Petrino is an eligible interviewer but has no active Ashby account by that name. Check their account and name in Ashby.'});
  }
  users=[hayley,{...hayley,id:id(12),email:'hayley.s@example.com'}];
  await assert.rejects(reader.resolveInterviewers(sessions),{status:409,message:'Session 1 ("Initial"): Hayley Samuels is an eligible interviewer but matches 2 active Ashby accounts by that name, so which one is meant can\'t be told. Check for duplicate accounts in Ashby, or add an interviewer identity override for Hayley Samuels to the client\'s scheduling rules.'});
  users=[{...hayley,email:''}];
  await assert.rejects(reader.resolveInterviewers(sessions),{status:409,message:'Session 1 ("Initial"): Hayley Samuels\'s active Ashby account has no usable ID or email.'});
  // A session without a title is named by its number alone.
  users=[];
  await assert.rejects(reader.resolveInterviewers([{assignmentVerified:true,eligibleInterviewers:[{name:'Hayley Samuels'}]}]),/^Error: Session 1: Hayley Samuels is an eligible interviewer but has no active Ashby account/);
});

test('an interviewer identity override picks among same-named accounts, and is never a fallback',async()=>{
  const joe=(n,email,isEnabled=true,firstName='Joe',lastName='Penn')=>({id:id(n),firstName,lastName,email,isEnabled});
  let users=[],overrides={};
  const reader=createBookingFacts({key:'key',clientId:'client',identityFor:name=>overrides[name]||null,
    request:async(url,options)=>{const body=JSON.parse(options.body);return {ok:true,json:async()=>({success:true,results:users.filter(u=>body.includeDeactivated||u.isEnabled),moreDataAvailable:false})};}});
  const sessions=[{assignmentVerified:true,title:'Technical',eligibleInterviewers:[{name:'Joe Penn'}]}];
  const two=[joe(30,'joe@luminai.com'),joe(31,'joe.penn@luminai.com')];
  // Ambiguous and no override: refused, as before.
  users=two;
  await assert.rejects(reader.resolveInterviewers(sessions),{status:409,message:/^Session 1 \("Technical"\): Joe Penn is an eligible interviewer but matches 2 active Ashby accounts by that name, .* or add an interviewer identity override for Joe Penn/});
  // With the override, its account is used.
  overrides={'Joe Penn':'joe@luminai.com'};
  assert.deepEqual((await reader.resolveInterviewers(sessions)).interviewers,[{userId:id(30),name:'Joe Penn',email:'joe@luminai.com'}]);
  // The deactivated-account filter agrees, keeping Joe against Ashby's count.
  const [kept]=await reader.excludeDeactivated([{...sessions[0],eligibleCount:1}]);
  assert.deepEqual(kept.eligibleInterviewers,[{name:'Joe Penn'}]);
  // The override's email must match exactly one active account...
  for(const list of [[joe(31,'joe.penn@luminai.com'),joe(32,'jp@luminai.com')],[...two,joe(32,'JOE@luminai.com')],[joe(30,'joe@luminai.com',false),joe(31,'joe.penn@luminai.com'),joe(32,'jp@luminai.com')]]){
    users=list;
    await assert.rejects(reader.resolveInterviewers(sessions),{status:409,message:/^Session 1 \("Technical"\): the identity override for Joe Penn gives joe@luminai\.com, which matches [02] active Ashby accounts, not exactly one\./});
  }
  // ...and that account must carry the name, or the ambiguity has only moved.
  users=[...two.slice(1),joe(32,'jp@luminai.com'),joe(30,'joe@luminai.com',true,'Josephine','Smith')];
  await assert.rejects(reader.resolveInterviewers(sessions),{status:409,message:/the identity override for Joe Penn gives joe@luminai\.com, but that account isn't one of the active Ashby accounts named Joe Penn/});
  // Enforced even when only one active account has the name.
  users=[joe(31,'joe.penn@luminai.com')];
  await assert.rejects(reader.resolveInterviewers(sessions),/matches 0 active Ashby accounts, not exactly one/);
  // Another ambiguous name is still refused: overrides are per name.
  users=[...two,joe(40,'a@luminai.com',true,'Ann','Lee'),joe(41,'b@luminai.com',true,'Ann','Lee')];
  await assert.rejects(reader.resolveInterviewers([...sessions,{assignmentVerified:true,title:'Lunch',eligibleInterviewers:[{name:'Ann Lee'}]}]),/^Error: Session 2 \("Lunch"\): Ann Lee is an eligible interviewer but matches 2 active Ashby accounts/);
});
