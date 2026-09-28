'use strict';
const {windowsToInstants}=require('./booking-planner');
function workingHoursOverride(input,coordinator,now=Date.now()){
  if(input==null)return null;
  if(!coordinator?.id||coordinator.canApprove!==true)throw Object.assign(Error('A coordinator is required to enter working hours.'),{status:403});
  const windows=windowsToInstants(input.windows,input.timezone,now);
  return {source:'coordinator_override',enteredBy:coordinator.id,checkedAt:now,timezone:input.timezone,windows:windows.map(w=>({start:new Date(w.start).toISOString(),end:new Date(w.end).toISOString()}))};
}
module.exports={workingHoursOverride};
