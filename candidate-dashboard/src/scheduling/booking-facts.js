"use strict";
const { digest } = require('./service');
const { windowsToInstants } = require('./booking-planner');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

// This reader uses only documented, read-only endpoints. Its results identify
// the requested interview; they never imply calendar availability or delivery.
// `identityFor(name)` gives the client rules' interviewer identity override
// for a name (rules.js), or null.
function createBookingFacts({ key, clientId, request = fetch, now = () => Date.now(), identityFor = () => null }) {
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
  // Ashby interview ids marked isDebrief, cached for ten minutes. Used to keep
  // debriefs out of the onsite preview when the rules defer them. A read that
  // fails refuses rather than guessing that nothing is a debrief.
  let debriefCache=null;
  async function debriefInterviewIds(){
    if(debriefCache&&now()-debriefCache.at<600000)return debriefCache.ids;
    const ids=new Set(),cursors=new Set();let cursor=null;
    do{
      const page=await read('interview.list',{limit:100,...(cursor?{cursor}:{})},true);
      if(!Array.isArray(page.results))fail(503,'Ashby\'s interview list could not be read, so debriefs can\'t be told apart.');
      for(const i of page.results)if(i?.isDebrief===true&&uuid(i.id))ids.add(i.id);
      cursor=page.moreDataAvailable?page.nextCursor:null;
      if(page.moreDataAvailable&&(!cursor||cursors.has(cursor)))fail(503,'Ashby\'s interview list is incomplete.');
      cursors.add(cursor);if(cursors.size>50)fail(503,'Ashby\'s interview list is too large.');
    }while(cursor);
    debriefCache={at:now(),ids};return ids;
  }
  // The candidate's LinkedIn URL from their Ashby profile (socialLinks), for the
  // Slack post's header line. null when none is on file; never guessed.
  async function candidateLinkedIn(candidateId){
    if(!uuid(candidateId))fail(422,'A verified candidate is required.');
    const c=await read('candidate.info',{id:candidateId});
    const url=(c?.socialLinks||[]).find(l=>/linkedin/i.test(l?.type||''))?.url;
    try{const u=new URL(url);return u.protocol==='https:'&&/(^|\.)linkedin\.com$/i.test(u.hostname)?u.href:null;}catch(_){return null;}
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
  const sessionLabel=(session,i)=>`Session ${i+1}${session.title?` ("${session.title}")`:''}`;
  // The one active Ashby account an interviewer's name means, or null when
  // the name has no active account (the callers say what that means). Names
  // with several active accounts need an identity override in the client's
  // rules; there is no fallback. An override is enforced whenever the name
  // has an active account: its email must match exactly one active account,
  // and that account must carry the name, or the ambiguity has only moved.
  function activeAccount(users,person,label){
    const active=users.filter(u=>u.isEnabled===true&&normalizeName([u.firstName,u.lastName].filter(Boolean).join(' '))===normalizeName(person.name));
    if(!active.length)return null;
    const email=identityFor(person.name);
    if(email){
      const byEmail=users.filter(u=>u.isEnabled===true&&String(u.email||'').toLowerCase()===email);
      if(byEmail.length!==1)fail(409,`${label}: the identity override for ${person.name} gives ${email}, which matches ${byEmail.length} active Ashby accounts, not exactly one. Fix the override in the client's scheduling rules.`);
      if(!active.includes(byEmail[0]))fail(409,`${label}: the identity override for ${person.name} gives ${email}, but that account isn't one of the active Ashby accounts named ${person.name}. Fix the override in the client's scheduling rules.`);
      return byEmail[0];
    }
    if(active.length>1)fail(409,`${label}: ${person.name} is an eligible interviewer but matches ${active.length} active Ashby accounts by that name, so which one is meant can't be told. Check for duplicate accounts in Ashby, or add an interviewer identity override for ${person.name} to the client's scheduling rules.`);
    return active[0];
  }
  // A slot can list someone Ashby no longer counts as eligible, for instance a
  // person who has left and whose account is deactivated: Ashby then shows
  // fewer eligible matches than the slot lists. The page doesn't mark
  // who, so it's settled here against Ashby's directory. A name whose only
  // accounts are deactivated is dropped; then the active people left must equal
  // Ashby's eligible count exactly. Anything else (a name with no account, two
  // active accounts and no identity override, a count still off) refuses,
  // naming who was read.
  async function excludeDeactivated(sessions) {
    if(!sessions.some(s=>Number.isInteger(s.eligibleCount)))return sessions;
    const users=await listUsers(true);
    return sessions.map((session,i)=>{
      if(!Number.isInteger(session.eligibleCount))return session;
      const kept=[],excluded=[],label=sessionLabel(session,i);
      for(const person of session.eligibleInterviewers){
        if(activeAccount(users,person,label)){kept.push(person);continue;}
        const named=users.filter(u=>normalizeName([u.firstName,u.lastName].filter(Boolean).join(' '))===normalizeName(person.name));
        if(named.length)excluded.push({name:person.name,reason:'deactivated in Ashby'});
        else fail(409,`${label}: ${person.name} is listed in the interviewer slot but has no Ashby account. Check the slot in Ashby.`);
      }
      if(kept.length!==session.eligibleCount)fail(409,`${label}: Ashby shows ${session.eligibleCount} eligible but ${kept.length} of the listed interviewers are active (${kept.map(p=>p.name).join(', ')||'none'}${excluded.length?`; ${excluded.map(p=>`${p.name} is ${p.reason}`).join('; ')}`:''}). Check the slot in Ashby, then load the plan again.`);
      const {eligibleCount,...rest}=session;
      return {...rest,eligibleInterviewers:kept,excludedInterviewers:excluded};
    });
  }
  async function resolveInterviewers(sessions) {
    if(!Array.isArray(sessions)||!sessions.length||sessions.some(s=>s.assignmentVerified!==true||!s.eligibleInterviewers?.length))fail(422,'Load the verified interviewer lists first.');
    const users=await listUsers(false);
    const people=new Map(),resolved=[];
    for(const [i,session] of sessions.entries()){
      const eligible=[],label=sessionLabel(session,i);
      for(const person of session.eligibleInterviewers){
        const user=activeAccount(users,person,label);
        if(!user)fail(409,`${label}: ${person.name} is an eligible interviewer but has no active Ashby account by that name. Check their account and name in Ashby.`);
        if(!uuid(user.id)||!/^\S+@\S+\.\S+$/.test(user.email||''))fail(409,`${label}: ${person.name}'s active Ashby account has no usable ID or email.`);
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
  return { load, application, resolveInterviewers, excludeDeactivated, interviewerLimits, debriefInterviewIds, candidateLinkedIn };
}
module.exports = { createBookingFacts };
