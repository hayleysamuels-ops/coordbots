"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "coordmetrics-weekly-"));
process.env.CLIENTS = "acme";
process.env.ASHBY_API_KEY_ACME = "test-key";
process.env.CLIENT_NAME_ACME = "Acme";
process.env.CLIENT_TIMEZONE_ACME = "America/New_York";
process.env.CARRARA_COORDINATORS_ACME = "Maggie Stout,Hayley Samuels";
process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.ALERT_SLACK_USER_ID = "U123";
process.env.ALERT_TIMEZONE = "America/Denver";

// Capture Slack calls instead of sending them.
const sent = [];
global.fetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : {};
  sent.push({ url, body });
  return { json: async () => ({ ok: true, channel: "D999", ts: "1.1" }) };
};

const store = require("../src/db");
const metrics = require("../src/metrics");
const weekly = require("../src/weekly");

const DAY = 86400000;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// The most recent Friday at 22:00 UTC — 3pm in Denver.
function lastFridayAfternoon() {
  const d = new Date();
  d.setUTCHours(22, 0, 0, 0);
  while (d.getUTCDay() !== 5 || d.getTime() > Date.now()) d.setTime(d.getTime() - DAY);
  return d.getTime();
}
const NOW = lastFridayAfternoon();
const MONDAY = NOW - 4 * DAY; // Monday of this week, 22:00 UTC

function utc(ms, hour) {
  const d = new Date(ms);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

let seq = 0;
function seed({ startMs, createdMs, by = "Maggie Stout", waitHours = 2 }) {
  seq += 1;
  const [first, last] = by.split(" ");
  const start = utc(startMs, 15); // 10–11am New York
  const created = utc(createdMs, 14);
  store.writeSchedulePage(
    "acme",
    [
      {
        id: `s${seq}`, status: "Complete", applicationId: `a${seq}`, interviewStageId: "st",
        scheduledBy: { id: "u", firstName: first, lastName: last },
        createdAt: created, updatedAt: created,
        interviewEvents: [{
          id: `e${seq}`, interviewId: "i", interviewScheduleId: `s${seq}`, interviewerUserIds: ["x"],
          createdAt: created, updatedAt: created, startTime: start, endTime: utc(startMs, 16), hasSubmittedFeedback: true,
        }],
      },
    ],
    new Date().toISOString()
  );
  store.db
    .prepare("INSERT INTO application_stages (client_id, application_id, stage_id, title, stage_number, entered_at, left_at) VALUES ('acme', ?, 'st', 'Screen', 1, ?, NULL)")
    .run(`a${seq}`, new Date(Date.parse(created) - waitHours * 3600000).toISOString());
}

test.before(() => {
  // Weeks 1–4 back: 4 interviews a day Mon–Fri (20 a week).
  // "Booked ahead" for baseline week k is week k-1's interviews that were
  // already created by week k's Friday — so the first two of each day in
  // weeks 0–3 are created a week early, giving 10 ahead for every k.
  for (let k = 1; k <= 4; k += 1) {
    for (let d = 0; d < 5; d += 1) {
      const day = MONDAY - 7 * k * DAY + d * DAY;
      for (let i = 0; i < 4; i += 1) seed({ startMs: day, createdMs: i < 2 && k <= 3 ? day - 7 * DAY : day });
    }
  }
  // This week: 2 a day Mon–Fri, both booked a week ahead.
  for (let d = 0; d < 5; d += 1) for (let i = 0; i < 2; i += 1) seed({ startMs: MONDAY + d * DAY, createdMs: MONDAY + d * DAY - 7 * DAY });
  // Next week so far: 3.
  for (let i = 0; i < 3; i += 1) seed({ startMs: MONDAY + 7 * DAY + i * DAY, createdMs: NOW - DAY });
  // Hayley books a few — never named in the coordinator section.
  for (let i = 0; i < 3; i += 1) seed({ startMs: MONDAY + i * DAY, createdMs: MONDAY + i * DAY, by: "Hayley Samuels" });

  store.recordSyncRun("acme", "incremental", new Date().toISOString(), true, null);
  metrics.rebuild();
});

test("week spans compare Monday–today against the same days in prior weeks", () => {
  const s = weekly.weekSpans("America/New_York", NOW);
  assert.strictEqual(s.current.from, s.monday);
  assert.strictEqual(s.baseline.length, 4);
  assert.strictEqual(s.baseline[0].from, weekly.addDays(s.monday, -7));
  assert.strictEqual(s.baseline[0].to, weekly.addDays(s.current.to, -7));
});

test("the summary flags volume and next week's load", () => {
  const { main, data } = weekly.build(NOW);
  assert.strictEqual(data.team.events, 13, "10 of Maggie's plus 3 of Hayley's");
  assert.strictEqual(data.team.eventsBase, 20);
  assert.ok(data.flags.volumeHit, "a 35% drop is flagged");
  assert.strictEqual(data.ahead.current, 3);
  assert.strictEqual(data.ahead.base, 10);
  assert.ok(data.flags.aheadHit);
  assert.match(main, /Interviews coordinated: \*13\*/);
  assert.match(main, /Acme: 13/);
  assert.match(main, /Next week already booked: \*3\*/);
  assert.ok(!/Maggie|Hayley/.test(main), "no one is named in the forwardable part");
});

test("the thread reply names coordinators alphabetically and leaves Hayley out", () => {
  const { coordinators } = weekly.build(NOW);
  // Bookings count by the day they were MADE: this week Maggie booked the
  // three for next week (the ones running this week were booked last week).
  assert.match(coordinators, /Maggie Stout: 3 booked/);
  assert.ok(!/Hayley/.test(coordinators));
  assert.match(coordinators, /not performance/);
});

test("sends once on Friday afternoon, as a message plus a thread reply", async () => {
  sent.length = 0;
  const thursday = await weekly.maybeSend(NOW - DAY);
  assert.strictEqual(thursday.skipped, "not time yet");
  const morning = await weekly.maybeSend(NOW - 8 * 3600000);
  assert.strictEqual(morning.skipped, "not time yet");

  const first = await weekly.maybeSend(NOW);
  assert.strictEqual(first.sent, true);
  const posts = sent.filter((c) => c.url.endsWith("chat.postMessage"));
  assert.strictEqual(posts.length, 2);
  assert.ok(!posts[0].body.thread_ts);
  assert.strictEqual(posts[1].body.thread_ts, "1.1");
  assert.strictEqual(posts[1].body.channel, "D999");

  const again = await weekly.maybeSend(NOW + 3600000);
  assert.strictEqual(again.skipped, "already sent");
  assert.strictEqual(DAY_NAMES[new Date(NOW).getUTCDay()], "Fri");
});
