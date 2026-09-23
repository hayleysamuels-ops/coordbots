'use strict';
// Preserve every open availability submission independently of triage dedup,
// aging thresholds, snoozes, and unrelated feedback alerts.
function readyQueue(schedules, applications) {
  const rows=new Map();
  for(const schedule of schedules){
    const app=applications.get(schedule.applicationId);
    if(schedule.status!=='CandidateAvailabilitySubmitted'||!app||app.status!=='Active')continue;
    rows.set(schedule.id,{...app,scheduleId:schedule.id,submittedAt:schedule.updatedAt,
      schedulingStageId:schedule.interviewStageId,
      stageMatches:!!schedule.interviewStageId&&schedule.interviewStageId===app.currentStageId});
  }
  return [...rows.values()].sort((a,b)=>Date.parse(a.submittedAt)-Date.parse(b.submittedAt));
}
module.exports={readyQueue};
