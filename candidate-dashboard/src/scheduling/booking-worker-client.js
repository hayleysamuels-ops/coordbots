"use strict";
const {signed}=require('./worker-auth');
function createBookingWorkerClient({url,secret,clientId,expectedIdentity,fetchImpl=fetch}) {
  function endpoint(){
    if(!url||!secret||secret.length<32||!clientId||!expectedIdentity)throw Object.assign(Error('The Ashby scheduling worker is not configured.'),{status:503});
    let target;try{target=new URL(url);if(target.username||target.password||target.search||target.hash||!['','/'].includes(target.pathname)||!(target.protocol==='https:'||(target.protocol==='http:'&&target.hostname==='scheduling-worker.railway.internal')))throw Error();}catch(_){throw Object.assign(Error('Invalid private scheduling worker address.'),{status:503});}
    target.pathname='/booking';return target;
  }
  async function call(action,payload={}) {
    const response=await fetchImpl(endpoint(),{method:'POST',...signed(secret,{action,clientId,expectedIdentity,payload}),redirect:'error',signal:AbortSignal.timeout(action==='inspect-calendar'?120000:55000)});
    const data=await response.json();
    if(!response.ok)throw Object.assign(Error(data.error||'Ashby scheduling worker unavailable.'),{status:response.status>=400&&response.status<500?response.status:503});
    if(data.clientId!==clientId||data.expectedIdentity!==expectedIdentity)throw Object.assign(Error('The scheduling worker identity does not match this client.'),{status:503});
    return data.result;
  }
  return {call,async capabilities(){try{const result=await call('status');return {available:result?.availabilityVerified===true&&result?.bookingVerified===true,reason:result?.reason||'The Ashby calendar reader and booking executor still need verification.'};}catch(_){return {available:false,reason:'The Ashby calendar reader and booking executor are not ready. Booking is disabled.'};}}};
}
module.exports={createBookingWorkerClient};
