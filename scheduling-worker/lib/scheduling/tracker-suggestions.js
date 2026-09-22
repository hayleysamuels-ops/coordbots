"use strict";
const DAY=require("../dateday"),SUGGEST=require("../suggest-assignments"),INV=require("../assignment-inventory"),DRI=require("../dri-aliases");
function todayDay(now=new Date()){const p=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));return Number(p.year+p.month+p.day);}
function value(c,key){return c?.values?.[key]??"";}
function trial(c,override){const start=override?.startDate||value(c,"startDate"),end=override?.endDate||value(c,"endDate")||start,span=DAY.trialSpan(DAY.parseDay(start),DAY.parseDay(end));if(!span)return null;return {id:c.id,span,personId:INV.personFor(value(c,"driName")),laptop:DRI.isUnset(value(c,"computer"))?null:value(c,"computer"),desk:value(c,"desk"),name:c.name||"Unnamed",role:value(c,"position")||c.position};}
function trackerSuggestions(candidate,rows,constraints,now=new Date()){
  const mine=trial(candidate,constraints);if(!mine)return {};
  const booked=(rows||[]).map(c=>trial(c)).filter(Boolean).filter(t=>t.id!==candidate.id),day=todayDay(now),out={};
  const unresolved=(rows||[]).map(c=>value(c,"driName")).filter(v=>!DRI.isUnset(v)&&!INV.personFor(v));
  if(DRI.isUnset(value(candidate,"driName")))out.partner=SUGGEST.suggestPartner({role:mine.role,span:mine.span,today:day,trials:booked,unresolved});
  const desk=value(candidate,"desk");if(INV.isDeskNeeded(desk)&&INV.isDeskRequest(desk))out.desk=SUGGEST.suggestDesk({span:mine.span,today:day,trials:booked,current:desk,role:mine.role});
  if(INV.isLaptopRequest(value(candidate,"computer")))out.laptop=SUGGEST.suggestLaptop({span:mine.span,today:day,trials:booked,location:value(candidate,"location"),role:mine.role});
  return out;
}
module.exports={trackerSuggestions,todayDay};
