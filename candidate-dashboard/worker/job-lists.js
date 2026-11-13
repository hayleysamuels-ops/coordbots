'use strict';
// The worker's BOOKING_COMPOSE_JOBS / BOOKING_SEND_JOBS: parsing and matching
// (see booking-locks.js for what the lists do). Loads nothing, on purpose:
// the dashboard's scheduling audit (src/scheduling/audit.js) requires this to
// judge the lists exactly as the worker does, and the dashboard must never
// load the booking robot (test/booking-dry-run-worker.test.js).
const isUuid=v=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const isText=v=>typeof v==='string'&&v.trim().length>0;

// One list, parsed: {jobs} (job ID -> "all" or trimmed, lowercased stage
// titles), or {problem} when it can't be used.
function jobList(env,name){
  const raw=String(env?.[name]??'').trim();
  if(!raw)return {jobs:{}};
  let v;try{v=JSON.parse(raw);}catch(_){return {problem:`${name} isn't valid JSON.`};}
  if(!v||typeof v!=='object'||Array.isArray(v))return {problem:`${name} must be a JSON object of job IDs.`};
  const jobs={};
  for(const [jobId,stages] of Object.entries(v)){
    if(!isUuid(jobId))return {problem:`${name} has a key that isn't a job ID (${String(jobId).slice(0,40)}).`};
    if(stages==='all'){jobs[jobId.toLowerCase()]='all';continue;}
    if(!Array.isArray(stages)||!stages.length||!stages.every(isText))return {problem:`${name} must give each job "all" or a list of stage titles.`};
    jobs[jobId.toLowerCase()]=stages.map(t=>t.trim().toLowerCase());
  }
  return {jobs};
}
// Whether a list allows this job and stage.
function jobAllows(jobs,jobId,stageTitle){
  const stages=jobs[String(jobId||'').toLowerCase()];
  return stages==='all'||(Array.isArray(stages)&&stages.includes(String(stageTitle||'').trim().toLowerCase()));
}

module.exports={jobList,jobAllows,isUuid,isText};
