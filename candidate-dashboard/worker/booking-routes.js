"use strict";
const express=require('express');
const {verifier}=require('../src/scheduling/worker-auth');
// The browser adapter is supplied only after its preparation, availability and
// send/readback flows are independently verified. Session existence is not that
// verification. No client body can enable an adapter or set its capabilities.
//
// `compose` and `discard-draft` are the Slack-approved check and its sweep
// (booking-compose.js, loaded only for them). They're the only actions here
// that write to Ashby, and Send is never among their writes. `ashby` supplies
// what they need: the worker's env, Chromium, the saved session and the
// sign-in connection; without it they answer 503.
//
// Ashby work takes turns: any number of inspections at once, or one write
// task (a check or a delete). A write task waits up to `writeWaitMs` for
// running inspections to finish; an inspection that arrives during one is
// told Ashby is busy.
function bookingRoutes({secret,clientId,expectedIdentity,adapter=null,draftReader=null,ashby=null,writeWaitMs=120000,sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
  const verify=verifier(secret),router=express.Router();
  let inspections=0,writing=false;
  const busy=()=>Object.assign(Error('Ashby is busy checking an approved schedule. Try again in a minute.'),{status:409});
  async function exclusively(task){
    if(writing)throw busy();
    writing=true;// claimed now, so no inspection starts while this waits
    try{
      const until=Date.now()+writeWaitMs;
      while(inspections>0){if(Date.now()>=until)throw Object.assign(Error('Ashby was busy with another check for two minutes, so this one didn\'t start.'),{status:409,busy:true});await sleep(250);}
      if(ashby.connection&&(await ashby.connection.status()).signInOpen)throw Object.assign(Error('The Ashby sign-in window is open, so this check didn\'t start. Close it and try again.'),{status:409,busy:true});
      return await task();
    }finally{writing=false;}
  }
  router.post('/',express.text({type:'application/json',limit:'128kb'}),async(req,res)=>{
    res.set('Cache-Control','no-store');
    if(typeof req.body!=='string'||!verify(req.headers,req.body))return res.status(401).json({error:'Unauthorized'});
    let data;try{data=JSON.parse(req.body);}catch(_){return res.status(400).json({error:'Invalid request'});}
    if(data.clientId!==clientId||data.expectedIdentity!==expectedIdentity)return res.status(403).json({error:'Client identity mismatch'});
    try{
      let result;
      if(data.action==='inspect-full-calendar'||data.action==='inspect-plan'||data.action==='inspect-draft'||data.action==='inspect-calendar'||data.action==='inspect-availability'){
        if(!draftReader)return res.status(503).json({error:'Draft inspection is not connected.'});
        if(writing)throw busy();
        inspections++;
        try{result=await draftReader.inspect(data.payload,data.action==='inspect-full-calendar'?'full-calendar':data.action==='inspect-plan'?'plan':data.action==='inspect-availability'?'availability':data.action==='inspect-calendar'?'calendar':'communications');}
        finally{inspections--;}
      }
      else if(data.action==='compose'||data.action==='discard-draft'){
        if(!ashby)return res.status(503).json({error:'The Ashby check is not connected.'});
        const run=require('./booking-compose')[data.action==='compose'?'compose':'discard'];
        result=await exclusively(()=>run({...ashby,payload:data.payload,clientId,expectedIdentity}));
      }
      else if(data.action==='status')result=adapter?await adapter.status():{availabilityVerified:false,bookingVerified:false,reason:'The saved Ashby connection is available for sign-in. Automatic calendar reading and booking still need verification.'};
      else {
        const status=adapter?await adapter.status():null;
        if(!status?.availabilityVerified||!status?.bookingVerified)return res.status(503).json({error:'Automatic scheduling has not been verified for this client.'});
        // Execute requires a separate, persisted approval dispatch protocol. It
        // is deliberately not exposed by this read-only capability endpoint.
        return res.status(400).json({error:'Unknown booking action'});
      }
      res.json({clientId,expectedIdentity,result});
    }catch(error){res.status(error.status||503).json({error:error.status?error.message:'Could not verify the scheduling worker.'});}
  });
  return router;
}
module.exports={bookingRoutes};
