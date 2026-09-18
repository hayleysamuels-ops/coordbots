"use strict";

const path = require("path");
const express = require("express");
const issues = require("./issues");
const dismissals = require("./dismissals");
const notes = require("./notes");
const { basicAuth } = require("./auth");

function createServer() {
  const app = express();

  // First, ahead of static files and every /api/* route — nothing on this
  // server is reachable without valid credentials.
  app.use(basicAuth);

  app.use(express.json());
  const scheduling = require("./scheduling/setup").setup(require("./config"), async () => {
    const snapshot = issues.getSnapshot();
    return Object.values(snapshot).filter(Array.isArray).flat().filter(c => c && c.applicationId);
  });
  app.use("/api/scheduling-review", require("./scheduling/routes").routes(scheduling));
  const connectionConfig = require("./config");
  app.use("/api/ashby-connection", require("./scheduling/connection-routes").connectionRoutes({
    url: connectionConfig.ashbyWorkerUrl, secret: connectionConfig.ashbyWorkerSecret,
    clientId: connectionConfig.schedulingClientId, expectedIdentity: connectionConfig.ashbyExpectedIdentity,
  }));
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/api/issues", (req, res) => {
    res.json(issues.getSnapshot());
  });

  // Manual refresh button on the dashboard hits this instead of waiting for
  // the background interval.
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

  // Save/update a candidate's local note (never written to Ashby — see
  // notes.js). Deliberately a separate store from dismissals, with its own
  // endpoints, so a note's lifecycle never rides along with a dismiss/
  // undismiss request.
  app.post("/api/notes", (req, res) => {
    const { candidateId, text } = req.body || {};
    if (!candidateId) return res.status(400).json({ error: "candidateId required" });
    notes.set(candidateId, text);
    res.json(issues.getSnapshot());
  });

  app.post("/api/notes/delete", (req, res) => {
    const { candidateId } = req.body || {};
    if (!candidateId) return res.status(400).json({ error: "candidateId required" });
    notes.remove(candidateId);
    res.json(issues.getSnapshot());
  });

  return app;
}

module.exports = { createServer };
