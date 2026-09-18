"use strict";
const express=require("express");
const {verifier}=require("../src/scheduling/worker-auth");
const {createConnection}=require("./connection");
const {createVault}=require("./session-vault");
function createWorkerApp({connection,secret,clientId,expectedIdentity}) {
  if(!clientId || !expectedIdentity) throw new Error("Worker client is required");
  const verify=verifier(secret),app=express();
  app.get("/health",(req,res)=>res.json({service:"scheduling-connection",bookingEnabled:false}));
  app.post("/connection",express.text({type:"application/json",limit:"16kb"}),async(req,res)=>{
    res.set("Cache-Control","no-store");
    if(typeof req.body!=="string"||!verify(req.headers,req.body))return res.status(401).json({error:"Unauthorized"});
    let data;try{data=JSON.parse(req.body);}catch(_){return res.status(400).json({error:"Invalid request"});}
    if(data.clientId!==clientId || data.expectedIdentity!==expectedIdentity || typeof data.owner!=="string" || !data.owner || data.owner.length>200)
      return res.status(403).json({error:"Client and coordinator identity required"});
    try {
      let result;
      switch(data.action){
        case "status":result=await connection.status();break;
        case "start":result=await connection.start(data.owner);break;
        case "frame":result=await connection.frame(data.owner,data.id);break;
        case "input":result=await connection.act(data.owner,data.id,data.input||{});break;
        case "finish":result=await connection.finish(data.owner,data.id);break;
        case "cancel":result=await connection.cancel(data.owner,data.id);break;
        default:return res.status(400).json({error:"Unknown connection action"});
      }
      res.json(result);
    }catch(error){res.status(error.status||503).json({error:error.status?error.message:"Ashby connection unavailable. No connection success has been confirmed."});}
  });
  return app;
}
function start(){
  const clientId=process.env.SCHEDULING_CLIENT_ID;
  if(!process.env.ASHBY_SESSION_FILE)throw new Error("Persistent session volume required");
  const isolation=process.env.ASHBY_BROWSER_ISOLATION||"sandbox";
  if(!["sandbox","container"].includes(isolation))throw new Error("Unknown browser isolation configuration");
  // Container mode is an operator-only choice requiring explicit owner approval.
  // The dashboard cannot choose or change browser isolation.
  const connection=createConnection({clientId,expectedIdentity:process.env.ASHBY_EXPECTED_IDENTITY,
    chromium:require("playwright").chromium,chromiumSandbox:isolation==="sandbox",
    vault:createVault(process.env.ASHBY_SESSION_FILE,process.env.ASHBY_SESSION_KEY)});
  const app=createWorkerApp({connection,clientId,expectedIdentity:process.env.ASHBY_EXPECTED_IDENTITY,secret:process.env.ASHBY_WORKER_SECRET});
  const server=app.listen(process.env.PORT||3001,"::");
  process.on("SIGTERM",()=>{server.close();connection.close().finally(()=>process.exit(0));});
}
module.exports={createWorkerApp,start};
