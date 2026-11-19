"use strict";

const crypto = require("crypto");
const express = require("express");
const config = require("./config");
const { parseRequest } = require("./remind-now");
const { verifyAshbySignature } = require("./signature");
const { parseWebhook } = require("./ashby");
const reminders = require("./reminders");

// Constant-time compare of the Bearer token with REMIND_SECRET.
function bearerOk(req, secret) {
  const m = /^Bearer (.+)$/.exec(req.get("Authorization") || "");
  if (!m || !secret) return false;
  const a = crypto.createHash("sha256").update(m[1]).digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

// `remindNow` (remind-now.js) and the settings are passed in so tests can
// run the routes without Slack or Ashby.
function createServer({ remindNow = null, settings = config } = {}) {
  const app = express();

  app.get("/health", (_req, res) => res.json({ ok: true, automaticReminders: settings.automaticReminders, remind: Boolean(remindNow && settings.remindSecret) }));

  // The dashboard's "remind now" button. Exists only with REMIND_SECRET set.
  if (remindNow && settings.remindSecret) {
    app.post("/remind", express.json({ limit: "64kb" }), async (req, res) => {
      if (!bearerOk(req, settings.remindSecret)) return res.status(401).json({ error: "unauthorised" });
      const { request, error } = parseRequest(req.body);
      if (error) return res.status(400).json({ error });
      try {
        res.json(await remindNow.remind(request));
      } catch (err) {
        console.error("[server] /remind failed:", err.message);
        res.status(500).json({ error: "reminder failed" });
      }
    });
  }

  // Ashby's schedule webhooks queue the automatic reminders. Off by default
  // (AUTOMATIC_REMINDERS): then this route doesn't exist and Ashby gets 404.
  if (!settings.automaticReminders) return app;

  // We need the RAW body to verify the signature, so capture it as a Buffer.
  app.use(
    "/webhooks/ashby",
    express.raw({ type: "*/*", limit: "2mb" })
  );

  app.post("/webhooks/ashby", (req, res) => {
    const rawBody = req.body; // Buffer
    const signature = req.get("Ashby-Signature");

    if (!verifyAshbySignature(rawBody, signature, config.ashbyWebhookSecret)) {
      console.warn("[server] Rejected webhook: bad or missing signature.");
      return res.status(401).send("invalid signature");
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch (err) {
      return res.status(400).send("invalid json");
    }

    if (config.debugPayloads) {
      console.log("[server] Raw payload:\n" + JSON.stringify(payload, null, 2));
    }

    const action = payload.action || payload.event || payload.type;

    // Ashby sends a "ping" when you create/edit the webhook. Ack it so the
    // webhook enables itself.
    if (action === "ping") {
      console.log("[server] Received ping webhook.");
      return res.status(200).send("pong");
    }

    // Ack fast; do the work after responding so Ashby doesn't time out / retry.
    res.status(200).send("ok");

    try {
      const parsed = parseWebhook(payload);
      // Note: a cancelled schedule arrives with zero events — we must still run
      // applyWebhook so it can cancel any queued reminders for that schedule.
      if (parsed.reminders.length === 0 && !parsed.scheduleId) {
        console.log(`[server] ${action}: nothing to process.`);
        return;
      }
      reminders
        .applyWebhook(parsed)
        .catch((err) => console.error("[server] applyWebhook error:", err.message));
    } catch (err) {
      console.error("[server] Error handling webhook:", err.message);
    }
  });

  return app;
}

module.exports = { createServer };
