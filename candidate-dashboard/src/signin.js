"use strict";
// Google sign-in, on only where ALLOWED_EMAIL_DOMAINS is set (Pace first).
// Where it's on, it replaces Basic Auth (auth.js) in front of everything
// except the public pages mounted ahead of it in server.js.
//
// Who gets in: a Google account whose ID token, verified here against
// Google's keys and this client ID, says
//   - email_verified is true,
//   - the email's domain is in ALLOWED_EMAIL_DOMAINS, and
//   - the signed `hd` claim (the Google Workspace that manages the account)
//     is in ALLOWED_EMAIL_DOMAINS too.
// The hd check is what keeps out a personal Google account registered on a
// work address: it has a verified withpace.com email but no hd. Google's
// `hd` request parameter is only a hint to the account picker and is not
// relied on. Google's tokens are used for that check and then dropped;
// nothing from Google is stored server-side.
//
// Sessions are a signed cookie (HMAC with SESSION_SECRET), no server store.
// Each request re-checks the cookie against the current settings, so
// narrowing ALLOWED_EMAIL_DOMAINS, shortening SESSION_HOURS, turning
// PASSWORD_SIGNIN off or rotating DASHBOARD_PASSWORD takes effect at once.
// Nothing else ends a session early: someone removed from the company's
// Google Workspace keeps access until theirs expires (SESSION_HOURS).
//
// The shared password stays as a form on the sign-in page while
// PASSWORD_SIGNIN isn't "off"; every use is logged. It is no longer accepted
// as a Basic Auth header, so a browser's saved password can't skip sign-in.
// The scheduling pilot's coordinator logins (approvers) still are, as on the
// dashboards without sign-in.

const crypto = require("crypto");
const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const { coordinatorLogin, basicLogin, approverFor, timingSafeEqualString } = require("./auth");
const { signInPage } = require("./signin-page");

const SESSION_COOKIE = "dashboard_session";
const FLOW_COOKIE = "dashboard_signin";
const CALLBACK_PATH = "/auth/google/callback";
const FLOW_MS = 10 * 60 * 1000;
const MAX_SESSION_HOURS = 24 * 30;

// Messages for /signin?error=, so nothing from the query string is echoed.
const ERRORS = {
  expired: "That sign-in took too long or was started in another browser. Try again.",
  cancelled: "Google sign-in was cancelled.",
  google: "Google couldn't confirm who you are. Try again.",
  unverified: "Google hasn't verified that account's email address.",
  domain: "That Google account can't sign in to this dashboard.",
  workspace: "That's a personal Google account. Sign in with your company Google Workspace account.",
  password: "That username or password isn't right.",
  "password-off": "Password sign-in is turned off on this dashboard.",
};
// The same refusals, as the usage log (usage-log.js) names them.
const REFUSED = {
  expired: "took too long or was started in another browser",
  cancelled: "cancelled at Google",
  google: "Google couldn't confirm the account",
  unverified: "email not verified by Google",
  domain: "account not in an allowed domain",
  workspace: "personal Google account",
  password: "wrong username or password",
  "password-off": "password sign-in is off",
};

