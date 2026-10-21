'use strict';
// Content checks for booking through Ashby's UI (worker/booking-check.js):
// each draft save may only move toward the approval, the final save must
// equal it, the previews must state the approved date and times, and
// dialogs are confirmed only from an explicit allowlist.
const {test}=require('node:test'),assert=require('node:assert/strict');
const c=require('../worker/booking-check');

const HAYLEY={userId:'u-hayley',name:'Hayley Samuels',email:'hayley@luminai.com'};
const MARY={userId:'u-mary',name:'Mary Petrino',email:'mary@luminai.com'};
const plan={candidate:{name:'TEST',email:'hayleysamuels511@gmail.com'},job:{title:'TEST'},stage:{title:'Initial Screen'},
  activityTitle:'Initial Screen Interview Schedule',interviewScheduleId:'sched-1',timeZone:'America/Denver',
  sessions:[{title:'Initial',interviewId:'int-1',start:'2026-10-20T19:05:00.000Z',end:'2026-10-20T19:35:00.000Z',interviewers:[HAYLEY]}]};
// A draft as Ashby sends it in ApiUpdateDraftSchedule.
const draft=({start='2026-10-12T17:00:00.000Z',end='2026-10-12T17:30:00.000Z',selected='u-mary',alternates=[],interviewId='int-1',title='Initial'}={})=>
  ({events:[{id:'ev-1',title,startTimeISO:start,endTimeISO:end,interviewId,interviewSlots:[{selected,alternates,feedbackRequired:true,dimension:{id:'d'}}]}]});
const N=x=>c.normalizeDraft(x);

