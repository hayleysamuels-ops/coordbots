'use strict';
// The booking dry run's fail-closed paths (worker/booking-composer.js), in a
// real browser against a small stand-in for Ashby's app, served at Ashby's
// address and navigated in-app as the real one is. A stand-in also answers
// permitted writes, so nothing reaches Ashby. These test the safeguards, not
// Ashby's markup; that's only known from a live run.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {dryRun,discardDraft}=require('../worker/booking-composer');
const {OP}=require('../worker/booking-permit');

let chromium=null;
try{chromium=require('../worker/node_modules/playwright').chromium;}catch(_){}
async function launch(){
  if(!chromium)return null;
  for(const options of [{},{channel:'chrome'}]){try{return await chromium.launch({headless:true,...options});}catch(_){}}
  return null;
}

const plan={jobId:'job-1',candidateId:'cand-1',applicationId:'app-1',interviewScheduleId:'sched-1',timeZone:'America/Denver',
  candidate:{name:'TEST',email:'t@example.com'},job:{title:'TEST'},stage:{title:'Initial Screen'},activityTitle:'Initial Screen Interview Schedule',
  sessions:[{title:'Initial',interviewId:'int-1',start:'2099-10-20T19:05:00.000Z',end:'2099-10-20T19:35:00.000Z',interviewers:[{userId:'u-h',name:'Hayley Samuels',email:'hayley@luminai.com'}]}]};

// The stand-in app. `menu` lists the Actions menu items; `dialogAfterManual`
// is a warning shown after "Manual Schedule"; `strayWrite` is a mutation the
// named menu item sends.
// `submitted` shows the availability-submitted card instead: a bare "Schedule"
// button (which must never be clicked) beside "Start Manual Schedule".
// `zone` gives the composer one session's fields and a time-zone button per
// label (a label or a list; '' for no button). `existing` lists drafts already on the
// schedule's Drafts tab; the run's own draft (draft-1) joins them once created.
// (Page state starts over on a full load.)
function app({menu=['Send Direct Booking Link','Request Candidate Availability','Manual Schedule','View All Scheduling Options'],dialogAfterManual=null,strayWrite=null,submitted=false,zone=null,existing=[]}={}){
  return `<!doctype html><html><body><nav><a href="/candidates/pipeline">Pipeline</a></nav><main id="m"></main><script>
  const drafts=${JSON.stringify(existing)};
  const gql=(name,variables)=>fetch('/api/graphql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationName:name,query:'mutation '+name+' { x }',variables})}).then(r=>r.json());
  // Like Ashby, every page loads something: one read query, answered by the stand-in.
  function render(){fetch('/api/graphql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationName:'ApiLoad',query:'query ApiLoad { x }'})});
    const p=location.pathname,m=document.getElementById('m');m.innerHTML='';
    if(p.endsWith('/feed')){
      m.innerHTML='<div role="dialog" aria-labelledby="cn"><h2 id="cn">TEST</h2><p>t@example.com</p><section><h2>Initial Screen Interview Schedule</h2>'+(${JSON.stringify(submitted)}?'<button id="sched">Schedule</button><button id="start">Start Manual Schedule</button>':'<button id="act">Actions</button>')+'</section></div>';
      const create=async()=>{const r=await gql('${OP.create}',{interviewScheduleId:'sched-1'});drafts.push(r.data.draftInterviewSchedule.id);history.pushState({},'','/schedules/drafts/'+r.data.draftInterviewSchedule.id);render();};
      if(${JSON.stringify(submitted)}){document.getElementById('sched').onclick=()=>gql('ApiScheduleCandidateAutomatically',{interviewScheduleId:'sched-1'}).catch(()=>{});document.getElementById('start').onclick=create;return;}
      document.getElementById('act').onclick=()=>{const u=document.createElement('div');u.setAttribute('role','menu');u.setAttribute('aria-label','Actions');
        u.innerHTML=${JSON.stringify(menu)}.map(t=>'<div role="menuitem" tabindex="0">'+t+'</div>').join('');document.body.appendChild(u);
        u.querySelectorAll('[role=menuitem]').forEach(i=>i.onclick=async()=>{u.remove();
          if(${JSON.stringify(strayWrite)}&&i.textContent===${JSON.stringify(strayWrite&&strayWrite.item)})gql(${JSON.stringify(strayWrite&&strayWrite.op)},{interviewScheduleId:'sched-1'}).catch(()=>{});
          if(i.textContent==='Manual Schedule'){const r=await gql('${OP.create}',{interviewScheduleId:'sched-1'});drafts.push(r.data.draftInterviewSchedule.id);
            history.pushState({},'','/schedules/drafts/'+r.data.draftInterviewSchedule.id);render();
            if(${JSON.stringify(dialogAfterManual)}){const d=document.createElement('div');d.setAttribute('role','alertdialog');d.innerHTML='<p>'+${JSON.stringify(dialogAfterManual)}+'</p><button>Confirm Anyway</button><button>Cancel</button>';document.body.appendChild(d);}}});};
    } else if(p.endsWith('/drafts')){
      m.innerHTML='<h2>Draft Schedules</h2>'+drafts.map(id=>'<div><a href="/schedules/drafts/'+id+'">open</a><button data-id="'+id+'"></button></div>').join('');
      m.querySelectorAll('button[data-id]').forEach(b=>b.onclick=async()=>{const id=b.dataset.id,r=await gql('${OP.discard}',{draftInterviewScheduleId:id}).catch(()=>({}));if(r.data)drafts.splice(drafts.indexOf(id),1);});
    } else if(p.startsWith('/schedules/drafts/')){m.innerHTML='<h1>Scheduling TEST TEST Initial Screen Unsaved</h1>'+(${JSON.stringify(zone)}===null?'':
      [].concat(${JSON.stringify(zone)}).filter(Boolean).map(z=>'<button aria-label="Select a timezone">'+z+'</button>').join('')+'<input aria-label="Set interview date..."><input role="combobox" aria-label="Start..."><input role="combobox" aria-label="End...">');}
  }
  addEventListener('popstate',render);render();
  </script></body></html>`;
}

