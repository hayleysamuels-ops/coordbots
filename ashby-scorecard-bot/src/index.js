"use strict";

const config = require("./config");
const { createServer } = require("./server");
const reminders = require("./reminders");
const { createRemindNow } = require("./remind-now");
const { sendManualReminder } = require("./slack");
const { interviewLinks } = require("./ashby");

const remindNow = config.remindSecret
  ? createRemindNow({
      filterAlreadySubmitted: reminders.filterAlreadySubmitted,
      sendManualReminder,
      interviewLinks,
      dataDir: config.dataDir,
      cooldownHours: config.manualCooldownHours,
    })
  : null;

const app = createServer({ remindNow });

// The webhook-driven reminders and their 30s loop run only with
// AUTOMATIC_REMINDERS on. Off, the bot never sends anything by itself.
if (config.automaticReminders) reminders.start();

app.listen(config.port, () => {
  console.log(`[server] Ashby scorecard bot listening on :${config.port}`);
  console.log(`[server] Automatic reminders: ${config.automaticReminders ? "ON (POST /webhooks/ashby)" : "off (no webhook route, nothing sent unprompted)"}`);
  console.log(`[server] Dashboard reminders: ${remindNow ? `on (POST /remind, ${config.manualCooldownHours}h per person per interview)` : "off (REMIND_SECRET not set)"}`);
});
