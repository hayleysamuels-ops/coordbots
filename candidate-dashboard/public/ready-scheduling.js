'use strict';
(() => {
  const root=document.getElementById('ready-scheduling-cards');
  if(!root)return;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cache=new Map();let generation=0;
  window.renderReadyScheduling=async(rows,status)=>{
    const current=++generation;
    const note=document.getElementById('ready-scheduling-status');
    note.textContent=status?.lastError?'Refresh failed. These are the last known submissions; refresh before scheduling.':!status?.lastUpdated?'Loading availability submissions…':`${rows.length} awaiting scheduling · Last checked ${new Date(status.lastUpdated).toLocaleString()}`;
    root.replaceChildren();
    if(!rows.length){root.textContent=status?.lastUpdated?'No candidates with submitted availability in the current filters.':'';return;}
    const pending=rows.map(row=>{
      const card=document.createElement('article');card.className='scheduling-draft';
      card.innerHTML=`<h3>${esc(row.candidateName)} · ${esc(row.jobTitle)}</h3><p>Availability submitted${row.submittedAt?' · '+esc(new Date(row.submittedAt).toLocaleString()):''}</p><div class="ready-agenda">Loading current Ashby interview plan…</div><p class="muted">Suggested times pending: candidate availability, interviewer calendars and working hours still need to be connected. No invitations have been sent by this workflow.</p><p><a href="https://app.ashbyhq.com/schedules/${encodeURIComponent(row.scheduleId)}" target="_blank" rel="noopener">View availability in Ashby</a> · <a href="/booking.html?applicationId=${encodeURIComponent(row.applicationId)}">Open booking review</a></p>`;
      root.append(card);return {row,card};
    });
    async function worker(){while(pending.length&&generation===current){const {row,card}=pending.shift(),agenda=card.querySelector('.ready-agenda');
      if(!row.stageMatches){agenda.textContent='Stage changed or could not be verified. Review the pending schedule in Ashby before drafting.';continue;}
      if(status?.lastError){agenda.textContent='Refresh the scheduling data to load the current interview plan.';continue;}
      try{
        const key=row.applicationId+':'+row.currentStageId;let saved=cache.get(key);
        if(!saved||Date.now()-saved.at>60000){const r=await fetch('/api/scheduling-review/template/'+encodeURIComponent(row.applicationId));const plan=await r.json();if(!r.ok)throw Error(plan.error||'Could not load the interview plan.');saved={plan,at:Date.now()};cache.set(key,saved);}
        if(generation!==current)return;
        const p=saved.plan;if(p.stageId!==row.schedulingStageId)throw Error('The interview stage changed. Refresh before drafting.');
        agenda.innerHTML=`<h4>Interview agenda · ${esc(p.stageTitle)}</h4>`+(p.activities.length?p.activities.map(a=>`<p><strong>${esc(a.title)}</strong></p><ol>${a.sessions.map(s=>`<li>${esc(s.title)} · ${esc(s.durationMinutes)} minutes</li>`).join('')}</ol>`).join(''):'<p>No schedulable interviews in the current plan.</p>');
      }catch(e){if(generation===current)agenda.textContent=e.message;}
    }}
    await Promise.all([worker(),worker()]);
  };
})();
