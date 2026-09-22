"use strict";

// The first deploy is an infrastructure check only. Do not replace this with a
// booking loop until the Ashby adapter has been verified with Test Tess.
const fs = require("fs");
const http = require("http");
const status = {
  service: "scheduling-worker", bookingEnabled: false,
  playwrightInstalled: !!require("playwright").chromium,
  sessionFilePresent: !!process.env.ASHBY_WORKER_STORAGE_STATE && fs.existsSync(process.env.ASHBY_WORKER_STORAGE_STATE),
  databaseConfigured: !!process.env.DATABASE_URL,
  blockers: ["Ashby booking adapter has not been verified", "Live booking is disabled"],
};
http.createServer((req, res) => {
  if (req.url !== "/health") { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(status));
}).listen(process.env.PORT || 3001);
