"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),express=require("express");
const {connectionRoutes}=require("../src/scheduling/connection-routes");
const {createWorkerApp}=require("../worker/server");
const {signed}=require("../src/scheduling/worker-auth");
const secret="s".repeat(40);
async function serve(t,app){const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});t.after(()=>{server.closeAllConnections();server.close();});return "http://127.0.0.1:"+server.address().port;}
const post=(url,body={},headers={})=>fetch(url,{method:"POST",headers:{"Content-Type":"application/json","X-Scheduling-Request":"1",...headers},body:JSON.stringify(body)});
test("gateway rejects shared users, cross-site actions and impersonated owners",async t=>{
 let payload,calls=0;
 const app=express();app.use(express.json());app.use((req,res,next)=>{if(req.get("Test-User"))req.schedulingUser={id:"actual-coordinator",canApprove:true};next();});
 app.use(connectionRoutes({url:"https://worker.example.test",secret,clientId:"test",expectedIdentity:"Test Client",fetchImpl:async(url,init)=>{calls++;payload=JSON.parse(init.body);return {status:200,ok:true,json:async()=>({clientId:"test",expectedIdentity:"Test Client",bookingEnabled:false})};}}));
 const base=await serve(t,app);
 assert.equal((await post(base+"/start")).status,403);
 assert.equal((await post(base+"/start",{}, {"Test-User":"1",Origin:"https://attacker.test"})).status,403);
 assert.equal(calls,0);
 assert.equal((await post(base+"/start",{owner:"forged",clientId:"wrong"},{"Test-User":"1"})).status,200);
 assert.equal(payload.owner,"actual-coordinator");assert.equal(payload.clientId,"test");
 assert.equal((await post(base+"/book",{}, {"Test-User":"1"})).status,404);
});
test("worker rejects cross-client requests, replay and booking commands",async t=>{
 let calls=0;const connection={status:async()=>{calls++;return {bookingEnabled:false};}};
 const base=await serve(t,createWorkerApp({connection,secret,clientId:"test",expectedIdentity:"Test Client"}));
 const send=payload=>{const req=signed(secret,payload);return fetch(base+"/connection",{method:"POST",...req});};
 assert.equal((await send({action:"status",clientId:"wrong",owner:"coordinator"})).status,403);assert.equal(calls,0);
 const req=signed(secret,{action:"status",clientId:"test",expectedIdentity:"Test Client",owner:"coordinator"});
 assert.equal((await fetch(base+"/connection",{method:"POST",...req})).status,200);
 assert.equal((await fetch(base+"/connection",{method:"POST",...req})).status,401);assert.equal(calls,1);
 assert.equal((await send({action:"book",clientId:"test",expectedIdentity:"Test Client",owner:"coordinator"})).status,400);
});
test("gateway refuses wrong worker identity and unsafe transport",async t=>{
 for(const url of ["http://public.example.test","https://worker.example.test"]){
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.schedulingUser={id:"rc",canApprove:true};next();});
 app.use(connectionRoutes({url,secret,clientId:"test",expectedIdentity:"Expected",fetchImpl:async()=>({status:200,ok:true,json:async()=>({clientId:"other",expectedIdentity:"Other"})})}));
 const base=await serve(t,app);assert.equal((await post(base+"/status")).status,503);
 }
});
