"use strict";
// Railway volumes mount as root. Initialize only our private session directory,
// then drop privileges before starting HTTP or Chromium. Never run Chrome root.
const fs=require("fs");
if(process.getuid && process.getuid()===0){
  fs.mkdirSync("/data/ashby",{recursive:true,mode:0o700});
  fs.chownSync("/data/ashby",1000,1000);
  process.setgroups([]);process.setgid(1000);process.setuid(1000);
}
require("./server").start();
