"use strict";
function list(value){return Array.isArray(value)?value:value?.results||[];}
function same(a,b){return String(a||"").toLowerCase()===String(b||"").toLowerCase();}
function walk(value,predicate,out=[],seen=new Set()){if(!value||typeof value!=="object"||seen.has(value))return out;seen.add(value);if(predicate(value))out.push(value);for(const child of Object.values(value))if(child&&typeof child==="object")walk(child,predicate,out,seen);return out;}
function createAshbyExecutor({api}){
  return {
    async preflight(plan){
      const application=await api.application(plan.applicationId);
      const planData=await api.interviewPlan(application.job?.id||application.jobId);
      const event=plan.events[0],users=list(await api.users(event.interviewers[0].email));
      const interviewer=users.find(u=>same(u.email,event.interviewers[0].email)&&u.enabled!==false&&u.isEnabled!==false);
      const interviews=plan.events.map(e=>walk(planData,v=>v.interviewId===e.interviewId)[0]);
      const stage=application.currentInterviewStage||application.interviewStage||{};
      const sourceFingerprint=api.fingerprint({applicationId:application.id,stageId:stage.id||stage.interviewStageId,interviewIds:interviews.map(x=>x?.interviewId),interviewerId:interviewer?.id});
      return {sourceFingerprint,available:!!interviewer&&interviews.every(Boolean),ready:same(application.status,"Active")};
    },
    async book(plan,{operationId}){
      if(plan.kind!=="new")throw new Error("Replacement booking is not enabled in the API pilot");
      return api.createSchedule({applicationId:plan.applicationId,interviewEvents:plan.events.map(event=>({startTime:event.start,endTime:event.end,interviewId:event.interviewId,interviewers:event.interviewers.map(person=>({email:person.email})),extraData:{trackerOperationId:operationId}}))});
    },
    async verify(plan,receipt){
      const events=list(receipt?.interviewEvents),expected=plan.events;
      const matches=!!receipt?.id&&events.length===expected.length&&expected.every((want,index)=>{
        const got=events[index]||{};
        return got.interviewId===want.interviewId&&Date.parse(got.startTime||got.start)===Date.parse(want.start)&&Date.parse(got.endTime||got.end)===Date.parse(want.end)&&want.interviewers.every(person=>list(got.interviewers).some(actual=>same(actual.email||actual.user?.email,person.email)));
      });
      // interviewSchedule.create records the schedule in Ashby, but its response
      // has no calendar event id or delivery receipt. A stored Ashby row must
      // never be presented as a dispatched invitation.
      return {matches,invitesConfirmed:false,scheduleId:receipt?.id||null,status:receipt?.status||null,
        deliveryStatus:"not_verified",verifiedAt:new Date().toISOString()};
    }
  };
}
module.exports={createAshbyExecutor};
