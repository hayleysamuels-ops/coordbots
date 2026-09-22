"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("fs"),os=require("os"),path=require("path");
const {signed,verifier}=require("../lib/scheduling/worker-auth");
const {createVault}=require("../worker/session-vault");
const {createConnection}=require("../worker/connection");
test("worker requests reject tampering, expiry and replay",()=>{
 const secret="s".repeat(40),check=verifier(secret,()=>100000),request=signed(secret,{action:"start",owner:"rc@example.com"},100000);
 const headers=Object.fromEntries(Object.entries(request.headers).map(([k,v])=>[k.toLowerCase(),v]));
 assert.equal(check(headers,request.body+" "),false);assert.equal(check(headers,request.body),true);assert.equal(check(headers,request.body),false);
 const old=signed(secret,{},1);assert.equal(check(Object.fromEntries(Object.entries(old.headers).map(([k,v])=>[k.toLowerCase(),v])),old.body),false);
});
test("session vault persists encrypted data, detects tampering and wrong key",t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"ashby-vault-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,"session.enc"),vault=createVault(file,"ab".repeat(32)),state={cookies:[{value:"secret-cookie-example"}]};
 assert.equal(vault.load(),null);vault.save(state);assert.deepEqual(vault.load(),state);assert.ok(!fs.readFileSync(file,"utf8").includes("secret-cookie-example"));
 assert.equal(fs.statSync(file).mode&0o777,0o600);assert.throws(()=>createVault(file,"cd".repeat(32)).load(),/decrypt/);
 const packet=JSON.parse(fs.readFileSync(file));packet.tag="00".repeat(16);fs.writeFileSync(file,JSON.stringify(packet));assert.throws(()=>vault.load(),/decrypt/);
});
function fake(){let saved=null,identity=true,closed=0,route,launchOptions;
 const listeners={},pages=[];
 function makePage(url="https://app.ashbyhq.com/home"){let current=url,isClosed=false;const handlers={};return {goto:async value=>{current=value;},url:()=>current,isClosed:()=>isClosed,on:(event,fn)=>{handlers[event]=fn;},emit:event=>handlers[event]?.(),close:()=>{isClosed=true;},screenshot:async()=>Buffer.from(current),getByRole:()=>({count:async()=>identity?1:0}),mouse:{click:async()=>{},wheel:async()=>{}},keyboard:{insertText:async()=>{},press:async()=>{}}};}
 const page=makePage();pages.push(page);
 let firstPage=true;
 const context={route:async(pattern,fn)=>{route=fn;},newPage:async()=>{if(firstPage){firstPage=false;return page;}const next=makePage("about:blank");pages.push(next);listeners.page?.(next);return next;},on:(event,fn)=>{listeners[event]=fn;},pages:()=>pages,storageState:async()=>({cookies:[{value:"test"}]})};
 return {chromium:{launch:async options=>{launchOptions=options;return {newContext:async()=>context,close:async()=>{closed++;}};}},vault:{save:value=>{saved=value;},load:()=>saved},popup(url="about:blank"){const next=makePage(url);pages.push(next);listeners.page?.(next);return next;},closeAll(){pages.forEach(item=>item.close());},get launchOptions(){return launchOptions;},get saved(){return saved;},set identity(v){identity=v;},get route(){return route;},get closed(){return closed;}};
}
test("sign-in lease belongs to one coordinator and saving requires Poetic identity",async t=>{
 const f=fake(),c=createConnection(f);t.after(()=>c.close());const session=await c.start("owner@carrara.is");
 await assert.rejects(c.start("other@carrara.is"),{status:409});await assert.rejects(c.frame("other@carrara.is",session.id),{status:403});
 await assert.rejects(c.act("owner@carrara.is",session.id,{type:"click",x:-1,y:2}),{status:400});
 f.identity=false;await assert.rejects(c.finish("owner@carrara.is",session.id),{status:409});assert.equal(f.saved,null);
 f.identity=true;assert.equal((await c.finish("owner@carrara.is",session.id)).bookingEnabled,false);assert.ok(f.saved);assert.equal(f.closed,1);
 await assert.rejects(c.frame("owner@carrara.is",session.id),{status:403});
});
test("expired login cannot be used and navigation refuses unknown destinations",async t=>{
 const f=fake();let clock=100;const c=createConnection({...f,now:()=>clock});t.after(()=>c.close());const session=await c.start("owner@carrara.is");
 let outcome;await f.route({request:()=>({isNavigationRequest:()=>true,url:()=>"http://169.254.169.254/"}),abort:()=>{outcome="blocked";},continue:()=>{outcome="allowed";}});assert.equal(outcome,"blocked");
 clock+=16*60*1000;await assert.rejects(c.frame("owner@carrara.is",session.id),{status:403});
});
test("deployed image starts the connection server after dropping root privileges",()=>{
 const vm=require("vm"),root=path.join(__dirname,"../worker"),docker=fs.readFileSync(path.join(root,"Dockerfile"),"utf8");
 const command=JSON.parse(docker.match(/^CMD (.+)$/m)[1]);assert.deepEqual(command,["node","worker/bootstrap.js"]);
 const calls=[];
 vm.runInNewContext(fs.readFileSync(path.join(root,"bootstrap.js"),"utf8"),{
  process:{getuid:()=>0,setgroups:()=>calls.push("groups"),setgid:()=>calls.push("gid"),setuid:()=>calls.push("uid")},
  require:name=>{if(name==="fs")return {mkdirSync:()=>{},chownSync:()=>{}};assert.equal(name,"./server");calls.push("server");}
 });
 assert.deepEqual(calls,["groups","gid","uid","server"]);
});

