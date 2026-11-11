"use strict";
// The real dashboard server with Google sign-in and ADMIN_EMAILS set: who
// can open /usage, what each route records, and what it never records.
// Fictional settings and people; its own process, so config.js reads these.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-server-"));
for (const k of Object.keys(process.env)) if (/^(SCHEDULING_|TRAINING_|GOOGLE_|ALLOWED_|SESSION_|PASSWORD_|DASHBOARD_|CLIENT_|ADMIN_)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  DASHBOARD_USER: "shared",
  DASHBOARD_PASSWORD: "fictional-shared-password",
  ASHBY_API_KEY: "fictional-ashby-key",
  DATA_DIR: dir,
  ALLOWED_EMAIL_DOMAINS: "example-client.com,example-agency.com",
  GOOGLE_SIGNIN_CLIENT_ID: "fictional-client-id.apps.googleusercontent.com",
  GOOGLE_SIGNIN_CLIENT_SECRET: "fictional-client-secret",
  GOOGLE_SIGNIN_REDIRECT_URI: "http://127.0.0.1/auth/google/callback",
  SESSION_SECRET: "u".repeat(64),
  ADMIN_EMAILS: " Boss@Example-Agency.com ",
});
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
const config = require("../src/config");
const { createServer } = require("../src/server");
const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const { signInSettings, createSignIn } = require("../src/signin");

