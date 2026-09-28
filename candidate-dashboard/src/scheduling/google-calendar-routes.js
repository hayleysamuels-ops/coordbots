'use strict';
const express=require('express');
const COOKIE='__Host-calendar-oauth';
function googleCalendarRoutes({connection,freeBusy}){
  const router=express.Router();
  router.use((req,res,next)=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});next();});
  // The callback is still behind dashboard Basic Auth. Its own single-use state
  // and HttpOnly browser cookie bind it to the coordinator who started OAuth.
  router.get('/callback',async(req,res)=>{
    const cookies=(req.get('Cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(COOKIE+'='));
    const browserToken=cookies.length===1?cookies[0].slice(COOKIE.length+1):null;
    res.clearCookie(COOKIE,{path:'/',secure:true,httpOnly:true,sameSite:'lax'});
    try{await connection.finish({state:req.query.state,browserToken,code:req.query.code,error:req.query.error});res.redirect(303,'/google-calendar.html?connection=saved');}
    catch(_){res.redirect(303,'/google-calendar.html?connection=failed');}
  });
  router.use((req,res,next)=>{
    if(!req.schedulingUser?.canApprove)return res.status(403).json({error:'Sign in with your coordinator account to manage Google Calendar.'});
    if(req.method!=='GET'){
      if(!req.is('application/json')||req.get('X-Scheduling-Request')!=='1'||req.get('Sec-Fetch-Site')==='cross-site')return res.status(403).json({error:'Invalid calendar connection request.'});
      try{if(req.get('Origin')&&new URL(req.get('Origin')).host!==req.get('host'))throw Error();}catch(_){return res.status(403).json({error:'Cross-site connection request refused.'});}
    }
    next();
  });
  const handle=fn=>async(req,res)=>{try{res.json(await fn(req,res));}catch(e){res.status(e.status||503).json({error:e.status?e.message:'Google Calendar connection could not be confirmed.'});}};
  router.get('/status',handle(()=>connection.status()));
  router.post('/start',handle(async(req,res)=>{const result=await connection.start(req.schedulingUser.id);res.cookie(COOKIE,result.browserToken,{secure:true,httpOnly:true,sameSite:'lax',path:'/',maxAge:600000});return {url:result.url};}));
  router.post('/disconnect',handle(req=>connection.disconnect(req.schedulingUser.id)));
  router.post('/verify',handle(async()=>{const state=connection.status(),start=Date.now()+60000;await freeBusy.read({calendarIds:[state.expectedEmail],timeMin:new Date(start).toISOString(),timeMax:new Date(start+1800000).toISOString()});return {verified:true,email:state.expectedEmail,checkedAt:Date.now(),message:'Read-only availability access is working for the connected account. Each interviewer’s calendar must also be checked.'};}));
  return router;
}
module.exports={googleCalendarRoutes};