test("browser sandbox is the default and alternative isolation must be server-configured",async t=>{
 const strict=fake(),normal=createConnection(strict);t.after(()=>normal.close());await normal.start("owner@carrara.is");assert.equal(strict.launchOptions.chromiumSandbox,true);
 const alternative=fake(),explicit=createConnection({...alternative,chromiumSandbox:false});t.after(()=>explicit.close());await explicit.start("owner@carrara.is");assert.equal(alternative.launchOptions.chromiumSandbox,false);
});
test("OAuth blank popup does not replace Ashby and a closed login popup falls back",async t=>{
 const f=fake(),c=createConnection(f);t.after(()=>c.close());const session=await c.start("owner@carrara.is");
 const blank=f.popup();assert.equal((await c.frame("owner@carrara.is",session.id)).origin,"https://app.ashbyhq.com");
 blank.goto("https://accounts.google.com/signin");blank.emit("domcontentloaded");assert.equal((await c.frame("owner@carrara.is",session.id)).origin,"https://accounts.google.com");
 blank.close();assert.equal((await c.frame("owner@carrara.is",session.id)).origin,"https://app.ashbyhq.com");
});
test("closing every OAuth page reopens Ashby in the same browser context",async t=>{
 const f=fake(),c=createConnection(f);t.after(()=>c.close());const session=await c.start("owner@carrara.is");
 const google=f.popup("https://accounts.google.com/signin");google.emit("domcontentloaded");
 f.closeAll();
 // The fixed recovery URL is opened without replacing the browser context.
 const originalFrame=await c.frame("owner@carrara.is",session.id);assert.equal(originalFrame.origin,"https://app.ashbyhq.com");
});
test("only an HTTPS app.ashbyhq.com magic link can navigate the worker",async t=>{
 const f=fake(),c=createConnection(f);t.after(()=>c.close());const session=await c.start("owner@carrara.is");
 await assert.rejects(c.act("owner@carrara.is",session.id,{type:"navigate",url:"https://accounts.google.com/signin"}),{status:400});
 await assert.rejects(c.act("owner@carrara.is",session.id,{type:"navigate",url:"javascript:alert(1)"}),{status:400});
 await c.act("owner@carrara.is",session.id,{type:"navigate",url:"https://app.ashbyhq.com/magic-link?token=test-token"});
 assert.equal((await c.frame("owner@carrara.is",session.id)).origin,"https://app.ashbyhq.com");
});
