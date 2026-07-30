"use strict";

const config = require("./config");
const { createServer } = require("./server");
const issues = require("./issues");

const app = createServer();

console.log(`[server] Data directory: ${config.dataDir}`);

issues.start();

app.listen(config.port, () => {
  console.log(`[server] Candidate dashboard listening on :${config.port}`);
});
