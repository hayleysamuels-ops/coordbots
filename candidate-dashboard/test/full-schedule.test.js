'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {proposeFullSchedule}=require('../src/scheduling/full-schedule');
const {parseAssignment}=require('../worker/plan-reader');
const now=Date.parse('2026-09-21T00:00Z');
const sessions=[15,60,60,60,30,30,60,30].map((durationMinutes,i)=>({sessionId:String(i),interviewId:String(i),title:'Interview '+i,durationMinutes,assignmentVerified:true,requiredCount:1,eligibleInterviewers:[{name:i===4?'Fixed Person':'Person One'},{name:'Person Two'}].slice(0,i===4?1:2)}));
const input={sessions,timezone:'America/New_York',now,windows:[{start:'2026-09-28T09:00',end:'2026-09-28T17:00'}]};
test('full agenda includes all eight interviews in template order within candidate availability',()=>{const r=proposeFullSchedule(input);assert.equal(r.totalMinutes,345);assert.equal(r.proposals[0].events.length,8);assert.equal(r.proposals[0].end,'2026-09-28T18:45:00.000Z');assert.equal(r.proposals[0].events[4].interviewer.name,'Fixed Person');assert.equal(r.bookingEnabled,false);assert.equal(r.availabilityVerified,false);for(let i=1;i<8;i++)assert.equal(r.proposals[0].events[i].start,r.proposals[0].events[i-1].end);});
test('short windows do not silently truncate the plan or split across days',()=>{const r=proposeFullSchedule({...input,windows:[{start:'2026-09-28T09:00',end:'2026-09-28T12:00'},{start:'2026-09-29T09:00',end:'2026-09-29T12:00'}]});assert.equal(r.proposals.length,0);});
test('unverified or missing interviewers cannot produce an agenda',()=>{assert.throws(()=>proposeFullSchedule({...input,sessions:[{...sessions[0],assignmentVerified:false}]}));assert.throws(()=>proposeFullSchedule({...input,sessions:[{...sessions[0],eligibleInterviewers:[]}]}));});
test('specific employee rule preserves eligible alternatives',()=>{const r=parseAssignment('Coding\nSlot #1 —\n2 Eligible Matches\nAdvanced\nSpecific Employees:\n2 Employees\nPerson One\nOR Person Two\nAdd Interviewer Slot');assert.deepEqual(r.eligibleInterviewers,[{name:'Person One'},{name:'Person Two'}]);});
test('advanced explicit identity rule checks resolved eligible count',()=>{assert.equal(parseAssignment("Welcome\nSlot #1 —\n2 Eligible Matches\nEmployee's Employee\nAll are true:\nis Person One\nPerson Two\nSearch for user...\nSelect matcher...\nAdd Interviewer Slot").eligibleInterviewers.length,2);assert.throws(()=>parseAssignment('Slot #1 —\n3 Eligible Matches\nSpecific Employees:\n3 Employees\nPerson One\nAdd Interviewer Slot'));});
test('rendered line breaks do not drop eligible employees',()=>{const r=parseAssignment('Coding\nSlot #1 —\n2\nEligible\nMatches\nSpecific\nEmployees:\n2\nEmployees\nPerson One\nOR Person Two\nAdd\nInterviewer\nSlot');assert.equal(r.eligibleInterviewers.length,2);});
test('employee names ending in is are not mistaken for matcher syntax',()=>{const r=parseAssignment('Welcome\nSlot #1 —\n2 Eligible Matches\nSpecific Employees:\n2 Employees\nChris\nOR Person Two\nAdd Interviewer Slot');assert.equal(r.eligibleInterviewers[0].name,'Chris');});