// The settings sign-in needs, checked. `enabled` is false where
// ALLOWED_EMAIL_DOMAINS is unset; `problems` lists what stops it where it
// is set, and then sign-in stays off and the password keeps working.
function signInSettings(config) {
  const domains = config.allowedEmailDomains || [];
  const settings = {
    enabled: false, problems: [], warnings: [],
    domains, clientId: config.googleSignInClientId, clientSecret: config.googleSignInClientSecret,
    redirectUri: config.googleSignInRedirectUri, sessionSecret: config.sessionSecret,
    sessionHours: config.sessionHours, passwordSignIn: config.passwordSignIn,
    dashboardUser: config.dashboardUser, dashboardPassword: config.dashboardPassword,
    title: config.dashboardTitle,
  };
  if (!domains.length) return settings;
  const p = settings.problems;
  for (const d of domains) if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) p.push(`ALLOWED_EMAIL_DOMAINS entry "${d}" isn't a domain`);
  if (!settings.clientId) p.push("GOOGLE_SIGNIN_CLIENT_ID is not set");
  if (!settings.clientSecret) p.push("GOOGLE_SIGNIN_CLIENT_SECRET is not set");
  if (!settings.redirectUri) p.push("GOOGLE_SIGNIN_REDIRECT_URI is not set");
  else {
    let u = null;
    try { u = new URL(settings.redirectUri); } catch (_) {}
    const local = u && ["localhost", "127.0.0.1"].includes(u.hostname);
    if (!u || !(u.protocol === "https:" || (local && u.protocol === "http:")) || u.username || u.password || u.search || u.hash || u.pathname !== CALLBACK_PATH) {
      p.push(`GOOGLE_SIGNIN_REDIRECT_URI must be https://<this dashboard's address>${CALLBACK_PATH}`);
    } else {
      settings.secure = u.protocol === "https:";
    }
  }
  if (settings.sessionSecret.length < 32) p.push("SESSION_SECRET must be at least 32 characters (openssl rand -hex 32)");
  if (!(settings.sessionHours > 0 && settings.sessionHours <= MAX_SESSION_HOURS)) {
    settings.warnings.push(`SESSION_HOURS must be more than 0 and at most ${MAX_SESSION_HOURS}; using 24`);
    settings.sessionHours = 24;
  }
  if (config.passwordSignInRaw && !["on", "off"].includes(config.passwordSignInRaw.toLowerCase())) {
    settings.warnings.push(`PASSWORD_SIGNIN is "${config.passwordSignInRaw}", not "on" or "off"; password sign-in stays on`);
  }
  settings.enabled = p.length === 0;
  return settings;
}

const b64 = (buf) => Buffer.from(buf).toString("base64url");

