"use strict";

const path = require("path");
const express = require("express");
const config = require("./config");
const { basicAuth } = require("./auth");
const metrics = require("./metrics");
const sync = require("./sync");
const store = require("./db");

const STARTED_AT = new Date().toISOString();

function createServer() {
  const app = express();
  app.use(express.json());

  // Unauthenticated: a liveness probe that reveals nothing. Everything
  // else, static files included, sits behind Basic Auth.
  //
  // Deliberately does NOT carry the commit SHA. A version string on an
  // open endpoint tells anyone exactly which build is running; the SHA
  // lives on /api/config, behind auth, where CI can still read it.
  app.get("/healthz", (req, res) => res.json({ ok: true }));

  app.use(basicAuth);

  // Client list and display config for the tab bar. API keys never leave
  // the server — only the id, name, zone and accent the UI needs.
  app.get("/api/config", (req, res) => {
    res.json({
      title: config.dashboardTitle,
      // Which build is actually serving.
      //
      // CI used to wait for /healthz to return 200 and then smoke-test
      // whatever was up — which cannot distinguish the new deployment
      // from the old one still running. When a Railway webhook was
      // dropped overnight, the committed fix never deployed and nothing
      // noticed: a green run would have certified the previous build.
      // CI now waits for this to equal the commit it is testing.
      commit: config.commitSha,
      startedAt: STARTED_AT,
      overviewTimeZone: config.overviewTimeZone,
      historyMonths: config.historyMonths,
      // Served so public/app.js builds its period control from the same
      // list the aggregation uses, instead of a hardcoded copy that can
      // drift out of sync with it.
      periods: metrics.PERIODS.map((p) => ({ key: p.key, label: p.label, description: p.description })),
      defaultPeriod: metrics.DEFAULT_PERIOD,
      scopes: [
        { key: "coordinated", label: "Carrara-coordinated" },
        { key: "all", label: "All activity" },
      ],
      defaultScope: "coordinated",
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
