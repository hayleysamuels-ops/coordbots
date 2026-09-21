"use strict";
const express=require('express');
const {verifier}=require('../src/scheduling/worker-auth');
// The browser adapter is supplied only after its preparation, availability and
// send/readback flows are independently verified. Session existence is not that
// verification. No client body can enable an adapter or set its capabilities.
function bookingRoutes({secret,clientId,expectedIdentity,adapter=null,draftReader=null}) {
  const verify=verifier(secret),router=express.Router();
  router.post('/',express.text({type:'application/json',limit:'128kb'}),async(req,res)=>{
    res.set('Cache-Control','no-store');
    if(typeof req.body!=='string'||!verify(req.headers,req.body))return res.status(401).json({error:'Unauthorized'});
    let data;try{data=JSON.parse(req.body);}catch(_){return res.status(400).json({error:'Invalid request'});}
    if(data.clientId!==clientId||data.expectedIdentity!==expectedIdentity)return res.status(403).json({error:'Client identity mismatch'});
    try{
      let result;
      if(data.action==='inspect-draft'||data.action==='inspect-calendar'||data.action==='inspect-availability'){
        if(!draftReader)return res.status(503).json({error:'Draft inspection is not connected.'});
        result=await draftReader.inspect(data.payload,data.action==='inspect-availability'?'availability':data.action==='inspect-calendar'?'calendar':'communications');
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
