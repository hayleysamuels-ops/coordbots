"use strict";
// The real dashboard server with Google sign-in on (ALLOWED_EMAIL_DOMAINS
// set): what's public, what isn't, and that a hide records the signed-in
// account. Fictional settings; its own process (node --test runs each file
// in one), so config.js reads these.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signin-server-"));
for (const k of Object.keys(process.env)) if (/^(SCHEDULING_|TRAINING_|GOOGLE_|ALLOWED_|SESSION_|PASSWORD_|DASHBOARD_|CLIENT_)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  DASHBOARD_USER: "shared",
  DASHBOARD_PASSWORD: "fictional-shared-password",
  ASHBY_API_KEY: "fictional-ashby-key",
  DATA_DIR: dir,
  ALLOWED_EMAIL_DOMAINS: "example-client.com, Example-Agency.com",
  GOOGLE_SIGNIN_CLIENT_ID: "fictional-client-id.apps.googleusercontent.com",
  GOOGLE_SIGNIN_CLIENT_SECRET: "fictional-client-secret",
  GOOGLE_SIGNIN_REDIRECT_URI: "http://127.0.0.1/auth/google/callback",
  SESSION_SECRET: "c".repeat(64),
  GOOGLE_SITE_VERIFICATION: "google0123456789abcdef.html",
});
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
const config = require("../src/config");
const { createServer } = require("../src/server");

let base;
const server = createServer().listen(0, "127.0.0.1");
const listening = new Promise((resolve) => server.on("listening", () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }));
test.beforeEach(() => listening);
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("config: domains are lowercased and trimmed", () => {
  assert.deepEqual(config.allowedEmailDomains, ["example-client.com", "example-agency.com"]);
});

test("public: /privacy, /terms, /signin and the Search Console file; the Slack routes still answer before sign-in", async () => {
  for (const p of ["/privacy", "/terms", "/signin", "/google0123456789abcdef.html"]) assert.equal((await fetch(base + p)).status, 200, p);
  for (const p of ["/api/slack/interactions", "/api/slack/events"]) {
    assert.equal((await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 404, p);
  }
});

test("not public: pages go to sign-in, everything else is 401, the shared password header included", async () => {
  const page = await fetch(base + "/?tab=offers", { redirect: "manual", headers: { Accept: "text/html" } });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/signin?next=%2F%3Ftab%3Doffers");
  const auth = "Basic " + Buffer.from("shared:fictional-shared-password").toString("base64");
  for (const p of ["/api/issues", "/api/viewer", "/app.js", "/style.css", "/assets/client-logo"]) {
    const res = await fetch(base + p, { headers: { Authorization: auth } });
    assert.equal(res.status, 401, p);
    assert.equal(res.headers.get("x-sign-in"), "/signin", p);
    assert.equal(res.headers.get("www-authenticate"), null, p);
  }
});

test("signed in with the password: /api/viewer says so, and a hide keeps the typed name as self-reported", async () => {
  const res = await fetch(base + "/signin/password", {
    method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "username=shared&password=fictional-shared-password",
  });
  assert.equal(res.status, 303);
  const cookie = res.headers.getSetCookie()[0].split(";")[0];
  const viewer = await (await fetch(base + "/api/viewer", { headers: { Cookie: cookie } })).json();
  assert.deepEqual(viewer, { signIn: true, method: "password", email: null, name: null });
  await fetch(base + "/api/dismiss", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ key: "candidate:fictional-1", scope: "forever", by: "Typed Name" }) });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "dismissals.json"), "utf8"))["candidate:fictional-1"];
  assert.equal(saved.by, "Typed Name");
  assert.equal(saved.byVerified, undefined);
});

test("signed in with Google: a hide records the account's name as verified, whatever name is sent", async () => {
  // A session cookie from a stand-in Google round trip; the server accepts it
  // because it's signed with the same SESSION_SECRET.
  const express = require("express");
  const { OAuth2Client } = require("google-auth-library");
  const { signInSettings, createSignIn } = require("../src/signin");
  let nonce;
  const settings = signInSettings(config);
  const signIn = createSignIn(settings, { log: { log() {}, warn() {} }, oauthFactory: (o) => Object.assign(new OAuth2Client(o), {
    getToken: async () => ({ tokens: { id_token: "fictional" } }),
    verifyIdToken: async () => ({ getPayload: () => ({ nonce, email: "ana@example-client.com", email_verified: true, hd: "example-client.com", name: "Ana Example" }) }),
  }) });
  const app = express().use(signIn.router);
  const stub = app.listen(0, "127.0.0.1");
  await new Promise((r) => stub.on("listening", r));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;
  try {
    const started = await fetch(stubBase + "/auth/google", { redirect: "manual" });
    const url = new URL(started.headers.get("location"));
    nonce = url.searchParams.get("nonce");
    const flow = started.headers.getSetCookie()[0].split(";")[0];
    const done = await fetch(`${stubBase}/auth/google/callback?state=${url.searchParams.get("state")}&code=x`, { redirect: "manual", headers: { Cookie: flow } });
    const cookie = done.headers.getSetCookie().find((c) => c.startsWith("dashboard_session=")).split(";")[0];
    const viewer = await (await fetch(base + "/api/viewer", { headers: { Cookie: cookie } })).json();
    assert.deepEqual(viewer, { signIn: true, method: "google", email: "ana@example-client.com", name: "Ana Example" });
    await fetch(base + "/api/dismiss", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ key: "candidate:fictional-2", scope: "today", by: "Someone Else" }) });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "dismissals.json"), "utf8"))["candidate:fictional-2"];
    assert.equal(saved.by, "Ana Example");
    assert.equal(saved.byVerified, true);
  } finally {
    stub.close();
  }
});
