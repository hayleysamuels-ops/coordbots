"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  let credentials = null, state = null, selected = null, busy = false, sessionVersion = 0;
  async function api(path = "", body) {
    const response = await fetch('/api/scheduling-booking' + path, {method:body === undefined ? 'GET':'POST',headers:{'X-Coordinator-Authorization':credentials,'Content-Type':'application/json','X-Scheduling-Request':'1'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    const data = await response.json(); if (!response.ok) throw Error(data.error || 'Booking request failed'); return data;
  }
  // Multi-second remote calls show progress in the control that started them
  // (docs/DESIGN.md § Loading): the label becomes the active verb, a spinner
  // shows (CSS, on aria-busy), and the button stays disabled. A button that
  // didn't start the call (an automatic reload) is only disabled.
  const BUSY_LABELS = {refresh:'Refreshing…','load-application':'Loading candidate…','load-plan':'Loading plan…','reload-full-plan':'Refreshing plan…','reload-availability':'Refreshing availability…','suggest-full':'Preparing agenda…','suggest-calendar':'Checking calendars…','read-google-calendars':'Reading calendars…','inspect-full-calendar':'Checking calendars…','check-details':'Checking details…','inspect-draft':'Reading draft…','inspect-calendar':'Checking calendars…','prepare-button':'Preparing draft…',send:'Sending…'};
  function busyStart(el, label) {
    el = typeof el === 'string' ? $(el) : el; el.disabled = true;
    label = label || BUSY_LABELS[el.id];
    if (label && !el.hasAttribute('aria-busy')) { el.dataset.idleLabel = el.textContent; el.textContent = label; el.setAttribute('aria-busy', 'true'); }
  }
  // `enable` false leaves disabled to the caller (e.g. a Post button that stays
  // disabled once it has posted).
  function busyEnd(el, enable = true) {
    el = typeof el === 'string' ? $(el) : el;
    if (el.hasAttribute('aria-busy')) { el.textContent = el.dataset.idleLabel; delete el.dataset.idleLabel; el.removeAttribute('aria-busy'); }
    if (enable) el.disabled = false;
  }
  // Counted, so overlapping calls (a click during an automatic load) don't
  // re-enable a button another request still holds. applyAvailabilityMode()
  // then restores the buttons that the availability source disables.
  const inFlight = new Map();
  async function whileBusy(ids, work, showProgress = false) {
    for (const id of ids) { const n = (inFlight.get(id) || 0) + 1; inFlight.set(id, n); if (n === 1) { if (showProgress) busyStart(id); else $(id).disabled = true; } }
    try { return await work(); }
    finally { for (const id of ids) { const n = inFlight.get(id) - 1; inFlight.set(id, n); if (!n) busyEnd(id); } applyAvailabilityMode(); }
  }
  const labels = {draft:'Ready for review',approved:'Approved; waiting for execution',checking:'Rechecking availability',submitting:'Sending — do not retry',scheduled:'Scheduled; sending confirmed',reconciliation_required:'Check Ashby before any retry',needs_review:'Changed — prepare a new draft',rejected:'Rejected'};
  function summary(row) {
    const p = row.plan, email = p.communications?.confirmation;
    const fmt = v => new Intl.DateTimeFormat('en-US',{timeZone:p.timezone || 'UTC',dateStyle:'full',timeStyle:'short'}).format(new Date(v));
    return `<h3>${esc(p.candidateName || p.candidateEmail)}</h3><p>${esc(p.jobTitle)} · ${esc(p.timezone || 'UTC')}</p><table><thead><tr><th>Interview</th><th>Time</th><th>Interviewers</th></tr></thead><tbody>${p.events.map(e=>`<tr><td>${esc(e.title)}</td><td>${esc(fmt(e.start))}<br>to ${esc(fmt(e.end))}</td><td>${e.interviewers.map(i=>esc(i.email)).join('<br>')}</td></tr>`).join('')}</tbody></table>${p.events.map(e=>`<p><strong>${esc(e.title)} invitations:</strong> ${e.notify.map(esc).join(', ')}<br>Location: ${esc(e.location)} · ${esc(({google_meet:'Google Meet',zoom:'Zoom',none:'No video link'})[e.conferencing.provider] || e.conferencing.provider)}</p>`).join('')}${email ? `<h4>Candidate confirmation email</h4><p>From: ${esc(email.from)}<br>To: ${esc(email.to)}<br>CC: ${email.cc.map(esc).join(', ') || 'None'}<br>BCC: ${email.bcc.map(esc).join(', ') || 'None'}</p><p><strong>${esc(email.subject)}</strong></p><pre>${esc(email.body)}</pre>` : '<p>Confirmation email has not been prepared.</p>'}`;
  }
  function render() {
    $('identity').textContent = `Coordinator: ${state.coordinator}`;
    $('message').textContent = state.capabilities.available ? 'Ashby connection ready. Drafts do not send anything until you approve.' : state.capabilities.reason;
    $('prepare-button').disabled = !state.capabilities.available;
    $('drafts').innerHTML = state.drafts.length ? state.drafts.slice().reverse().map(row=>`<article><p><strong>${esc(labels[row.state] || row.state)}</strong> · Revision ${row.revision}</p>${summary(row)}${row.issue?`<p role="alert">${esc(row.issue)}</p>`:''}${row.state === 'draft'?`<button data-approve="${esc(row.id)}" ${state.capabilities.available?'':'disabled'}>Review and approve booking</button><button data-reject="${esc(row.id)}">Reject draft</button>`:''}${row.receipt?.scheduleId?`<a target="_blank" rel="noopener" href="https://app.ashbyhq.com/schedules/${encodeURIComponent(row.receipt.scheduleId)}">View in Ashby</a>`:''}</article>`).join(''):'<p>No booking drafts yet. Slack discussion drafts remain on the dashboard.</p>';
  }
  async function refresh(){state=await api();render();}
  $('login').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,signIn=form.querySelector('button');if(signIn.disabled)return;busyStart(signIn,'Signing in…');credentials='Basic '+btoa(unescape(encodeURIComponent(form.username.value+':'+form.password.value)));try{await refresh();form.password.value='';form.hidden=true;$('workspace').hidden=false;const r=await fetch('/api/issues');if(!r.ok)throw Error('Candidate list unavailable');const snapshot=await r.json();const rows=[...new Map((snapshot.readyToSchedule||[]).filter(c=>c?.applicationId&&c.status==='Active').map(c=>[c.applicationId,c])).values()];$('prepare').applicationId.innerHTML='<option value="">Select candidate</option>'+rows.map(c=>`<option value="${esc(c.applicationId)}">${esc(c.candidateName)} · ${esc(c.jobTitle)}</option>`).join('');const target=new URLSearchParams(location.search).get('applicationId');if(target&&rows.some(c=>c.applicationId===target)){$('prepare').applicationId.value=target;$('prepare').closest('details').open=true;await $('load-plan').onclick();}}catch(err){credentials=null;form.hidden=false;$('workspace').hidden=true;$('message').textContent=err.message;}finally{busyEnd(signIn);}};
  $('logout').onclick=()=>{sessionVersion++;clearFullPlan();$('source-details').textContent='';$('windows').replaceChildren();$('availability-status').textContent='';$('prepare').availabilitySource.value='ashby';applyAvailabilityMode();$('calendar-preview').replaceChildren();$('ashby-preview').replaceChildren();credentials=null;state=null;selected=null;$('approval').close();$('drafts').replaceChildren();$('workspace').hidden=true;$('login').hidden=false;$('message').textContent='Signed out.';};
  $('refresh').onclick=()=>whileBusy(['refresh'],refresh,true).catch(e=>$('message').textContent=e.message);
  $('load-application').onclick=async()=>{
    const version=sessionVersion;
    try {
      const url=new URL($('prepare').applicationUrl.value),match=url.pathname.match(/\/applications\/([a-f0-9-]{36})(?:\/|$)/i);
      if(url.origin!=='https://app.ashbyhq.com'||url.username||url.password||!match)throw Error('Use the candidate’s Ashby link with an application selected.');
      busyStart('load-application');const data=await api('/application',{applicationId:match[1]});
      if(version!==sessionVersion||!credentials)return;
      $('calendar-preview').replaceChildren();const select=$('prepare').applicationId;let option=[...select.options].find(o=>o.value===data.applicationId);
      if(!option){option=document.createElement('option');option.value=data.applicationId;select.append(option);}
      option.textContent=`${data.candidateName} · ${data.jobTitle}`;select.value=data.applicationId;
      $('prepare').interviewId.innerHTML=data.activities.flatMap(a=>a.sessions.map(s=>`<option value="${esc(s.interviewId)}">${esc(a.title)}: ${esc(s.title)} (${s.durationMinutes} min)</option>`)).join('');
      $('source-details').textContent=data.activities.length?'Candidate and current interview plan loaded from Ashby.':'This stage has no schedulable interviews.';$('ashby-preview').replaceChildren();await loadAvailabilityRequests();
    }catch(err){if(version===sessionVersion)$('source-details').textContent=err.message;}finally{busyEnd('load-application');}
  };
  $('load-plan').onclick=()=>whileBusy(['load-plan'],async()=>{try{const id=$('prepare').applicationId.value;if(!id)throw Error('Choose a candidate.');$('full-plan-status').textContent='Reading the interview plan from Ashby…';const response=await fetch('/api/scheduling-review/template/'+encodeURIComponent(id));const data=await response.json();if(!response.ok)throw Error(data.error);$('prepare').interviewId.innerHTML=data.activities.flatMap(a=>a.sessions.map(s=>`<option value="${esc(s.interviewId)}">${esc(a.title)}: ${esc(s.title)} (${s.durationMinutes} min)</option>`)).join('');await loadAvailabilityRequests();}catch(e){$('message').textContent=e.message;}},true);
  $('prepare').applicationId.onchange=async()=>{$('prepare').interviewId.innerHTML='<option value="">Load a plan first</option>';clearAvailability();await $('load-plan').onclick();};
  let fullPlanVersion=0;
  function clearFullPlan(){fullPlanVersion++;$('full-plan').replaceChildren();$('full-suggestions').replaceChildren();$('full-calendar-preview').replaceChildren();$('google-calendar-preview').replaceChildren();$('full-plan-status').textContent='Load the full plan for this availability request.';}
  const loadFullPlan=e=>whileBusy(['reload-full-plan'],loadFullPlanNow,e instanceof Event);
  async function loadFullPlanNow(){
    const f=$('prepare'),applicationId=f.applicationId.value,scheduleId=f.scheduleId.value,version=++fullPlanVersion,session=sessionVersion;
    $('full-plan').replaceChildren();$('full-suggestions').replaceChildren();$('full-calendar-preview').replaceChildren();$('google-calendar-preview').replaceChildren();
    if(!scheduleId){$('full-plan-status').textContent='Choose a pending request to load its full interview template.';return;}
    $('full-plan-status').textContent='Reading all interviews and eligible interviewers from Ashby…';
    try{const plan=await api('/full-plan',{applicationId,scheduleId});if(version!==fullPlanVersion||session!==sessionVersion||!credentials)return;
      const minutes=plan.sessions.reduce((n,s)=>n+s.durationMinutes,0);
      $('full-plan-status').textContent=`${plan.sessions.length} interviews · ${Math.floor(minutes/60)}h ${minutes%60}m · Interviewers from the linked Ashby template. Calendars have not been checked.`;
      $('full-plan').innerHTML='<table><thead><tr><th>Interview</th><th>Duration</th><th>Eligible interviewers</th></tr></thead><tbody>'+plan.sessions.map(s=>`<tr><td>${esc(s.title)}</td><td>${s.durationMinutes} min</td><td>${s.eligibleInterviewers.map(i=>esc(i.name)).join(', ')}${s.eligibleInterviewers.length>1?' (choose one)':' (fixed)'}</td></tr>`).join('')+'</tbody></table>';
    }catch(e){if(version===fullPlanVersion&&session===sessionVersion)$('full-plan-status').textContent=e.message;}
  }
  $('reload-full-plan').onclick=loadFullPlan;
  // Both previews render the same way. The calendar-checked one asks the server
  // to use interviewers' Google free/busy as a constraint (calendarCheck); the
  // flag travels with the request, so posting rebuilds the same kind of option.
  const preview=calendarCheck=>async()=>{
    const button=calendarCheck?'suggest-calendar':'suggest-full';
    const f=$('prepare'),request={...requestDetails(),...(calendarCheck?{calendarCheck:true}:{})},version=fullPlanVersion,session=sessionVersion;
    busyStart(button);$('full-suggestions').textContent='Preparing the entire agenda from the current Ashby template and candidate availability…';
    try{const result=await api('/suggest-full-schedule',request);const {calendarCheck:_,...plain}=request;if(version!==fullPlanVersion||session!==sessionVersion||!credentials||JSON.stringify(plain)!==JSON.stringify(requestDetails()))return;
      const fmt=value=>new Intl.DateTimeFormat('en-US',{timeZone:result.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
      const windowsLine=list=>list?.length?`<p>Start windows applied: ${[...new Map(list.map(w=>[w.title+w.earliestStart+w.latestStart+w.timezone,w])).values()].map(w=>`${esc(w.title)} starts ${esc(w.earliestStart)}–${esc(w.latestStart)} ${esc(w.timezone)}`).join('; ')}.</p>`:'';
      const cc=result.calendarCheck,checkedNote=cc?`<p>${result.status==='calendar_checked'?'Interviewers are free on their primary Google calendars':'Checked against primary Google calendars'}${result.calendarCheckedAt?' at '+esc(fmt(result.calendarCheckedAt)):''}. Meeting hours are assumed from client rules (${[...new Set(cc.meetingHours.map(h=>h.source==='override'?'individual overrides':`${h.start}–${h.end} ${h.timezone}`))].map(esc).join('; ')}), not verified.</p>${cc.excluded.length?`<p class="sched-warning">Excluded: ${cc.excluded.map(x=>esc(x.name)+' ('+esc(x.reason)+')').join('; ')}.</p>`:''}${windowsLine(cc.startWindowsApplied)}`:`${windowsLine(result.startWindowsApplied)}<p class="sched-warning">Not checked: ${(result.notChecked||['interviewer calendars']).map(esc).join(', ')}. Suggested interviewers are eligible choices, not confirmed available.</p>`;
      const variety=result.proposals.length>1?'<p class="sched-status-line">Each option differs from the others by day, by at least an hour, or by interviewer.</p>':'';
      $('full-suggestions').innerHTML=`<h2>${result.diagnosis?'No schedule fits':cc?'Calendar-checked schedule options':'Schedule options without calendar checks'}</h2><p>${esc(cc?result.reason.replace(' Meeting hours are assumed from client rules, not verified.',''):result.reason)}</p>${checkedNote}${result.diagnosis?diagnosisHtml(result.diagnosis):''}${typeof variety==='string'?variety:''}<p>Shown in ${esc(result.timezone)}. These options cannot send invitations. Posting one to Slack is for discussion only and books nothing.</p>`+result.proposals.map((p,i)=>`<article><h3>Option ${i+1}: ${esc(fmt(p.start))}</h3><p><button type="button" class="post-option" data-index="${i}" data-digest="${esc(p.optionDigest)}">Post to Slack for discussion</button> <span class="post-option-status" role="status"></span></p><table><thead><tr><th>Interview</th><th>Time</th><th>Suggested interviewer</th></tr></thead><tbody>${p.events.map(e=>`<tr><td>${esc(e.title)}</td><td>${esc(fmt(e.start))}–${esc(fmt(e.end))}</td><td>${esc(e.interviewer.name)}${cc?' <span class="muted">free</span>':''}<details><summary>Eligible alternatives</summary>${e.eligibleInterviewers.map(i=>esc(i.name)).join(', ')}</details></td></tr>`).join('')}</tbody></table></article>`).join('');
      suggestedRequest=request;
    }catch(e){if(version===fullPlanVersion&&session===sessionVersion)$('full-suggestions').textContent=e.message;}finally{busyEnd(button);}
  };
  // The no-fit report (full-calendar-schedule.js diagnose()): furthest reach
  // first, then at most two changes that would produce a fit, then one line per
  // interviewer at the blocking session. Placeholder hours are always labelled
  // as a data gap so they never read as a real conflict.
  function diagnosisHtml(d){
    const hours=c=>c.hoursSource==='default'?`the client's placeholder hours (${esc(c.hoursLabel)}), which aren't confirmed for them`:c.hoursSource==='verified'?'their verified meeting hours':`the hours set for them (${esc(c.hoursLabel)}), which are assumed`;
    const win=w=>`${esc(w.earliestStart)}–${esc(w.latestStart)} ${esc(w.timezone)}`;
    const change=c=>c.kind==='placement'?`<strong>Start window:</strong> ${esc(c.title)} must start ${c.windows.map(win).join(' and ')}, and that's what rules it out.${c.gapsZero?` With no gap allowed between sessions (0/0), the only way to meet it is moving the agenda's start time, so a non-zero maxGapMinutes would allow slack before it. ${c.fitsWithMaxGapMinutes?`Allowing up to ${c.fitsWithMaxGapMinutes} minutes between sessions would fit.`:'Even 120 minutes between sessions would not be enough on its own.'}`:''}`
      :c.kind==='hours'?(c.dataGap?`<strong>Data gap:</strong> enter ${esc(c.name)}'s real meeting hours. Every slot that would fit is outside ${hours(c)}.`:`<strong>Assumed hours:</strong> ${esc(c.name)} could take it outside ${hours(c)}.`)
      :c.kind==='busy'?`<strong>Busy time:</strong> ${esc(c.name)}'s primary calendar is busy at every slot that would otherwise fit. If some of it is a hold that can be booked over, it could work; that isn't supported yet.`
      :`<strong>Interview limit:</strong> ${esc(c.name)}'s Ashby limit rules it out.`;
    const unblock=d.unblock.map(u=>u.kind==='availability'?`<li>${esc(u.text)}</li>`:u.kind==='combination'?`<li>Only both changes together would fit:<ul>${u.changes.map(c=>`<li>${change(c)}</li>`).join('')}</ul></li>`:`<li>${change(u.changes[0])}</li>`).join('');
    const why=x=>x.reason==='placement'?'never reached: no start inside the session\'s start window':x.reason==='hours'?`outside ${x.hoursSource==='default'?'placeholder hours, not confirmed for them':x.hoursSource==='verified'?'verified meeting hours':'assumed hours set for them'}`:x.reason==='busy'?'busy on their primary calendar':x.reason==='limits'?'Ashby interview limit':'no slot left once earlier sessions are placed';
    const f=d.furthest,c=d.conflicts;
    return `<p><strong>Furthest reach:</strong> ${f.placed} of ${f.of} sessions placed in order${f.blockedAt?`; every path stopped at ${esc(f.blockedAt.title)}`:''}.</p>`
      +`<h3>What would unblock it</h3>${unblock?`<ul>${unblock}</ul>`:'<p>No single change, or pair of changes, to one interviewer\'s hours, busy time or limit produces a fit. More candidate availability or other interviewers would be needed.</p>'}`
      +(f.blockedAt?`<h3>At ${esc(f.blockedAt.title)}</h3><ul>${d.atBlocked.map(x=>`<li>${esc(x.name)}: ${why(x)}${x.hoursSource==='default'&&x.reason==='hours'?' <span class="sched-warning">data gap</span>':''}</li>`).join('')}</ul>`:'')
      +(d.blockedPlacement?`<p>${esc(d.blockedPlacement.title)} must start ${d.blockedPlacement.windows.map(win).join(' and ')}; ${d.blockedPlacement.rejectedStarts} candidate start${d.blockedPlacement.rejectedStarts===1?' was':'s were'} outside it.</p>`:'')
      +`<p class="sched-status-line">Rejected slots: busy time ${c.busy} · outside placeholder hours ${c.hours.default} · outside hours set per person ${c.hours.override+c.hours.assumed} · outside verified hours ${c.hours.verified} · limits ${c.limits} · outside a start window ${c.placement||0}</p>`;
  }
  $('suggest-full').onclick=preview(false);
  $('suggest-calendar').onclick=preview(true);
  // Every Post button is disabled while one post is in flight, and a posted
  // option's button stays disabled, so a double-click sends one request. The
  // server's claim-before-posting and per-option check are the real guard.
  let suggestedRequest=null;
  $('full-suggestions').addEventListener('click',async e=>{
    const button=e.target.closest('.post-option');if(!button||button.disabled||!suggestedRequest)return;
    const status=button.parentElement.querySelector('.post-option-status'),buttons=[...$('full-suggestions').querySelectorAll('.post-option')],session=sessionVersion;
    const {calendarCheck:_,...sameForm}=suggestedRequest;
    if(JSON.stringify(sameForm)!==JSON.stringify(requestDetails())){status.textContent='The request changed. Suggest the full schedule again.';return;}
    for(const b of buttons)b.disabled=true;busyStart(button,'Posting…');status.textContent='Rechecking Ashby and posting…';
    let posted=false;
    try{const r=await api('/post-full-schedule-option',{...suggestedRequest,optionIndex:Number(button.dataset.index),optionDigest:button.dataset.digest});busyEnd(button,false);if(session!==sessionVersion)return;
      posted=true;button.textContent=r.state==='shared'?'Posted':'Check Slack';
      status.textContent=r.state==='shared'?`Posted to ${r.channelName} for discussion. Nothing was booked.`:`Slack didn’t confirm delivery. Check ${r.channelName} before trying again. This candidate can’t get another post until the draft is reconciled.`;
    }catch(err){busyEnd(button,false);if(session===sessionVersion)status.textContent=err.message;}
    finally{for(const b of buttons)if(!(b===button&&posted)&&b.textContent==='Post to Slack for discussion')b.disabled=false;}
  });
  function clearAvailability(){clearFullPlan();$('windows').replaceChildren();$('calendar-preview').replaceChildren();$('availability-status').textContent='';$('prepare').scheduleId.innerHTML='<option value="">Loading requests…</option>';}
  function applyAvailabilityMode(){const imported=$('prepare').availabilitySource.value==='ashby';$('add-window').disabled=imported;for(const el of $('windows').querySelectorAll('input'))el.readOnly=imported;for(const el of $('windows').querySelectorAll('button'))el.disabled=imported;$('prepare').timezone.disabled=imported;$('prepare').scheduleId.disabled=!imported;$('reload-availability').disabled=!imported;}
  const importAvailability=e=>$('prepare').availabilitySource.value==='ashby'?whileBusy(['reload-availability'],importAvailabilityNow,e instanceof Event):importAvailabilityNow();
  async function importAvailabilityNow(){
    const f=$('prepare'),applicationId=f.applicationId.value,scheduleId=f.scheduleId.value,version=sessionVersion;
    if(f.availabilitySource.value!=='ashby')return;
    $('windows').replaceChildren();$('calendar-preview').replaceChildren();$('full-suggestions').replaceChildren();$('full-calendar-preview').replaceChildren();$('google-calendar-preview').replaceChildren();
    if(!scheduleId){$('availability-status').textContent='Choose a pending request to import its availability.';return;}
    $('availability-status').textContent='Reading the candidate’s submitted availability…';
    try{const data=await api('/availability',{applicationId,scheduleId});if(version!==sessionVersion||!credentials||applicationId!==f.applicationId.value||scheduleId!==f.scheduleId.value||f.availabilitySource.value!=='ashby')return;
      if(![...f.timezone.options].some(o=>o.value===data.timezone)){const option=document.createElement('option');option.value=option.textContent=data.timezone;f.timezone.append(option);}f.timezone.value=data.timezone;
      for(const w of data.localWindows)addWindow(w);
      $('availability-status').textContent=data.localWindows.length?`Imported ${data.localWindows.length} submitted windows from Ashby (${data.timezone}).`:'No future availability was found in the checked range.';
      if(data.scope)$('availability-status').textContent+=' Checked '+data.scope.start+' through '+data.scope.end+'.';
      if(data.expiredCount)$('availability-status').textContent+=` ${data.expiredCount} elapsed windows omitted.`;
      if(data.notes)$('availability-status').textContent+=' Candidate note: '+data.notes;
      applyAvailabilityMode();
    }catch(e){if(version===sessionVersion&&applicationId===f.applicationId.value&&scheduleId===f.scheduleId.value)$('availability-status').textContent=e.message;}
  }
  async function loadAvailabilityRequests(){
    const f=$('prepare'),applicationId=f.applicationId.value,version=sessionVersion;
    if(!applicationId)return;clearAvailability();$('availability-status').textContent='Reading availability requests from Ashby…';
    try{const data=await api('/availability-requests',{applicationId});if(version!==sessionVersion||!credentials||applicationId!==f.applicationId.value)return;
      f.scheduleId.innerHTML='<option value="">Select availability request</option>'+data.requests.map(r=>`<option value="${esc(r.scheduleId)}">Updated ${esc(new Date(r.updatedAt).toLocaleString())} · ${esc(r.scheduleId.slice(0,8))}</option>`).join('');
      const target=new URLSearchParams(location.search).get('scheduleId');
      if(data.requests.some(r=>r.scheduleId===target))f.scheduleId.value=target;else if(data.requests.length===1)f.scheduleId.value=data.requests[0].scheduleId;
      if(f.availabilitySource.value==='ashby'){if(data.requests.length)await importAvailability();else $('availability-status').textContent='No current submitted-availability request. Use coordinator entry for times shared outside Ashby.';}else addWindow();
      applyAvailabilityMode();await loadFullPlan();
    }catch(e){if(version===sessionVersion&&applicationId===f.applicationId.value)$('availability-status').textContent=e.message;}
  }
  $('reload-availability').onclick=importAvailability;
  $('prepare').scheduleId.onchange=async()=>{clearFullPlan();await importAvailability();await loadFullPlan();};
  $('prepare').availabilitySource.onchange=async()=>{$('full-suggestions').replaceChildren();$('full-calendar-preview').replaceChildren();$('google-calendar-preview').replaceChildren();$('calendar-preview').replaceChildren();if($('prepare').availabilitySource.value==='ashby')await importAvailability();else {if(!$('windows').children.length)addWindow();$('availability-status').textContent='Coordinator-entered availability. These times are not a verified Ashby submission.';}applyAvailabilityMode();};

  function addWindow(values){const field=document.createElement('fieldset');field.innerHTML='<legend>Candidate availability</legend><label>From<input name="start" type="datetime-local" required></label><label>Until<input name="end" type="datetime-local" required></label><button type="button">Remove window</button>';field.querySelector('button').onclick=()=>{field.remove();$('full-suggestions').replaceChildren();$('full-calendar-preview').replaceChildren();$('google-calendar-preview').replaceChildren();$('calendar-preview').replaceChildren();};if(values?.start){field.querySelector('[name=start]').value=values.start;field.querySelector('[name=end]').value=values.end;}$('windows').append(field);}
  $('add-window').onclick=()=>addWindow();applyAvailabilityMode();
  function addWorkingWindow(){const field=document.createElement('fieldset');field.innerHTML='<legend>Allowed working hours</legend><label>From<input name="workingStart" type="datetime-local"></label><label>Until<input name="workingEnd" type="datetime-local"></label><button type="button">Remove working hours</button>';field.querySelector('button').onclick=()=>{field.remove();$('full-suggestions').replaceChildren();$('full-calendar-preview').replaceChildren();$('google-calendar-preview').replaceChildren();$('calendar-preview').replaceChildren();};$('working-windows').append(field);}
  $('add-working-window').onclick=addWorkingWindow;addWorkingWindow();
  function workingOverride(){const windows=[...$('working-windows').children].map(w=>({start:w.querySelector('[name=workingStart]').value,end:w.querySelector('[name=workingEnd]').value})).filter(w=>w.start||w.end);return windows.length?{timezone:$('prepare').workingTimezone.value,windows}:null;}

  function requestDetails(){const f=$('prepare');return {applicationId:f.applicationId.value,interviewId:f.interviewId.value,interviewerEmail:f.interviewerEmail.value,availabilitySource:f.availabilitySource.value,scheduleId:f.scheduleId.value,timezone:f.timezone.value,windows:[...$('windows').children].map(w=>({start:w.querySelector('[name=start]').value,end:w.querySelector('[name=end]').value}))};}
  $('prepare').addEventListener('input',()=>{$('full-suggestions').replaceChildren();$('full-calendar-preview').replaceChildren();$('google-calendar-preview').replaceChildren();$('source-details').textContent='';$('calendar-preview').replaceChildren();});
  $('check-details').onclick=async()=>{
    if(!$('prepare').reportValidity())return;
    const request=requestDetails(),version=sessionVersion;busyStart('check-details');
    try{const facts=await api('/details',request);if(version!==sessionVersion||!credentials||JSON.stringify(request)!==JSON.stringify(requestDetails()))return;
      $('source-details').textContent=`Verified in Ashby: ${facts.candidateName} (${facts.candidateEmail}), ${facts.title}, ${facts.durationMinutes} minutes, with ${facts.interviewer.name} (${facts.interviewer.email}). Interviewer limits: ${facts.interviewerLimits.dailyLimit??'no configured'} daily; ${facts.interviewerLimits.weeklyLimit??'no configured'} weekly. Calendar availability has not been checked. Nothing has been scheduled or sent.`;
    }catch(err){if(version===sessionVersion&&credentials)$('source-details').textContent=err.message;}finally{busyEnd('check-details');}
  };
  $('read-google-calendars').onclick=async()=>{
    const f=$('prepare'),version=sessionVersion,planVersion=fullPlanVersion,request={applicationId:f.applicationId.value,scheduleId:f.scheduleId.value,availabilitySource:f.availabilitySource.value},output=$('google-calendar-preview');
    busyStart('read-google-calendars');output.textContent='Reading primary-calendar busy times for the interview plan…';
    try{if(request.availabilitySource!=='ashby')throw Error('Choose the candidate’s submitted Ashby availability for this calendar check.');const r=await api('/calendar-availability',request);if(version!==sessionVersion||planVersion!==fullPlanVersion||!credentials||request.applicationId!==f.applicationId.value||request.scheduleId!==f.scheduleId.value||request.availabilitySource!==f.availabilitySource.value)return;
      const fmt=v=>new Intl.DateTimeFormat('en-US',{timeZone:r.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(v));
      output.innerHTML='<p>'+esc(r.reason)+'</p><p>Shown in '+esc(r.timezone)+'.</p>'+r.calendars.map(c=>`<details><summary>${esc(c.name)} — ${c.busy.length} busy intervals</summary><p>Checked ${esc(fmt(c.checkedAt))}</p><ul>${c.busy.map(b=>`<li>${esc(fmt(b.start))}–${esc(fmt(b.end))}</li>`).join('')||'<li>No busy intervals returned for this primary calendar in the checked range.</li>'}</ul></details>`).join('');
    }catch(e){if(version===sessionVersion&&planVersion===fullPlanVersion)output.textContent=e.message;}finally{busyEnd('read-google-calendars');}
  };
  $('inspect-full-calendar').onclick=async()=>{
    const f=$('prepare'),version=sessionVersion,planVersion=fullPlanVersion,draftUrl=f.fullDraftUrl.value;
    const request={applicationId:f.applicationId.value,scheduleId:f.scheduleId.value},output=$('full-calendar-preview');
    try{
      const url=new URL(draftUrl),match=url.pathname.match(/^\/schedules\/drafts\/([a-f0-9-]{36})\/?$/i);
      if(url.origin!=='https://app.ashbyhq.com'||url.username||url.password||url.search||url.hash||!match)throw Error('Enter the root URL of an unsent Ashby draft.');
      busyStart('inspect-full-calendar');output.textContent='Reading each interview’s calendar assessment from Ashby…';
      const result=await api('/inspect-full-calendar',{...request,draftId:match[1]});
      if(version!==sessionVersion||planVersion!==fullPlanVersion||!credentials||draftUrl!==f.fullDraftUrl.value||request.applicationId!==f.applicationId.value||request.scheduleId!==f.scheduleId.value)return;
      output.innerHTML='<p>'+esc(result.reason)+'</p>'+result.events.map(e=>`<article><h3>${esc(e.title)}</h3><p>${esc(e.date)} · ${esc(e.start)}–${esc(e.end)} (draft display time)</p><ul>${e.interviewers.map(i=>`<li><strong>${esc(i.name)} — ${i.status==='conflict'?'Conflict':'Not verified'}</strong>: ${esc(i.reason)}</li>`).join('')}</ul></article>`).join('');
    }catch(e){if(version===sessionVersion&&planVersion===fullPlanVersion&&draftUrl===f.fullDraftUrl.value)output.textContent=e.message;}finally{busyEnd('inspect-full-calendar');}
  };
  $('inspect-draft').onclick=async()=>{
    if(!$('prepare').reportValidity())return;
    const request=requestDetails(),version=sessionVersion;
    try {
      const url=new URL($('prepare').draftUrl.value);
      const match=url.pathname.match(/^\/schedules\/drafts\/([a-f0-9-]{36})(?:\/communication(?:\/[a-z-]+)?)?\/?$/i);
      if(url.origin!=='https://app.ashbyhq.com'||url.username||url.password||url.search||url.hash||!match)throw Error('Enter an Ashby draft URL.');
      busyStart('inspect-draft');$('ashby-preview').textContent='Reading the saved Ashby draft…';
      const result=await api('/inspect-draft',{...request,draftId:match[1]});
      if(version!==sessionVersion||!credentials||JSON.stringify(request)!==JSON.stringify(requestDetails()))return;
      const output=$('ashby-preview');output.replaceChildren();
      for(const [title,text] of [['Saved Ashby draft','Read-only preview. Nothing has been scheduled or sent.'],['Candidate calendar invitation',result.candidatePreview],['Interviewer calendar invitation',result.interviewerPreview],['Candidate confirmation email',result.confirmationPreview]]){const heading=document.createElement('h4'),body=document.createElement('pre');heading.textContent=title;body.textContent=text;output.append(heading,body);}
      const flags=document.createElement('p');flags.textContent=`Send candidate invite: ${result.candidateInvite?'On':'Off'} · Send interviewer invite: ${result.interviewerInvite?'On':'Off'} · Confirmation email: ${result.confirmationEnabled?'On':'Off'}. This read does not approve sending.`;output.append(flags);
    }catch(err){if(version===sessionVersion&&credentials)$('ashby-preview').textContent=err.message;}finally{busyEnd('inspect-draft');}
  };
  $('inspect-calendar').onclick=async()=>{
    if(!$('prepare').reportValidity())return;
    const request=requestDetails(),version=sessionVersion,output=$('calendar-preview'),draftUrl=$('prepare').draftUrl.value,workingHoursOverride=workingOverride();
    try{
      const url=new URL($('prepare').draftUrl.value),match=url.pathname.match(/^\/schedules\/drafts\/([a-f0-9-]{36})(?:\/communication(?:\/[a-z-]+)?)?\/?$/i);
      if(url.origin!=='https://app.ashbyhq.com'||url.username||url.password||url.search||url.hash||!match)throw Error('Enter the saved Ashby draft URL.');
      busyStart('inspect-calendar');output.textContent='Checking calendars across the candidate’s availability dates…';
      const result=await api('/inspect-calendar',{...request,draftId:match[1],workingHoursOverride});
      if(version!==sessionVersion||!credentials||draftUrl!==$('prepare').draftUrl.value||JSON.stringify(workingHoursOverride)!==JSON.stringify(workingOverride())||JSON.stringify(request)!==JSON.stringify(requestDetails()))return;
      const fmt=v=>new Intl.DateTimeFormat('en-US',{timeZone:request.timezone,month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(v));
      output.textContent=`${result.interviewer.name} · ${(result.dates||[result.date]).join(', ')} · Calendar timezone: ${result.timezone}\nObserved occupied times (shown in ${request.timezone}):\n`+result.observedBusy.map(b=>fmt(b.start)+' – '+fmt(b.end)).join('\n')+'\n'+result.issues.join(' ');
      if(result.workingHoursOverride)output.textContent+='\nWorking hours override entered by '+result.workingHoursOverride.enteredBy+': '+result.workingHoursOverride.windows.map(w=>fmt(w.start)+' – '+fmt(w.end)).join(', ')+'. Calendar conflicts and interview limits still apply.';
      if(result.suggestions){output.textContent+='\n\nTentative times — review required\n'+result.suggestions.reason;for(const slot of result.suggestions.slots)output.textContent+='\n'+fmt(slot.start)+' – '+fmt(slot.end);if(result.suggestions.slots.length)output.textContent+='\nStill to verify: '+result.suggestions.checks.join('; ')+'. These suggestions do not create or approve an Ashby booking.';}
      output.style.whiteSpace='pre-wrap';
    }catch(e){if(version===sessionVersion)output.textContent=e.message;}finally{busyEnd('inspect-calendar');}
  };
  $('prepare').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;busyStart('prepare-button');try{const f=e.currentTarget;await api('/drafts',{applicationId:f.applicationId.value,interviewId:f.interviewId.value,interviewerEmail:f.interviewerEmail.value,availabilitySource:f.availabilitySource.value,scheduleId:f.scheduleId.value,timezone:f.timezone.value,windows:[...$('windows').children].map(w=>({start:w.querySelector('[name=start]').value,end:w.querySelector('[name=end]').value}))});await refresh();}catch(err){$('message').textContent=err.message;}finally{busy=false;busyEnd('prepare-button');$('prepare-button').disabled=!state?.capabilities.available;}};
  $('drafts').onclick=async e=>{const approve=e.target.closest('[data-approve]'),reject=e.target.closest('[data-reject]');if(approve){selected=state.drafts.find(r=>r.id===approve.dataset.approve);$('approval-summary').innerHTML=summary(selected);$('approval').showModal();}if(reject){const row=state.drafts.find(r=>r.id===reject.dataset.reject);busyStart(reject,'Rejecting…');try{await api('/'+encodeURIComponent(row.id)+'/reject',{revision:row.revision,digest:row.digest});await refresh();}catch(err){$('message').textContent=err.message;busyEnd(reject);}}};
  $('cancel').onclick=()=>{$('approval').close();selected=null;};
  $('send').onclick=async()=>{if(busy||!selected)return;busy=true;busyStart('send');const row=selected;selected=null;try{await api('/'+encodeURIComponent(row.id)+'/approve',{revision:row.revision,digest:row.digest});$('approval').close();await refresh();}catch(err){$('approval').close();$('message').textContent=err.message+' Refresh status before taking further action.';}finally{busy=false;busyEnd('send');}};

  // Progressive disclosure (docs/DESIGN.md § Scheduling pages). Each step's
  // state is derived from what the page already shows — nothing here changes
  // the handlers above. The active step is the first incomplete one; earlier
  // steps collapse to a one-line summary with "Change"; later steps show only
  // their title until reachable. Step 5 is the output and never completes.
  (() => {
    const f = $('prepare'), cards = [...f.querySelectorAll('.sched-card[data-step]')];
    const chosen = select => select.value ? (select.selectedOptions[0]?.textContent.trim() || '') : '';
    const windowRows = () => [...$('windows').children].map(w => ({start: w.querySelector('[name=start]')?.value, end: w.querySelector('[name=end]')?.value}));
    const when = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? v : d.toLocaleString([], {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}); };
    const complete = {
      1: () => !!(f.applicationId.value && f.scheduleId.value),
      2: () => !!$('full-plan').querySelector('table'),
      3: () => f.availabilitySource.value === 'manual' || windowRows().length > 0,
      4: () => { const w = windowRows(); return w.length > 0 && w.every(r => r.start && r.end); },
    };
    const summary = {
      1: () => `${chosen(f.applicationId)} · ${chosen(f.scheduleId)}`,
      2: () => $('full-plan-status').textContent.split(' · ').slice(0, 2).join(' · '),
      3: () => `${chosen(f.availabilitySource)} · ${chosen(f.timezone)}`,
      4: () => { const w = windowRows(); return `${w.length} window${w.length === 1 ? '' : 's'} · first ${when(w[0].start)} – ${when(w[0].end)}`; },
    };
    let reopened = null, lastActive = null;
    // Only write what changed: the observer below watches this subtree.
    const set = (el, key, value) => { if (el[key] !== value) el[key] = value; };
    function update() {
      let active = 5;
      for (let n = 1; n <= 4; n++) if (!complete[n]()) { active = n; break; }
      if (active !== lastActive) { reopened = null; lastActive = active; }
      for (const card of cards) {
        const n = +card.dataset.step, state = n === active || n === reopened ? 'active' : n < active ? 'complete' : 'locked';
        if (card.dataset.state !== state) card.dataset.state = state;
        set(card.querySelector('.sched-step-summary'), 'textContent', n < active && summary[n] ? summary[n]() : '');
        const edit = card.querySelector('.sched-step-edit');
        if (edit) { set(edit, 'hidden', !(n < active)); set(edit, 'textContent', n === reopened ? 'Done' : 'Change'); if (edit.getAttribute('aria-expanded') !== String(state === 'active')) edit.setAttribute('aria-expanded', String(state === 'active')); }
      }
    }
    for (const card of cards) {
      const edit = card.querySelector('.sched-step-edit');
      if (edit) edit.onclick = () => { const n = +card.dataset.step; reopened = reopened === n ? null : n; update(); };
    }
    // Loads fill the plan table, windows and options asynchronously; selects
    // change by user input or by code, so watch both.
    new MutationObserver(update).observe(f, {subtree: true, childList: true, characterData: true});
    f.addEventListener('change', update); f.addEventListener('input', update);
    update();
  })();
})();
