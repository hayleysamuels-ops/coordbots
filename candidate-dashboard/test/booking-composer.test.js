'use strict';
// The booking dry run's fail-closed paths (worker/booking-composer.js), in a
// real browser against a small stand-in for Ashby's app, served at Ashby's
// address and navigated in-app as the real one is. A stand-in also answers
// permitted writes, so nothing reaches Ashby. These test the safeguards, not
// Ashby's markup; that's only known from a live run.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {dryRun}=require('../worker/booking-composer');
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
// `zone` gives the composer one session's fields and a time-zone button with
// that label ('' for no button).
function app({menu=['Send Direct Booking Link','Request Candidate Availability','Manual Schedule','View All Scheduling Options'],dialogAfterManual=null,strayWrite=null,submitted=false,zone=null}={}){
  return `<!doctype html><html><body><nav><a href="/candidates/pipeline">Pipeline</a></nav><main id="m"></main><script>
  let deleted=false;
  const gql=(name,variables)=>fetch('/api/graphql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationName:name,query:'mutation '+name+' { x }',variables})}).then(r=>r.json());
  // Like Ashby, every page loads something: one read query, answered by the stand-in.
  function render(){fetch('/api/graphql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationName:'ApiLoad',query:'query ApiLoad { x }'})});
    const p=location.pathname,m=document.getElementById('m');m.innerHTML='';
    if(p.endsWith('/feed')){
      m.innerHTML='<div role="dialog" aria-labelledby="cn"><h2 id="cn">TEST</h2><p>t@example.com</p><section><h2>Initial Screen Interview Schedule</h2>'+(${JSON.stringify(submitted)}?'<button id="sched">Schedule</button><button id="start">Start Manual Schedule</button>':'<button id="act">Actions</button>')+'</section></div>';
      const create=async()=>{const r=await gql('${OP.create}',{interviewScheduleId:'sched-1'});history.pushState({},'','/schedules/drafts/'+r.data.draftInterviewSchedule.id);render();};
      if(${JSON.stringify(submitted)}){document.getElementById('sched').onclick=()=>gql('ApiScheduleCandidateAutomatically',{interviewScheduleId:'sched-1'}).catch(()=>{});document.getElementById('start').onclick=create;return;}
      document.getElementById('act').onclick=()=>{const u=document.createElement('div');u.setAttribute('role','menu');u.setAttribute('aria-label','Actions');
        u.innerHTML=${JSON.stringify(menu)}.map(t=>'<div role="menuitem" tabindex="0">'+t+'</div>').join('');document.body.appendChild(u);
        u.querySelectorAll('[role=menuitem]').forEach(i=>i.onclick=async()=>{u.remove();
          if(${JSON.stringify(strayWrite)}&&i.textContent===${JSON.stringify(strayWrite&&strayWrite.item)})gql(${JSON.stringify(strayWrite&&strayWrite.op)},{interviewScheduleId:'sched-1'}).catch(()=>{});
          if(i.textContent==='Manual Schedule'){const r=await gql('${OP.create}',{interviewScheduleId:'sched-1'});
            history.pushState({},'','/schedules/drafts/'+r.data.draftInterviewSchedule.id);render();
            if(${JSON.stringify(dialogAfterManual)}){const d=document.createElement('div');d.setAttribute('role','alertdialog');d.innerHTML='<p>'+${JSON.stringify(dialogAfterManual)}+'</p><button>Confirm Anyway</button><button>Cancel</button>';document.body.appendChild(d);}}});};
    } else if(p.endsWith('/drafts')){
      m.innerHTML='<h2>Draft Schedules</h2>'+(deleted?'':'<div><a href="/schedules/drafts/draft-1">open</a><button id="del"></button></div>');
      const b=document.getElementById('del');if(b)b.onclick=async()=>{const r=await gql('${OP.discard}',{draftInterviewScheduleId:'draft-1'});if(r.data)deleted=true;};
    } else if(p.startsWith('/schedules/drafts/')){m.innerHTML='<h1>Scheduling TEST TEST Initial Screen Unsaved</h1>'+(${JSON.stringify(zone)}===null?'':
      (${JSON.stringify(zone)}?'<button aria-label="Select a timezone">'+${JSON.stringify(zone)}+'</button>':'')+'<input aria-label="Set interview date..."><input role="combobox" aria-label="Start..."><input role="combobox" aria-label="End...">');}
  }
  addEventListener('popstate',render);render();
  </script></body></html>`;
}