let base;
const server = createServer().listen(0, "127.0.0.1");
const listening = new Promise((resolve) => server.on("listening", () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }));
test.beforeEach(() => listening);
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const entries = () => {
  const usageDir = path.join(dir, "usage");
  if (!fs.existsSync(usageDir)) return [];
  return fs.readdirSync(usageDir).flatMap((f) => fs.readFileSync(path.join(usageDir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
};
const raw = () => fs.readdirSync(path.join(dir, "usage")).map((f) => fs.readFileSync(path.join(dir, "usage", f), "utf8")).join("");

// A Google session cookie from a stand-in round trip, signed with the same
// SESSION_SECRET, so the real server accepts it. `recorded` collects what
// this sign-in sends to the usage log.
async function googleSignIn(identity, recorded = []) {
  let nonce;
  const signIn = createSignIn(signInSettings(config), { log: { log() {}, warn() {} }, usage: { record: (...a) => recorded.push(a) },
    oauthFactory: (o) => Object.assign(new OAuth2Client(o), {
      getToken: async () => ({ tokens: { id_token: "fictional" } }),
      verifyIdToken: async () => ({ getPayload: () => ({ nonce, email_verified: true, ...identity }) }),
    }) });
  const stub = express().use(signIn.router).listen(0, "127.0.0.1");
  await new Promise((r) => stub.on("listening", r));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;
  try {
    const started = await fetch(stubBase + "/auth/google", { redirect: "manual" });
    const url = new URL(started.headers.get("location"));
    nonce = url.searchParams.get("nonce");
    const flow = started.headers.getSetCookie()[0].split(";")[0];
    const done = await fetch(`${stubBase}/auth/google/callback?state=${url.searchParams.get("state")}&code=x`, { redirect: "manual", headers: { Cookie: flow } });
    const c = done.headers.getSetCookie().find((x) => x.startsWith("dashboard_session=") && !x.startsWith("dashboard_session=;"));
    return c ? c.split(";")[0] : null;
  } finally {
    stub.close();
  }
}
async function passwordSignIn(password = "fictional-shared-password") {
  const res = await fetch(base + "/signin/password", {
    method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `username=shared&password=${password}`,
  });
  const c = res.headers.getSetCookie().find((x) => x.startsWith("dashboard_session="));
  return c ? c.split(";")[0] : null;
}
const post = (cookie, p, body) => fetch(base + p, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("config: ADMIN_EMAILS is trimmed and lowercased", () => {
  assert.deepEqual(config.adminEmails, ["boss@example-agency.com"]);
});

test("password sign-in: recorded as the dashboard password with a session id, never the typed name; /usage is a 404", async () => {
  assert.equal(await passwordSignIn("wrong"), null);
  const cookie = await passwordSignIn();
  const viewer = await (await fetch(base + "/api/viewer", { headers: { Cookie: cookie } })).json();
  assert.deepEqual(viewer, { signIn: true, method: "password", email: null, name: null, usageLog: true, admin: false });
  assert.equal((await fetch(base + "/usage", { headers: { Cookie: cookie } })).status, 404);

  await fetch(base + "/", { headers: { Cookie: cookie, Accept: "text/html" } });
  await post(cookie, "/api/dismiss", { key: "candidate:fictional-1", scope: "forever", by: "Typed Name" });
  await post(cookie, "/api/undismiss", { key: "candidate:fictional-1" });
  await post(cookie, "/api/notes", { candidateId: "fictional-1", text: "Fictional private note text" });
  await post(cookie, "/api/notes", { candidateId: "fictional-1", text: "  " });
  await post(cookie, "/api/notes/delete", { candidateId: "fictional-1" });

  const mine = entries().filter((e) => e.via === "password");
  assert.deepEqual(mine.map((e) => [e.event, e.detail || null]), [
    ["signin_refused", "wrong username or password"],
    ["signin", "dashboard password"],
    ["page", null],
    ["hide", "candidate:fictional-1"],
    ["restore", "candidate:fictional-1"],
    ["note_saved", null],
    ["note_deleted", null],
    ["note_deleted", null],
  ]);
  assert.ok(mine.every((e) => e.who === null));
  const sid = mine[1].session;
  assert.match(sid, /^[A-Za-z0-9_-]{8}$/);
  assert.ok(mine.slice(1).every((e) => e.session === sid));
  assert.equal(mine[0].session, undefined);
  assert.equal(mine[5].candidateId, "fictional-1");
  assert.equal(raw().includes("Typed Name"), false);
  assert.equal(raw().includes("Fictional private note text"), false);
  assert.equal(/\d+\.\d+\.\d+\.\d+|::1/.test(raw()), false, "no IP addresses");
});

test("the browser's events: tabs, queues, sections and Ashby links, under the session's account; anything else refused", async () => {
  const recorded = [];
  const cookie = await googleSignIn({ email: "ana@example-client.com", hd: "example-client.com", name: "Ana Example" }, recorded);
  assert.deepEqual(recorded.map(([v, e, x]) => [v.email, e, x.detail]), [["ana@example-client.com", "signin", "Google"]]);
  assert.equal((await post(cookie, "/api/usage", { event: "tab", detail: "Offers", who: "someone@else.com" })).status, 204);
  await post(cookie, "/api/usage", { event: "queue", detail: "Hidden & snoozed" });
  await post(cookie, "/api/usage", { event: "section", detail: "Stale candidates" });
  await post(cookie, "/api/usage", { event: "ashby", href: "https://app.ashbyhq.com/candidate-searches/new/right-side/candidates/0b1c2d3e-aaaa-bbbb-cccc-000000000001" });
  assert.equal((await post(cookie, "/api/usage", { event: "hide", detail: "forged" })).status, 400);
  assert.equal((await post(cookie, "/api/usage", { event: "signin" })).status, 400);
  const ana = entries().filter((e) => e.who === "ana@example-client.com");
  assert.deepEqual(ana.map((e) => [e.event, e.detail]), [
    ["tab", "Offers"], ["queue", "Hidden & snoozed"], ["section", "Stale candidates"], ["ashby", "candidate not on the dashboard"],
  ]);
  assert.equal(ana[3].candidateId, "0b1c2d3e-aaaa-bbbb-cccc-000000000001");
  assert.ok(ana.every((e) => e.via === "google"));
  assert.equal((await fetch(base + "/usage", { headers: { Cookie: cookie } })).status, 404, "not an admin");
  const viewer = await (await fetch(base + "/api/viewer", { headers: { Cookie: cookie } })).json();
  assert.equal(viewer.admin, false);
  const out = await fetch(base + "/signout", { method: "POST", redirect: "manual", headers: { Cookie: cookie } });
  assert.equal(out.status, 303);
  assert.equal(entries().filter((e) => e.who === "ana@example-client.com").pop().event, "signout");
});

test("refused Google sign-ins are recorded with the account, when Google named one", async () => {
  const recorded = [];
  assert.equal(await googleSignIn({ email: "someone@gmail-like.example", hd: undefined }, recorded), null);
  assert.equal(await googleSignIn({ email: "x@example-client.com", hd: undefined }, recorded), null);
  assert.deepEqual(recorded.map(([v, e, x]) => [v, e, x.who, x.via, x.detail]), [
    [null, "signin_refused", "someone@gmail-like.example", "google", "account not in an allowed domain"],
    [null, "signin_refused", "x@example-client.com", "google", "personal Google account"],
  ]);
});

test("an admin: the link, the page, filters, and their own activity recorded but left out until asked for", async () => {
  const cookie = await googleSignIn({ email: "boss@example-agency.com", hd: "example-agency.com", name: "Fictional Boss" });
  const viewer = await (await fetch(base + "/api/viewer", { headers: { Cookie: cookie } })).json();
  assert.equal(viewer.admin, true);
  await post(cookie, "/api/dismiss", { key: "candidate:fictional-9", scope: "today" });

  const page = await fetch(base + "/usage", { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const html = await page.text();
  assert.match(html, /ana@example-client\.com/);
  assert.match(html, /dashboard password/);
  assert.match(html, /Opened in Ashby/);
  assert.doesNotMatch(html, /<td>boss@example-agency\.com<\/td>/, "admins left out by default");

  const withAdmins = await (await fetch(base + "/usage?admins=1", { headers: { Cookie: cookie } })).text();
  assert.match(withAdmins, /<td>boss@example-agency\.com<\/td>/);
  assert.match(withAdmins, /Opened the usage log/);
  const justAna = await (await fetch(base + "/usage?person=ana%40example-client.com", { headers: { Cookie: cookie } })).text();
  assert.doesNotMatch(justAna, /dashboard password<\/span>/);
  const justBoss = await (await fetch(base + "/usage?person=boss%40example-agency.com", { headers: { Cookie: cookie } })).text();
  assert.match(justBoss, /Snoozed/, "picking an admin shows them without the toggle");
  const noDay = await (await fetch(base + "/usage?day=1999-01-01", { headers: { Cookie: cookie } })).text();
  assert.match(noDay, /Nothing recorded for this filter/);

  const boss = entries().filter((e) => e.who === "boss@example-agency.com").map((e) => e.event);
  assert.deepEqual(boss, ["snooze", "usage_view", "usage_view", "usage_view", "usage_view", "usage_view"]);
});
