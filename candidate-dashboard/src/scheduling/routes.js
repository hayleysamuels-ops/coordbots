"use strict";
const express = require("express");
function routes(service) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.method !== "GET") {
      if (!req.is("application/json") || req.get("X-Scheduling-Request") !== "1" || req.get("Sec-Fetch-Site") === "cross-site") return res.status(403).json({ error: "Invalid scheduling request" });
      // Compare host rather than scheme: Railway terminates HTTPS at the proxy.
      const origin = req.get("Origin");
      try { if (origin && new URL(origin).host !== req.get("host")) return res.status(403).json({ error: "Cross-site request refused" }); }
      catch (_) { return res.status(403).json({ error: "Invalid origin" }); }
    }
    next();
  });
  const handle = fn => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : "Scheduling is unavailable. Refresh to check the latest status." }); }
  };
  router.get("/", handle(async req => ({ status: service.status(req.schedulingUser), proposals: await service.list(), sources: await service.sources() })));
  router.get("/template/:applicationId", handle(req => service.template(req.params.applicationId)));
  router.post("/import/:id", handle(req => service.importSource(req.params.id, req.schedulingUser)));
  router.post("/drafts", handle(req => service.draft(req.body, req.schedulingUser)));
  router.post("/:id/share", handle(req => service.share(req.params.id, req.body, req.schedulingUser)));
  router.post("/:id/reject", handle(req => service.reject(req.params.id, req.body, req.schedulingUser)));
  router.post("/:id/book", handle(req => service.approveBooking(req.params.id, req.body, req.schedulingUser)));
  return router;
}
module.exports = { routes };
