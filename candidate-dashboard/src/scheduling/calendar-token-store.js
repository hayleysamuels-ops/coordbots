'use strict';
const crypto=require('crypto'),fs=require('fs'),path=require('path');
function calendarTokenStore({file,keyHex,binding}){
  if(!/^[a-f0-9]{64}$/i.test(keyHex||'')||!binding)throw Error('Calendar token encryption is not configured.');
  const key=Buffer.from(keyHex,'hex'),aad=Buffer.from(binding);
  return {
    load(){let packet;try{packet=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw Error('Calendar connection cannot be read.');}
      try{const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(packet.iv,'hex'));d.setAAD(aad);d.setAuthTag(Buffer.from(packet.tag,'hex'));return JSON.parse(Buffer.concat([d.update(Buffer.from(packet.data,'base64')),d.final()]).toString());}catch(_){throw Error('Calendar connection cannot be decrypted.');}},
    save(value){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(aad);const data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file+'.tmp',JSON.stringify({iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),data:data.toString('base64')}),{mode:0o600});fs.renameSync(file+'.tmp',file);},
    clear(){this.save(null);}
  };
}
module.exports={calendarTokenStore};
