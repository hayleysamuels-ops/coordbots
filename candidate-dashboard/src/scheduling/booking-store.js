"use strict";
const fs=require("fs"),path=require("path");
function createBookingStore(dir){
 const file=path.join(dir,"booking-ledger.json"),lock=file+".lock";
 function read(){try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch(e){if(e.code==="ENOENT")return {};throw e;}}
 function mutate(fn){fs.mkdirSync(dir,{recursive:true,mode:0o700});let fd;try{fd=fs.openSync(lock,"wx",0o600);}catch(_){throw Object.assign(new Error("Booking ledger requires recovery or is busy"),{status:409});}
 try{const rows=read(),result=fn(rows),tmp=file+".tmp",out=fs.openSync(tmp,"w",0o600);try{fs.writeFileSync(out,JSON.stringify(rows));fs.fsyncSync(out);}finally{fs.closeSync(out);}fs.renameSync(tmp,file);const d=fs.openSync(dir,"r");try{fs.fsyncSync(d);}finally{fs.closeSync(d);}return result;}finally{fs.closeSync(fd);fs.unlinkSync(lock);}}
 return {get:async id=>read()[id]||null,list:async()=>Object.values(read()),
 insert:async row=>mutate(rows=>{if(rows[row.id]||Object.values(rows).some(r=>r.clientId===row.clientId&&r.plan.candidateId===row.plan.candidateId&&!['scheduled','rejected','needs_review'].includes(r.state)))return false;rows[row.id]=row;return true;}),
 replace:async(id,revision,next)=>mutate(rows=>{if(next.id!==id||next.revision!==revision+1)throw new Error("Invalid revision");if(rows[id]?.revision!==revision)return false;
 // No candidate may execute while another write is in flight or uncertain.
 if(['checking','submitting'].includes(next.state)&&Object.values(rows).some(r=>r.id!==id&&r.clientId===next.clientId&&['checking','submitting','reconciliation_required'].includes(r.state)))return false;
 rows[id]=next;return true;})};
}
module.exports={createBookingStore};
