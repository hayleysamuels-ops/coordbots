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

  // The one route outside Basic Auth: Slack's interactivity callback for the
  // "Schedule" button. Slack can't send dashboard credentials, so every request
  // must instead carry a valid Slack signature over its raw body (checked in
  // slack-interactions.js before anything is parsed). It exists only with the
  // scheduling pilot on and interactivity configured; otherwise it's a 404.
  let slackInteractions = null;
  app.post("/api/slack/interactions", express.raw({ type: "application/x-www-form-urlencoded", limit: "64kb" }),
    (req, res) => slackInteractions ? slackInteractions(req, res) : res.status(404).end());

  // First, ahead of static files and every other /api/* route: nothing else
  // on this server is reachable without valid credentials.
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
    const slackConfig = require("./config");
    if (scheduling.slackApi && require("./scheduling/setup").slackInteractive(slackConfig)) {
      slackInteractions = require("./scheduling/slack-interactions").createSlackInteractions({
        service: scheduling, slackApi: scheduling.slackApi, signingSecret: slackConfig.schedulingSlackSigningSecret,
        teamId: slackConfig.schedulingSlackTeamId, appId: slackConfig.schedulingSlackAppId,
        channelId: slackConfig.schedulingChannelId, approvers: slackConfig.schedulingSlackApprovers });
      console.log("[slack] Schedule button enabled: interactivity endpoint /api/slack/interactions is live.");
    }
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
      discussion: scheduling,
      rules: require("./scheduling/rules").loadRules({ clientId: connectionConfig.schedulingClientId }),
      availability: require("./scheduling/availability-source").createAvailabilitySource({key:connectionConfig.ashbyApiKey,clientId:connectionConfig.schedulingClientId,inspect:payload=>bookingWorker.call("inspect-availability",payload)}),
      inspectFullCalendar: payload => bookingWorker.call("inspect-full-calendar",payload),
      inspectPlan: payload => bookingWorker.call("inspect-plan",payload),
      inspectCalendar: payload => bookingWorker.call("inspect-calendar",payload),
      inspectDraft: payload => bookingWorker.call("inspect-draft",payload),
      facts: require("./scheduling/booking-facts").createBookingFacts({key: connectionConfig.ashbyApiKey, clientId: connectionConfig.schedulingClientId}),
      capabilities: async () => { const worker = await bookingWorker.capabilities(); return {available: false, reason: worker.available ? "The booking executor is being connected to this dashboard. Sending remains disabled." : worker.reason}; },
    }));
  }

  // Feature-gated markup and assets. Without the scheduling pilot, its pages
  // and assets 404 and its index.html blocks are removed. The training
  // tracker gates in BOTH directions: exactly one of the two training blocks
  // survives, because the tracker replaces the original Ashby-native
  // Interviewer Training section rather than sitting alongside it. With every
  // feature on, express.static serves each file unchanged.
  const rawIndexHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  let indexHtml = rawIndexHtml;
  if (!config.schedulingEnabled) indexHtml = pageGate.stripBlocks(indexHtml, "scheduling");
  indexHtml = config.trainingTrackerEnabled
    ? pageGate.stripBlocks(indexHtml, "training-legacy")
    : pageGate.stripBlocks(indexHtml, "training");

  if (indexHtml !== rawIndexHtml || !config.schedulingEnabled || !config.trainingTrackerEnabled) {
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (!config.schedulingEnabled && pageGate.SCHEDULING_ONLY_ASSETS.has(req.path)) return res.status(404).send("Not found");
      if (!config.trainingTrackerEnabled && pageGate.TRAINING_ONLY_ASSETS.has(req.path)) return res.status(404).send("Not found");
      if (req.path === "/" || req.path === "/index.html") return res.type("html").send(indexHtml);
      next();
    });
  }
  app.use(express.static(path.join(__dirname, "..", "public")));

  // Interviewer training tracker: mounted only where TRAINING_TRACKER_CLIENT_ID
  // is set, so the other dashboards 404 on all of it - same gating shape as
  // the scheduling pilot above. Every route writes to this app's own store
  // and nothing to Ashby (see training/routes.js).
  if (config.trainingTrackerEnabled) {
    app.use("/api/training", require("./training/routes").routes(issues));
  }

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