// A panel is read slot by slot, never merged into one slot; each slot is held
// to the same rules as a one-person interview, and named by number.
test('a panel is read as one eligible list per slot, with everyone in them, never merged into one slot',()=>{
  const slots=n=>Array.from({length:n},(_,k)=>`Slot #${k+1} —\n1 Eligible Match\nSpecific Employees:\n1 Employees\nPerson ${['One','Two','Three','Four'][k]}`).join('\nAND\n')+'\nAdd Interviewer Slot';
  const r=parseAssignment(`Case Study Presentation\nInterviewers 4\n${slots(4)}`,'Case Study Presentation');
  assert.equal(r.requiredCount,4);
  assert.deepEqual(r.slots.map(x=>x.eligibleInterviewers.map(p=>p.name)),[['Person One'],['Person Two'],['Person Three'],['Person Four']]);
  assert.deepEqual(r.eligibleInterviewers.map(p=>p.name),['Person One','Person Two','Person Three','Person Four']);
  // The live Welcome shape: one host, and a second slot either of two can take.
  const welcome=parseAssignment('Welcome\nInterviewers\n2\nSlot #1\n—\n1 Eligible Match\nSpecific Employees:\n1 Employees\nGabrielle Struckell\nAND\nSlot #2\n—\n2 Eligible Matches\nSpecific Employees:\n2 Employees\nGrace Buckingham\nOR Ali Feldman\nAdd Interviewer Slot','Welcome');
  assert.equal(welcome.requiredCount,2);
  assert.deepEqual(welcome.slots.map(x=>x.eligibleInterviewers.map(p=>p.name)),[['Gabrielle Struckell'],['Grace Buckingham','Ali Feldman']]);
  // The page as read (textContent): the separator is "and" (CSS shows it
  // uppercase), and need not be the body's last line. TEST's two-slot Initial.
  for(const sep of ['and','And','AND','and\nor'])for(const where of ['end','middle']){
    const slot1=where==='end'?`Hayley Samuels\n${sep}`:`${sep}\nHayley Samuels`;
    const t=parseAssignment(`Initial\nInterviewers\n2\nSlot #1\n—\n1 Eligible Match\nSpecific Employees:\n1 Employees\n${slot1}\nSlot #2\n—\n1 Eligible Match\nSpecific Employees:\n1 Employees\nAnna Jones\nAdd Interviewer Slot`,'Initial');
    assert.deepEqual(t.slots.map(x=>x.eligibleInterviewers.map(p=>p.name)),[['Hayley Samuels'],['Anna Jones']],`${JSON.stringify(sep)} at the ${where}`);
  }
  // Anything else stray between slots still refuses (never becomes a name).
  assert.throws(()=>parseAssignment('Initial\nSlot #1\n—\n1 Eligible Match\nSpecific Employees:\n1 Employees\nHayley Samuels\nFeedback required\nand\nSlot #2\n—\n1 Eligible Match\nSpecific Employees:\n1 Employees\nAnna Jones\nAdd Interviewer Slot','Initial'),/Slot #1 lists 1 employee but 2 names were read from it \("Hayley Samuels", "Feedback required"\)/);
  // Someone in both slots is one person in the union.
  const both=parseAssignment('Welcome\nSlot #1 —\n2 Eligible Matches\nSpecific Employees:\n2 Employees\nGabrielle Struckell\nOR Grace Buckingham\nAND\nSlot #2 —\n2 Eligible Matches\nSpecific Employees:\n2 Employees\nGabrielle Struckell\nOR Grace Buckingham\nAdd Interviewer Slot','Welcome');
  assert.deepEqual(both.eligibleInterviewers.map(p=>p.name),['Gabrielle Struckell','Grace Buckingham']);
  // Out-of-order numbering, or a heading count that doesn't match, refuses.
  assert.throws(()=>parseAssignment('Welcome\nSlot #2 —\n1 Eligible Match\nSpecific Employees:\n1 Employees\nPerson One\nAdd Interviewer Slot','Welcome'),/numbered #2, not in order from #1/);
  assert.throws(()=>parseAssignment(`Welcome\nInterviewers 3\n${slots(2)}`,'Welcome'),/Ashby shows "Interviewers 3" but 2 slots were read/);
});

test('unsupported slot rules say what was found and what is supported, naming the slot',()=>{
  const refused=(text,pattern)=>assert.throws(()=>parseAssignment(text,'Recruiter Screen'),e=>{assert.equal(e.status,409);assert.match(e.message,pattern);assert.doesNotMatch(e.message,/Review it in Ashby/);return true;});
  refused('Recruiter Screen\nSlot #1 —\n4 Eligible Matches\nEmployees from Pool:\nSupport Interviewers Pool\nQualified only\nAdd Interviewer Slot',/^"Recruiter Screen": Slot #1 draws from an interviewer pool \(Ashby shows "Employees from Pool:"\), which isn't supported\. Only named interviewers are supported: use Specific Employees in the template\.$/);
  refused('Recruiter Screen\nSlot #1 —\n1 Eligible Match\nHiring Team Role:\nRecruiter\nAdd Interviewer Slot',/Slot #1 is filled by the candidate's hiring team role \("Hiring Team Role:"\)/);
  refused("Recruiter Screen\nSlot #1 —\n6 Eligible Matches\nEmployee's Department\nAll are true:\nis Support\nSelect matcher...\nAdd Interviewer Slot",/Slot #1 uses an Advanced matcher on the employee's department/);
  refused('Recruiter Screen\nSlot #1 —\nSomething new\nAdd Interviewer Slot',/Slot #1 shows no eligible-match count \(Ashby shows "Something new"\)/);
  refused('Recruiter Screen\nSlot #1 —\n3 Eligible Matches\nSpecific Employees:\n3 Employees\nPerson One\nAdd Interviewer Slot',/Slot #1 lists 3 employees but 1 name was read from it \("Person One"\)/);
  // A panel's second slot is held to the same rules, by its own number.
  refused('Recruiter Screen\nSlot #1 —\n1 Eligible Match\nSpecific Employees:\n1 Employees\nPerson One\nAND\nSlot #2 —\n1 Eligible Match\nHiring Team Role:\nRecruiter\nAdd Interviewer Slot',/Slot #2 is filled by the candidate's hiring team role/);
  refused('Recruiter Screen\nSlot #1 —\n1 Eligible Match\nSpecific Employees:\n1 Employees\nPerson One\nAND\nSlot #2 —\n2 Eligible Matches\nSpecific Employees:\n2 Employees\nPerson Two\nAdd Interviewer Slot',/Slot #2 lists 2 employees but 1 name was read from it \("Person Two"\)/);
});

test('Advanced matcher text split across lines, as Ashby renders it, is read and checked',()=>{
  // Exactly as the live worker log showed the Welcome slot.
  const live="Welcome\nmin\nConfigure\nRoom\nInterviewers\n1\nSlot #1\n—\n2 Eligible Matches\nAdvanced\nEmployee's Employee\n:\nAll\nare true:\nis\nGabrielle Struckell\nGrace Buckingham\nSearch for user...\nAdd Field to Match\nAdd Interviewer Slot";
  assert.deepEqual(parseAssignment(live,'Welcome').eligibleInterviewers,[{name:'Gabrielle Struckell'},{name:'Grace Buckingham'}]);
  assert.throws(()=>parseAssignment(live.replace('All\nare true:','Any\nare true:'),'Welcome'),/an Advanced matcher where any condition can match/);
  assert.throws(()=>parseAssignment(live.replace('Interviewers\n1','Interviewers\n2'),'Welcome'),/Ashby shows "Interviewers 2" but 1 slot was read/);
});

test('a slot listing more employees than Ashby counts eligible passes every name on with Ashby\'s count',()=>{
  // The Lunch slot exactly as logged.
  const lunch='Lunch\nSlot #1\n—\n3 Eligible Matches\nAdvanced\nSpecific Employees:\n4 Employees\nUpasna Madhok\nOR\nFormer Employee\nOR\nKathryn Wicks\nOR\nAriel Perez Chavez';
  const r=parseAssignment(lunch,'Lunch');
  assert.equal(r.eligibleCount,3);
  assert.deepEqual(r.eligibleInterviewers.map(p=>p.name),['Upasna Madhok','Former Employee','Kathryn Wicks','Ariel Perez Chavez']);
  // More eligible than listed is never possible, so it still refuses.
  assert.throws(()=>parseAssignment(lunch.replace('3 Eligible','5 Eligible'),'Lunch'),/says 5 eligible matches but 4 names were read/);
  // Names read must match the slot's own "N Employees".
  assert.throws(()=>parseAssignment(lunch.replace('4 Employees','5 Employees'),'Lunch'),/lists 5 employees but 4 names were read/);
});
