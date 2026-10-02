"use strict";
const { digest } = require('./service');
const { windowsToInstants } = require('./booking-planner');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

// This reader uses only documented, read-only endpoints. Its results identify
// the requested interview; they never imply calendar availability or delivery.
function createBookingFacts({ key, clientId, request = fetch, now = () => Date.now() }) {
  async function read(endpoint, body, envelope = false) {
    if (!key || !clientId) fail(503, 'The client Ashby read connection is not configured.');
    const response = await request('https://api.ashbyhq.com/' + endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64'), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok || data.success !== true) fail(503, 'Could not verify the current Ashby scheduling details.');
    return envelope ? data : data.results;
  }
  async function load(input) {
    if (!input || !uuid(input.applicationId) || !uuid(input.interviewId)) fail(422, 'Choose a candidate and interview from the current plan.');
    const email = typeof input.interviewerEmail === 'string' ? input.interviewerEmail.trim().toLowerCase() : '';
    if (!/^\S+@\S+\.\S+$/.test(email)) fail(422, 'Enter the interviewer’s email address.');
    const windows = windowsToInstants(input.windows, input.timezone, now());
    const application = await read('application.info', { applicationId: input.applicationId });
    if (application?.id !== input.applicationId || application.status !== 'Active') fail(409, 'The candidate application is no longer active.');
    if (!uuid(application.candidate?.id) || !application.candidate.primaryEmailAddress?.value || !uuid(application.job?.id)) fail(422, 'Candidate contact or job details are incomplete in Ashby.');
    const plan = await read('jobInterviewPlan.info', { jobId: application.job.id });
    const stage = plan?.stages?.find(s => s.id === application.currentInterviewStage?.id);
    if (!stage) fail(409, 'The candidate’s current stage is missing from the published plan.');
    const matches = (stage.activities || []).flatMap(a => (a.interviews || []).filter(i => i.interviewId === input.interviewId && i.isSchedulable === true).map(i => ({ activityId: a.id, ...i })));
    if (matches.length !== 1) fail(409, 'Choose an unambiguous interview from the candidate’s current stage.');
    const selected = matches[0];
    if (!uuid(selected.activityId) || !Number.isInteger(selected.interviewDurationMinutes) || selected.interviewDurationMinutes < 5 || selected.interviewDurationMinutes > 480) fail(422, 'The interview’s scheduling requirements are incomplete.');
    const users = await read('user.search', { email });
    const exact = Array.isArray(users) ? users.filter(u => u.email?.toLowerCase() === email && u.isEnabled === true) : [];
    if (exact.length !== 1 || !uuid(exact[0].id)) fail(422, 'No unique active Ashby interviewer matches that email.');
    const user = exact[0];
    const limits = await read('user.interviewerSettings', { userId: user.id });
    if (!limits || !['dailyLimit','weeklyLimit'].every(k => Object.hasOwn(limits,k) && (limits[k]===null || (Number.isInteger(limits[k]) && limits[k]>=0)))) fail(503, 'The interviewer’s scheduling limits could not be verified.');
    const requirements = { stageId: stage.id, activityId: selected.activityId, interviewId: selected.interviewId, title: selected.title, durationMinutes: selected.interviewDurationMinutes };
    const facts = {
      clientId, applicationId: application.id, candidateId: application.candidate.id,
      candidateName: application.candidate.name, candidateEmail: application.candidate.primaryEmailAddress.value,
      jobId: application.job.id, jobTitle: application.job.title,
      ...requirements, interviewer: { userId: user.id, email: user.email, name: [user.firstName, user.lastName].filter(Boolean).join(' ').trim() },
      interviewerLimits: { dailyLimit: limits.dailyLimit, weeklyLimit: limits.weeklyLimit },
      timezone: input.timezone, windows: windows.map(w => ({ start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() })),
      templateRevision: digest(stage),
    };
    return { ...facts, sourceFingerprint: digest(facts), checkedAt: now(), availabilityVerified: false };
  }
  async function application(applicationId) {
    if(!uuid(applicationId))fail(422,'Use an Ashby candidate application link.');
    const a=await read('application.info',{applicationId});
    if(a?.id!==applicationId||a.status!=='Active'||!uuid(a.job?.id))fail(409,'This candidate application is not active.');
    const p=await read('jobInterviewPlan.info',{jobId:a.job.id});
    const stage=p?.stages?.find(s=>s.id===a.currentInterviewStage?.id);
    if(!stage)fail(409,'The current interview stage could not be found.');
    return {applicationId:a.id,candidateId:a.candidate?.id,stageId:stage.id,templateRevision:digest(stage),candidateName:a.candidate?.name,jobTitle:a.job.title,activities:(stage.activities||[]).map(activity=>({id:activity.id,title:activity.title,sessions:(activity.interviews||[]).filter(i=>i.isSchedulable===true).map(i=>({sessionId:i.id,interviewId:i.interviewId,title:i.title,durationMinutes:i.interviewDurationMinutes}))})).filter(a=>a.sessions.length)};
  }
  async function listUsers(includeDeactivated){
    const users=[],cursors=new Set();let cursor='start';
    while(cursor){
      const page=await read('user.list',{cursor,limit:100,includeDeactivated},true);
      if(!Array.isArray(page.results))fail(503,'The interviewer directory could not be read.');
      users.push(...page.results);
      cursor=page.moreDataAvailable?page.nextCursor:null;
      if(page.moreDataAvailable&&(!cursor||cursors.has(cursor)))fail(503,'The interviewer directory is incomplete.');
      cursors.add(cursor);if(cursors.size>50)fail(503,'The interviewer directory is too large.');
    }
    return users;
  }
  const normalizeName=s=>String(s||'').replace(/\s+/g,' ').trim().toLowerCase();
  // A slot can list someone Ashby no longer counts as eligible: on Luminai's
  // Lunch and One on One, Patrick Lii is listed but his account is deactivated,
  // so Ashby shows 3 and 5 eligible for 4 and 6 listed. The page doesn't mark
  // who, so it's settled here against Ashby's directory. A name whose only
  // accounts are deactivated is dropped; then the active people left must equal
  // Ashby's eligible count exactly. Anything else (a name with no account, two
  // active accounts, a count still off) refuses, naming who was read.
  async function excludeDeactivated(sessions) {
    if(!sessions.some(s=>Number.isInteger(s.eligibleCount)))return sessions;
    const users=await listUsers(true);
    return sessions.map(session=>{
      if(!Number.isInteger(session.eligibleCount))return session;
      const kept=[],excluded=[];
      for(const person of session.eligibleInterviewers){
        const named=users.filter(u=>normalizeName([u.firstName,u.lastName].filter(Boolean).join(' '))===normalizeName(person.name));
        const active=named.filter(u=>u.isEnabled===true);
        if(active.length===1)kept.push(person);
        else if(!active.length&&named.length)excluded.push({name:person.name,reason:'deactivated in Ashby'});
        else fail(409,`"${session.title}": ${person.name} is listed in the interviewer slot but ${active.length?'matches more than one active Ashby account':'has no Ashby account'}. Check the slot in Ashby.`);
      }
      if(kept.length!==session.eligibleCount)fail(409,`"${session.title}": Ashby shows ${session.eligibleCount} eligible but ${kept.length} of the listed interviewers are active (${kept.map(p=>p.name).join(', ')||'none'}${excluded.length?`; ${excluded.map(p=>`${p.name} is ${p.reason}`).join('; ')}`:''}). Check the slot in Ashby, then load the plan again.`);
      const {eligibleCount,...rest}=session;
      return {...rest,eligibleInterviewers:kept,excludedInterviewers:excluded};
    });
  }
  async function resolveInterviewers(sessions) {
    if(!Array.isArray(sessions)||!sessions.length||sessions.some(s=>s.assignmentVerified!==true||!s.eligibleInterviewers?.length))fail(422,'Load the verified interviewer lists first.');
    const users=await listUsers(false);
    const normalize=normalizeName,people=new Map(),resolved=[];
    for(const session of sessions){
      const eligible=[];
      for(const person of session.eligibleInterviewers){
        const matches=users.filter(u=>u.isEnabled===true&&normalize([u.firstName,u.lastName].filter(Boolean).join(' '))===normalize(person.name));
        if(matches.length!==1||!uuid(matches[0].id)||!/^\S+@\S+\.\S+$/.test(matches[0].email||''))fail(409,'An eligible interviewer could not be uniquely matched to an active Ashby account.');
        const user=matches[0];
        if(!people.has(user.id))people.set(user.id,{userId:user.id,name:person.name,email:user.email.toLowerCase()});
        eligible.push(people.get(user.id));
      }
      resolved.push({...session,eligibleInterviewers:eligible});
    }
    return {sessions:resolved,interviewers:[...people.values()]};
  }
  // Ashby's per-interviewer limits for every resolved interviewer, read four at
  // a time. The shape is checked exactly as load() checks it; a missing or
  // malformed answer refuses rather than counting as "no limit".
  async function interviewerLimits(userIds) {
    if (!Array.isArray(userIds) || userIds.some(id => !uuid(id))) fail(422, 'Resolve the interviewers first.');
    const out = new Map(), ids = [...new Set(userIds)];
    for (let i = 0; i < ids.length; i += 4) {
      await Promise.all(ids.slice(i, i + 4).map(async userId => {
        const limits = await read('user.interviewerSettings', { userId });
        if (!limits || !['dailyLimit','weeklyLimit'].every(k => Object.hasOwn(limits,k) && (limits[k]===null || (Number.isInteger(limits[k]) && limits[k]>=0)))) fail(503, 'An interviewer’s scheduling limits could not be verified.');
        out.set(userId, { dailyLimit: limits.dailyLimit, weeklyLimit: limits.weeklyLimit });
      }));
    }
    return out;
  }
  return { load, application, resolveInterviewers, excludeDeactivated, interviewerLimits };
}
module.exports = { createBookingFacts };
