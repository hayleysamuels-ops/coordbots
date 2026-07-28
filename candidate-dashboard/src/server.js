"use strict";

const path = require("path");
const express = require("express");
const issues = require("./issues");
const dismissals = require("./dismissals");
const { basicAuth } = require("./auth");

function createServer() {
  const app = express();

  // First, ahead of static files and every /api/* route — nothing on this
  // server is reachable without valid credentials.
  app.use(basicAuth);

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/api/issues", (req, res) => {
    res.json(issues.getSnapshot());
  });

  // Manual refresh button on the dashboard hits this instead of waiting for
  // the background interval. Deliberately only refreshes the six main
  // sections (issues.refresh()) — NOT Active Referrals, which stays on its
  // own independent timer (referralCache.js). Forcing that here on every
  // button click would reintroduce exactly the multi-minute wait the whole
  // two-timer split exists to avoid.
  app.post("/api/refresh", async (req, res) => {
    await issues.refresh();
    res.json(issues.getSnapshot());
  });

  // Dismiss a candidate/interviewer card. scope "today" clears at next local
  // midnight; "forever" persists until manually undismissed. Returns the
  // freshly filtered snapshot so the dashboard updates immediately.
  app.post("/api/dismiss", (req, res) => {
    const { key, scope } = req.body || {};
    if (!key) return res.status(400).json({ error: "key required" });
    dismissals.add(key, scope === "forever" ? "forever" : "today");
    res.json(issues.getSnapshot());
  });

  app.post("/api/undismiss", (req, res) => {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ error: "key required" });
    dismissals.remove(key);
    res.json(issues.getSnapshot());
  });

  return app;
}

module.exports = { createServer };
