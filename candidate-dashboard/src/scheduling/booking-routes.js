"use strict";
const express = require("express");
function bookingRoutes({ engine, store, clientId, facts, capabilities = async () => ({ available: false, reason: "Ashby calendar and booking automation are not connected yet." }) }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!req.schedulingUser?.canApprove) return res.status(403).json({ error: "Sign in with your coordinator account to review and approve bookings." });
    if (req.method !== "GET") {
      if (!req.is("application/json") || req.get("X-Scheduling-Request") !== "1" || req.get("Sec-Fetch-Site") === "cross-site") return res.status(403).json({ error: "Invalid booking request" });
      try { if (req.get("Origin") && new URL(req.get("Origin")).host !== req.get("host")) throw Error(); }
      catch (_) { return res.status(403).json({ error: "Cross-site booking request refused" }); }
    }
    next();
  });
  const handle = fn => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) { res.status(e.status || 503).json({ error: e.status ? e.message : "Could not confirm booking status. Refresh before taking further action." }); }
  };
  router.get("/", handle(async req => ({ clientId, coordinator: req.schedulingUser.id, capabilities: await capabilities(), drafts: (await store.list()).filter(r => r.clientId === clientId) })));
  router.post("/details", handle(req => {
    if (!facts) throw Object.assign(new Error("Ashby interview details are not connected."), { status: 503 });
    return facts.load(req.body);
  }));
  router.post("/drafts", handle(req => engine.draft(req.body, req.schedulingUser)));
  router.post("/:id/reject", handle(req => engine.reject(req.params.id, req.body, req.schedulingUser)));
  router.post("/:id/approve", handle(async req => {
    // Approval and dispatch occur in a single request. The durable engine claims
    // the operation before any external write; a lost response cannot retry it.
    const approved = await engine.approve(req.params.id, req.body, req.schedulingUser);
    await engine.execute(approved.id);
    return store.get(approved.id);
  }));
  return router;
}
module.exports = { bookingRoutes };