async function run(t,{appOptions,baseline}={}){
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
  const respond=async route=>{const b=JSON.parse(route.request().postData());received.push(b.operationName);
    if(b.operationName===OP.create)return {status:200,json:{data:{draftInterviewSchedule:{id:'draft-1',draftSchedule:{events:[baseline||{id:'ev-1',title:'Initial',startTimeISO:'2099-10-12T17:00:00.000Z',endTimeISO:'2099-10-12T17:30:00.000Z',interviewId:'int-1',interviewSlots:[{selected:'u-m'}]}]}}}}};
    return {status:200,json:{data:{id:'x'}}};};
  const page=await context.newPage();
  const report=await dryRun({context,page,plan,respond,timing:{settle:200,short:300,wait:3000}});
  return {report,received};
}

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
  assert.deepEqual(r.received,[OP.create,OP.discard]);
});

test('"The interview time is in the past" is never confirmed: the run stops and the draft is deleted',async t=>{
  const r=await run(t,{appOptions:{dialogAfterManual:'Heads up: The interview time is in the past.'}});if(!r)return;
  assert.equal(r.report.status,'refused');assert.match(r.report.reason,/never confirmed/);
  assert.deepEqual(r.report.cleanup,{deleted:true,draftId:'draft-1'});
  assert.deepEqual(r.received,[OP.create,OP.discard],'nothing was confirmed or saved');
});

test('a write the booking doesn\'t permit is blocked and stops the run',async t=>{
  // "Manual Schedule" is made to also send a booking-link email, as a neighbour would.
  const r=await run(t,{appOptions:{strayWrite:{item:'Manual Schedule',op:'ApiSendDirectBookingLink'}}});if(!r)return;
  assert.equal(r.report.status,'refused');assert.match(r.report.reason,/doesn't permit: POST \/api\/graphql mutation ApiSendDirectBookingLink/);
  assert.ok(!r.received.includes('ApiSendDirectBookingLink'),'it never reached the stand-in');
  assert.deepEqual(r.report.cleanup,{deleted:true,draftId:'draft-1'});
});

test('a composer in another time zone is refused, naming the zone it shows, and the draft is deleted',async t=>{
  for(const [zone,shown] of [['EDT','"EDT"'],['',"no time zone \\(there's no \"Select a timezone\" button\\)"]]){
    const r=await run(t,{appOptions:{zone}});if(!r)return;
    assert.equal(r.report.status,'refused');assert.equal(r.report.step,'compose session 1 ("Initial")');
    assert.match(r.report.reason,new RegExp(`^The composer shows times in ${shown}, not MDT; the account's time zone must match the plan's \\(America/Denver\\)\\.$`));
    assert.deepEqual(r.received,[OP.create,OP.discard],'nothing was saved');
  }
  // The plan's own zone passes the check; the bare stand-in then stops at the session editor.
  const r=await run(t,{appOptions:{zone:'MDT'}});if(!r)return;
  assert.match(r.report.reason,/Couldn't find the editor for session 1/);
});

test('availability submitted: starts from "Start Manual Schedule", never the bare "Schedule" beside it',async t=>{
  const r=await run(t,{appOptions:{submitted:true},baseline:{id:'ev-1',title:'Other',startTimeISO:'2099-10-12T17:00:00.000Z',endTimeISO:'2099-10-12T17:30:00.000Z',interviewId:'int-9',interviewSlots:[{selected:null}]}});if(!r)return;
  // The mismatched draft stops the run right after creation, which is all this needs.
  assert.ok(r.report.checks.some(c=>c.name==='started from "Start Manual Schedule" (availability submitted)'));
  assert.deepEqual(r.received,[OP.create,OP.discard],'only the create and the cleanup reached the stand-in');
  assert.ok(!r.report.blocked.some(b=>/ApiScheduleCandidateAutomatically/.test(b)),'the bare "Schedule" was never clicked');
});
