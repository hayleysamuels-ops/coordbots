"use strict";

const express = require("express");
const config = require("./config");
const { verifyAshbySignature } = require("./signature");
const { parseWebhook } = require("./ashby");
const handler = require("./handler");

function createServer() {
  const app = express();

  // The signature covers the raw bytes, so capture the body as a Buffer and
  // parse it ourselves.
  app.use("/webhooks/ashby", express.raw({ type: "*/*", limit: "2mb" }));

  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      dryRun: config.dryRun,
      channelPrefix: config.channelPrefix || null,
      archiveOn: [...config.archiveOn],
    })
  );

  app.post("/webhooks/ashby", (req, res) => {
    const rawBody = req.body;
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

    // Ashby pings the endpoint when the webhook is created or edited. Acking it
    // is what enables the webhook.
    if (action === "ping") {
      console.log("[server] Received ping webhook.");
      return res.status(200).send("pong");
    }

    // Ack first, then work, so Ashby does not time out and retry.
    res.status(200).send("ok");

    let event;
    try {
      event = parseWebhook(payload);
    } catch (err) {
      console.error("[server] Could not parse webhook:", err.message);
      return;
    }

    handler.handleEvent(event).catch((err) => {
      console.error("[server] Unhandled error while processing webhook:", err.message);
    });
  });

  return app;
}

module.exports = { createServer };
