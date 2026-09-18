"use strict";
const crypto = require("crypto"), fs = require("fs"), path = require("path");
function createVault(file, keyHex) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex || "")) throw new Error("A dedicated 32-byte session encryption key is required");
  const key = Buffer.from(keyHex,"hex");
  return {
    load() {
      let packet; try { packet = JSON.parse(fs.readFileSync(file,"utf8")); } catch(error) { if(error.code === "ENOENT") return null; throw new Error("Session cannot be read"); }
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm",key,Buffer.from(packet.iv,"hex"));
        decipher.setAuthTag(Buffer.from(packet.tag,"hex"));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(packet.data,"base64")),decipher.final()]).toString("utf8"));
      } catch (_) { throw new Error("Session cannot be decrypted"); }
    },
    save(state) {
      const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv("aes-256-gcm",key,iv);
      const data=Buffer.concat([cipher.update(JSON.stringify(state),"utf8"),cipher.final()]);
      fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
      fs.writeFileSync(file+".tmp",JSON.stringify({iv:iv.toString("hex"),tag:cipher.getAuthTag().toString("hex"),data:data.toString("base64")}),{mode:0o600});
      fs.renameSync(file+".tmp",file);
    },
  };
}
module.exports = { createVault };
