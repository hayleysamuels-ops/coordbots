'use strict';
// Preserve every open availability submission independently of triage dedup,
// aging thresholds, candidate snoozes, and unrelated feedback alerts. Rows are
// dismissed only by their own schedule key (see dismissKey below).
function readyQueue(schedules, applications) {
  const rows=new Map();
  for(const schedule of schedules){
    const app=applications.get(schedule.applicationId);
    if(schedule.status!=='CandidateAvailabilitySubmitted'||!app||app.status!=='Active')continue;
    const row={...app,scheduleId:schedule.id,submittedAt:schedule.updatedAt,
      schedulingStageId:schedule.interviewStageId,
      stageMatches:!!schedule.interviewStageId&&schedule.interviewStageId===app.currentStageId};
    row.dismissKey=dismissKey(row);
    rows.set(schedule.id,row);
  }
  return [...rows.values()].sort((a,b)=>Date.parse(a.submittedAt)-Date.parse(b.submittedAt));
}
// A snooze/hide covers one submission, not the candidate: "candidate:<id>"
// dismissals from other sections never apply here. submittedAt is the
// schedule's updatedAt, so any later Ashby change to the schedule (a
// resubmission, or an unrelated edit) no longer matches and the row
// resurfaces. That is deliberate: there is no un-hide UI past the Undo toast,
// and a resurfaced row is safer than a permanently buried submission. Without
// both ids the row gets no key and can't be dismissed at all.
function dismissKey(row) {
  return row.scheduleId&&row.submittedAt?`schedule:${row.scheduleId}:${row.submittedAt}`:null;
}
// Splits rows at serve time into what the section shows and what is hidden,
// so the dashboard can say how many are hidden.
function splitDismissed(rows, isDismissed) {
  const visible=[],hidden=[];
  for(const row of rows)(row.dismissKey&&isDismissed(row.dismissKey)?hidden:visible).push(row);
  return {visible,hidden};
}
module.exports={readyQueue,dismissKey,splitDismissed};
