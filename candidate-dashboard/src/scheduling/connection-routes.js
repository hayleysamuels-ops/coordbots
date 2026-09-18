"use strict";
const express = require("express");
const { signed } = require("./worker-auth");
function connectionRoutes({ url, secret, clientId, expectedIdentity, fetchImpl = fetch }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!req.schedulingUser?.canApprove) return res.status(403).json({ error: "Sign in with an individual coordinator account to connect Ashby. The shared dashboard login cannot manage connections." });
    if (!req.is("application/json") || req.get("X-Scheduling-Request") !== "1" || req.get("Sec-Fetch-Site") === "cross-site") return res.status(403).json({ error: "Invalid connection request" });
    try { if (req.get("Origin") && new URL(req.get("Origin")).host !== req.get("host")) throw new Error(); }
    catch (_) { return res.status(403).json({ error: "Cross-site connection request refused" }); }
    next();
  });
  router.post("/:action", async (req, res) => {
    const action = req.params.action;
    if (!["status", "start", "frame", "input", "finish", "cancel"].includes(action)) return res.status(404).json({ error: "Unknown connection action" });
    if (!url || !secret || secret.length < 32 || !clientId || !expectedIdentity) return res.status(503).json({ error: "The dedicated Ashby connection has not been configured for this dashboard yet." });
    let endpoint;
    try {
      endpoint = new URL(url);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !["", "/"].includes(endpoint.pathname)) throw new Error();
      if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && endpoint.hostname === "scheduling-worker.railway.internal")) throw new Error();
      endpoint.pathname = "/connection";
    } catch (_) { return res.status(503).json({ error: "The connection requires HTTPS or the dedicated Railway private network." }); }
    try {
      const request = signed(secret, { action, clientId, expectedIdentity, owner: req.schedulingUser.id, id: req.body.id, input: req.body.input });
      const response = await fetchImpl(endpoint, { method: "POST", ...request, redirect: "error", signal: AbortSignal.timeout(55000) });
      const data = await response.json();
      if (response.ok && action === "status" && (data.clientId !== clientId || data.expectedIdentity !== expectedIdentity)) return res.status(503).json({ error: "The worker belongs to a different client or Ashby account. Connection refused." });
      res.status(response.status).json(data);
    } catch (_) { res.status(503).json({ error: "The Ashby connection could not be reached. No connection success has been confirmed." }); }
  });
  return router;
}
module.exports = { connectionRoutes };
