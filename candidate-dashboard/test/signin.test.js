"use strict";
// Google sign-in (signin.js) against a stand-in for Google: the real
// OAuth2Client builds the authorization URL; its token exchange and ID token
// check return what each test says Google returned. Fictional domains,
// accounts and secrets throughout.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const { signInSettings, createSignIn } = require("../src/signin");

const BASE_CONFIG = {
  allowedEmailDomains: ["example-client.com", "example-agency.com"],
  googleSignInClientId: "fictional-client-id.apps.googleusercontent.com",
  googleSignInClientSecret: "fictional-client-secret",
  googleSignInRedirectUri: "http://127.0.0.1/auth/google/callback",
  sessionSecret: "a".repeat(64),
  sessionHours: 24,
  passwordSignIn: true,
  passwordSignInRaw: "",
  dashboardUser: "shared",
  dashboardPassword: "fictional-shared-password",
  dashboardTitle: "Example Coordination Dashboard",
};

// Starts a dashboard-shaped app: sign-in's routes, then its check in front of
// a page and an API route. Returns helpers that keep cookies like a browser.
async function start(t, { config = {}, identity = {}, tokens } = {}) {
  let clock = Date.parse("2026-11-09T12:00:00Z");
  const logs = [];
  const google = { identity: { email: "ana@example-client.com", email_verified: true, hd: "example-client.com", name: "Ana Example", sub: "1", ...identity }, tokens };
  const settings = signInSettings({ ...BASE_CONFIG, ...config });
  assert.deepEqual(settings.problems, []);
  const oauthFactory = (opts) => {
    const client = new OAuth2Client(opts);
    client.getToken = async ({ code, codeVerifier }) => {
      assert.equal(code, "fictional-code");
      assert.ok(codeVerifier && codeVerifier.length >= 43, "PKCE verifier sent");
      return { tokens: google.tokens === undefined ? { id_token: "fictional-id-token", access_token: "x" } : google.tokens };
    };
    client.verifyIdToken = async ({ idToken, audience }) => {
      assert.equal(idToken, "fictional-id-token");
      assert.equal(audience, BASE_CONFIG.googleSignInClientId);
      return { getPayload: () => ({ nonce: google.nonce, ...google.identity }) };
    };
    return client;
  };
  const signIn = createSignIn(settings, { oauthFactory, now: () => clock, log: { log: (m) => logs.push(m), warn: (m) => logs.push(m) } });
  const app = express();
  app.use(signIn.router);
  app.use(signIn.requireSignIn);
  app.get("/", (req, res) => res.send("dashboard"));
  app.get("/api/viewer", (req, res) => res.json(req.viewer));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => server.close());
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  // The redirect URI has to be where the test server listens.
  settings.redirectUri = `http://${host}/auth/google/callback`;
  const jar = {};
  async function request(path, { method = "GET", headers = {}, body, html = false } = {}) {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`http://${host}${path}`, {
      method, redirect: "manual", body,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(html ? { Accept: "text/html" } : {}), ...headers },
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split("; ");
      const [k, v] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (attrs.includes("Max-Age=0")) delete jar[k]; else jar[k] = v;
    }
    return res;
  }
  // Runs the whole Google round trip; returns the callback's response.
  async function signInWithGoogle({ next, tamper } = {}) {
    const start = await request("/auth/google" + (next ? `?next=${encodeURIComponent(next)}` : ""));
    assert.equal(start.status, 302);
    const url = new URL(start.headers.get("location"));
    google.nonce = url.searchParams.get("nonce");
    const state = tamper === "state" ? "wrong-state" : url.searchParams.get("state");
    if (tamper === "nonce") google.nonce = "wrong-nonce";
    if (tamper === "flow") delete jar.dashboard_signin;
    return request(`/auth/google/callback?state=${encodeURIComponent(state)}&code=fictional-code`);
  }
  return { request, signInWithGoogle, jar, logs, settings, google, advance: (ms) => { clock += ms; } };
}

test("settings: off where ALLOWED_EMAIL_DOMAINS is unset; incomplete settings leave it off with every problem named", () => {
  assert.equal(signInSettings({ ...BASE_CONFIG, allowedEmailDomains: [] }).enabled, false);
  assert.deepEqual(signInSettings({ ...BASE_CONFIG, allowedEmailDomains: [] }).problems, []);
  const bad = signInSettings({ ...BASE_CONFIG, googleSignInClientSecret: "", sessionSecret: "short",
    googleSignInRedirectUri: "https://dash.example.com/api/google-calendar/callback", allowedEmailDomains: ["example-client.com", "not a domain"] });
  assert.equal(bad.enabled, false);
  assert.equal(bad.problems.length, 4, bad.problems.join("\n"));
  assert.match(bad.problems.join("\n"), /not a domain.*\n.*GOOGLE_SIGNIN_CLIENT_SECRET.*\n.*REDIRECT_URI.*\n.*SESSION_SECRET/s);
  assert.equal(signInSettings({ ...BASE_CONFIG, googleSignInRedirectUri: "http://dash.example.com/auth/google/callback" }).enabled, false, "http only on localhost");
  const ok = signInSettings({ ...BASE_CONFIG, googleSignInRedirectUri: "https://dash.example.com/auth/google/callback", sessionHours: 0, passwordSignInRaw: "of" });
  assert.equal(ok.enabled, true);
  assert.equal(ok.secure, true);
  assert.equal(ok.sessionHours, 24);
  assert.equal(ok.warnings.length, 2);
});

