'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createBookingWorkerClient}=require('../src/scheduling/booking-worker-client');
const settings={url:'https://worker.example',secret:'x'.repeat(40),clientId:'client',expectedIdentity:'Coordinator Client'};
test('saved connection cannot imply verified booking capability',async()=>{const client=createBookingWorkerClient({...settings,fetchImpl:async()=>({ok:true,json:async()=>({clientId:'client',expectedIdentity:'Coordinator Client',result:{sessionSaved:true}})})});assert.equal((await client.capabilities()).available,false);});
test('wrong client and redirects cannot turn booking on',async()=>{let options;const client=createBookingWorkerClient({...settings,fetchImpl:async(url,opts)=>{options=opts;return {ok:true,json:async()=>({clientId:'other',expectedIdentity:'Coordinator Client',result:{availabilityVerified:true,bookingVerified:true}})};}});assert.equal((await client.capabilities()).available,false);assert.equal(options.redirect,'error');});
test('worker URL cannot send credentials to an arbitrary insecure host',async()=>{let called=false;const client=createBookingWorkerClient({...settings,url:'http://other.internal',fetchImpl:async()=>{called=true;}});assert.equal((await client.capabilities()).available,false);assert.equal(called,false);});
