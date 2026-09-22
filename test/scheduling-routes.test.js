"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),express=require("express"),fs=require("fs"),path=require("path");
const {schedulingRoutes}=require("../lib/scheduling/routes");
const {connectionRoutes}=require("../lib/scheduling/connection-routes");
// Exercise Express handlers without opening network sockets, so the clock
// sweep remains independent of host networking and live services.
async function call(router,{method="POST",url="/status",headers={},body={},user={active:true,can_approve:true,email:"rc@carrara.is"}}={}){
 return new Promise((resolve,reject)=>{
  const req={method,url,originalUrl:url,headers,body,user,protocol:"https",get(name){return this.headers[name.toLowerCase()];},is(type){return type==="application/json"&&this.get("content-type")==="application/json";}};
  const res={headers:{},set(k,v){this.headers[k]=v;return this;},status(code){this.statusCode=code;return this;},json(data){resolve({status:this.statusCode||200,data,headers:this.headers});}};
  router.handle(req,res,error=>error?reject(error):resolve({status:404}));
 });
}
const headers={"content-type":"application/json","x-scheduling-request":"1",host:"tracker.example",origin:"https://tracker.example"};
test("scheduling routes reject unsigned, cross-site and inactive requests",async()=>{
 let called=0;const routes=schedulingRoutes({approve:async()=>{called++;return {};}});
 for(const h of [{}, {...headers,origin:"https://other.example"}])assert.equal((await call(routes,{url:"/proposals/test/approve",headers:h})).status,403);
 assert.equal((await call(routes,{url:"/proposals/test/approve",headers,user:{active:false}})).status,401);
 assert.equal(called,0);assert.equal((await call(routes,{url:"/proposals/test/approve",headers})).status,200);assert.equal(called,1);
});
test("worker proxy refuses unconfigured service and approval permission failures",async()=>{
 const routes=connectionRoutes({});assert.equal((await call(routes,{headers})).status,503);
 assert.equal((await call(routes,{headers,user:{active:true,can_approve:false}})).status,403);
});
test("worker proxy binds owner to authenticated user and requires HTTPS",async()=>{
 let payload;const routes=connectionRoutes({url:"https://worker.example",secret:"s".repeat(40),fetchImpl:async(url,options)=>{payload=JSON.parse(options.body);return {status:200,json:async()=>({ok:true})};}});
 assert.equal((await call(routes,{url:"/start",headers,body:{owner:"forged@carrara.is"}})).status,200);assert.equal(payload.owner,"rc@carrara.is");
 assert.equal((await call(connectionRoutes({url:"http://worker.example",secret:"s".repeat(40)}),{headers})).status,503);
});
test("new browser screens contain syntactically valid standalone scripts",()=>{
 for(const file of ["scheduling.html","ashby-connection.html"]){const html=fs.readFileSync(path.join(__dirname,"../public",file),"utf8");for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new Function(match[1]));}
});
test("schedule form shows tracker-selected partner and laptop instead of an email field",()=>{
 const html=fs.readFileSync(path.join(__dirname,"../public/scheduling.html"),"utf8");
 assert.match(html,/>Main Partner </);assert.match(html,/>Suggested laptop </);assert.doesNotMatch(html,/>Interviewer email </);
 assert.match(html,/resources\.partner/);assert.match(html,/resources\.laptop/);
});
test("schedule form defaults to a full trial and reports submit results beside the button",()=>{
 const html=fs.readFileSync(path.join(__dirname,"../public/scheduling.html"),"utf8");
 assert.match(html,/elements\.sessionTitle\.value = "Full Work Trial"/);assert.match(html,/id="formMessage"/);assert.match(html,/setMessage\(error\.message\)/);
});