test("signed out: a page load goes to /signin and comes back; an API call gets 401 with X-Sign-In and no password prompt", async (t) => {
  const s = await start(t);
  const page = await s.request("/?tab=offers", { html: true });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/signin?next=%2F%3Ftab%3Doffers");
  const api = await s.request("/api/viewer");
  assert.equal(api.status, 401);
  assert.equal(api.headers.get("x-sign-in"), "/signin");
  assert.equal(api.headers.get("www-authenticate"), null);
  const signin = await s.request("/signin?next=%2F%3Ftab%3Doffers", { html: true });
  assert.equal(signin.status, 200);
  const body = await signin.text();
  assert.match(body, /<strong>example-client\.com<\/strong> or <strong>example-agency\.com<\/strong> Google account/);
  assert.match(body, /href="\/auth\/google\?next=%2F%3Ftab%3Doffers"/);
  assert.match(body, /action="\/signin\/password"/);
});

test("the shared password as a Basic Auth header no longer gets in", async (t) => {
  const s = await start(t);
  const auth = "Basic " + Buffer.from("shared:fictional-shared-password").toString("base64");
  assert.equal((await s.request("/api/viewer", { headers: { Authorization: auth } })).status, 401);
});

test("Google: the request asks for openid, email and profile only, with state, nonce and PKCE", async (t) => {
  const s = await start(t);
  const res = await s.request("/auth/google");
  const url = new URL(res.headers.get("location"));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("client_id"), BASE_CONFIG.googleSignInClientId);
  assert.equal(url.searchParams.get("redirect_uri"), s.settings.redirectUri);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  for (const p of ["state", "nonce", "code_challenge"]) assert.ok(url.searchParams.get(p), p);
  assert.equal(url.searchParams.get("access_type"), null, "no offline access");
  assert.ok(s.jar.dashboard_signin, "flow cookie set");
});

test("Google: a verified Workspace account on an allowed domain is signed in, returned where it was going, and logged", async (t) => {
  const s = await start(t);
  const res = await s.signInWithGoogle({ next: "/?tab=offers" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/?tab=offers");
  assert.ok(s.jar.dashboard_session);
  assert.equal(s.jar.dashboard_signin, undefined, "flow cookie cleared");
  const viewer = await (await s.request("/api/viewer")).json();
  assert.equal(viewer.method, "google");
  assert.equal(viewer.email, "ana@example-client.com");
  assert.equal(viewer.name, "Ana Example");
  assert.deepEqual(s.logs, ["[auth] Google sign-in: ana@example-client.com"]);
  assert.equal((await s.request("/", { html: true })).status, 200);
});

test("Google: the session cookie is HttpOnly and SameSite=Lax, and Secure on an https address", async (t) => {
  const s = await start(t);
  s.settings.secure = true;
  const start2 = await s.request("/auth/google");
  assert.match(start2.headers.getSetCookie()[0], /^dashboard_signin=[^;]+; Path=\/auth\/google; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/);
});

for (const [name, identity, error] of [
  ["a personal Google account on a work address (no hd)", { hd: undefined }, "workspace"],
  ["an account managed by another Workspace", { hd: "other-company.com" }, "domain"],
  ["an email on a domain not allowed", { email: "ana@other-company.com", hd: "other-company.com" }, "domain"],
  ["an email in an allowed Workspace but on another domain", { email: "ana@gmail.com" }, "domain"],
  ["an unverified email", { email_verified: false }, "unverified"],
  ["email_verified as a string", { email_verified: "true" }, "unverified"],
]) {
  test(`Google: refuses ${name}`, async (t) => {
    const s = await start(t, { identity });
    const res = await s.signInWithGoogle();
    assert.equal(res.headers.get("location"), `/signin?error=${error}`);
    assert.equal(s.jar.dashboard_session, undefined);
    assert.match(s.logs.join("\n"), /\[auth\] Google sign-in refused/);
  });
}

for (const [name, tamper, error] of [["a different state", "state", "expired"], ["no sign-in cookie", "flow", "expired"], ["a different nonce", "nonce", "google"]]) {
  test(`Google: refuses a callback with ${name}`, async (t) => {
    const s = await start(t);
    const res = await s.signInWithGoogle({ tamper });
    assert.equal(res.headers.get("location"), `/signin?error=${error}`);
    assert.equal(s.jar.dashboard_session, undefined);
  });
}

test("Google: refuses a callback after ten minutes, and one where Google sent no ID token", async (t) => {
  const s = await start(t);
  await s.request("/auth/google");
  s.advance(10 * 60 * 1000 + 1);
  const late = await s.request("/auth/google/callback?state=x&code=fictional-code");
  assert.equal(late.headers.get("location"), "/signin?error=expired");
  const s2 = await start(t, { tokens: { access_token: "x" } });
  assert.equal((await s2.signInWithGoogle()).headers.get("location"), "/signin?error=google");
});

test("Google: a cancelled consent screen says so", async (t) => {
  const s = await start(t);
  const startRes = await s.request("/auth/google");
  const state = new URL(startRes.headers.get("location")).searchParams.get("state");
  const res = await s.request(`/auth/google/callback?state=${state}&error=access_denied`);
  assert.equal(res.headers.get("location"), "/signin?error=cancelled");
});

test("next: only a path on this dashboard, never another site", async (t) => {
  const s = await start(t);
  for (const next of ["//evil.example", "https://evil.example/", "/\\evil.example", "/signin?next=/", "/auth/google"]) {
    const res = await s.signInWithGoogle({ next });
    assert.equal(res.headers.get("location"), "/", next);
  }
});

test("sessions end after SESSION_HOURS, and at once if it's shortened or the domain is removed", async (t) => {
  const s = await start(t);
  await s.signInWithGoogle();
  s.advance(23 * 3600000);
  assert.equal((await s.request("/api/viewer")).status, 200);
  s.settings.sessionHours = 12;
  assert.equal((await s.request("/api/viewer")).status, 401, "shortened");
  s.settings.sessionHours = 24;
  s.advance(3600000);
  assert.equal((await s.request("/api/viewer")).status, 401, "expired");
  s.advance(-3600000);
  assert.equal((await s.request("/api/viewer")).status, 200);
  s.settings.domains = ["example-agency.com"];
  assert.equal((await s.request("/api/viewer")).status, 401, "domain removed");
});

test("a session cookie that's been edited or signed with another secret is refused", async (t) => {
  const s = await start(t);
  await s.signInWithGoogle();
  const [data, sig] = s.jar.dashboard_session.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(data, "base64url")), e: "eve@example-client.com" })).toString("base64url");
  s.jar.dashboard_session = `${forged}.${sig}`;
  assert.equal((await s.request("/api/viewer")).status, 401);
  const other = await start(t, { config: { sessionSecret: "b".repeat(64) } });
  await other.signInWithGoogle();
  s.jar.dashboard_session = other.jar.dashboard_session;
  assert.equal((await s.request("/api/viewer")).status, 401);
});