function createSignIn(settings, { oauthFactory = (o) => new OAuth2Client(o), now = () => Date.now(), log = console, usage = null } = {}) {
  // The usage log (usage-log.js), where it's on: sign-ins, refusals, sign-outs.
  const recordUsage = (...args) => { if (usage) usage.record(...args); };
  const key = crypto.createHmac("sha256", settings.sessionSecret).update("dashboard-session-v1").digest();
  const mac = (purpose, data) => crypto.createHmac("sha256", key).update(purpose + "." + data).digest("base64url");
  const sign = (purpose, payload) => { const data = b64(JSON.stringify(payload)); return data + "." + mac(purpose, data); };
  function unsign(purpose, token) {
    if (typeof token !== "string" || token.length > 4096) return null;
    const dot = token.indexOf(".");
    if (dot < 1) return null;
    const data = token.slice(0, dot);
    if (!timingSafeEqualString(token.slice(dot + 1), mac(purpose, data))) return null;
    try { return JSON.parse(Buffer.from(data, "base64url").toString("utf8")); } catch (_) { return null; }
  }
  // Ties a password session to the password it was made with, so rotating
  // DASHBOARD_PASSWORD ends it.
  const passwordMark = () => mac("password", settings.dashboardUser + ":" + settings.dashboardPassword).slice(0, 22);
  const allowed = (domain) => typeof domain === "string" && settings.domains.includes(domain.toLowerCase());
  const domainOf = (email) => String(email).split("@").pop().toLowerCase();

  function cookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || "").split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return out;
  }
  function setCookie(res, name, value, { maxAge, path = "/" }) {
    res.append("Set-Cookie", `${name}=${value}; Path=${path}; Max-Age=${Math.floor(maxAge / 1000)}; HttpOnly; SameSite=Lax${settings.secure ? "; Secure" : ""}`);
  }
  const clearCookie = (res, name, path = "/") => setCookie(res, name, "", { maxAge: 0, path });

  // The signed-in viewer for this request, or null.
  function session(req) {
    const s = unsign("session", cookies(req)[SESSION_COOKIE]);
    if (!s || typeof s.iat !== "number") return null;
    const t = now();
    if (s.iat > t + 60000 || t >= s.iat + settings.sessionHours * 3600000) return null;
    if (s.m === "google") {
      if (typeof s.e !== "string" || !allowed(domainOf(s.e)) || !allowed(s.h)) return null;
      return { method: "google", email: s.e, name: s.n || s.e, expiresAt: s.iat + settings.sessionHours * 3600000 };
    }
    if (s.m === "password") {
      if (!settings.passwordSignIn || !timingSafeEqualString(String(s.p), passwordMark())) return null;
      return { method: "password", email: null, name: null, session: typeof s.s === "string" ? s.s : null, expiresAt: s.iat + settings.sessionHours * 3600000 };
    }
    return null;
  }
  const startSession = (res, payload) =>
    setCookie(res, SESSION_COOKIE, sign("session", { ...payload, iat: now() }), { maxAge: settings.sessionHours * 3600000 });

  // Where to go after signing in: a path on this dashboard, never another site.
  function safeNext(value) {
    if (typeof value !== "string" || value.length > 512 || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
    if (value.startsWith("/signin") || value.startsWith("/auth/")) return "/";
    return value;
  }
  const signInUrl = (next, error) => {
    const q = new URLSearchParams();
    if (next && next !== "/") q.set("next", next);
    if (error) q.set("error", error);
    const s = q.toString();
    return "/signin" + (s ? "?" + s : "");
  };
  const ip = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

  const router = express.Router();

  router.get("/signin", (req, res) => {
    const next = safeNext(req.query.next);
    if (session(req)) return res.redirect(302, next);
    res.set("Cache-Control", "no-store");
    res.type("html").send(signInPage({
      title: settings.title, domains: settings.domains, passwordSignIn: settings.passwordSignIn, next,
      error: ERRORS[req.query.error] || null, signedOut: req.query.signedout === "1",
    }));
  });

  router.get("/auth/google", async (req, res) => {
    try {
      const client = oauthFactory({ clientId: settings.clientId, clientSecret: settings.clientSecret, redirectUri: settings.redirectUri });
      const pkce = await client.generateCodeVerifierAsync();
      const state = b64(crypto.randomBytes(32)), nonce = b64(crypto.randomBytes(32));
      setCookie(res, FLOW_COOKIE, sign("flow", { s: state, n: nonce, v: pkce.codeVerifier, x: safeNext(req.query.next), t: now() + FLOW_MS }),
        { maxAge: FLOW_MS, path: "/auth/google" });
      res.set("Cache-Control", "no-store");
      res.redirect(302, client.generateAuthUrl({
        response_type: "code", scope: ["openid", "email", "profile"], prompt: "select_account",
        state, nonce, code_challenge: pkce.codeChallenge, code_challenge_method: "S256",
      }));
    } catch (e) {
      log.warn(`[auth] Couldn't start Google sign-in: ${e.message}`);
      res.redirect(302, signInUrl(safeNext(req.query.next), "google"));
    }
  });

  router.get(CALLBACK_PATH, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const flow = unsign("flow", cookies(req)[FLOW_COOKIE]);
    clearCookie(res, FLOW_COOKIE, "/auth/google");
    const state = req.query.state;
    if (!flow || typeof flow.t !== "number" || now() > flow.t || typeof state !== "string" || !timingSafeEqualString(state, String(flow.s))) {
      recordUsage(null, "signin_refused", { via: "google", detail: REFUSED.expired });
      return res.redirect(302, signInUrl("/", "expired"));
    }
    const next = safeNext(flow.x);
    const refuse = (code, why, email = null) => {
      log.warn(`[auth] Google sign-in refused (${why}).`);
      recordUsage(null, "signin_refused", { via: "google", who: email, detail: REFUSED[code] });
      res.redirect(302, signInUrl(next, code));
    };
    if (req.query.error) return refuse("cancelled", `Google returned ${String(req.query.error).slice(0, 40)}`);
    const code = req.query.code;
    if (typeof code !== "string" || !code || code.length > 4096) return refuse("google", "no authorization code");
    let identity;
    try {
      const client = oauthFactory({ clientId: settings.clientId, clientSecret: settings.clientSecret, redirectUri: settings.redirectUri });
      const { tokens } = await client.getToken({ code, codeVerifier: flow.v, redirect_uri: settings.redirectUri });
      if (!tokens || !tokens.id_token) return refuse("google", "no ID token");
      identity = (await client.verifyIdToken({ idToken: tokens.id_token, audience: settings.clientId })).getPayload();
    } catch (e) {
      return refuse("google", `token exchange or verification failed: ${e.message}`);
    }
    if (!identity || identity.nonce !== flow.n) return refuse("google", "nonce mismatch");
    const email = typeof identity.email === "string" ? identity.email.toLowerCase() : "";
    if (!email.includes("@")) return refuse("google", "no email in token");
    if (identity.email_verified !== true) return refuse("unverified", `unverified email ${email}`, email);
    if (!allowed(domainOf(email))) return refuse("domain", `${email} isn't in ALLOWED_EMAIL_DOMAINS`, email);
    if (!identity.hd) return refuse("workspace", `${email} is a personal Google account (no hd)`, email);
    if (!allowed(identity.hd)) return refuse("domain", `${email} is managed by ${identity.hd}, not in ALLOWED_EMAIL_DOMAINS`, email);
    const name = typeof identity.name === "string" && identity.name.trim() ? identity.name.trim().slice(0, 80) : null;
    startSession(res, { m: "google", e: email, n: name, h: String(identity.hd).toLowerCase() });
    log.log(`[auth] Google sign-in: ${email}`);
    recordUsage({ method: "google", email }, "signin", { detail: "Google" });
    res.redirect(302, next);
  });

  router.post("/signin/password", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
    res.set("Cache-Control", "no-store");
    const next = safeNext(req.body && req.body.next);
    if (!settings.passwordSignIn) {
      log.warn(`[auth] Password sign-in refused (PASSWORD_SIGNIN is off) from ${ip(req)}.`);
      recordUsage(null, "signin_refused", { via: "password", detail: REFUSED["password-off"] });
      return res.redirect(303, signInUrl(next, "password-off"));
    }
    const user = String((req.body && req.body.username) || ""), pass = String((req.body && req.body.password) || "");
    const userOk = timingSafeEqualString(user, settings.dashboardUser);
    const passOk = timingSafeEqualString(pass, settings.dashboardPassword);
    if (!settings.dashboardUser || !settings.dashboardPassword || !userOk || !passOk) {
      log.warn(`[auth] Password sign-in refused (wrong username or password) from ${ip(req)}.`);
      recordUsage(null, "signin_refused", { via: "password", detail: REFUSED.password });
      return res.redirect(303, signInUrl(next, "password"));
    }
    // s: a random id for this sign-in, so the usage log can tell password
    // sessions apart without naming anyone.
    const sid = b64(crypto.randomBytes(6));
    startSession(res, { m: "password", p: passwordMark(), s: sid });
    log.log(`[auth] Password sign-in (shared dashboard password) from ${ip(req)}.`);
    recordUsage({ method: "password", session: sid }, "signin", { detail: "dashboard password" });
    res.redirect(303, next);
  });

  router.post("/signout", (req, res) => {
    const viewer = session(req);
    if (viewer) recordUsage(viewer, "signout");
    clearCookie(res, SESSION_COOKIE);
    res.redirect(303, "/signin?signedout=1");
  });

  // In front of everything that isn't public (server.js).
  function requireSignIn(req, res, next) {
    if (coordinatorLogin(req, res, next)) return;
    const viewer = session(req);
    if (viewer) { req.viewer = viewer; return next(); }
    // The scheduling pilot's coordinator logins, as with Basic Auth. The
    // shared dashboard password is not accepted this way.
    const login = basicLogin(req);
    const approver = login && approverFor(login);
    if (approver) { req.schedulingUser = { id: approver.username, canApprove: true }; return next(); }
    const page = ["GET", "HEAD"].includes(req.method) && (req.headers.accept || "").includes("text/html");
    if (page) return res.redirect(302, signInUrl(safeNext(req.originalUrl)));
    // app.js sends the page to sign-in when it sees X-Sign-In. No
    // WWW-Authenticate, so the browser doesn't open its password prompt.
    res.set("X-Sign-In", "/signin");
    res.set("Cache-Control", "no-store");
    res.status(401).json({ error: "Sign in to the dashboard again." });
  }

  return { router, requireSignIn, session };
}

module.exports = { signInSettings, createSignIn, CALLBACK_PATH, SESSION_COOKIE };
