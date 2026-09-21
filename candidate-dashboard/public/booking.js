"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  let credentials = null, state = null, selected = null, busy = false, sessionVersion = 0;
  async function api(path = "", body) {
    const response = await fetch('/api/scheduling-booking' + path, {method:body === undefined ? 'GET':'POST',headers:{'X-Coordinator-Authorization':credentials,'Content-Type':'application/json','X-Scheduling-Request':'1'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    const data = await response.json(); if (!response.ok) throw Error(data.error || 'Booking request failed'); return data;
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
  $('login').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget;credentials='Basic '+btoa(unescape(encodeURIComponent(form.username.value+':'+form.password.value)));try{await refresh();form.password.value='';form.hidden=true;$('workspace').hidden=false;const r=await fetch('/api/issues');if(!r.ok)throw Error('Candidate list unavailable');const snapshot=await r.json();const rows=[...new Map(Object.values(snapshot).filter(Array.isArray).flat().filter(c=>c?.applicationId&&c.status==='Active').map(c=>[c.applicationId,c])).values()];$('prepare').applicationId.innerHTML='<option value="">Select candidate</option>'+rows.map(c=>`<option value="${esc(c.applicationId)}">${esc(c.candidateName)} · ${esc(c.jobTitle)}</option>`).join('');}catch(err){credentials=null;form.hidden=false;$('workspace').hidden=true;$('message').textContent=err.message;}};
  $('logout').onclick=()=>{sessionVersion++;$('source-details').textContent='';credentials=null;state=null;selected=null;$('approval').close();$('drafts').replaceChildren();$('workspace').hidden=true;$('login').hidden=false;$('message').textContent='Signed out.';};
  $('refresh').onclick=()=>refresh().catch(e=>$('message').textContent=e.message);
  $('load-plan').onclick=async()=>{try{const id=$('prepare').applicationId.value;if(!id)throw Error('Choose a candidate.');const response=await fetch('/api/scheduling-review/template/'+encodeURIComponent(id));const data=await response.json();if(!response.ok)throw Error(data.error);$('prepare').interviewId.innerHTML=data.activities.flatMap(a=>a.sessions.map(s=>`<option value="${esc(s.interviewId)}">${esc(a.title)}: ${esc(s.title)} (${s.durationMinutes} min)</option>`)).join('');}catch(e){$('message').textContent=e.message;}};
  $('prepare').applicationId.onchange=()=>{$('prepare').interviewId.innerHTML='<option value="">Load a plan first</option>';};
  function addWindow(){const field=document.createElement('fieldset');field.innerHTML='<legend>Candidate availability</legend><label>From<input name="start" type="datetime-local" required></label><label>Until<input name="end" type="datetime-local" required></label><button type="button">Remove window</button>';field.querySelector('button').onclick=()=>field.remove();$('windows').append(field);}
  $('add-window').onclick=addWindow;addWindow();
  function requestDetails(){const f=$('prepare');return {applicationId:f.applicationId.value,interviewId:f.interviewId.value,interviewerEmail:f.interviewerEmail.value,timezone:f.timezone.value,windows:[...$('windows').children].map(w=>({start:w.querySelector('[name=start]').value,end:w.querySelector('[name=end]').value}))};}
  $('prepare').addEventListener('input',()=>{$('source-details').textContent='';});
  $('check-details').onclick=async()=>{
    if(!$('prepare').reportValidity())return;
    const request=requestDetails(),version=sessionVersion;$('check-details').disabled=true;
    try{const facts=await api('/details',request);if(version!==sessionVersion||!credentials||JSON.stringify(request)!==JSON.stringify(requestDetails()))return;
      $('source-details').textContent=`Verified in Ashby: ${facts.candidateName} (${facts.candidateEmail}), ${facts.title}, ${facts.durationMinutes} minutes, with ${facts.interviewer.name} (${facts.interviewer.email}). Calendar availability has not been checked. Nothing has been scheduled or sent.`;
    }catch(err){if(version===sessionVersion&&credentials)$('source-details').textContent=err.message;}finally{$('check-details').disabled=false;}
  };
  $('prepare').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;$('prepare-button').disabled=true;try{const f=e.currentTarget;await api('/drafts',{applicationId:f.applicationId.value,interviewId:f.interviewId.value,interviewerEmail:f.interviewerEmail.value,timezone:f.timezone.value,windows:[...$('windows').children].map(w=>({start:w.querySelector('[name=start]').value,end:w.querySelector('[name=end]').value}))});await refresh();}catch(err){$('message').textContent=err.message;}finally{busy=false;$('prepare-button').disabled=!state?.capabilities.available;}};
  $('drafts').onclick=async e=>{const approve=e.target.closest('[data-approve]'),reject=e.target.closest('[data-reject]');if(approve){selected=state.drafts.find(r=>r.id===approve.dataset.approve);$('approval-summary').innerHTML=summary(selected);$('approval').showModal();}if(reject){const row=state.drafts.find(r=>r.id===reject.dataset.reject);reject.disabled=true;try{await api('/'+encodeURIComponent(row.id)+'/reject',{revision:row.revision,digest:row.digest});await refresh();}catch(err){$('message').textContent=err.message;reject.disabled=false;}}};
  $('cancel').onclick=()=>{$('approval').close();selected=null;};
  $('send').onclick=async()=>{if(busy||!selected)return;busy=true;$('send').disabled=true;const row=selected;selected=null;try{await api('/'+encodeURIComponent(row.id)+'/approve',{revision:row.revision,digest:row.digest});$('approval').close();await refresh();}catch(err){$('approval').close();$('message').textContent=err.message+' Refresh status before taking further action.';}finally{busy=false;$('send').disabled=false;}};
})();
