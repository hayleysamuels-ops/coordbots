'use strict';
// Content checks for booking through Ashby's scheduling UI. Pure: no browser,
// no network. booking-permit.js runs checkSave on every ApiUpdateDraftSchedule
// before it may leave the browser; booking-composer.js runs the rest.
//
// The approved plan (from the Slack Schedule approval) looks like:
//   { candidate:{name,email}, job:{title}, stage:{title}, activityTitle,
//     interviewScheduleId, timeZone,
//     sessions:[{ title, interviewId, start, end, interviewers:[{userId,name,email}] }] }
// Every draft save carries the whole draft, so each one can be checked against
// that plan by content, not just by operation name.
const fail=(message,details)=>{throw Object.assign(Error(message),{status:409,details});};

// The interviewer a slot has selected. Ashby's shape for `selected` hasn't been
// seen with a value yet, so only these are accepted; anything else refuses.
function selectedId(selected){
  if(selected==null)return null;
  if(typeof selected==='string')return selected;
  if(typeof selected==='object'){const id=selected.id??selected.userId??selected.user?.id;if(typeof id==='string')return id;}
  return undefined;
}
const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort():[];
const instant=v=>{const t=Date.parse(v);return Number.isFinite(t)?t:NaN;};

// A draft as the checks see it: events in order, with times as instants and
// each slot's selected interviewer. `rest` holds every other field, so a save
// can be refused for changing something it had no reason to.
function normalizeDraft(draftSchedule){
  const events=draftSchedule?.events;
  if(!Array.isArray(events)||!events.length)fail('The draft has no events.');
  return events.map((e,i)=>{
    const slots=(e.interviewSlots||[]).map((s,j)=>{
      const id=selectedId(s?.selected);
      if(id===undefined)fail(`Event ${i+1}, slot ${j+1}: the selected interviewer is in a shape this check doesn't recognise (fields: ${keys(s.selected).join(', ')||typeof s.selected}).`);
      const {selected,alternates,...rest}=s||{};
      // Alternates: the people the slot could use. Picking someone narrows it
      // to them (seen October 13: [Mary, Hayley] → [Hayley]). IDs only.
      let alts=null;
      if(alternates!==undefined&&alternates!==null){
        if(!Array.isArray(alternates))fail(`Event ${i+1}, slot ${j+1}: alternates are in a shape this check doesn't recognise.`);
        alts=alternates.map(selectedId);
        if(alts.some(a=>typeof a!=='string'))fail(`Event ${i+1}, slot ${j+1}: an alternate is in a shape this check doesn't recognise.`);
        alts.sort();
      }
      return {selected:id,alternates:alts,rest};
    });
    const {id,title,startTimeISO,endTimeISO,interviewId,interviewSlots,__typename,...rest}=e;
    return {id,title,start:instant(startTimeISO),end:instant(endTimeISO),interviewId,slots,rest};
  });
}

