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
// `timeZone` is the zone the composer edits in (composerZone below); the plan's
// own zone until it has been read.
// `observeAlternates` (the dry run's --observe-alternates only, never a real
// check): a slot's alternates may also narrow to any subset of what it held
// before, never gain anyone. It exists to watch what Ashby does with them.
function checkSave(prev,next,plan,{compareRest=true,timeZone=null,observeAlternates=false}={}){
  const why=[];
  if(next.length!==prev.length)fail(`This save has ${next.length} events; the draft had ${prev.length}.`);
  next.forEach((e,i)=>{
    const p=prev[i],s=plan.sessions[i],label=`"${s.title}"`;
    if(e.id!==p.id)why.push(`${label}: the event ID changed`);
    if(e.title!==p.title)why.push(`${label}: the title changed to "${e.title}"`);
    if(e.interviewId!==p.interviewId&&e.interviewId!==s.interviewId)why.push(`${label}: the interview changed to one that wasn't approved`);
    const tz=timeZone||plan.timeZone;
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
      const narrowed=observeAlternates&&Array.isArray(slot.alternates)&&Array.isArray(p.slots[j]?.alternates)&&slot.alternates.every(a=>p.slots[j].alternates.includes(a));
      if(!narrowed&&!same(slot.alternates,p.slots[j]?.alternates)&&!same(slot.alternates,[...approvedIds].sort()))why.push(`${label}, slot ${j+1}: alternates changed to ${JSON.stringify(slot.alternates)}, which is neither the previous list nor exactly the approved interviewers`);
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

// The draft objects in a GraphQL response: anything with this draft's `id`
// and a `draftSchedule` holding events, at any depth. The re-read before Send
// needs exactly one (booking-composer.js).
function draftsIn(json,draftId){
  const found=[],seen=new Set();
  (function walk(v){
    if(!v||typeof v!=='object'||seen.has(v))return;seen.add(v);
    if(v.id===draftId&&Array.isArray(v.draftSchedule?.events))found.push(v);
    for(const k of Object.keys(v))walk(v[k]);
  })(json);
  return found;
}

// The invite status on a schedule's page in Ashby, from what it shows
// (booking-composer.js readInviteStatus). Seen October 20 after a booking
// whose invites were blocked: "Scheduled Pending invites" in the heading,
// "Pending invites", and "Send to Candidate" / "Send to Interviewers" buttons.
//   pending: any of those, or "Not Sent";
//   sent: "Waiting on RSVP(s)" (seen October 20 once the invites went out:
//     "Scheduled Waiting on RSVPs Waiting on RSVP", no Send Calendar Invites
//     section), or an explicit "invite(s) sent", and in either case no sign of
//     pending and no "Send to …" button (Hayley, 2026-10-20);
//   unknown: anything else.
// Invitations are never reported sent without this evidence.
function classifyInviteStatus({headings=[],lines=[],buttons=[]}){
  const text=[...headings,...lines].map(t=>String(t).replace(/\s+/g,' ').trim()).filter(Boolean);
  const evidence=[...new Set(text.filter(t=>/invit|\bsent\b|pending/i.test(t)).map(t=>t.slice(0,100)))].slice(0,10);
  const sendButtons=[...new Set(buttons.map(b=>String(b).trim()).filter(b=>/^Send to (?:Candidate|Interviewers?)$/.test(b)))];
  if(text.some(t=>/\bPending invites?\b|\bNot Sent\b/i.test(t))||sendButtons.length)return {state:'pending',evidence:[...evidence,...sendButtons.map(b=>`button: ${b}`)]};
  const sentSign=text.filter(t=>/\bWaiting on RSVPs?\b/i.test(t)||/\binvites? (?:were |have been )?sent\b/i.test(t));
  if(sentSign.length)return {state:'sent',evidence:[...new Set([...sentSign.map(t=>t.slice(0,100)),...evidence])].slice(0,10)};
  return {state:'unknown',evidence};
}

// Ashby's read of a draft (seen October 20): the query ApiGetDraftSchedule,
// with the draft at data.draftInterviewSchedule. The same response also lists
// the schedule's drafts (data.draftInterviewSchedule.interviewSchedule.drafts),
// which include this one. The copy at data.draftInterviewSchedule is the one
// read; every other copy must have exactly the same sessions, times,
// interviews and interviewers, or this refuses. Returns its draftSchedule.
const DRAFT_READ_OP='ApiGetDraftSchedule';
function draftReadCopy(json,draftId){
  const main=json?.data?.draftInterviewSchedule;
  if(!main||main.id!==draftId||!Array.isArray(main.draftSchedule?.events))fail(`Ashby's read of this draft doesn't hold it at data.draftInterviewSchedule.`);
  const view=d=>JSON.stringify(normalizeDraft(d).map(e=>({id:e.id,title:e.title,start:e.start,end:e.end,interviewId:e.interviewId,slots:e.slots.map(x=>({selected:x.selected,alternates:x.alternates}))})));
  const mainView=view(main.draftSchedule);
  const others=draftsIn(json,draftId).filter(o=>o!==main);
  const differing=others.filter(o=>view(o.draftSchedule)!==mainView).length;
  if(differing)fail(`Ashby's read of this draft holds ${differing} other cop${differing===1?'y':'ies'} of it that differ${differing===1?'s':''} from the one read.`);
  return main.draftSchedule;
}

// Where a draft's ID appears in a GraphQL response, for the log when no
// draft read is found (Hayley, 2026-10-20): each object whose `id` is the
// draft's, by path, with its field names and what its `draftSchedule` and
// events are (object, text, list); and each other field whose value is the
// draft's ID. Field names and types only, never values. Capped.
function draftShape(json,draftId){
  const objects=[],references=[],seen=new Set();
  const kind=v=>v===null?'null':Array.isArray(v)?`list(${v.length})`:typeof v==='object'?'object':typeof v;
  (function walk(v,path){
    if(!v||typeof v!=='object'||seen.has(v)||objects.length+references.length>=20)return;seen.add(v);
    if(v.id===draftId){
      const d=v.draftSchedule;
      objects.push({path:path||'(root)',keys:Object.keys(v).sort().slice(0,40),draftSchedule:kind(d),
        ...(d&&typeof d==='object'&&!Array.isArray(d)?{draftScheduleKeys:Object.keys(d).sort().slice(0,40),events:kind(d.events)}:{})});
    }
    for(const [k,x] of Object.entries(v)){
      const at=path?`${path}.${k}`:k;
      if(x===draftId&&k!=='id')references.push(at);
      else walk(x,at);
    }
  })(json,'');
  return {objects,references};
}

// The final save must equal the approval exactly. With `observeAlternates`
// (dry run only), unapproved alternates are returned for the log instead of
// refused; everything else is checked as always.
function checkFinal(state,plan,{observeAlternates=false}={}){
  const strayAlternates=[];
  const why=[];
  state.forEach((e,i)=>{
    const s=plan.sessions[i],label=`"${s.title}"`;
    if(e.start!==instant(s.start)||e.end!==instant(s.end))why.push(`${label} is at ${new Date(e.start).toISOString()}–${new Date(e.end).toISOString()}, not the approved ${s.start}–${s.end}`);
    if(e.interviewId!==s.interviewId)why.push(`${label} isn't the approved interview`);
    const chosen=e.slots.map(x=>x.selected).sort(),approved=s.interviewers.map(x=>x.userId).sort();
    if(!same(chosen,approved))why.push(`${label} doesn't have exactly the approved interviewers`);
    const stray=[...new Set(e.slots.flatMap(x=>x.alternates||[]))].filter(a=>!approved.includes(a));
    if(stray.length&&observeAlternates)strayAlternates.push({session:i+1,alternates:stray});
    else if(stray.length)why.push(`${label} still lists ${stray.length} unapproved alternate${stray.length===1?'':'s'} (${stray.join(', ')})`);
  });
  if(why.length)fail(`The composed draft doesn't match the approval: ${why.join('; ')}.`,why);
  return {strayAlternates};
}

// Display strings Ashby uses, in the zone it shows (composerZone).
function formats(iso,timeZone){
  const d=new Date(iso),f=o=>new Intl.DateTimeFormat('en-US',{timeZone,...o}).format(d);
  const zone=new Intl.DateTimeFormat('en-US',{timeZone,timeZoneName:'short'}).formatToParts(d).find(p=>p.type==='timeZoneName').value;
  const time=f({hour:'numeric',minute:'2-digit'});// "1:05 PM"
  return {zone,shortDate:`${f({weekday:'short'})}, ${f({month:'short'})} ${f({day:'numeric'})}, ${f({year:'numeric'})}`,// "Mon, Oct 12, 2026"
    longDate:f({weekday:'long',month:'long',day:'numeric',year:'numeric'}),// "Monday, October 12, 2026"
    upper:time,lower:time.replace(' AM','am').replace(' PM','pm')};
}

// The zone Ashby's composer shows times in: a per-draft dropdown in the
// scheduling view, not the account's zone or the candidate's. Read from its
// "Select a timezone" buttons (seen October 14 and 16: two, reading
// "America/Denver" and "MDT").
// Exactly one must be an IANA zone name, and anything else shown must be that
// zone's own abbreviation at `atIso`; anything else refuses. The approved
// instants are then typed and checked in this zone. A misread zone still
// can't book the wrong time: every save is checked against the approved
// instants (checkSave, checkFinal).
// Ashby writes multi-word cities with a space ("America/Los Angeles", seen
// October 20); the IANA name has an underscore. A zone-shaped button has its
// spaces turned into underscores, and the result must be a real IANA zone:
// written as IANA writes it (each part capitalised, so "america/los_angeles"
// isn't one), and accepted by the runtime's time zone data, aliases included
// (America/Argentina/Buenos_Aires is listed here as America/Buenos_Aires).
const ZONE_SHAPE=/^[A-Za-z]+(?:\/[A-Za-z0-9][A-Za-z0-9 _+'-]*)+$/;
const asZoneName=t=>ZONE_SHAPE.test(t)?t.replace(/ +/g,'_'):t;
function isIanaZone(t){
  if(!/^[A-Z][A-Za-z_]*(?:\/[A-Z0-9][A-Za-z0-9_+-]*)+$/.test(t))return false;
  try{new Intl.DateTimeFormat('en-US',{timeZone:t});return true;}catch(_){return false;}
}
function composerZone(shown,atIso){
  const texts=[...new Set(shown.map(t=>String(t).replace(/\s+/g,' ').trim()).filter(Boolean))];
  const said=texts.length?texts.slice(0,4).map(t=>`"${t.slice(0,40)}"`).join(', '):'no time zone (there\'s no "Select a timezone" button)';
  const names=texts.map(asZoneName);
  const zones=[...new Set(names.filter(isIanaZone))];
  if(zones.length!==1)fail(`The composer shows times in ${said}; exactly one IANA time zone name is needed to read it by.`);
  const zone=zones[0],abbr=formats(atIso,zone).zone,other=texts.filter((t,i)=>names[i]!==zone&&t!==abbr);
  if(other.length)fail(`The composer shows times in ${said}; ${other.map(t=>`"${t.slice(0,40)}"`).join(', ')} isn't ${zone} (${abbr}).`);
  return zone;
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

// Invite previews state times in their own zone, which needn't be the
// composer's: the candidate's invite is in the candidate's zone (seen October
// 19: "10:00 AM - 10:30 AM (PDT)" for a session typed as 11:00am MDT), and
// interviewer invites in the schedule's Primary Interview Timezone. So times
// are read with their zone label and compared as instants. A label that isn't
// one of these refuses.
const ZONE_OFFSETS={UTC:0,GMT:0,EST:-300,EDT:-240,CST:-360,CDT:-300,MST:-420,MDT:-360,PST:-480,PDT:-420,AKST:-540,AKDT:-480,HST:-600};
function zoneOffset(label){
  const l=String(label||'').trim();
  if(Object.hasOwn(ZONE_OFFSETS,l))return ZONE_OFFSETS[l];
  const m=/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d\d))?$/.exec(l);
  return m?(m[1]==='-'?-1:1)*(Number(m[2])*60+Number(m[3]||0)):null;
}
// "10:00 AM" or "10:00am" → minutes after midnight.
function clockMinutes(t){
  const m=/^(\d{1,2}):(\d\d)\s*([AaPp])[Mm]$/.exec(String(t).trim());
  if(!m||Number(m[1])<1||Number(m[1])>12||Number(m[2])>59)return null;
  return (Number(m[1])%12+(/[Pp]/.test(m[3])?12:0))*60+Number(m[2]);
}
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// An approved instant as wall-clock time at a UTC offset: minutes after
// midnight, and the date as Ashby writes it ("Thu, Oct 22, 2026").
function wallClock(iso,offset){
  const d=new Date(Date.parse(iso)+offset*60000);
  return {minutes:d.getUTCHours()*60+d.getUTCMinutes(),
    shortDate:`${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`,
    longDate:`${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getUTCDay()]}, ${['January','February','March','April','May','June','July','August','September','October','November','December'][d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`};
}
const hhmm=min=>`${String(Math.floor(min/60)).padStart(2,'0')}:${String(min%60).padStart(2,'0')}`;
// Whether "start - end" at `offset` is the session's approved instants: the
// same wall-clock times at that offset. (The date is checked separately.)
function sameInstants(s,offset,startMin,endMin){
  return wallClock(s.start,offset).minutes===startMin&&wallClock(s.end,offset).minutes===endMin;
}
const approvedAt=(s,offset)=>`${hhmm(wallClock(s.start,offset).minutes)}–${hhmm(wallClock(s.end,offset).minutes)} at that offset (${s.start}–${s.end})`;

// One agenda item per session, in order. Each reads "10:00 AM - 10:30 AM (PDT)
// - Onsite", in any zone, and must be the session's approved instants; what
// follows may only be that session's approved interviewers: Ashby puts a name
// inline, or on its own line with "(LinkedIn)" when the profile has one (seen
// October 13). Anything else left over refuses. Returns the problems and the
// first item's offset, for the date.
function agendaWhy(items,plan){
  const why=[],norm=v=>v.replace(/\s+/g,' ').trim();let firstOffset=null;
  if(items.length!==plan.sessions.length)return {why:[`its agenda has ${items.length} item${items.length===1?'':'s'}, but ${plan.sessions.length} session${plan.sessions.length===1?' was':'s were'} approved`],firstOffset};
  plan.sessions.forEach((s,i)=>{
    const item=norm(items[i]);
    const m=/^(\d{1,2}:\d\d\s*[AP]M) - (\d{1,2}:\d\d\s*[AP]M) \(([^)]+)\) - (.*)$/.exec(item);
    if(!m){why.push(`agenda item ${i+1} reads "${item.slice(0,80)}", which isn't a time range with its zone`);return;}
    const offset=zoneOffset(m[3]),start=clockMinutes(m[1]),end=clockMinutes(m[2]);
    if(offset===null){why.push(`agenda item ${i+1}'s time zone "${m[3].slice(0,20)}" can't be read`);return;}
    if(i===0)firstOffset=offset;
    if(start===null||end===null||!sameInstants(s,offset,start,end))why.push(`agenda item ${i+1} reads "${m[1]} - ${m[2]} (${m[3]})", not the approved ${approvedAt(s,offset)}`);
    if(!(m[4]===s.title||m[4].startsWith(s.title+' '))){why.push(`agenda item ${i+1} is "${m[4].slice(0,40)}", not "${s.title}"`);return;}
    let rest=m[4].slice(s.title.length);
    for(const x of s.interviewers){if(!rest.includes(x.name))why.push(`agenda item ${i+1} doesn't name ${x.name}`);rest=rest.split(x.name).join(' ');}
    rest=rest.replace(/\(\s*LinkedIn\s*\)/g,' ').replace(/[\s,\-–]+/g,' ').trim();
    if(rest)why.push(`agenda item ${i+1} also names "${rest.slice(0,60)}", who wasn't approved`);
  });
  return {why,firstOffset};
}

// An agenda item as the log shows it when the agenda can't be read (Hayley,
// 2026-10-20): its first 20 characters, the leading times kept and every
// letter after them masked as "x", so no name is ever logged. Unusual spaces
// are named ([nbsp], [nnbsp], [thin]) and line breaks shown as "⏎", since
// either would stop the reader recognising "9:00 AM - 9:30 AM (PDT)".
const LEADING_TIMES=/^\s*(?:\d{1,2}:\d\d[\s   ]*[AaPp][Mm](?:\s*[-–]\s*)?){1,2}/;
function maskAgendaItem(text){
  const head=[...String(text||'')].slice(0,20).join('');
  const kept=(LEADING_TIMES.exec(head)||[''])[0];
  const masked=kept+head.slice(kept.length).replace(/\p{L}/gu,'x');
  return masked.replace(/ /g,'[nbsp]').replace(/ /g,'[nnbsp]').replace(/ /g,'[thin]').replace(/\n/g,'⏎');
}

// The candidate's calendar invite preview: the date (in the agenda's own
// zone), the agenda (one item per session, as above) and exactly the
// candidate as recipient.
function checkInvitePreview(text,plan,agendaItems){
  const t=text.replace(/\s+/g,' ');
  const {why,firstOffset}=agendaWhy(agendaItems,plan);
  if(firstOffset!==null){const date=wallClock(plan.sessions[0].start,firstOffset).shortDate;if(!t.includes(date))why.unshift(`it doesn't show the date ${date}`);}
  why.push(...exactly(emailsIn(t),[plan.candidate.email],'candidate invite'));
  if(why.length)fail(`The candidate's calendar invite preview doesn't match the approval: ${why.join('; ')}.`,why);
}

// The interviewers' invite previews: Ashby sends one per session (seen
// October 13 with two sessions). Each states its time as "Thu, Oct 15, 2026
// 1:00pm - 1:30pm MDT", in the schedule's Primary Interview Timezone; it's
// read with its zone and matched to the session with those instants, exactly
// once, and must go to exactly that session's approved interviewers, so
// anyone else Ashby would invite (an alternate, say) shows up on every run.
const INVITE_LINE=/([A-Z][a-z]{2}), ([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{1,2}:\d\d\s*[ap]m) - (\d{1,2}:\d\d\s*[ap]m) ([A-Z]{2,5}|(?:GMT|UTC)[+-]\d{1,2}(?::?\d\d)?)\b/;
function inviteInstants(panel){
  const m=INVITE_LINE.exec(panel);if(!m)return null;
  const offset=zoneOffset(m[7]),month=MONTHS.indexOf(m[2]),start=clockMinutes(m[5]),end=clockMinutes(m[6]);
  if(offset===null||month<0||start===null||end===null)return {unreadable:m[0]};
  const day=Date.UTC(Number(m[4]),month,Number(m[3]));
  // An end before the start is past midnight.
  return {start:day+(start-offset)*60000,end:day+(end+(end<start?1440:0)-offset)*60000,line:m[0]};
}
function checkInterviewerInvitePreviews(texts,plan){
  const why=[],panels=texts.map(t=>t.replace(/\s+/g,' '));
  if(panels.length!==plan.sessions.length)why.push(`there are ${panels.length} interviewer invite previews, but ${plan.sessions.length} session${plan.sessions.length===1?' was':'s were'} approved`);
  else{
    const read=panels.map(inviteInstants);
    read.forEach((r,k)=>{if(!r)why.push(`interviewer invite preview ${k+1} has no date and time with a zone`);else if(r.unreadable)why.push(`interviewer invite preview ${k+1}'s time "${r.unreadable.slice(0,60)}" can't be read`);});
    if(!why.length)plan.sessions.forEach((s,i)=>{
      const matches=panels.filter((p,k)=>read[k].start===Date.parse(s.start)&&read[k].end===Date.parse(s.end));
      if(matches.length!==1){why.push(`${matches.length} interviewer invite previews are for session ${i+1} (${s.start}–${s.end})`);return;}
      why.push(...exactly(emailsIn(matches[0]),s.interviewers.map(x=>x.email),`interviewer invite for session ${i+1}`));
    });
  }
  if(why.length)fail(`The interviewers' calendar invite previews don't match the approval: ${why.join('; ')}.`,why);
}

// Which invite preview is whose, by where each sits between the "Candidate
// Invite" and "Interviewer Invites" headings (booking-composer.js
// readPreviewSections): the candidate's between them, the interviewers' after
// the second. Seen October 19 on TEST's six-session Onsite: one combined
// candidate invite ("Invite for Onsite, Onsite, … and Lunch"), then one
// interviewer invite per session. Each heading must appear exactly once, in
// that order, with exactly one candidate preview, one interviewer preview per
// session, and none before the candidate's heading; anything else refuses.
// Returns the preview indexes: {candidate, interviewers:[…]}.
function partitionPreviews({candidateHeadings,interviewerHeadings,ordered,where},sessions){
  if(candidateHeadings!==1||interviewerHeadings!==1)fail(`Couldn't tell the candidate invite from the interviewer invites: found ${candidateHeadings} "Candidate Invite" and ${interviewerHeadings} "Interviewer Invites" headings; each must appear exactly once.`);
  if(!ordered)fail('Couldn\'t tell the candidate invite from the interviewer invites: the "Interviewer Invites" heading comes before "Candidate Invite".');
  const at=s=>where.map((w,k)=>w===s?k:-1).filter(k=>k>=0);
  const candidate=at('candidate'),interviewers=at('interviewer'),before=at('before');
  const why=[];
  if(before.length)why.push(`${before.length} preview${before.length===1?' is':'s are'} above the "Candidate Invite" heading`);
  if(candidate.length!==1)why.push(`${candidate.length} candidate invite previews (between "Candidate Invite" and "Interviewer Invites"), not 1`);
  if(interviewers.length!==sessions)why.push(`${interviewers.length} interviewer invite previews (after "Interviewer Invites"), not one for each of the ${sessions} session${sessions===1?'':'s'}`);
  if(why.length)fail(`The invite previews aren't laid out as expected: ${why.join('; ')}.`);
  return {candidate:candidate[0],interviewers};
}

// The candidate confirmation email. Its body has the same agenda as the
// candidate's invite (seen October 19): one line per session, "11:00 AM -
// 11:30 AM (PDT) - Onsite - Hayley Samuels", in the candidate's zone. An
// interviewer's name may sit on its own line below the time instead, as Mary
// Petrino's did, like "(LinkedIn)" in the invite's agenda.
//
// The check used to look for each start time, in the composer's zone, as a
// substring of the body. That passed without understanding anything: on
// October 19 the Mountain "2:00 PM" and "2:30 PM" matched inside the Pacific
// "12:00 PM" and "12:30 PM". So it now reads each agenda line with its zone
// and compares instants, as the invite check does (agendaWhy), and checks the
// dates in that zone. A stale preview (an earlier date) still refuses.
const AGENDA_TIME=/^\d{1,2}:\d\d\s*[AP]M - \d{1,2}:\d\d\s*[AP]M \([^)]+\)/;
// A line that is only a name, or pieces of "(LinkedIn)": Ashby splits it over
// lines ("Mary Petrino (", "LinkedIn", ")"). Brackets and "LinkedIn" are set
// aside, and what's left must be empty or two to four capitalised words.
const NAME=/^\p{Lu}[\p{L}'’.-]*(?: \p{Lu}[\p{L}'’.-]*){1,3}$/u;
const isNameLine=l=>{const core=l.replace(/[()]/g,' ').replace(/\bLinkedIn\b/g,' ').replace(/\s+/g,' ').trim();return !core||NAME.test(core);};
// The body's agenda items: each time line, with the name-only lines directly
// below it. Any other line ends the item. Every item is then checked by
// agendaWhy, so a name that isn't approved still refuses.
function emailAgendaItems(body){
  const items=[];let open=false;
  for(const raw of String(body||'').split(/\n+/)){
    const l=raw.replace(/\s+/g,' ').trim();
    if(!l)continue;
    if(AGENDA_TIME.test(l)){items.push(l);open=true;}
    else if(open&&isNameLine(l))items[items.length-1]+='\n'+l;
    else open=false;
  }
  return items;
}
function checkConfirmationEmail({subject,body},plan){
  const s=(subject||'').replace(/\s+/g,' '),b=(body||'').replace(/\s+/g,' ');
  const {why,firstOffset}=agendaWhy(emailAgendaItems(body),plan);
  if(firstOffset!==null){
    const day=wallClock(plan.sessions[0].start,firstOffset);
    if(!s.includes(day.shortDate))why.unshift(`the subject ("${s.slice(0,120)}") doesn't show ${day.shortDate}`);
    if(!b.includes(day.longDate))why.unshift(`the body doesn't show ${day.longDate}`);
  }
  if(why.length)fail(`The candidate confirmation email doesn't match the approval: ${why.join('; ')}. It may be out of date.`,why);
}

// The Calendar Invites screen's settings, in its dropdown layout. Between the
// "Calendar Invites and Notifications" and "Candidate Invite" headings:
//   several sessions (TEST's six-session Onsite, October 19): exactly three
//     dropdowns, two reading "Send calendar invites" and one "Send one invite
//     per block" (under a "Manage Candidate Invites" heading);
//   one session (TEST's First Round, October 20, read once the screen had
//     settled): exactly two "Send calendar invites", and no "Manage Candidate
//     Invites" heading; with one session there's no block to split.
// Which "Send calendar invites" is the candidate's isn't shown in the markup,
// and needn't be: both must send. Anything else (an invite not sent, another
// invite mode, another dropdown, a per-block setting on a one-session screen)
// refuses. The robot never opens or changes them.
const INVITE_DROPDOWNS=['Send calendar invites','Send calendar invites','Send one invite per block'];
const ONE_SESSION_DROPDOWNS=['Send calendar invites','Send calendar invites'];
function checkInviteDropdowns({start,end,dropdowns,manageHeadings=0},sessions){
  if(!start||!end)fail(`Couldn't find the Calendar Invites settings: the "${!start?'Calendar Invites and Notifications':'Candidate Invite'}" heading is missing.`);
  const shown=(dropdowns||[]).map(t=>String(t).replace(/\s+/g,' ').trim());
  const said=shown.length?shown.map(t=>`"${t.slice(0,60)}"`).join(', '):'no dropdowns';
  if(sessions===1){
    if(manageHeadings)fail(`The Calendar Invites screen for one session has a "Manage Candidate Invites" section, which only several sessions should have; it shows ${said}.`);
    if(!same([...shown].sort(),ONE_SESSION_DROPDOWNS))fail(`The Calendar Invites settings show ${said}; for one session they must be exactly two "Send calendar invites".`);
    return;
  }
  if(!same([...shown].sort(),[...INVITE_DROPDOWNS].sort()))
    fail(`The Calendar Invites settings show ${said}; they must be exactly two "Send calendar invites" and one "Send one invite per block".`);
}

// Dialogs. Confirmable warnings are an explicit allowlist (empty for now);
// some are named as never confirmable; anything else stops the run.
const CONFIRMABLE=[];
// Never confirmed, each with what it means, by Ashby's exact text:
//   "Heads up: The interview time is in the past." (October 13): freshness
//     requires the start to be 15+ minutes away, so something upstream is wrong.
//   "Heads Up No Location is set for this interview's calendar invites. You
//     can add an address or conference link on the Invite Settings page."
//     (October 19, on opening Schedule; buttons Cancel / Submit): the SOP
//     requires Google Meet as an onsite's interview room, so the schedule
//     needs a location set in Ashby, not an invite sent without one.
const NEVER_CONFIRM=[
  {match:/The interview time is in the past/i,
    reason:t=>`Ashby warned: "${t.slice(0,160)}". This is never confirmed; something upstream is wrong (the start should be at least 15 minutes away).`},
  {match:/No Location is set for this interview'?s calendar invites/i,
    reason:()=>'This schedule has no location set for its calendar invites, and it needs one: the SOP requires Google Meet as the interview room for onsites. Set it in Ashby on the schedule\'s Invite Settings page (or on the interview template), then approve again. Ashby\'s "No Location" warning is never confirmed.'},
];
function classifyDialog(text){
  const t=(text||'').replace(/\s+/g,' ').trim();
  const never=NEVER_CONFIRM.find(n=>n.match.test(t));
  if(never)return {action:'stop',reason:never.reason(t)};
  const ok=CONFIRMABLE.find(c=>c.match.test(t));
  if(ok)return {action:'confirm',button:ok.button};
  return {action:'stop',reason:`Ashby showed a dialog the booking doesn't recognise: "${t.slice(0,160)}". Nothing was confirmed.`};
}

module.exports={classifyInviteStatus,DRAFT_READ_OP,draftReadCopy,draftShape,draftsIn,maskAgendaItem,emailAgendaItems,zoneOffset,clockMinutes,partitionPreviews,selectedId,normalizeDraft,checkBaseline,checkSave,checkFinal,formats,composerZone,checkInviteDropdowns,INVITE_DROPDOWNS,ONE_SESSION_DROPDOWNS,emailsIn,checkInvitePreview,checkInterviewerInvitePreviews,checkConfirmationEmail,classifyDialog,CONFIRMABLE,NEVER_CONFIRM};
