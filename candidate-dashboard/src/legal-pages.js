"use strict";
// The dashboard's privacy policy and terms of service, at exactly /privacy and
// /terms on every deployment and outside the login: Google's consent screen
// and reviewers link to them from outside. Exact, case-sensitive paths on
// GET/HEAD only, like /privacy.html (server.js): app.get() would also match
// "/PRIVACY" and "/privacy/". The files live in legal/, not public/, so
// express.static never serves them under another path.
//
// /privacy.html is a different page: the Luminai scheduler's Google Calendar
// policy, served only where the scheduling pilot is on.

const path = require("path");

const PAGES = {
  "/privacy": path.join(__dirname, "..", "legal", "privacy.html"),
  "/terms": path.join(__dirname, "..", "legal", "terms.html"),
};

function legalPages(req, res, next) {
  const file = Object.prototype.hasOwnProperty.call(PAGES, req.path) ? PAGES[req.path] : null;
  if (!file || (req.method !== "GET" && req.method !== "HEAD")) return next();
  res.sendFile(file);
}

module.exports = { legalPages, LEGAL_PAGES: PAGES };