// When the draft is created, its events must be the approved sessions: same
// count, same interviews, same titles, in the same order. Otherwise the
// template doesn't match what was approved, and nothing more happens.
function checkBaseline(events,plan){
  if(events.length!==plan.sessions.length)fail(`Ashby's draft has ${events.length} event${events.length===1?'':'s'}, but ${plan.sessions.length} session${plan.sessions.length===1?' was':'s were'} approved.`);
  events.forEach((e,i)=>{
    const s=plan.sessions[i];
    if(e.interviewId!==s.interviewId||e.title!==s.title)fail(`Ashby's draft event ${i+1} is "${e.title}", but the approved session ${i+1} is "${s.title}". The interview template doesn't match the approval.`);
    if(e.slots.length!==s.interviewers.length)fail(`"${s.title}" has ${e.slots.length} interviewer slot${e.slots.length===1?'':'s'} in Ashby, but ${s.interviewers.length} interviewer${s.interviewers.length===1?' was':'s were'} approved.`);
  });
}

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// A time as the composer edits it: the calendar date and the time of day, in
// the plan's time zone. Date and time are separate saves in Ashby, so between
// them the draft holds (say) the approved date at the old time.
function parts(ms,timeZone){
  if(!Number.isFinite(ms))return {date:'?',time:'?'};
  const f=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms));
  const g=t=>f.find(p=>p.type===t).value;
  return {date:`${g('year')}-${g('month')}-${g('day')}`,time:`${g('hour')}:${g('minute')}:${g('second')}`};
}
// One save may only move toward the approval: every tracked field is either
// unchanged from the last accepted state or equal to its approved value, no
// interviewer outside the approval is ever selected, and nothing else changes.
// Times are checked as two fields each, date and time of day. End may also be
// the one value Ashby derives itself: the new start plus the previous length.
// `prev` is the last accepted state; `compareRest` is false for the first save,
// whose previous state came from Ashby's create response (a different shape).
function checkSave(prev,next,plan,{compareRest=true}={}){
  const why=[];
  if(next.length!==prev.length)fail(`This save has ${next.length} events; the draft had ${prev.length}.`);
  next.forEach((e,i)=>{
    const p=prev[i],s=plan.sessions[i],label=`"${s.title}"`;
    if(e.id!==p.id)why.push(`${label}: the event ID changed`);
    if(e.title!==p.title)why.push(`${label}: the title changed to "${e.title}"`);
    if(e.interviewId!==p.interviewId&&e.interviewId!==s.interviewId)why.push(`${label}: the interview changed to one that wasn't approved`);
    const tz=plan.timeZone;
    for(const [field,approved] of [['start',instant(s.start)],['end',instant(s.end)]]){
      if(e[field]===p[field]||e[field]===approved)continue;
      if(field==='end'&&e.end-e.start===p.end-p.start&&e.start!==p.start)continue;// Ashby kept the length when start moved
      const now=parts(e[field],tz),was=parts(p[field],tz),want=parts(approved,tz);
      const bad=['date','time'].filter(k=>now[k]!==was[k]&&now[k]!==want[k]);
      if(!Number.isFinite(e[field])||bad.length)why.push(`${label}: the ${field} ${bad.join(' and ')||'time'} moved to ${Number.isFinite(e[field])?new Date(e[field]).toISOString():'an unreadable time'}, which is neither the previous nor the approved ${bad.join(' or ')||'time'}`);
    }
    if(e.slots.length!==p.slots.length)why.push(`${label}: the number of interviewer slots changed`);
    const approvedIds=s.interviewers.map(x=>x.userId);
    e.slots.forEach((slot,j)=>{
      if(slot.selected!==p.slots[j]?.selected&&slot.selected!==null&&!approvedIds.includes(slot.selected))why.push(`${label}, slot ${j+1}: an interviewer who wasn't approved was selected`);
      // Alternates may only stay as they were or become exactly the approved interviewers.
      if(!same(slot.alternates,p.slots[j]?.alternates)&&!same(slot.alternates,[...approvedIds].sort()))why.push(`${label}, slot ${j+1}: alternates changed to ${JSON.stringify(slot.alternates)}, which is neither the previous list nor exactly the approved interviewers`);
      if(compareRest&&!same(slot.rest,p.slots[j]?.rest)){
        // Name what changed, with before and after (IDs and settings, never page text).
        const changed=keys(slot.rest).filter(k=>!same(slot.rest[k],p.slots[j]?.rest?.[k]));
        const show=v=>JSON.stringify(v===undefined?null:v).slice(0,240);
        why.push(`${label}, slot ${j+1}: other slot settings changed (${changed.map(k=>`${k}: ${show(p.slots[j]?.rest?.[k])} → ${show(slot.rest[k])}`).join('; ')})`);
      }
    });
    if(compareRest&&!same(e.rest,p.rest))why.push(`${label}: other event settings changed (${keys(e.rest).filter(k=>!same(e.rest[k],p.rest[k])).join(', ')})`);
  });
  if(why.length)fail(`A draft save was refused: ${why.join('; ')}.`,why);
}

