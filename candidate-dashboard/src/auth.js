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
// server.js. Credentials come from DASHBOARD_USER/DASHBOARD_PASSWORD — if
// either is unset, config's required() already warned at startup and every
// request will simply fail auth (safer default than leaving the dashboard
// open).
function basicAuth(req, res, next) {
  // Coordinator credentials are scoped to connection and booking routes. They
  // do not replace the browser's cached shared dashboard Basic Auth credentials.
  const connectionLogin = req.headers["x-coordinator-authorization"];
  const connectionRequest = req.method === "POST" && req.path.startsWith("/api/ashby-connection/");
  const bookingRequest = ["GET", "POST"].includes(req.method) &&
    (req.path === "/api/scheduling-booking" || req.path.startsWith("/api/scheduling-booking/"));
  if (connectionLogin !== undefined && (connectionRequest || bookingRequest)) {
    res.set("Cache-Control", "no-store");
    const match = typeof connectionLogin === "string" && /^Basic ([A-Za-z0-9+/=]+)$/.exec(connectionLogin);
    const decoded = match ? Buffer.from(match[1], "base64").toString("utf8") : "";
    const split = decoded.indexOf(":");
    const user = decoded.slice(0, split), pass = decoded.slice(split + 1);
    const approver = split > 0 && config.schedulingApprovers.find(a => timingSafeEqualString(user, a.username) && timingSafeEqualString(pass, a.password));
    if (!approver) return res.status(403).json({ error: "Coordinator username or password is incorrect." });
    req.schedulingUser = { id: approver.username, canApprove: true };
    return next();
  }
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sepIndex = decoded.indexOf(":");
    if (sepIndex !== -1) {
      const user = decoded.slice(0, sepIndex);
      const pass = decoded.slice(sepIndex + 1);
      // Shared dashboard access never grants approval permission.
      const approver = config.schedulingApprovers.find(a => timingSafeEqualString(user, a.username) && timingSafeEqualString(pass, a.password));
      if (approver) { req.schedulingUser = { id: approver.username, canApprove: true }; return next(); }
      const userOk = timingSafeEqualString(user, config.dashboardUser);
      const passOk = timingSafeEqualString(pass, config.dashboardPassword);
      if (config.dashboardUser && config.dashboardPassword && userOk && passOk) return next();
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Candidate Dashboard"');
  res.status(401).send("Authentication required.");
}

module.exports = { basicAuth };