test("password: the right one signs in and is logged; a wrong one is refused and logged", async (t) => {
  const s = await start(t);
  const form = (u, p) => new URLSearchParams({ username: u, password: p, next: "/?tab=offers" }).toString();
  const headers = { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "203.0.113.7" };
  const bad = await s.request("/signin/password", { method: "POST", headers, body: form("shared", "wrong") });
  assert.equal(bad.status, 303);
  assert.equal(bad.headers.get("location"), "/signin?next=%2F%3Ftab%3Doffers&error=password");
  assert.equal(s.jar.dashboard_session, undefined);
  const good = await s.request("/signin/password", { method: "POST", headers, body: form("shared", "fictional-shared-password") });
  assert.equal(good.headers.get("location"), "/?tab=offers");
  const viewer = await (await s.request("/api/viewer")).json();
  assert.equal(viewer.method, "password");
  assert.equal(viewer.email, null);
  assert.deepEqual(s.logs, [
    "[auth] Password sign-in refused (wrong username or password) from 203.0.113.7.",
    "[auth] Password sign-in (shared dashboard password) from 203.0.113.7.",
  ]);
});

test("password: rotating DASHBOARD_PASSWORD or turning PASSWORD_SIGNIN off ends password sessions; off also removes the form", async (t) => {
  const s = await start(t);
  const body = new URLSearchParams({ username: "shared", password: "fictional-shared-password" }).toString();
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  await s.request("/signin/password", { method: "POST", headers, body });
  assert.equal((await s.request("/api/viewer")).status, 200);
  s.settings.dashboardPassword = "a-new-fictional-password";
  assert.equal((await s.request("/api/viewer")).status, 401, "rotated");
  s.settings.dashboardPassword = "fictional-shared-password";
  assert.equal((await s.request("/api/viewer")).status, 200);
  s.settings.passwordSignIn = false;
  assert.equal((await s.request("/api/viewer")).status, 401, "flag off");
  const again = await s.request("/signin/password", { method: "POST", headers, body });
  assert.equal(again.headers.get("location"), "/signin?error=password-off");
  const page = await (await s.request("/signin")).text();
  assert.doesNotMatch(page, /signin\/password/);
});

test("sign out clears the session", async (t) => {
  const s = await start(t);
  await s.signInWithGoogle();
  const res = await s.request("/signout", { method: "POST" });
  assert.equal(res.headers.get("location"), "/signin?signedout=1");
  assert.equal(s.jar.dashboard_session, undefined);
  assert.equal((await s.request("/api/viewer")).status, 401);
});

test("an error in the query string is never echoed onto the page", async (t) => {
  const s = await start(t);
  const page = await (await s.request("/signin?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E")).text();
  assert.doesNotMatch(page, /<script/i);
  assert.doesNotMatch(page, /role="alert"/);
});
