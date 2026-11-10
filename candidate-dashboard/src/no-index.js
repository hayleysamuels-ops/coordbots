"use strict";
// Keeps every dashboard out of search results. Every response carries
// X-Robots-Tag: noindex, nofollow (pages, files, API answers, errors), and
// /robots.txt is public and asks crawlers to stay out, except for /privacy
// and /terms: Google's OAuth consent screen links to those, and a crawler
// that's allowed to fetch them sees the noindex header, where a disallowed
// one could still list the bare address if it found a link.

const ROBOTS = "User-agent: *\nAllow: /privacy\nAllow: /terms\nDisallow: /\n";

function noIndex(req, res, next) {
  res.set("X-Robots-Tag", "noindex, nofollow");
  if (req.path === "/robots.txt" && (req.method === "GET" || req.method === "HEAD")) return res.type("text/plain").send(ROBOTS);
  next();
}

module.exports = { noIndex, ROBOTS };
