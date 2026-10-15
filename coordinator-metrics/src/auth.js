"use strict";

const crypto = require("crypto");
const config = require("./config");

// Constant-time compare. crypto.timingSafeEqual throws on mismatched
// lengths, so a differing length still runs a same-shape comparison
// against a zero buffer rather than short-circuiting to false — that early
// return would leak the credential length through timing.
function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * One shared credential in front of every route, matching the other
 * dashboards in this monorepo. This is the internal-first posture that was
 * agreed: everyone who can log in sees every client's tab.
 *
 * If a per-client client-facing view is added later, it needs real
 * per-user auth — this function is deliberately the only place that
 * decides access, so that change lands in one file.
 *
 * With either variable unset, config has already warned at startup and
 * every request fails closed rather than leaving the dashboard open.
 */
function basicAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sepIndex = decoded.indexOf(":");
    if (sepIndex !== -1) {
      const user = decoded.slice(0, sepIndex);
      const pass = decoded.slice(sepIndex + 1);
      const userOk = timingSafeEqualString(user, config.dashboardUser);
      const passOk = timingSafeEqualString(pass, config.dashboardPassword);
      if (config.dashboardUser && config.dashboardPassword && userOk && passOk) return next();
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Coordinator Metrics"');
  res.status(401).send("Authentication required.");
}

module.exports = { basicAuth };
