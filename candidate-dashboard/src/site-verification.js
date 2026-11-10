"use strict";
// Google Search Console's HTML-file ownership check, so Google's OAuth
// Branding review accepts this dashboard's *.up.railway.app address as ours
// (a Railway subdomain can't be verified by DNS). GOOGLE_SITE_VERIFICATION
// is the file name Search Console gives, e.g. google1234abcd.html; the page
// is served at exactly /<that name>, outside the login, with the one line
// Search Console expects in it. Unset (every dashboard by default), nothing
// is served. Keep the file served after verifying: Google re-checks it.

const NAME = /^google[0-9a-f]{6,64}\.html$/;

function siteVerificationSettings(raw) {
  const value = (raw || "").trim();
  if (!value) return { file: null, warning: null };
  const file = value.endsWith(".html") ? value : value + ".html";
  if (!NAME.test(file)) return { file: null, warning: `GOOGLE_SITE_VERIFICATION "${value}" isn't a Search Console file name like google1234abcd.html; nothing is served` };
  return { file, warning: null };
}

function siteVerification(file) {
  const body = `google-site-verification: ${file}`;
  return (req, res, next) => {
    if (!file || req.path !== "/" + file || (req.method !== "GET" && req.method !== "HEAD")) return next();
    res.type("html").send(body);
  };
}

module.exports = { siteVerificationSettings, siteVerification };
