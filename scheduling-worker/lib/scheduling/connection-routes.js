"use strict";
const express=require("express");
const {canApprove}=require("../../users");
const {signed}=require("./worker-auth");
function connectionRoutes({url,secret,fetchImpl=fetch}) {
  const router=express.Router();
  router.use((req,res,next)=>{
    res.set("Cache-Control","no-store");
    if(!canApprove(req.user))return res.status(403).json({error:"Coordinator approval permission is required"});
    if(!req.is("application/json")||req.get("X-Scheduling-Request")!=="1")return res.status(403).json({error:"Invalid connection request"});
    if(req.get("Origin")&&req.get("Origin")!==req.protocol+"://"+req.get("host"))return res.status(403).json({error:"Cross-site connection request refused"});
    next();
  });
  router.post("/:action",async(req,res)=>{
    if(!["status","start","frame","input","finish","cancel"].includes(req.params.action))return res.status(404).json({error:"Unknown connection action"});
    if(!url||!secret||secret.length<32)return res.status(503).json({error:"Railway sign-in worker has not been configured yet."});
    let endpoint;try{endpoint=new URL("/connection",url);// Railway private traffic is encrypted by Wireguard. Only the exact
    // worker hostname is allowed over HTTP; public endpoints require TLS.
    if(endpoint.protocol!=="https:" && !(endpoint.protocol==="http:" && endpoint.hostname==="scheduling-worker.railway.internal"))throw new Error();}catch(_){return res.status(503).json({error:"Worker requires HTTPS or its encrypted Railway private network."});}
    try {
      const request=signed(secret,{action:req.params.action,owner:req.user.email,id:req.body.id,input:req.body.input});
      const response=await fetchImpl(endpoint,{method:"POST",...request,redirect:"error",signal:AbortSignal.timeout(55000)});
      const data=await response.json();res.status(response.status).json(data);
    } catch(error) {
      const code = error.cause?.code || error.code;
      const details = { ENOTFOUND: "Private worker hostname could not be resolved.", ECONNREFUSED: "Private worker is not listening on its configured port.", ETIMEDOUT: "Private worker connection timed out.", ECONNRESET: "Private worker closed the connection." };
      const detail = details[code] || "The Railway sign-in worker could not be reached.";
      console.warn("[ashby-connection]", details[code] ? code : "connection_failed");
      res.status(503).json({error: detail + " No connection success has been confirmed."});
    }
  });
  return router;
}
module.exports={connectionRoutes};
