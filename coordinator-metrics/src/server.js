"use strict";

const path = require("path");
const express = require("express");
const config = require("./config");
const { basicAuth } = require("./auth");
const metrics = require("./metrics");
const sync = require("./sync");
const store = require("./db");

function createServer() {
  const app = express();
  app.use(express.json());

  // Unauthenticated: a liveness probe that reveals nothing. Everything
  // else, static files included, sits behind Basic Auth.
  app.get("/healthz", (req, res) => res.json({ ok: true }));

  app.use(basicAuth);

  // Client list and display config for the tab bar. API keys never leave
  // the server — only the id, name, zone and accent the UI needs.
  app.get("/api/config", (req, res) => {
    res.json({
      title: config.dashboardTitle,
      overviewTimeZone: config.overviewTimeZone,
      historyMonths: config.historyMonths,
      shortNoticeHours: config.shortNoticeHours,
      businessHours: { start: config.businessHourStart, end: config.businessHourEnd },
      clients: config.clients.map((c) => ({
        id: c.id,
        name: c.name,
        timeZone: c.timeZone,
        accentColor: c.accentColor || null,
        configured: Boolean(c.apiKey),
      })),
    });
  });

  app.get("/api/overview", (req, res) => {
    const payload = metrics.getOverview();
    if (!payload) return res.status(503).json({ error: "Metrics have not been computed yet. The first sync may still be running." });
    res.json(payload);
  });

  app.get("/api/client/:id", (req, res) => {
    const client = config.clients.find((c) => c.id === req.params.id);
    if (!client) return res.status(404).json({ error: "Unknown client" });
    if (!client.apiKey) {
      return res.status(503).json({
        error: `"${client.name}" has no Ashby API key configured on this deployment, so there is nothing to show. Set ASHBY_API_KEY_${client.id.toUpperCase()} in Railway.`,
      });
    }

    const payload = metrics.getClient(req.params.id);
    if (!payload) return res.status(503).json({ error: "Metrics have not been computed yet. The first sync may still be running." });
    res.json(payload);
  });

  // Sync health: what ran, when, and whether it worked. Surfaced in the UI
  // footer so a silently stale dashboard is visible rather than looking
  // like a quiet week.
  app.get("/api/status", (req, res) => {
    res.json({
      runs: store.lastSyncRuns(),
      progress: sync.getSyncProgress(),
      generatedAt: metrics.getOverview() ? metrics.getOverview().generatedAt : null,
    });
  });

  // Manual refresh. Incremental by default; ?kind=full re-pulls the whole
  // 12 months, which takes minutes — hence the explicit opt-in.
  app.post("/api/sync", async (req, res) => {
    const kind = req.query.kind === "full" ? "full" : "incremental";
    if (sync.getSyncProgress().running) {
      return res.status(409).json({ error: "A sync is already running", progress: sync.getSyncProgress() });
    }

    res.json({ started: true, kind });
    try {
      await sync.syncAll(kind); // rebuilds the metrics cache itself when it finishes
    } catch (err) {
      console.error("[server] manual sync failed:", err.message);
    }
  });

  app.use(express.static(path.join(__dirname, "..", "public")));

  return app;
}

module.exports = { createServer };
