"use strict";
const express = require("express");
const { verifier } = require("../lib/scheduling/worker-auth");
const { createVault } = require("./session-vault");
const { createConnection } = require("./connection");
const {createSchedulingStore}=require("../lib/scheduling/store");
const {createWorker}=require("../lib/scheduling/worker");
const {createAshbySchedulingApi}=require("../lib/scheduling/ashby-api");
const {createAshbyExecutor}=require("../lib/scheduling/ashby-executor");
const verify=verifier(process.env.ASHBY_WORKER_SECRET);
if(!process.env.ASHBY_SESSION_FILE) throw new Error("ASHBY_SESSION_FILE must point to a persistent private volume");
const isolation=process.env.ASHBY_BROWSER_ISOLATION||"sandbox";
if(!["sandbox","container"].includes(isolation))throw new Error("Unknown browser isolation configuration");
// Container mode requires an explicit owner decision. It cannot be selected by
// a browser request, and is not enabled in the deployed Railway configuration.
const connection=createConnection({chromium:require("playwright").chromium,
  chromiumSandbox:isolation==="sandbox",vault:createVault(process.env.ASHBY_SESSION_FILE,process.env.ASHBY_SESSION_KEY)});
const app=express();
let runner=null,timer=null;
if(process.env.SCHEDULING_EXECUTION_ENABLED==="true"&&process.env.ASHBY_SCHEDULING_KEY&&process.env.DATABASE_URL){
  const {Pool}=require("pg"),pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:/localhost|127\.0\.0\.1|\.railway\.internal/.test(process.env.DATABASE_URL)?false:{rejectUnauthorized:false}});
  const schedulingStore=createSchedulingStore({pool});
  const api=createAshbySchedulingApi(process.env.ASHBY_SCHEDULING_KEY);
  runner=createWorker({store:schedulingStore,executor:createAshbyExecutor({api}),userByEmail:async email=>(await pool.query("SELECT * FROM users WHERE lower(email)=lower($1)",[email])).rows[0]||null});
  let busy=false;timer=setInterval(async()=>{if(busy)return;busy=true;try{for(const row of await schedulingStore.list())if(row.state==="approved")await runner.execute(row.id);}catch(_){console.error("[scheduling-worker] queue sweep failed");}finally{busy=false;}},5000);timer.unref();
}
app.get("/health",(req,res)=>res.json({service:"scheduling-worker",bookingEnabled:!!runner,method:runner?"ashby-api":null}));
app.post("/connection",express.text({type:"application/json",limit:"16kb"}),async(req,res)=>{
  res.set("Cache-Control","no-store");
  if(typeof req.body!=="string"||!verify(req.headers,req.body)) return res.status(401).json({error:"Unauthorized"});
  let data; try { data=JSON.parse(req.body); } catch(_){ return res.status(400).json({error:"Invalid request"}); }
  if(typeof data.owner!=="string"||!data.owner.endsWith("@carrara.is")) return res.status(403).json({error:"Coordinator identity required"});
  try {
    let result;
    switch(data.action) {
      case "status":result=await connection.status();break;
      case "start":result=await connection.start(data.owner);break;
      case "frame":result=await connection.frame(data.owner,data.id);break;
      case "input":result=await connection.act(data.owner,data.id,data.input||{});break;
      case "finish":result=await connection.finish(data.owner,data.id);break;
      case "cancel":result=await connection.cancel(data.owner,data.id);break;
      default:return res.status(400).json({error:"Unknown connection action"});
    }
    res.json(result);
  } catch(error) {
    // Never log raw Playwright errors: these can contain typed credentials.
    res.status(error.status||503).json({error:error.status?error.message:"Worker browser unavailable. Reopen sign-in or ask the administrator to check its deployment."});
  }
});
const server=app.listen(process.env.PORT||3001,"::",()=>console.log("[scheduling-worker] listening on",process.env.PORT||3001));
async function stop(){if(timer)clearInterval(timer);server.close();await connection.close();}
process.on("SIGTERM",()=>stop().finally(()=>process.exit(0)));
