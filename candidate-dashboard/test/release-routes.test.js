'use strict';
// The review routes' release action (src/scheduling/routes.js): approvers
// only, same-site only, and the release needs the preview's token.
const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {routes}=require('../src/scheduling/routes');
async function fixture(t,{ashbyCheck}={}){
  const calls=[];const service={ashbyCheck:ashbyCheck===undefined?{preview:async id=>{calls.push(['preview',id]);return {scheduleId:id,token:'t1',clearing:[]};},
    release:async(id,token,user)=>{calls.push(['release',id,token,user.id]);return {scheduleId:id,released:[]};}}:ashbyCheck};
  const app=express();app.use(express.json());
  app.use((req,res,next)=>{const u=req.get('X-Test-User');if(u)req.schedulingUser={id:u,canApprove:u==='coordinator'};next();});
  app.use('/review',routes(service));
  const server=app.listen(0);t.after(()=>server.close());await new Promise(r=>server.once('listening',r));
  return {url:`http://127.0.0.1:${server.address().port}/review`,calls};
}
const headers={'X-Test-User':'coordinator','X-Scheduling-Request':'1','Content-Type':'application/json'};
const post=(url,body,h=headers)=>fetch(url,{method:'POST',headers:h,body:JSON.stringify(body)});
test('release is for approvers only, same-site, and passes the preview\'s token through',async t=>{
  const f=await fixture(t);
  assert.equal((await post(f.url+'/release/preview',{scheduleId:'s'},{...headers,'X-Test-User':'viewer'})).status,403);
  assert.equal((await post(f.url+'/release',{scheduleId:'s',token:'t1'},{...headers,Origin:'https://evil.example'})).status,403);
  assert.equal((await post(f.url+'/release',{scheduleId:'s',token:'t1'},{'X-Test-User':'coordinator','Content-Type':'application/json'})).status,403,'no scheduling header');
  assert.deepEqual(f.calls,[],'nothing reached the release');
  assert.equal((await (await post(f.url+'/release/preview',{scheduleId:'s'})).json()).token,'t1');
  assert.equal((await post(f.url+'/release',{scheduleId:'s',token:'t1'})).status,200);
  assert.deepEqual(f.calls,[['preview','s'],['release','s','t1','coordinator']]);
});
test('without the Ashby check running there\'s nothing to release',async t=>{
  const f=await fixture(t,{ashbyCheck:null});
  const r=await post(f.url+'/release/preview',{scheduleId:'s'});
  assert.equal(r.status,503);assert.match((await r.json()).error,/isn't running here/);
});
