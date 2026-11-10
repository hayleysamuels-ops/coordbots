"use strict";
// Search Console's ownership file (site-verification.js). Fictional file names.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { siteVerificationSettings, siteVerification } = require("../src/site-verification");

test("settings: the file name as given, with or without .html; anything else serves nothing and warns", () => {
  assert.deepEqual(siteVerificationSettings(""), { file: null, warning: null });
  assert.deepEqual(siteVerificationSettings(" google0123456789abcdef.html "), { file: "google0123456789abcdef.html", warning: null });
  assert.equal(siteVerificationSettings("google0123456789abcdef").file, "google0123456789abcdef.html");
  for (const bad of ["../etc/passwd", "google0123.html/x", "index.html", "googleXYZ.html", "google-site-verification: google0123456789abcdef.html"]) {
    const s = siteVerificationSettings(bad);
    assert.equal(s.file, null, bad);
    assert.ok(s.warning, bad);
  }
});

test("serves exactly /<file> on GET and HEAD with Search Console's line, and nothing else", async (t) => {
  const app = express();
  app.use(siteVerification("google0123456789abcdef.html"));
  app.use((req, res) => res.status(401).send("login"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ok = await fetch(base + "/google0123456789abcdef.html");
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type"), /^text\/html/);
  assert.equal(await ok.text(), "google-site-verification: google0123456789abcdef.html");
  assert.equal((await fetch(base + "/google0123456789abcdef.html", { method: "HEAD" })).status, 200);
  for (const p of ["/google0123456789abcdef.html/", "/GOOGLE0123456789abcdef.html", "/google0123456789abcdee.html", "/"]) {
    assert.equal((await fetch(base + p)).status, 401, p);
  }
  assert.equal((await fetch(base + "/google0123456789abcdef.html", { method: "POST" })).status, 401);
});

test("unset: nothing is served", async (t) => {
  const app = express().use(siteVerification(null)).use((req, res) => res.status(401).end());
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  t.after(() => server.close());
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/google0123456789abcdef.html`)).status, 401);
});
