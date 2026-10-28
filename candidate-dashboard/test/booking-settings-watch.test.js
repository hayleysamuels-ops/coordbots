"use strict";
// The worker's booking settings, posted in the channel when they change
// (src/scheduling/booking-settings-watch.js), and the worker's read-only
// report of them (worker/booking-compose.js bookingSettings).
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { createBookingSettingsWatch, describe } = require("../src/scheduling/booking-settings-watch");
const { bookingSettings } = require("../worker/booking-compose");

const TEST_JOB = "837cc1e9-15ed-4f07-8755-51ee29f4ea39", OTHER = "00000000-0000-4000-8000-000000000000";
const env = { BOOKING_COMPOSE: "on", BOOKING_SEND: "on", BOOKING_COMPOSE_JOBS: JSON.stringify({ [TEST_JOB]: "all" }), BOOKING_SEND_JOBS: JSON.stringify({ [TEST_JOB]: ["Initial Screen", "First Round"] }),
  BOOKING_INTERVIEWER_DOMAINS: "luminai.com", BOOKING_SEND_DAILY_CAP: "10", ASHBY_READ_API_KEY: "secret-key" };

test("the worker reports its settings, and never the read key itself", () => {
  const s = bookingSettings({ env });
  assert.deepEqual(s, { compose: true, send: true, composeJobs: { jobs: { [TEST_JOB]: "all" } }, sendJobs: { jobs: { [TEST_JOB]: ["initial screen", "first round"] } },
    sendListProblem: null, domains: ["luminai.com"], dailyCap: 10, readKey: true });
  assert.doesNotMatch(JSON.stringify(s), /secret-key/);
  assert.match(bookingSettings({ env: { ...env, BOOKING_SEND_JOBS: "{x" } }).sendJobs.problem, /isn't valid JSON/);
});

test("the description reads the same for the same settings, with job titles where Ashby gives them", () => {
  const text = describe(bookingSettings({ env }), { [TEST_JOB]: "TEST" });
  assert.equal(text, [
    "Ashby check (BOOKING_COMPOSE): on",
    "Send (BOOKING_SEND): on",
    `Jobs it may compose for (BOOKING_COMPOSE_JOBS): TEST (${TEST_JOB}): all stages`,
    `Jobs it may send for (BOOKING_SEND_JOBS): TEST (${TEST_JOB}): first round, initial screen`,
    "Interviewer domains (BOOKING_INTERVIEWER_DOMAINS): luminai.com",
    "Daily send cap (BOOKING_SEND_DAILY_CAP): 10",
    "Ashby read key (ASHBY_READ_API_KEY): set"].join("\n"));
  const bare = describe(bookingSettings({ env: {} }));
  assert.match(bare, /compose for \(BOOKING_COMPOSE_JOBS\): none/);
  assert.match(bare, /BOOKING_SEND_DAILY_CAP\): not set \(nothing is sent\)/);
  assert.match(bare, /ASHBY_READ_API_KEY\): not set \(nothing is composed or sent\)/);
  assert.match(describe(bookingSettings({ env: { ...env, BOOKING_SEND_JOBS: JSON.stringify({ [OTHER]: "all" }) } })), /\(nothing is sent: BOOKING_SEND_JOBS opts in job 0{8}-0{4}-4000-8000-0{12} beyond what BOOKING_COMPOSE_JOBS allows\.\)/);
});

test("the first settings are posted, then only a change; a worker that can't be asked posts nothing", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-")), notices = [];
  let current = env, down = false;
  const worker = { call: async action => { assert.equal(action, "booking-settings"); if (down) throw Error("worker away"); return bookingSettings({ env: current }); } };
  const watch = createBookingSettingsWatch({ worker, dataDir, channelId: "C1", slackApi: { notice: async n => { notices.push(n); } },
    jobTitle: async id => id === TEST_JOB ? "TEST" : null, log: { warn() {} } });
  await watch.round();
  assert.equal(notices.length, 1);assert.equal(notices[0].channel, "C1");
  assert.match(notices[0].text, /^The scheduling worker's booking settings:\nAshby check \(BOOKING_COMPOSE\): on/);
  await watch.round();
  assert.equal(notices.length, 1, "unchanged: nothing posted");
  current = { ...env, BOOKING_SEND_JOBS: JSON.stringify({ [TEST_JOB]: "all" }) };
  await watch.round();
  assert.equal(notices.length, 2);
  assert.match(notices[1].text, /^The scheduling worker's booking settings changed\. Now:\n/);
  assert.match(notices[1].text, /send for \(BOOKING_SEND_JOBS\): TEST \(837cc1e9-15ed-4f07-8755-51ee29f4ea39\): all stages/);
  down = true;await watch.round();
  assert.equal(notices.length, 2);
  // What was posted survives a restart: a new watch posts nothing for the same settings.
  down = false;
  const again = createBookingSettingsWatch({ worker, dataDir, channelId: "C1", slackApi: { notice: async n => { notices.push(n); } }, log: { warn() {} } });
  await again.round();
  assert.equal(notices.length, 2);
});

test("a notice that fails to post is tried again next round", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-")), notices = [];
  let fail = true;
  const watch = createBookingSettingsWatch({ worker: { call: async () => bookingSettings({ env }) }, dataDir, channelId: "C1", log: { warn() {} },
    slackApi: { notice: async n => { if (fail) throw Error("slack down"); notices.push(n); } } });
  await watch.round();
  fail = false;await watch.round();
  assert.equal(notices.length, 1);
});
