"use strict";

const config = require("./config");
const { createServer } = require("./server");
const reminders = require("./reminders");

const app = createServer();

reminders.start();

app.listen(config.port, () => {
  console.log(`[server] Ashby scorecard bot listening on :${config.port}`);
  console.log(`[server] Webhook endpoint: POST /webhooks/ashby`);
});
