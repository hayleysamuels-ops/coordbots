"use strict";

const express = require("express");
const config = require("./config");
const { verifyAshbySignature } = require("./signature");
const { parseWebhook } = require("./ashby");
const reminders = require("./reminders");

function createServer() {
  const app = express();

  // We need the RAW body to verify the signature, so capture it as a Buffer.
  app.use(
    "/webhooks/ashby",
    express.raw({ type: "*/*", limit: "2mb" })
  );

  app.get("/health", (_req, res) => res.json({ ok: true }));

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
      if (parsed.reminders.length === 0) {
        console.log(`[server] ${action}: no schedulable interview events found.`);
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
