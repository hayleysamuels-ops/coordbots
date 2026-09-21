"use strict";
const { digest } = require('./service');
const { windowsToInstants } = require('./booking-planner');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

// This reader uses only documented, read-only endpoints. Its results identify
// the requested interview; they never imply calendar availability or delivery.
function createBookingFacts({ key, clientId, request = fetch, now = () => Date.now() }) {
  async function read(endpoint, body) {
    if (!key || !clientId) fail(503, 'The client Ashby read connection is not configured.');
    const response = await request('https://api.ashbyhq.com/' + endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64'), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok || data.success !== true) fail(503, 'Could not verify the current Ashby scheduling details.');
    return data.results;
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
    const requirements = { stageId: stage.id, activityId: selected.activityId, interviewId: selected.interviewId, title: selected.title, durationMinutes: selected.interviewDurationMinutes };
    const facts = {
      clientId, applicationId: application.id, candidateId: application.candidate.id,
      candidateName: application.candidate.name, candidateEmail: application.candidate.primaryEmailAddress.value,
      jobId: application.job.id, jobTitle: application.job.title,
      ...requirements, interviewer: { userId: user.id, email: user.email, name: [user.firstName, user.lastName].filter(Boolean).join(' ').trim() },
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
    return {applicationId:a.id,candidateName:a.candidate?.name,jobTitle:a.job.title,activities:(stage.activities||[]).map(activity=>({id:activity.id,title:activity.title,sessions:(activity.interviews||[]).filter(i=>i.isSchedulable===true).map(i=>({interviewId:i.interviewId,title:i.title,durationMinutes:i.interviewDurationMinutes}))})).filter(a=>a.sessions.length)};
  }
  return { load, application };
}
module.exports = { createBookingFacts };
