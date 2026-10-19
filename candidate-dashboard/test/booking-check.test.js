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
  assert.throws(()=>c.checkInvitePreview('Thu, Oct 15, 2026 TEST hayleysamuels511@gmail.com',two,[items[1],items[0]]),/agenda item 1 reads "1:30 PM/);
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

test('a stale confirmation email (an earlier date) refuses',()=>{
  const fresh={subject:'Confirmed: Interview with Luminai - Tue, Oct 20, 2026',body:'Hi TEST, Agenda: Tuesday, October 20, 2026 1:05 PM - 1:35 PM Initial'};
  c.checkConfirmationEmail(fresh,plan);
  // Seen live: the preview kept Wed, Oct 14 after the draft moved, until it was refreshed.
  const stale={subject:'Confirmed: Interview with Luminai - Wed, Oct 14, 2026',body:'Agenda: Wednesday, October 14, 2026 10:00 AM'};
  assert.throws(()=>c.checkConfirmationEmail(stale,plan),/doesn't show Tue, Oct 20, 2026.*It may be out of date/);
});

test('the dropdown invite layout: exactly two "Send calendar invites" and one "Send one invite per block", or it refuses',()=>{
  const ok={start:true,end:true,dropdowns:['Send calendar invites','Send calendar invites','Send one invite per block']};
  c.checkInviteDropdowns(ok);
  c.checkInviteDropdowns({...ok,dropdowns:['Send one invite per block','Send calendar invites','Send calendar invites']});
  for(const [read,why] of [
    [{...ok,dropdowns:['Send calendar invites',"Don't send calendar invites",'Send one invite per block']},/"Don't send calendar invites"/],
    [{...ok,dropdowns:['Send calendar invites','Send calendar invites','Send one invite per interview']},/"Send one invite per interview"; they must be exactly two/],
    [{...ok,dropdowns:['Send calendar invites','Send calendar invites']},/must be exactly two/],
    [{...ok,dropdowns:[...ok.dropdowns,'Send reminders']},/"Send reminders"/],
    [{...ok,dropdowns:[]},/show no dropdowns/],
    [{...ok,start:false},/"Calendar Invites and Notifications" heading is missing/],
    [{...ok,end:false},/"Candidate Invite" heading is missing/]])
    assert.throws(()=>c.checkInviteDropdowns(read),why);
});

test('dialogs: the past-time warning is never confirmed, and anything unrecognised stops',()=>{
  // Ashby's exact text, observed October 13, 2026.
  const past=c.classifyDialog('Heads up: The interview time is in the past. Confirm Anyway Cancel');
  assert.equal(past.action,'stop');assert.match(past.reason,/never confirmed/);
  assert.equal(c.classifyDialog('Something new and unexpected OK').action,'stop');
  assert.deepEqual(c.CONFIRMABLE,[]);
});
