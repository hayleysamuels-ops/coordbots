'use strict';
// The topbar logo per client (client-logo.js): CLIENT_LOGO names a file in
// public/assets/clients/, falling back to Carrara's mark.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {resolveClientLogo}=require('../src/client-logo');

const assetsDir=fs.mkdtempSync(path.join(os.tmpdir(),'logo-'));
fs.mkdirSync(path.join(assetsDir,'clients'));
for(const f of ['acme.svg','acme-dark.svg','solo.png'])fs.writeFileSync(path.join(assetsDir,'clients',f),'x');
const base=p=>p&&path.basename(p);
const pick=slug=>{const r=resolveClientLogo(slug,{assetsDir});return {light:base(r.light),dark:base(r.dark),warned:!!r.warning};};

test('unset shows Carrara\'s mark, light and dark, with no warning',()=>{
  assert.deepEqual(pick(''),{light:'carrara-iso-grafite.svg',dark:'carrara-iso-marmol.svg',warned:false});
});
test('a client file is used, with its dark version when there is one',()=>{
  assert.deepEqual(pick('acme'),{light:'acme.svg',dark:'acme-dark.svg',warned:false});
  assert.deepEqual(pick('solo'),{light:'solo.png',dark:'solo.png',warned:false});
});
test('a name with no file, or that isn\'t a plain file name, warns and shows Carrara\'s mark',()=>{
  assert.deepEqual(pick('nobody'),{light:'carrara-iso-grafite.svg',dark:'carrara-iso-marmol.svg',warned:true});
  assert.equal(pick('../acme').warned,true);
});
test('the repo ships Carrara\'s two marks where the fallback expects them',()=>{
  const real=resolveClientLogo('',{assetsDir:path.join(__dirname,'..','public','assets')});
  assert.ok(fs.existsSync(real.light)&&fs.existsSync(real.dark));
});
