"use strict";

const crypto = require("crypto");
const config = require("./config");

// Constant-time string compare. crypto.timingSafeEqual throws on
// mismatched lengths, so a differing length still runs a same-shape
// comparison (against a zero buffer) rather than short-circuiting straight
// to `false` — keeps the timing profile close to a real comparison instead
// of leaking length via an early return.
function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Applied in front of every route (including static files and /api/*) in
// server.js, on every dashboard without Google sign-in (with it, signin.js's
// middleware takes its place), except those mounted ahead of it there: GET /robots.txt (no-index.js), GET /privacy and /terms
// (every deployment, legal-pages.js), GET /google<…>.html (only where
// GOOGLE_SITE_VERIFICATION names it, site-verification.js), GET /privacy.html (only
// where the scheduling pilot is on), POST /api/slack/interactions and POST
// /api/slack/events (both Slack-signed). Credentials come from DASHBOARD_USER/DASHBOARD_PASSWORD — if
// either is unset, config's required() already warned at startup and every
// request will simply fail auth (safer default than leaving the dashboard
// open).
function basicAuth(req, res, next) {
  if (coordinatorLogin(req, res, next)) return;
  const login = basicLogin(req);
  if (login) {
    // Shared dashboard access never grants approval permission.
    const approver = approverFor(login);
    if (approver) { req.schedulingUser = { id: approver.username, canApprove: true }; return next(); }
    const userOk = timingSafeEqualString(login.user, config.dashboardUser);
    const passOk = timingSafeEqualString(login.pass, config.dashboardPassword);
    if (config.dashboardUser && config.dashboardPassword && userOk && passOk) return next();
  }

  res.set("WWW-Authenticate", 'Basic realm="Candidate Dashboard"');
  res.status(401).send("Authentication required.");
}

// Coordinator credentials are scoped to connection and booking routes. They
// do not replace the browser's cached shared dashboard Basic Auth credentials
// (or, with Google sign-in on, its session). Returns true when it has handled
// the request: passed it on, or refused it.
function coordinatorLogin(req, res, next) {
  const connectionLogin = req.headers["x-coordinator-authorization"];
  const connectionRequest = req.method === "POST" && req.path.startsWith("/api/ashby-connection/");
  const bookingRequest = ["GET", "POST"].includes(req.method) &&
    (req.path === "/api/scheduling-booking" || req.path.startsWith("/api/scheduling-booking/"));
  const calendarRequest = ["GET", "POST"].includes(req.method) && req.path.startsWith("/api/google-calendar/");
  if (connectionLogin === undefined || !(connectionRequest || bookingRequest || calendarRequest)) return false;
  res.set("Cache-Control", "no-store");
  const match = typeof connectionLogin === "string" && /^Basic ([A-Za-z0-9+/=]+)$/.exec(connectionLogin);
  const decoded = match ? Buffer.from(match[1], "base64").toString("utf8") : "";
  const split = decoded.indexOf(":");
  const user = decoded.slice(0, split), pass = decoded.slice(split + 1);
  const approver = split > 0 && approverFor({ user, pass });
  if (!approver) { res.status(403).json({ error: "Coordinator username or password is incorrect." }); return true; }
  req.schedulingUser = { id: approver.username, canApprove: true };
  next();
  return true;
}

// The Authorization header's Basic username and password, or null.
function basicLogin(req) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return null;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const sepIndex = decoded.indexOf(":");
  if (sepIndex === -1) return null;
  return { user: decoded.slice(0, sepIndex), pass: decoded.slice(sepIndex + 1) };
}

function approverFor({ user, pass }) {
  return config.schedulingApprovers.find(a => timingSafeEqualString(user, a.username) && timingSafeEqualString(pass, a.password)) || null;
}

module.exports = { basicAuth, coordinatorLogin, basicLogin, approverFor, timingSafeEqualString };