test('the created draft must be the approved agenda: same sessions, interviews, titles and slot counts',()=>{
  c.checkBaseline(N(draft()),plan);
  assert.throws(()=>c.checkBaseline(N(draft({interviewId:'int-2'})),plan),/doesn't match the approval/);
  assert.throws(()=>c.checkBaseline(N({events:[...draft().events,...draft().events]}),plan),/2 events, but 1 session was approved/);
  const twoSlots=draft();twoSlots.events[0].interviewSlots.push({selected:null});
  assert.throws(()=>c.checkBaseline(N(twoSlots),plan),/2 interviewer slots in Ashby, but 1 interviewer was approved/);
});

test('a save may only move toward the approval',()=>{
  const base=N(draft());
  // Selecting the approved interviewer, then moving to the approved time: both accepted.
  const withHayley=N(draft({selected:'u-hayley'}));c.checkSave(base,withHayley,plan);
  const atTime=N(draft({selected:'u-hayley',start:plan.sessions[0].start,end:plan.sessions[0].end}));c.checkSave(withHayley,atTime,plan);
  // Clearing a slot is how Ashby swaps interviewers, so it's accepted; the final check catches an empty slot.
  c.checkSave(base,N(draft({selected:null})),plan);
  // Refused: an unapproved interviewer, a time that's neither previous nor approved, a different interview.
  assert.throws(()=>c.checkSave(base,N(draft({selected:'u-stranger'})),plan),/an interviewer who wasn't approved was selected/);
  assert.throws(()=>c.checkSave(base,N(draft({start:'2026-10-21T19:05:00.000Z'})),plan),/the start date moved to 2026-10-21T19:05:00.000Z, which is neither the previous nor the approved date/);
  assert.throws(()=>c.checkSave(base,N(draft({interviewId:'int-9'})),plan),/the interview changed to one that wasn't approved/);
  assert.throws(()=>c.checkSave(base,N(draft({title:'Other'})),plan),/the title changed/);
});

test('date and time are separate edits: the approved date at the old time is a step toward the approval',()=>{
  // Draft starts Mon Oct 12 11:00-11:30 MDT; approved Tue Oct 20 13:05-13:35 MDT.
  const base=N(draft({selected:'u-hayley'}));
  const dateFirst=N(draft({selected:'u-hayley',start:'2026-10-20T17:00:00.000Z',end:'2026-10-20T17:30:00.000Z'}));// Oct 20, 11:00
  c.checkSave(base,dateFirst,plan);
  const timeFirst=N(draft({selected:'u-hayley',start:'2026-10-12T19:05:00.000Z',end:'2026-10-12T19:35:00.000Z'}));// Oct 12, 13:05
  c.checkSave(base,timeFirst,plan);
  // End follows start, keeping the length, even when that isn't the approved end yet.
  const longer={...plan,sessions:[{...plan.sessions[0],end:'2026-10-20T20:05:00.000Z'}]};// approved 60 min
  c.checkSave(base,N(draft({selected:'u-hayley',start:'2026-10-20T19:05:00.000Z',end:'2026-10-20T19:35:00.000Z'})),longer);
  // A date that's neither the previous nor the approved one is still refused, even at the approved time.
  assert.throws(()=>c.checkSave(base,N(draft({selected:'u-hayley',start:'2026-10-25T19:05:00.000Z',end:'2026-10-25T19:35:00.000Z'})),plan),/the start date moved/);
  // So is a time of day that's neither, on the approved date.
  assert.throws(()=>c.checkSave(base,N(draft({selected:'u-hayley',start:'2026-10-20T21:00:00.000Z',end:'2026-10-20T21:30:00.000Z'})),plan),/the start time moved/);
});

test('a multi-word city is read with its underscore, and must be a real IANA zone',()=>{
  // As TEST's First Round composer showed it on October 20.
  assert.equal(c.composerZone(['America/Los Angeles','PDT'],'2026-10-26T16:00:00.000Z'),'America/Los_Angeles');
  assert.equal(c.composerZone(['America/New York','EDT'],'2026-10-26T16:00:00.000Z'),'America/New_York');
  assert.equal(c.composerZone(['America/Los_Angeles','America/Los Angeles','PDT'],'2026-10-26T16:00:00.000Z'),'America/Los_Angeles','the same zone written both ways');
  assert.equal(c.composerZone(['America/Argentina/Buenos Aires'],'2026-10-26T16:00:00.000Z'),'America/Argentina/Buenos_Aires');
  assert.throws(()=>c.composerZone(['America/Not A City','PDT'],'2026-10-26T16:00:00.000Z'),/"America\/Not A City", "PDT"; exactly one IANA time zone name/);
  assert.throws(()=>c.composerZone(['america/los angeles','PDT'],'2026-10-26T16:00:00.000Z'),/exactly one IANA/,'case must match');
  assert.throws(()=>c.composerZone(['America/Los Angeles','MDT'],'2026-10-26T16:00:00.000Z'),/"MDT" isn't America\/Los_Angeles \(PDT\)/);
});

test('partial saves are read in the zone the composer edits in, not the plan\'s',()=>{
  // Approved Tue Oct 20 11:30pm PDT, which is Wed Oct 21 00:30 MDT. Typed in a
  // Pacific composer, the time goes in first: Oct 12 at 11:30pm PDT. In
  // Denver that's Oct 13, a date that's neither the old nor the approved one.
  const late={...plan,sessions:[{...plan.sessions[0],start:'2026-10-21T06:30:00.000Z',end:'2026-10-21T07:00:00.000Z'}]};
  const base=N(draft({selected:'u-hayley'})),timeFirst=N(draft({selected:'u-hayley',start:'2026-10-13T06:30:00.000Z',end:'2026-10-13T07:00:00.000Z'}));
  c.checkSave(base,timeFirst,late,{timeZone:'America/Los_Angeles'});
  assert.throws(()=>c.checkSave(base,timeFirst,late),/the start date moved/);
  // The final check is by instant either way.
  assert.throws(()=>c.checkFinal(timeFirst,late),/not the approved/);
});

test('the composer\'s zone: one IANA name, and nothing else but its own abbreviation',()=>{
  const at='2026-10-22T16:00:00.000Z';
  assert.equal(c.composerZone(['America/Denver','MDT'],at),'America/Denver');
  assert.equal(c.composerZone([' MDT ','America/Denver','America/Denver'],at),'America/Denver');
  assert.equal(c.composerZone(['America/Los_Angeles'],at),'America/Los_Angeles');
  // In winter Denver is MST, so MDT then is a mismatch.
  assert.throws(()=>c.composerZone(['America/Denver','MDT'],'2026-12-22T16:00:00.000Z'),/"MDT" isn't America\/Denver \(MST\)/);
  for(const [shown,why] of [[['MDT'],/"MDT"; exactly one IANA/],[[],/no time zone/],[['America/Denver','PDT'],/"PDT" isn't America\/Denver \(MDT\)/],
    [['America/Denver','America/Chicago'],/exactly one IANA/],[['Mars/Olympus','MDT'],/exactly one IANA/],[['America/Denver','MDT','Eastern'],/"Eastern" isn't/]])
    assert.throws(()=>c.composerZone(shown,at),why);
});

test('a save that changes any other field is refused, except against the create response',()=>{
  const first=N(draft({selected:'u-hayley'}));
  const changed=N({events:[{...draft({selected:'u-hayley'}).events[0],interviewSlots:[{selected:'u-hayley',alternates:[],feedbackRequired:false,dimension:{id:'d'}}]}]});
  assert.throws(()=>c.checkSave(first,changed,plan),/other slot settings changed \(feedbackRequired: true → false\)/);
  // The create response has a different shape, so the first save only checks the tracked fields.
  c.checkSave(first,changed,plan,{compareRest:false});
});

test('alternates may only narrow to exactly the approved interviewers',()=>{
  // Seen live: picking Hayley narrowed alternates from [Mary, Hayley] to [Hayley].
  const base=N(draft({alternates:['u-mary','u-hayley']}));
  c.checkSave(base,N(draft({selected:'u-hayley',alternates:['u-hayley']})),plan);
  assert.throws(()=>c.checkSave(base,N(draft({selected:'u-hayley',alternates:['u-mary']})),plan),/alternates changed to \["u-mary"\], which is neither the previous list nor exactly the approved interviewers/);
  assert.throws(()=>c.checkSave(base,N(draft({alternates:['u-hayley','u-stranger']})),plan),/alternates changed/);
  assert.throws(()=>N(draft({alternates:[{weird:1}]})),/an alternate is in a shape this check doesn't recognise/);
  // The final draft may not keep an unapproved alternate.
  const at={start:plan.sessions[0].start,end:plan.sessions[0].end};
  c.checkFinal(N(draft({selected:'u-hayley',alternates:['u-hayley'],...at})),plan);
  assert.throws(()=>c.checkFinal(N(draft({selected:'u-hayley',alternates:['u-mary','u-hayley'],...at})),plan),/still lists 1 unapproved alternate \(u-mary\)/);
});

test('an unrecognised selected-interviewer shape refuses rather than being guessed',()=>{
  assert.equal(c.selectedId({id:'u-1'}),'u-1');assert.equal(c.selectedId({user:{id:'u-2'}}),'u-2');assert.equal(c.selectedId(null),null);
  assert.throws(()=>N(draft({selected:{employee:'x'}})),/selected interviewer is in a shape this check doesn't recognise \(fields: employee\)/);
  assert.throws(()=>N(draft({selected:42})),/doesn't recognise/);
});

test('the final save must equal the approval exactly',()=>{
  c.checkFinal(N(draft({selected:'u-hayley',start:plan.sessions[0].start,end:plan.sessions[0].end})),plan);
  assert.throws(()=>c.checkFinal(N(draft({selected:'u-hayley'})),plan),/not the approved/);
  assert.throws(()=>c.checkFinal(N(draft({selected:null,start:plan.sessions[0].start,end:plan.sessions[0].end})),plan),/exactly the approved interviewers/);
});

test('display strings follow the account time zone, with off-grid minutes',()=>{
  const f=c.formats('2026-10-20T19:05:00.000Z','America/Denver');
  assert.deepEqual(f,{zone:'MDT',shortDate:'Tue, Oct 20, 2026',longDate:'Tuesday, October 20, 2026',upper:'1:05 PM',lower:'1:05pm'});
  assert.equal(c.formats('2026-11-03T19:05:00.000Z','America/Denver').zone,'MST');
});

test('the candidate invite: the approved date, one agenda item per session, only the candidate',()=>{
  const ok='Invite for Initial Interview with Luminai Tue, Oct 20, 2026 1:05pm - 1:35pm MDT Agenda: 1:05 PM - 1:35 PM (MDT) - Initial - Hayley Samuels Invitees T TEST hayleysamuels511@gmail.com';
  const items=['1:05 PM - 1:35 PM (MDT) - Initial - Hayley Samuels'];
  c.checkInvitePreview(ok,plan,items);
  assert.throws(()=>c.checkInvitePreview(ok,plan,['1:05 PM - 1:35 PM (MDT) - Initial - Mary Petrino']),/agenda item 1 doesn't name Hayley Samuels; agenda item 1 also names "Mary Petrino", who wasn't approved/);
  assert.throws(()=>c.checkInvitePreview(ok,plan,[]),/its agenda has 0 items, but 1 session was approved/);
  assert.throws(()=>c.checkInvitePreview(ok.replace('hayleysamuels511@gmail.com','someone@example.com'),plan,items),/doesn't include hayleysamuels511@gmail.com.*also goes to someone@example.com/);
  assert.throws(()=>c.checkInvitePreview(ok+' X extra@example.com',plan,items),/candidate invite also goes to extra@example.com, who wasn't approved/);
});

// The two-session First Round, as Ashby showed it on October 13.
const MARY2={userId:'u-mary',name:'Mary Petrino',email:'mary@luminai.com'};
const two={...plan,sessions:[{title:'First Round',interviewId:'i-1',start:'2026-10-15T19:00:00.000Z',end:'2026-10-15T19:30:00.000Z',interviewers:[HAYLEY]},
  {title:'First Round',interviewId:'i-2',start:'2026-10-15T19:30:00.000Z',end:'2026-10-15T20:00:00.000Z',interviewers:[MARY2]}]};

test('agenda items: a name on its own line with "(LinkedIn)" is accepted; a stray name is not',()=>{
  const items=['1:00 PM - 1:30 PM (MDT) - First Round - Hayley Samuels','1:30 PM - 2:00 PM (MDT) - First Round\nMary Petrino (\nLinkedIn\n)'];
  c.checkInvitePreview('Thu, Oct 15, 2026 1:00pm - 2:00pm MDT Invitees TEST hayleysamuels511@gmail.com',two,items);
  assert.throws(()=>c.checkInvitePreview('Thu, Oct 15, 2026 TEST hayleysamuels511@gmail.com',two,[items[0],items[1]+'\nPatrick Lii']),/agenda item 2 also names "Patrick Lii", who wasn't approved/);
  assert.throws(()=>c.checkInvitePreview('Thu, Oct 15, 2026 TEST hayleysamuels511@gmail.com',two,[items[1],items[0]]),/agenda item 1 reads "1:30 PM - 2:00 PM \(MDT\)", not the approved 13:00–13:30 at that offset/);
});

test('interviewer invites: one per session, each to exactly that session\'s interviewers',()=>{
  const hayley='First Round - TEST - TEST Thu, Oct 15, 2026 1:00pm - 1:30pm MDT Invitees & Rooms Hayley Samuels hayley@luminai.com No room...';
  const mary='First Round - TEST - TEST Thu, Oct 15, 2026 1:30pm - 2:00pm MDT Invitees & Rooms Mary Petrino mary@luminai.com No room...';
  c.checkInterviewerInvitePreviews([hayley,mary],two);
  assert.throws(()=>c.checkInterviewerInvitePreviews([hayley,mary.replace('No room','Gabrielle gabby@luminai.com')],two),/interviewer invite for session 2 also goes to gabby@luminai.com, who wasn't approved/);
  assert.throws(()=>c.checkInterviewerInvitePreviews([hayley],two),/there are 1 interviewer invite previews, but 2 sessions were approved/);
  assert.throws(()=>c.checkInterviewerInvitePreviews([hayley,hayley],two),/0 interviewer invite previews are for session 2/);
  assert.throws(()=>c.checkInterviewerInvitePreviews(['First Round Tue, Oct 20, 2026 1:05pm - 1:35pm MDT Invitees Hayley Samuels'],plan),/no recipients could be read from the interviewer invite for session 1/);
});

// TEST's Onsite on October 19: typed as 11:00am MDT in the composer, shown to
// the candidate as 10:00 AM PDT, and to interviewers in the Primary Interview
// Timezone. The same instants, so all pass.
const onsite={...plan,sessions:[{title:'Onsite',interviewId:'i-1',start:'2026-10-22T17:00:00.000Z',end:'2026-10-22T17:30:00.000Z',interviewers:[HAYLEY]},
  {title:'Lunch',interviewId:'i-2',start:'2026-10-22T19:30:00.000Z',end:'2026-10-22T20:00:00.000Z',interviewers:[MARY2]}]};
test('invite previews in another zone are compared as instants: the candidate\'s in PDT and the composer\'s in MDT agree',()=>{
  const items=['10:00 AM - 10:30 AM (PDT) - Onsite - Hayley Samuels','12:30 PM - 1:00 PM (PDT) - Lunch - Mary Petrino'];
  const text='Invite for Onsite and Lunch Thu, Oct 22, 2026 10:00am - 1:00pm PDT Invitees TEST hayleysamuels511@gmail.com';
  c.checkInvitePreview(text,onsite,items);
  c.checkInvitePreview(text.replace(/PDT/g,'MDT'),onsite,['11:00 AM - 11:30 AM (MDT) - Onsite - Hayley Samuels','1:30 PM - 2:00 PM (MDT) - Lunch - Mary Petrino']);
  c.checkInvitePreview(text,onsite,['5:00 PM - 5:30 PM (GMT+0) - Onsite - Hayley Samuels','7:30 PM - 8:00 PM (UTC) - Lunch - Mary Petrino']);
  // A different instant refuses, saying what it is at that offset.
  assert.throws(()=>c.checkInvitePreview(text,onsite,['10:30 AM - 11:00 AM (PDT) - Onsite - Hayley Samuels',items[1]]),
    /agenda item 1 reads "10:30 AM - 11:00 AM \(PDT\)", not the approved 10:00–10:30 at that offset \(2026-10-22T17:00:00.000Z–2026-10-22T17:30:00.000Z\)/);
  // So does a zone label that can't be read, or a line without one.
  assert.throws(()=>c.checkInvitePreview(text,onsite,['10:00 AM - 10:30 AM (Pacific) - Onsite - Hayley Samuels',items[1]]),/agenda item 1's time zone "Pacific" can't be read/);
  assert.throws(()=>c.checkInvitePreview(text,onsite,['10:00 AM - 10:30 AM - Onsite - Hayley Samuels',items[1]]),/isn't a time range with its zone/);
  // The date is read in the agenda's zone.
  assert.throws(()=>c.checkInvitePreview(text.replace('Oct 22','Oct 23'),onsite,items),/doesn't show the date Thu, Oct 22, 2026/);
  // Names are checked as before.
  assert.throws(()=>c.checkInvitePreview(text,onsite,[items[0].replace('Hayley Samuels','Joe Penn'),items[1]]),/doesn't name Hayley Samuels.*also names "Joe Penn"/);
  // Interviewer invites: matched by instant, whatever zone each states.
  const inv=(when,who)=>`Onsite - TEST - TEST ${when} Invitees & Rooms ${who}`;
  c.checkInterviewerInvitePreviews([inv('Thu, Oct 22, 2026 11:00am - 11:30am MDT','hayley@luminai.com'),inv('Thu, Oct 22, 2026 12:30pm - 1:00pm PDT','mary@luminai.com')],onsite);
  assert.throws(()=>c.checkInterviewerInvitePreviews([inv('Thu, Oct 22, 2026 11:00am - 11:30am PDT','hayley@luminai.com'),inv('Thu, Oct 22, 2026 12:30pm - 1:00pm PDT','mary@luminai.com')],onsite),
    /0 interviewer invite previews are for session 1 \(2026-10-22T17:00:00.000Z/);
  assert.throws(()=>c.checkInterviewerInvitePreviews([inv('Thu, Oct 22, 2026 11:00am - 11:30am XYZT','hayley@luminai.com'),inv('Thu, Oct 22, 2026 12:30pm - 1:00pm PDT','mary@luminai.com')],onsite),
    /preview 1's time "Thu, Oct 22, 2026 11:00am - 11:30am XYZT" can't be read/);
  assert.equal(c.zoneOffset('GMT-7'),-420);assert.equal(c.zoneOffset('UTC+05:30'),330);assert.equal(c.zoneOffset('Pacific'),null);
  assert.equal(c.clockMinutes('12:30 AM'),30);assert.equal(c.clockMinutes('12:30pm'),750);assert.equal(c.clockMinutes('13:00 PM'),null);
});

test('invite previews are whose their place says: one candidate preview between the headings, one interviewer preview per session after',()=>{
  const ok={candidateHeadings:1,interviewerHeadings:1,ordered:true};
  // October 19, TEST's Onsite: one combined candidate invite, then six.
  assert.deepEqual(c.partitionPreviews({...ok,where:['candidate',...Array(6).fill('interviewer')]},6),{candidate:0,interviewers:[1,2,3,4,5,6]});
  assert.deepEqual(c.partitionPreviews({...ok,where:['candidate','interviewer']},1),{candidate:0,interviewers:[1]});
  for(const [read,n,why] of [
    [{...ok,candidateHeadings:0,where:[]},6,/found 0 "Candidate Invite" and 1 "Interviewer Invites" headings; each must appear exactly once/],
    [{...ok,interviewerHeadings:2,where:[]},6,/found 1 "Candidate Invite" and 2 "Interviewer Invites"/],
    [{...ok,ordered:false,where:[]},6,/"Interviewer Invites" heading comes before "Candidate Invite"/],
    [{...ok,where:['candidate','candidate',...Array(6).fill('interviewer')]},6,/2 candidate invite previews .* not 1/],
    [{...ok,where:['candidate',...Array(5).fill('interviewer')]},6,/5 interviewer invite previews .* not one for each of the 6 sessions/],
    [{...ok,where:Array(7).fill('interviewer')},6,/0 candidate invite previews.*7 interviewer invite previews/],
    [{...ok,where:['before','candidate',...Array(6).fill('interviewer')]},6,/1 preview is above the "Candidate Invite" heading/]])
    assert.throws(()=>c.partitionPreviews(read,n),why);
});

// The confirmation email as logged on October 19 (TEST's Onsite, approved for
// Tue Oct 20 18:00Z), in the candidate's zone; Mary's name on its own line.
const person=(name,email)=>({userId:'u-'+name.split(' ')[0].toLowerCase(),name,email});
const JOE=person('Joe Penn','joe@luminai.com'),ANNA=person('Anna Jones','anna@luminai.com');
const oct20={...plan,sessions:[[18,HAYLEY],[18.5,JOE],[19,MARY2],[19.5,ANNA],[20,HAYLEY]].map(([h,who])=>({title:'Onsite',interviewId:'i',interviewers:[who],
  start:new Date(Date.UTC(2026,9,20,Math.floor(h),(h%1)*60)).toISOString(),end:new Date(Date.UTC(2026,9,20,Math.floor(h),(h%1)*60+30)).toISOString()})).concat([
  {title:'Lunch',interviewId:'i',interviewers:[HAYLEY],start:'2026-10-20T20:30:00.000Z',end:'2026-10-20T21:00:00.000Z'}])};
const email={subject:'Confirmed: Interview with Luminai - Tue, Oct 20, 2026',body:['Hi TEST,','Here is your schedule.','Tuesday, October 20, 2026',
  '11:00 AM - 11:30 AM (PDT) - Onsite - Hayley Samuels','11:30 AM - 12:00 PM (PDT) - Onsite - Joe Penn','12:00 PM - 12:30 PM (PDT) - Onsite','Mary Petrino (','LinkedIn',')',
  '12:30 PM - 1:00 PM (PDT) - Onsite - Anna Jones','1:00 PM - 1:30 PM (PDT) - Onsite - Hayley Samuels','1:30 PM - 2:00 PM (PDT) - Lunch - Hayley Samuels','See you then.','Luminai Recruiting'].join('\n')};

test('the confirmation email is read like the invite: each agenda line\'s zone, compared as instants, with names on their own lines',()=>{
  c.checkConfirmationEmail(email,oct20);
  // Mary's name sits on its own line, and is attached to her session.
  assert.equal(c.emailAgendaItems(email.body)[2],'12:00 PM - 12:30 PM (PDT) - Onsite\nMary Petrino (\nLinkedIn\n)');
  // A line that isn't a name ends the item: "See you then." isn't read as an interviewer.
  assert.equal(c.emailAgendaItems(email.body)[5],'1:30 PM - 2:00 PM (PDT) - Lunch - Hayley Samuels');
  // The same instants in Mountain time pass too.
  const mountain=email.body.replace(/(\d{1,2}):(\d\d) ([AP]M) - (\d{1,2}):(\d\d) ([AP]M) \(PDT\)/g,(m,h1,m1,a1,h2,m2,a2)=>{
    const t=(h,mm,ap)=>{let x=(Number(h)%12+(ap==='PM'?12:0))*60+Number(mm)+60;const hh=Math.floor(x/60)%24;return `${hh%12||12}:${String(x%60).padStart(2,'0')} ${hh>=12?'PM':'AM'}`;};
    return `${t(h1,m1,a1)} - ${t(h2,m2,a2)} (MDT)`;});
  c.checkConfirmationEmail({...email,body:mountain},oct20);
});

test('an unreadable agenda item is logged masked: times kept, every letter after them masked, unusual spaces named, never a name',()=>{
  assert.equal(c.maskAgendaItem('9:00 AM - 9:30 AM (PDT) - Onsite - Hayley Samuels'),'9:00 AM - 9:30 AM (x');
  assert.equal(c.maskAgendaItem('9:00 AM - 9:30 AM (PDT) - Onsite'),'9:00[nnbsp]AM - 9:30[nnbsp]AM (x');
  assert.equal(c.maskAgendaItem('9:00 AM – 9:30 AM PDT Onsite'),'9:00[nbsp]AM – 9:30[nbsp]AM xx');
  // No time first: every letter is masked, so a name never shows.
  assert.equal(c.maskAgendaItem('Hayley Samuels\n9:00 AM'),'xxxxxx xxxxxxx⏎9:00 ');
  assert.equal(c.maskAgendaItem('Thursday, October 22'),'xxxxxxxx, xxxxxxx 22');
  assert.doesNotMatch(c.maskAgendaItem('10:00 AM - 10:30 AM Hayley'),/Hayley|Hay|H/);
});

test('the old substring check passed by coincidence; reading zones and instants doesn\'t',()=>{
  // October 19: the old check looked for Mountain start times as substrings,
  // and "2:00 PM" and "2:30 PM" matched inside the Pacific "12:00 PM" and
  // "12:30 PM". Labelled as Mountain, those same lines are an hour early: refused.
  assert.throws(()=>c.checkConfirmationEmail({...email,body:email.body.replace(/\(PDT\)/g,'(MDT)')},oct20),/agenda item 1 reads "11:00 AM - 11:30 AM \(MDT\)", not the approved 12:00–12:30 at that offset/);
});

test('the confirmation email refuses on a stale date, a missing zone, a stranger, or a missing name',()=>{
  // Seen live on October 13: the preview kept an earlier date until it was refreshed.
  assert.throws(()=>c.checkConfirmationEmail({...email,subject:'Confirmed: Interview with Luminai - Mon, Oct 19, 2026'},oct20),/the subject .* doesn't show Tue, Oct 20, 2026.*It may be out of date/);
  assert.throws(()=>c.checkConfirmationEmail({...email,body:email.body.replace('Tuesday, October 20','Monday, October 19')},oct20),/the body doesn't show Tuesday, October 20, 2026/);
  assert.throws(()=>c.checkConfirmationEmail({...email,body:email.body.replace(/ \(PDT\)/g,'')},oct20),/its agenda has 0 items, but 6 sessions were approved/);
  assert.throws(()=>c.checkConfirmationEmail({...email,body:email.body.replace('Mary Petrino (','Gabrielle Struckell (')},oct20),/agenda item 3 doesn't name Mary Petrino; agenda item 3 also names "Gabrielle Struckell", who wasn't approved/);
  assert.throws(()=>c.checkConfirmationEmail({...email,body:email.body.replace(' - Joe Penn','')},oct20),/agenda item 2 doesn't name Joe Penn/);
});
test('the dropdown invite layout: two "Send calendar invites", plus "Send one invite per block" for several sessions, or it refuses',()=>{
  const ok={start:true,end:true,dropdowns:['Send calendar invites','Send calendar invites','Send one invite per block']};
  c.checkInviteDropdowns(ok,6);
  c.checkInviteDropdowns({...ok,dropdowns:['Send one invite per block','Send calendar invites','Send calendar invites']},6);
  for(const [read,why] of [
    [{...ok,dropdowns:['Send calendar invites',"Don't send calendar invites",'Send one invite per block']},/"Don't send calendar invites"/],
    [{...ok,dropdowns:['Send calendar invites','Send calendar invites','Send one invite per interview']},/"Send one invite per interview"; they must be exactly two/],
    [{...ok,dropdowns:['Send calendar invites','Send calendar invites']},/must be exactly two/],
    [{...ok,dropdowns:[...ok.dropdowns,'Send reminders']},/"Send reminders"/],
    [{...ok,dropdowns:[]},/show no dropdowns/],
    [{...ok,start:false},/"Calendar Invites and Notifications" heading is missing/],
    [{...ok,end:false},/"Candidate Invite" heading is missing/]])
    assert.throws(()=>c.checkInviteDropdowns(read,6),why);
  // One session (TEST's First Round, October 20, settled): two "Send calendar
  // invites" and no "Manage Candidate Invites" section.
  const one={start:true,end:true,manageHeadings:0,dropdowns:['Send calendar invites','Send calendar invites']};
  c.checkInviteDropdowns(one,1);
  for(const [read,why] of [
    [{...one,dropdowns:[...one.dropdowns,'Send one invite per block']},/for one session they must be exactly two "Send calendar invites"/],
    [{...one,manageHeadings:1},/for one session has a "Manage Candidate Invites" section, which only several sessions should have/],
    [{...one,dropdowns:['Send calendar invites',"Don't send calendar invites"]},/"Don't send calendar invites"; for one session/],
    [{...one,dropdowns:['Send calendar invites']},/for one session they must be exactly two/],
    [{...one,end:false},/"Candidate Invite" heading is missing/]])
    assert.throws(()=>c.checkInviteDropdowns(read,1),why);
  // Several sessions still need the per-block setting.
  assert.throws(()=>c.checkInviteDropdowns(one,2),/must be exactly two "Send calendar invites" and one "Send one invite per block"/);
});

test('dialogs: the past-time and no-location warnings are never confirmed, and anything unrecognised stops',()=>{
  // Ashby's exact text, observed October 13, 2026.
  const past=c.classifyDialog('Heads up: The interview time is in the past. Confirm Anyway Cancel');
  assert.equal(past.action,'stop');assert.match(past.reason,/never confirmed/);
  assert.equal(c.classifyDialog('Something new and unexpected OK').action,'stop');
  // Ashby's exact text, observed October 19 on opening Schedule (Cancel / Submit).
  const noLocation=c.classifyDialog("Heads Up No Location is set for this interview's calendar invites. You can add an address or conference link on the Invite Settings page. Cancel Submit");
  assert.equal(noLocation.action,'stop');
  assert.equal(noLocation.reason,'This schedule has no location set for its calendar invites, and it needs one: the SOP requires Google Meet as the interview room for onsites. Set it in Ashby on the schedule\'s Invite Settings page (or on the interview template), then approve again. Ashby\'s "No Location" warning is never confirmed.');
  assert.deepEqual(c.CONFIRMABLE,[]);
  assert.equal(c.NEVER_CONFIRM.length,2);
});
