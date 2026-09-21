'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {parseConfirmation}=require('../worker/confirmation-reader');
const fields=()=>({editors:['Confirmed: Welcome','Hi TEST, your virtual interview is confirmed.'],senders:['Anna <anna@example.com>','Calendar','Write with AI'],ccCollapsed:true,bccCollapsed:true,attachments:[],to:'test@example.com'});
test('extracts a unique sender and separate email editors',()=>{const r=parseConfirmation(fields());assert.equal(r.complete,true);assert.equal(r.from,'anna@example.com');assert.equal(r.subject,'Confirmed: Welcome');assert.deepEqual(r.cc,[]);});
test('missing or ambiguous senders cannot count as complete',()=>{for(const senders of [[],['a@example.com','b@example.com']]){const r=parseConfirmation({...fields(),senders});assert.equal(r.complete,false);assert.equal(r.from,null);}});
test('expanded CC or BCC cannot silently become no recipients',()=>{for(const field of ['ccCollapsed','bccCollapsed']){const r=parseConfirmation({...fields(),[field]:false});assert.equal(r.complete,false);assert.equal(r[field==='ccCollapsed'?'cc':'bcc'],null);}});
test('extra editors or an unknown candidate require further review',()=>{assert.equal(parseConfirmation({...fields(),editors:['Subject','Body','Unknown editor']}).complete,false);assert.equal(parseConfirmation({...fields(),to:null}).complete,false);});
