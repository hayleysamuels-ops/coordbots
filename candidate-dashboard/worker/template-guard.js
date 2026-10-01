'use strict';
// The schedule template editor is a live client's Ashby configuration and the
// one write-capable page the reader touches, because it has to click each
// event's "Interviewers" expander. This guard makes a save impossible to send,
// not merely unlikely:
//   - Every request that isn't GET, HEAD or OPTIONS is blocked unless its body
//     is GraphQL whose every operation is a query. A mutation, a persisted
//     operation we can't classify, a form post or a beacon is aborted.
//   - WebSockets are never connected (a write could travel over one).
//   - Service workers are blocked by the context (see draft-reader), because
//     their requests would bypass routing.
// Blocked requests are recorded by method, path and operation name only (no
// bodies, no query strings) so the worker log shows what Ashby tried to send.
const READS=new Set(['GET','HEAD','OPTIONS']);

function operations(body){
  let parsed;try{parsed=JSON.parse(body);}catch(_){return null;}
  const list=Array.isArray(parsed)?parsed:[parsed];
  if(!list.length)return null;
  return list.map(o=>{
    const name=typeof o?.operationName==='string'?o.operationName:null;
    if(typeof o?.query!=='string')return {name,kind:'unknown'};
    const q=o.query.replace(/#[^\n]*/g,'').trim();
    return {name,kind:q.startsWith('{')?'query':(q.match(/^(query|mutation|subscription)\b/)?.[1]||'unknown')};
  });
}

function classify({method,url,postData}){
  if(READS.has(method))return {allow:true};
  const ops=operations(postData||'');
  if(ops&&ops.every(o=>o.kind==='query'))return {allow:true};
  let path;try{path=new URL(url).pathname;}catch(_){path='(unreadable URL)';}
  return {allow:false,mutation:!!ops?.some(o=>o.kind==='mutation'),
    summary:`${method} ${path} ${ops?ops.map(o=>o.kind+(o.name?' '+o.name:'')).join(', '):'(not GraphQL)'}`};
}

async function guardWrites(context,log=console){
  const blocked=[];let phase='load',sockets=0;
  await context.route('**/*',async route=>{
    const r=route.request(),verdict=classify({method:r.method(),url:r.url(),postData:r.postData()});
    if(verdict.allow)return route.fallback();
    blocked.push({...verdict,phase});
    log.warn(`[plan-reader] Blocked a write during ${phase}: ${verdict.summary}`);
    return route.abort('blockedbyclient');
  });
  // Not connecting to the server leaves every socket inert.
  await context.routeWebSocket(/.*/,()=>{sockets++;});
  return {
    blocked,
    get sockets(){return sockets;},
    expanding(){phase='expanding';},
    // A mutation at any point, or any write while expanding, stops the read.
    // Unclassifiable requests during page load are blocked and logged but don't
    // fail the read: they're usually telemetry, and they never reached Ashby.
    problem(){return blocked.find(b=>b.mutation||b.phase==='expanding')||null;},
  };
}

module.exports={guardWrites,classify};