// The final save must equal the approval exactly.
function checkFinal(state,plan){
  const why=[];
  state.forEach((e,i)=>{
    const s=plan.sessions[i],label=`"${s.title}"`;
    if(e.start!==instant(s.start)||e.end!==instant(s.end))why.push(`${label} is at ${new Date(e.start).toISOString()}–${new Date(e.end).toISOString()}, not the approved ${s.start}–${s.end}`);
    if(e.interviewId!==s.interviewId)why.push(`${label} isn't the approved interview`);
    const chosen=e.slots.map(x=>x.selected).sort(),approved=s.interviewers.map(x=>x.userId).sort();
    if(!same(chosen,approved))why.push(`${label} doesn't have exactly the approved interviewers`);
    const stray=[...new Set(e.slots.flatMap(x=>x.alternates||[]))].filter(a=>!approved.includes(a));
    if(stray.length)why.push(`${label} still lists ${stray.length} unapproved alternate${stray.length===1?'':'s'} (${stray.join(', ')})`);
  });
  if(why.length)fail(`The composed draft doesn't match the approval: ${why.join('; ')}.`,why);
}

// Display strings Ashby uses, in the account's time zone.
function formats(iso,timeZone){
  const d=new Date(iso),f=o=>new Intl.DateTimeFormat('en-US',{timeZone,...o}).format(d);
  const zone=new Intl.DateTimeFormat('en-US',{timeZone,timeZoneName:'short'}).formatToParts(d).find(p=>p.type==='timeZoneName').value;
  const time=f({hour:'numeric',minute:'2-digit'});// "1:05 PM"
  return {zone,shortDate:`${f({weekday:'short'})}, ${f({month:'short'})} ${f({day:'numeric'})}, ${f({year:'numeric'})}`,// "Mon, Oct 12, 2026"
    longDate:f({weekday:'long',month:'long',day:'numeric',year:'numeric'}),// "Monday, October 12, 2026"
    upper:time,lower:time.replace(' AM','am').replace(' PM','pm')};
}

// Every email address a preview shows: its recipients.
const emailsIn=text=>[...new Set((text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)||[]).map(e=>e.toLowerCase()))].sort();
function exactly(found,expected,what){
  const want=[...new Set(expected.map(e=>e.toLowerCase()))].sort(),why=[];
  const missing=want.filter(e=>!found.includes(e)),extra=found.filter(e=>!want.includes(e));
  if(!found.length)why.push(`no recipients could be read from the ${what}`);
  else{if(missing.length)why.push(`the ${what} doesn't include ${missing.join(', ')}`);if(extra.length)why.push(`the ${what} also goes to ${extra.join(', ')}, who wasn't approved`);}
  return why;
}

// One agenda item per session, in order. Each starts "1:00 PM - 1:30 PM (MDT)
// - First Round", and what follows may only be that session's approved
// interviewers: Ashby puts a name inline, or on its own line with "(LinkedIn)"
// when the profile has one (seen October 13). Anything else left over refuses.
function agendaWhy(items,plan){
  const why=[],norm=v=>v.replace(/\s+/g,' ').trim();
  if(items.length!==plan.sessions.length)return [`its agenda has ${items.length} item${items.length===1?'':'s'}, but ${plan.sessions.length} session${plan.sessions.length===1?' was':'s were'} approved`];
  plan.sessions.forEach((s,i)=>{
    const a=formats(s.start,plan.timeZone),b=formats(s.end,plan.timeZone),prefix=`${a.upper} - ${b.upper} (${a.zone}) - ${s.title}`,item=norm(items[i]);
    if(!item.startsWith(prefix)){why.push(`agenda item ${i+1} reads "${item.slice(0,80)}", not "${prefix}"`);return;}
    let rest=item.slice(prefix.length);
    for(const x of s.interviewers){if(!rest.includes(x.name))why.push(`agenda item ${i+1} doesn't name ${x.name}`);rest=rest.split(x.name).join(' ');}
    rest=rest.replace(/\(\s*LinkedIn\s*\)/g,' ').replace(/[\s,\-–]+/g,' ').trim();
    if(rest)why.push(`agenda item ${i+1} also names "${rest.slice(0,60)}", who wasn't approved`);
  });
  return why;
}