async function run(t,{appOptions,baseline,runOptions={},task=null}={}){
  const browser=await launch();
  if(!browser){t.skip('no Chromium available');return null;}
  t.after(()=>browser.close());
  const context=await browser.newContext({serviceWorkers:'block'});
  // The stand-in app: pages, and replies to read queries (the guard lets
  // queries through; they must never reach Ashby). Writes go to the guard and
  // the permits, whose replies come from `respond` below.
  await context.route('https://app.ashbyhq.com/**',route=>{const r=route.request();
    if(r.method()==='GET')return route.fulfill({contentType:'text/html',body:app(appOptions)});
    if(/^\s*query\b/.test(JSON.parse(r.postData()||'{}').query||''))return route.fulfill({contentType:'application/json',body:'{"data":{}}'});
    return route.fallback();});
  const received=[];
  const respond=async route=>{const b=JSON.parse(route.request().postData());received.push(b.operationName===OP.discard?`${OP.discard}:${b.variables.draftInterviewScheduleId}`:b.operationName);
    if(b.operationName===OP.create)return {status:200,json:{data:{draftInterviewSchedule:{id:'draft-1',draftSchedule:{events:[baseline||{id:'ev-1',title:'Initial',startTimeISO:'2099-10-12T17:00:00.000Z',endTimeISO:'2099-10-12T17:30:00.000Z',interviewId:'int-1',interviewSlots:[{selected:'u-m'}]}]}}}}};
    return {status:200,json:{data:{id:'x'}}};};
  const page=await context.newPage();
  const timing={settle:200,short:300,wait:3000};
  const report=task?await task({context,page,respond,timing}):await dryRun({context,page,plan,respond,timing,...runOptions});
  return {report,received};
}
const discarded=id=>`${OP.discard}:${id}`;

