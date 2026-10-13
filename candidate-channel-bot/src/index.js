"use strict";

const config = require("./config");
const { createServer } = require("./server");

const app = createServer();

app.listen(config.port, () => {
  console.log(`[server] Candidate channel bot listening on :${config.port}`);
  console.log(`[server] Webhook endpoint: POST /webhooks/ashby`);
  console.log(`[server] Channel prefix: ${config.channelPrefix || "(unset: nothing will be archived)"}`);
  console.log(`[server] Archiving on: ${[...config.archiveOn].join(", ")}`);
  if (config.dryRun) {
    console.log("[server] DRY_RUN is on. The bot will report what it would archive and change nothing.");
  }
});
