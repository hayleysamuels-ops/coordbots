"use strict";
const express = require("express");
function schedulingRoutes(service) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!req.user?.active) return res.status(401).json({ error: "Sign in to continue" });
    if (req.method !== "GET") {
      // JSON plus an explicit same-origin browser header prevents cross-site
      // forms from approving plans with the coordinator's cookie.
      if (!req.is("application/json") || req.get("X-Scheduling-Request") !== "1")
        return res.status(403).json({ error: "Invalid scheduling request" });
      const origin = req.get("Origin");
      if (origin && origin !== req.protocol + "://" + req.get("host"))
        return res.status(403).json({ error: "Cross-site scheduling request refused" });
    }
    next();
  });
  const handle = fn => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Scheduling is unavailable. No successful booking has been confirmed." }); }
  };
  router.get("/status", handle(() => service.readiness()));
  router.get("/context/:candidateId", handle(req => service.context(req.params.candidateId, req.query)));
  router.get("/proposals", handle(req => service.list(req.query.candidateId)));
  router.post("/suggest/:candidateId", handle(req => service.suggest(req.params.candidateId, req.body, req.user)));
  router.post("/proposals/:id/approve", handle(req => service.approve(req.params.id, req.body, req.user)));
  router.post("/proposals/:id/reject", handle(req => service.reject(req.params.id, req.body, req.user)));
  return router;
}
module.exports = { schedulingRoutes };
