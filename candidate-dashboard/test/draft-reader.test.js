'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createDraftReader}=require('../worker/draft-reader');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const input={draftId:id(1),candidateId:id(2),applicationId:id(3),candidateName:'TEST Candidate'};
function setup(){
 let url,closed=0;const visits=[];const options={wrongCandidate:false,redirect:false};
 const page={goto:async target=>{visits.push(target);url=options.redirect?'https://app.ashbyhq.com/login':target;},url:()=>url, getByRole:(role,query)=>({waitFor:async()=>{},isChecked:async()=>true,all:async()=>[{getAttribute:async()=>options.wrongCandidate?'/other':'/candidates/'+input.candidateId+'/applications/'+input.applicationId}]}),locator:()=>({innerText:async()=>url.endsWith('calendar-invites')?'Candidate Invite\nVirtual welcome\nInterviewer Invite\nMary only':'PREVIEW\nFrom Anna\nHi TEST'})};
 const chromium={launch:async()=>({newContext:async()=>({route:async()=>{},newPage:async()=>page}),close:async()=>{closed++;}})};
 const saved={clientId:'a',expectedIdentity:'Anna Luminai',storageState:{}};
 const deps={chromium,vault:{load:()=>saved},connection:{status:async()=>({signInOpen:false})},clientId:'a',expectedIdentity:'Anna Luminai'};
 return {deps,options,visits,closed:()=>closed};
}
test('reads fixed draft previews and never enables sending',async()=>{const s=setup(),r=await createDraftReader(s.deps).inspect(input);assert.equal(r.candidatePreview,'Virtual welcome');assert.equal(r.confirmationEnabled,true);assert.equal(r.bookingEnabled,false);assert.equal(s.visits.length,2);assert.ok(s.visits.every(v=>v.includes('/schedules/drafts/'+input.draftId+'/communication/')));assert.equal(s.closed(),1);});
test('wrong candidate and login redirects cannot return previews',async()=>{for(const key of ['wrongCandidate','redirect']){const s=setup();s.options[key]=true;await assert.rejects(()=>createDraftReader(s.deps).inspect(input));assert.equal(s.closed(),1);assert.equal(s.visits.length,1);}});
test('invalid input and another client session never launch',async()=>{const s=setup();await assert.rejects(()=>createDraftReader(s.deps).inspect({...input,draftId:'invalid'}));s.deps.expectedIdentity='Other';await assert.rejects(()=>createDraftReader(s.deps).inspect(input));assert.equal(s.visits.length,0);});
test('open sign-in window blocks draft inspection',async()=>{const s=setup();s.deps.connection.status=async()=>({signInOpen:true});await assert.rejects(()=>createDraftReader(s.deps).inspect(input),/Close the sign-in/);assert.equal(s.visits.length,0);});
