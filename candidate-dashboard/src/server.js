"use strict";

const fs = require("fs");
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
  const config = require("./config");
  const pageGate = require("./scheduling/page-gate");

  // Scheduling pilot: mounted only where SCHEDULING_CLIENT_ID is set. Other
  // dashboards get 404s for these routes (see scheduling/page-gate.js).
  if (config.schedulingEnabled) {
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
    const googleCalendar = require("./scheduling/google-calendar-connection").createGoogleCalendarConnection({
      tenantId: connectionConfig.schedulingClientId, clientId: connectionConfig.googleCalendarClientId,
      clientSecret: connectionConfig.googleCalendarClientSecret, redirectUri: connectionConfig.googleCalendarRedirectUri,
      expectedEmail: connectionConfig.googleCalendarExpectedEmail, keyHex: connectionConfig.googleCalendarEncryptionKey,
      dataDir: connectionConfig.dataDir, ownerAllowed: async id => connectionConfig.schedulingApprovers.some(a => a.username === id),
    });
    const googleFreeBusy = require("./scheduling/google-freebusy").createGoogleFreeBusy({connection:googleCalendar});
    app.use("/api/google-calendar", require("./scheduling/google-calendar-routes").googleCalendarRoutes({connection:googleCalendar,freeBusy:googleFreeBusy}));
    const bookingWorker = require("./scheduling/booking-worker-client").createBookingWorkerClient({
      url: connectionConfig.ashbyWorkerUrl, secret: connectionConfig.ashbyWorkerSecret,
      clientId: connectionConfig.schedulingClientId, expectedIdentity: connectionConfig.ashbyExpectedIdentity,
    });
    const bookingStore = require("./scheduling/booking-store").createBookingStore(connectionConfig.dataDir);
    const bookingEngine = require("./scheduling/booking-engine").createBookingEngine({
      store: bookingStore, clientId: connectionConfig.schedulingClientId,
      source: null, executor: null,
      userById: async id => connectionConfig.schedulingApprovers.some(a => a.username === id) ? { id, canApprove: true } : null,
    });
    app.use("/api/scheduling-booking", require("./scheduling/booking-routes").bookingRoutes({
      engine: bookingEngine, store: bookingStore, clientId: connectionConfig.schedulingClientId, googleCalendar, googleFreeBusy,
      availability: require("./scheduling/availability-source").createAvailabilitySource({key:connectionConfig.ashbyApiKey,clientId:connectionConfig.schedulingClientId,inspect:payload=>bookingWorker.call("inspect-availability",payload)}),
      inspectFullCalendar: payload => bookingWorker.call("inspect-full-calendar",payload),
      inspectPlan: payload => bookingWorker.call("inspect-plan",payload),
      inspectCalendar: payload => bookingWorker.call("inspect-calendar",payload),
      inspectDraft: payload => bookingWorker.call("inspect-draft",payload),
      facts: require("./scheduling/booking-facts").createBookingFacts({key: connectionConfig.ashbyApiKey, clientId: connectionConfig.schedulingClientId}),
      capabilities: async () => { const worker = await bookingWorker.capabilities(); return {available: false, reason: worker.available ? "The booking executor is being connected to this dashboard. Sending remains disabled." : worker.reason}; },
    }));
  }

  // Without the pilot, scheduling-only pages and assets 404, and index.html
  // is sent with its scheduling blocks removed. With it, express.static
  // serves every file unchanged, exactly as before the flag existed.
  if (!config.schedulingEnabled) {
    const indexHtml = pageGate.stripSchedulingBlocks(
      fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8"));
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (pageGate.SCHEDULING_ONLY_ASSETS.has(req.path)) return res.status(404).send("Not found");
      if (req.path === "/" || req.path === "/index.html") return res.type("html").send(indexHtml);
      next();
    });
  }
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