// The candidate's calendar invite preview: the date, the agenda (one item per
// session, as above) and exactly the candidate as recipient.
function checkInvitePreview(text,plan,agendaItems){
  const t=text.replace(/\s+/g,' '),why=[];
  const first=formats(plan.sessions[0].start,plan.timeZone);
  if(!t.includes(first.shortDate))why.push(`it doesn't show the date ${first.shortDate}`);
  why.push(...agendaWhy(agendaItems,plan));
  why.push(...exactly(emailsIn(t),[plan.candidate.email],'candidate invite'));
  if(why.length)fail(`The candidate's calendar invite preview doesn't match the approval: ${why.join('; ')}.`,why);
}

// The interviewers' invite previews: Ashby sends one per session (seen
// October 13 with two sessions). Each is matched to its session by its
// "Thu, Oct 15, 2026 1:00pm - 1:30pm MDT" line, exactly once, and must go to
// exactly that session's approved interviewers, so anyone else Ashby would
// invite (an alternate, say) shows up on every run.
function checkInterviewerInvitePreviews(texts,plan){
  const why=[],panels=texts.map(t=>t.replace(/\s+/g,' '));
  if(panels.length!==plan.sessions.length)why.push(`there are ${panels.length} interviewer invite previews, but ${plan.sessions.length} session${plan.sessions.length===1?' was':'s were'} approved`);
  else plan.sessions.forEach((s,i)=>{
    const a=formats(s.start,plan.timeZone),b=formats(s.end,plan.timeZone),line=`${a.shortDate} ${a.lower} - ${b.lower} ${a.zone}`;
    const matches=panels.filter(p=>p.includes(line));
    if(matches.length!==1){why.push(`${matches.length} interviewer invite previews are for session ${i+1} ("${line}")`);return;}
    why.push(...exactly(emailsIn(matches[0]),s.interviewers.map(x=>x.email),`interviewer invite for session ${i+1}`));
  });
  if(why.length)fail(`The interviewers' calendar invite previews don't match the approval: ${why.join('; ')}.`,why);
}

// The candidate confirmation email: the subject's date, the body's date, and
// each session's start time. A stale preview (an earlier date) refuses.
function checkConfirmationEmail({subject,body},plan){
  const s=(subject||'').replace(/\s+/g,' '),b=(body||'').replace(/\s+/g,' '),why=[];
  const first=formats(plan.sessions[0].start,plan.timeZone);
  if(!s.includes(first.shortDate))why.push(`the subject ("${s.slice(0,120)}") doesn't show ${first.shortDate}`);
  if(!b.includes(first.longDate))why.push(`the body doesn't show ${first.longDate}`);
  for(const x of plan.sessions){const f=formats(x.start,plan.timeZone);if(!b.includes(f.upper)&&!b.includes(f.lower))why.push(`the body doesn't show "${x.title}" starting at ${f.upper}`);}
  if(why.length)fail(`The candidate confirmation email doesn't match the approval: ${why.join('; ')}. It may be out of date.`,why);
}

// Dialogs. Confirmable warnings are an explicit allowlist (empty for now);
// some are named as never confirmable; anything else stops the run.
const CONFIRMABLE=[];
const NEVER_CONFIRM=[/The interview time is in the past/i];
function classifyDialog(text){
  const t=(text||'').replace(/\s+/g,' ').trim();
  if(NEVER_CONFIRM.some(r=>r.test(t)))return {action:'stop',reason:`Ashby warned: "${t.slice(0,160)}". This is never confirmed; something upstream is wrong (the start should be at least 15 minutes away).`};
  const ok=CONFIRMABLE.find(c=>c.match.test(t));
  if(ok)return {action:'confirm',button:ok.button};
  return {action:'stop',reason:`Ashby showed a dialog the booking doesn't recognise: "${t.slice(0,160)}". Nothing was confirmed.`};
}

module.exports={selectedId,normalizeDraft,checkBaseline,checkSave,checkFinal,formats,emailsIn,checkInvitePreview,checkInterviewerInvitePreviews,checkConfirmationEmail,classifyDialog,CONFIRMABLE,NEVER_CONFIRM};
