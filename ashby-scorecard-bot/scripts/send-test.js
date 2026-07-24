"use strict";

/**
 * Send a signed sample interviewScheduleUpdate webhook to a running server.
 *
 *   node scripts/send-test.js                 # end time ~1 min from now
 *   node scripts/send-test.js now             # end time in the past -> fires immediately
 *
 * Uses ASHBY_WEBHOOK_SECRET from your .env so the signature matches.
 */

require("dotenv").config();
const crypto = require("crypto");

const secret = process.env.ASHBY_WEBHOOK_SECRET || "replace-with-your-webhook-secret";
const url = process.env.TEST_URL || `http://localhost:${process.env.PORT || 3000}/webhooks/ashby`;
const fireNow = process.argv[2] === "now";

const end = new Date(Date.now() + (fireNow ? -60_000 : 60_000)).toISOString();

const payload = {
  action: "interviewScheduleUpdate",
  data: {
    interviewSchedule: {
      id: "sched_test_123",
      applicationId: "app_test_123",
      status: "Scheduled",
      interviewEvents: [
        {
          id: "evt_test_" + Date.now(),
          title: "Technical Interview",
          status: "Scheduled",
          startTime: new Date(Date.now() - 3_600_000).toISOString(),
          endTime: end,
          interviewers: [
            {
              email: process.env.TEST_INTERVIEWER_EMAIL || "interviewer@example.com",
              firstName: "Test",
              lastName: "Interviewer",
              feedbackLink: "https://app.ashbyhq.com/interviews/feedback/test",
            },
          ],
        },
      ],
    },
  },
};

const body = JSON.stringify(payload);
const signature =
  "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

(async () => {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Ashby-Signature": signature,
    },
    body,
  });
  console.log(`POST ${url} -> ${res.status} ${await res.text()}`);
  console.log(`Interview end time: ${end}${fireNow ? " (already passed; reminder fires on next tick)" : ""}`);
})();