test('"Manual Schedule" twice in the menu: refused before any write, nothing to clean up',async t=>{
  const r=await run(t,{appOptions:{menu:['Manual Schedule','Request Candidate Availability','Manual Schedule']}});if(!r)return;
  assert.equal(r.report.status,'refused');assert.equal(r.report.step,'open Manual Schedule');
  assert.match(r.report.reason,/Expected exactly one "Manual Schedule" in the Actions menu; found 2/);
  assert.deepEqual(r.received,[]);
  assert.deepEqual(r.report.cleanup,{deleted:false,reason:'no draft was created'});
});

test('a created draft that doesn\'t match the approved agenda is refused, then deleted',async t=>{
  const r=await run(t,{baseline:{id:'ev-1',title:'Something else',startTimeISO:'2099-10-12T17:00:00.000Z',endTimeISO:'2099-10-12T17:30:00.000Z',interviewId:'int-9',interviewSlots:[{selected:null}]}});if(!r)return;
  assert.equal(r.report.status,'refused');assert.match(r.report.reason,/doesn't match the approval/);
  assert.equal(r.report.draftId,'draft-1');
  assert.deepEqual(r.report.cleanup,{deleted:true,draftId:'draft-1'});
  assert.deepEqual(r.received,[OP.create,discarded('draft-1')]);
});

test('"The interview time is in the past" is never confirmed: the run stops and the draft is deleted',async t=>{
  const r=await run(t,{appOptions:{dialogAfterManual:'Heads up: The interview time is in the past.'}});if(!r)return;
  assert.equal(r.report.status,'refused');assert.match(r.report.reason,/never confirmed/);
  assert.deepEqual(r.report.cleanup,{deleted:true,draftId:'draft-1'});
  assert.deepEqual(r.received,[OP.create,discarded('draft-1')],'nothing was confirmed or saved');
});

test('a write the booking doesn\'t permit is blocked and stops the run',async t=>{
  // "Manual Schedule" is made to also send a booking-link email, as a neighbour would.
  const r=await run(t,{appOptions:{strayWrite:{item:'Manual Schedule',op:'ApiSendDirectBookingLink'}}});if(!r)return;
  assert.equal(r.report.status,'refused');assert.match(r.report.reason,/doesn't permit: POST \/api\/graphql mutation ApiSendDirectBookingLink/);
  assert.ok(!r.received.includes('ApiSendDirectBookingLink'),'it never reached the stand-in');
  assert.deepEqual(r.report.cleanup,{deleted:true,draftId:'draft-1'});
});

test('the composer\'s zone is read, not required to match: the approved times are entered in it',async t=>{
  // Ashby shows Denver; the candidate's availability (the plan's zone) is Pacific.
  const pacific={...plan,timeZone:'America/Los_Angeles'};
  for(const zone of [['America/Denver','MDT'],['MDT','America/Denver'],'America/Denver']){
    const r=await run(t,{appOptions:{zone},runOptions:{plan:pacific}});if(!r)return;
    assert.ok(r.report.checks.some(c=>c.name==='composer shows times in America/Denver; the approved times are entered in it (the candidate\'s availability is in America/Los_Angeles)'),JSON.stringify(r.report.checks));
    assert.equal(r.report.displayZone,'America/Denver');
    // Past the zone, the bare stand-in stops at the session editor.
    assert.match(r.report.reason,/Couldn't find the editor for session 1/);
  }
  const same=await run(t,{appOptions:{zone:['America/Denver','MDT']}});if(!same)return;
  assert.ok(same.report.checks.some(c=>c.name==='composer shows times in America/Denver'));
});

test('a zone that can\'t be read unambiguously is refused, naming what Ashby shows, and the draft is deleted',async t=>{
  for(const [zone,why] of [
    ['EDT','"EDT"; exactly one IANA time zone name is needed to read it by'],
    ['',"no time zone \\(there's no \"Select a timezone\" button\\); exactly one IANA"],
    [['America/Denver','EDT'],'"America/Denver", "EDT"; "EDT" isn\'t America/Denver \\(MDT\\)'],
    [['America/Denver','America/New_York'],'"America/Denver", "America/New_York"; exactly one IANA'],
    [['Mars/Olympus','MDT'],'"Mars/Olympus", "MDT"; exactly one IANA']]){
    const r=await run(t,{appOptions:{zone}});if(!r)return;
    assert.equal(r.report.status,'refused');assert.equal(r.report.step,"read the composer's time zone");
    assert.match(r.report.reason,new RegExp(`^The composer shows times in ${why}`));
    assert.deepEqual(r.received,[OP.create,discarded('draft-1')],'nothing was saved');
  }
});

test('availability submitted: starts from "Start Manual Schedule", never the bare "Schedule" beside it',async t=>{
  const r=await run(t,{appOptions:{submitted:true},baseline:{id:'ev-1',title:'Other',startTimeISO:'2099-10-12T17:00:00.000Z',endTimeISO:'2099-10-12T17:30:00.000Z',interviewId:'int-9',interviewSlots:[{selected:null}]}});if(!r)return;
  // The mismatched draft stops the run right after creation, which is all this needs.
  assert.ok(r.report.checks.some(c=>c.name==='started from "Start Manual Schedule" (availability submitted)'));
  assert.deepEqual(r.received,[OP.create,discarded('draft-1')],'only the create and the cleanup reached the stand-in');
  assert.ok(!r.report.blocked.some(b=>/ApiScheduleCandidateAutomatically/.test(b)),'the bare "Schedule" was never clicked');
});

test('the Slack-approved check refuses before creating anything if the schedule already has a draft',async t=>{
  const r=await run(t,{appOptions:{existing:['someone-elses']},runOptions:{checkExistingDrafts:true,keepOnSuccess:true}});if(!r)return;
  assert.equal(r.report.status,'refused');assert.equal(r.report.step,"check the schedule's drafts");
  assert.match(r.report.reason,/already has a draft in Ashby that the dashboard didn't make/);
  assert.deepEqual(r.received,[],'nothing was created or deleted');
  assert.deepEqual(r.report.cleanup,{deleted:false,reason:'no draft was created'});
});

test('the dashboard\'s earlier draft for the schedule is deleted first, by its ID only; a refusal still deletes the new one',async t=>{
  const r=await run(t,{appOptions:{existing:['d-old']},runOptions:{checkExistingDrafts:true,keepOnSuccess:true,supersedeDraftId:'d-old'}});if(!r)return;
  assert.deepEqual(r.report.superseded,{draftId:'d-old',deleted:true});
  assert.ok(r.report.checks.some(c=>c.name==='the schedule has no other drafts'));
  // The bare stand-in composer has no session fields, so the run refuses there;
  // keepOnSuccess never keeps a refused run's draft.
  assert.equal(r.report.status,'refused');
  assert.deepEqual(r.report.cleanup,{deleted:true,draftId:'draft-1'});
  assert.deepEqual(r.received,[discarded('d-old'),OP.create,discarded('draft-1')]);
});

test('the sweep\'s delete removes exactly the named draft, and reports one that\'s already gone',async t=>{
  const del=draftId=>({context,page,respond,timing})=>discardDraft({context,page,plan,draftId,respond,timing});
  const r=await run(t,{appOptions:{existing:['d-old','someone-elses']},task:del('d-old')});if(!r)return;
  assert.deepEqual(r.report,{deleted:true,draftId:'d-old'});
  assert.deepEqual(r.received,[discarded('d-old')]);
  const gone=await run(t,{appOptions:{existing:['someone-elses']},task:del('d-old')});
  assert.deepEqual(gone.report,{deleted:false,absent:true,draftId:'d-old'});
  assert.deepEqual(gone.received,[]);
});
