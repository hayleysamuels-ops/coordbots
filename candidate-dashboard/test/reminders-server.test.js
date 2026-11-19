"use strict";
// The real dashboard server with scorecard reminders on: /api/remind needs a
// Google sign-in, and a dashboard without the settings has no such route.
// Fictional settings; its own process, so config.js reads these.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reminders-server-"));
for (const k of Object.keys(process.env)) if (/^(SCHEDULING_|TRAINING_|GOOGLE_|ALLOWED_|SESSION_|PASSWORD_|DASHBOARD_|CLIENT_|ADMIN_|REMINDER_)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  DASHBOARD_USER: "shared",
  DASHBOARD_PASSWORD: "fictional-shared-password",
  ASHBY_API_KEY: "fictional-ashby-key",
  DATA_DIR: dir,
  ALLOWED_EMAIL_DOMAINS: "example-client.com",
  GOOGLE_SIGNIN_CLIENT_ID: "fictional-client-id.apps.googleusercontent.com",
  GOOGLE_SIGNIN_CLIENT_SECRET: "fictional-client-secret",
  GOOGLE_SIGNIN_REDIRECT_URI: "http://127.0.0.1/auth/google/callback",
  SESSION_SECRET: "r".repeat(64),
  REMINDER_BOT_URL: "http://127.0.0.1:9/",
  REMINDER_BOT_SECRET: "fictional-remind-secret",
});
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
const config = require("../src/config");
const { createServer } = require("../src/server");
const issues = require("../src/issues");

let base;
const server = createServer().listen(0, "127.0.0.1");
const listening = new Promise((resolve) => server.on("listening", () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }));
test.beforeEach(() => listening);
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function passwordSignIn() {
  const res = await fetch(base + "/signin/password", {
    method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "username=shared&password=fictional-shared-password",
  });
  return res.headers.getSetCookie().find((x) => x.startsWith("dashboard_session=")).split(";")[0];
}

test("config: both settings turn reminders on, trailing slash dropped", () => {
  assert.equal(config.remindersEnabled, true);
  assert.equal(config.reminderBotUrl, "http://127.0.0.1:9");
  assert.equal(issues.getSnapshot().feedbackOverdue === undefined || Array.isArray(issues.getSnapshot().feedbackOverdue), true);
});

test("the shared password can't send a reminder", async () => {
  const cookie = await passwordSignIn();
  const res = await fetch(base + "/api/remind", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ interviewEventId: "x" }) });
  assert.equal(res.status, 403);
});

test("not signed in at all: the sign-in wall answers first", async () => {
  const res = await fetch(base + "/api/remind", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
});

test("the page is told reminders are on", async () => {
  const cookie = await passwordSignIn();
  const data = await (await fetch(base + "/api/issues", { headers: { Cookie: cookie } })).json();
  assert.equal(data.appConfig.remindersEnabled, true);
});
