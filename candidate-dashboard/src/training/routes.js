"use strict";

const express = require("express");
const store = require("./store");
const config = require("../config");

// Mutation routes for the interviewer training tracker. Mounted only where
// TRAINING_TRACKER_CLIENT_ID is set (see server.js), so the other five
// dashboards 404 on all of it.
//
// EVERY route here writes to this app's own store and NOTHING to Ashby. That
// is a deliberate product decision, not a limitation to route around later:
// Ashby exposes `interviewerPool.addUser` and no other interviewer-pool
// write, so enrolment, stages, pausing and required counts aren't writable
// through the API at all - and the tracker is explicitly read-only against
// Ashby regardless. A completed trainee therefore has to be added to the
// Ashby pool by hand, which is why progress.js surfaces "complete" as its
// own visible state rather than quietly finishing.
//
// Auth is the dashboard's shared Basic Auth (src/auth.js), applied ahead of
// every route in server.js. There is no per-user identity behind it, so
// these mutations are not attributed to an individual - anyone with the
// dashboard password can enrol, pause and override.

// Every mutation responds with the freshly recomputed snapshot so the page
// updates on the same request rather than waiting for the next poll - the
// same contract /api/dismiss and /api/notes already use.
function routes(issues) {
  const router = express.Router();

  function respond(res) {
    res.json(issues.getSnapshot());
  }

  function requireFields(res, body, names) {
    for (const name of names) {
      if (!body || !body[name]) {
        res.status(400).json({ error: `${name} required` });
        return false;
      }
    }
    return true;
  }

  // Ashby users, for the enrolment picker. Cached upstream (ashby.listUsers).
  router.get("/users", async (req, res) => {
    try {
      res.json(await require("../ashby").listUsers());
    } catch (err) {
      res.status(502).json({ error: `Could not load users from Ashby: ${err.message}` });
    }
  });

  // --- paths -------------------------------------------------------------

  // A path is one interview title scoped to one job. interviewIds comes from
  // the picker's observed options, so it is already resolved - storing ids
  // rather than matching the title at read time means renaming an interview
  // in Ashby can't silently orphan the path.
  router.post("/paths", (req, res) => {
    const { id, label, interviewTitle, interviewIds, jobId, jobTitle, requiredShadows, requiredReverseShadows } = req.body || {};
    if (!requireFields(res, req.body, ["interviewTitle", "jobId"])) return;
    if (!Array.isArray(interviewIds) || !interviewIds.length) {
      return res.status(400).json({ error: "interviewIds required" });
    }
    store.upsertPath({
      id,
      label,
      interviewTitle,
      interviewIds,
      jobId,
      jobTitle: jobTitle || "",
      requiredShadows: Number.isFinite(requiredShadows) ? requiredShadows : config.trainingDefaultShadows,
      requiredReverseShadows: Number.isFinite(requiredReverseShadows)
        ? requiredReverseShadows
        : config.trainingDefaultReverseShadows,
    });
    respond(res);
  });

  // Accepts a "new Ashby interview record matches this path" suggestion (see
  // progress.suggestedPathInterviews). Deliberately a confirmation rather
  // than automatic: same-titled duplicates in Ashby are not always the same
  // interview.
  router.post("/paths/add-interview", (req, res) => {
    const { pathId, interviewId } = req.body || {};
    if (!requireFields(res, req.body, ["pathId", "interviewId"])) return;
    if (!store.getPath(pathId)) return res.status(404).json({ error: "path not found" });
    store.addInterviewIdToPath(pathId, interviewId);
    respond(res);
  });

  // Removes the path AND its enrolments - an enrolment whose path is gone is
  // unreachable in the UI and would accumulate invisibly.
  router.post("/paths/delete", (req, res) => {
    if (!requireFields(res, req.body, ["pathId"])) return;
    store.removePath(req.body.pathId);
    respond(res);
  });

  // --- enrolment ---------------------------------------------------------

  router.post("/enrol", (req, res) => {
    const { userId, userName, userEmail, pathId } = req.body || {};
    if (!requireFields(res, req.body, ["userId", "pathId"])) return;
    if (!store.getPath(pathId)) return res.status(404).json({ error: "path not found" });
    store.enrol({ userId, userName, userEmail, pathId });
    respond(res);
  });

  router.post("/unenrol", (req, res) => {
    if (!requireFields(res, req.body, ["userId", "pathId"])) return;
    store.unenrol(req.body.userId, req.body.pathId);
    respond(res);
  });

  // --- state -------------------------------------------------------------

  // Reason and expected return are both optional; the paused-on date is
  // always recorded. A session that happens while someone is paused is still
  // recorded and flagged, never counted and never silently unpausing them
  // (see progress.isDuringPause).
  router.post("/pause", (req, res) => {
    const { userId, pathId, reason, expectedReturn } = req.body || {};
    if (!requireFields(res, req.body, ["userId", "pathId"])) return;
    if (!store.pause(userId, pathId, { reason, expectedReturn })) {
      return res.status(404).json({ error: "enrolment not found" });
    }
    respond(res);
  });

  router.post("/unpause", (req, res) => {
    if (!requireFields(res, req.body, ["userId", "pathId"])) return;
    if (!store.unpause(req.body.userId, req.body.pathId)) {
      return res.status(404).json({ error: "enrolment not found" });
    }
    respond(res);
  });

  router.post("/archive", (req, res) => {
    if (!requireFields(res, req.body, ["userId", "pathId"])) return;
    if (!store.archive(req.body.userId, req.body.pathId)) {
      return res.status(404).json({ error: "enrolment not found" });
    }
    respond(res);
  });

  router.post("/unarchive", (req, res) => {
    if (!requireFields(res, req.body, ["userId", "pathId"])) return;
    if (!store.unarchive(req.body.userId, req.body.pathId)) {
      return res.status(404).json({ error: "enrolment not found" });
    }
    respond(res);
  });

  // Per-person requirement override. null on either field restores the
  // path's own requirement rather than pinning the current value.
  router.post("/requirements", (req, res) => {
    const { userId, pathId, shadows, reverseShadows } = req.body || {};
    if (!requireFields(res, req.body, ["userId", "pathId"])) return;
    const bad = (n) => n != null && (!Number.isInteger(n) || n < 0 || n > 20);
    if (bad(shadows) || bad(reverseShadows)) {
      return res.status(400).json({ error: "shadows/reverseShadows must be whole numbers between 0 and 20, or null" });
    }
    if (!store.setRequirements(userId, pathId, { shadows, reverseShadows })) {
      return res.status(404).json({ error: "enrolment not found" });
    }
    respond(res);
  });

  // --- sessions ----------------------------------------------------------

  // `role` reclassifies a session the sequence rule got wrong. `discounted`
  // excludes it - the manual answer to Ashby exposing no RSVP data anywhere,
  // so a trainee who didn't turn up to an interview that went ahead can be
  // discounted by hand. Both are also how an ambiguous session (the trainee
  // was the ONLY interviewer, so they ran it rather than shadowed it) gets
  // resolved.
  router.post("/session", (req, res) => {
    const { userId, pathId, eventId, role, discounted, note } = req.body || {};
    if (!requireFields(res, req.body, ["userId", "pathId", "eventId"])) return;
    if (role != null && role !== "Shadow" && role !== "ReverseShadow") {
      return res.status(400).json({ error: "role must be Shadow, ReverseShadow or null" });
    }
    if (!store.setSessionOverride(userId, pathId, eventId, { role, discounted, note })) {
      return res.status(404).json({ error: "enrolment not found" });
    }
    respond(res);
  });

  // Credit for a session that happened before enrolment, or outside Ashby.
  // Enrolment deliberately counts only from its own date onward, so this is
  // how anything already done gets recognised.
  router.post("/credit", (req, res) => {
    const { userId, pathId, role, at, note } = req.body || {};
    if (!requireFields(res, req.body, ["userId", "pathId"])) return;
    if (role !== "Shadow" && role !== "ReverseShadow") {
      return res.status(400).json({ error: "role must be Shadow or ReverseShadow" });
    }
    if (at && Number.isNaN(new Date(at).getTime())) {
      return res.status(400).json({ error: "at must be a valid date" });
    }
    if (!store.addManualCredit(userId, pathId, { role, at, note })) {
      return res.status(404).json({ error: "enrolment not found" });
    }
    respond(res);
  });

  router.post("/credit/delete", (req, res) => {
    if (!requireFields(res, req.body, ["userId", "pathId", "creditId"])) return;
    if (!store.removeManualCredit(req.body.userId, req.body.pathId, req.body.creditId)) {
      return res.status(404).json({ error: "enrolment not found" });
    }
    respond(res);
  });

  return router;
}

module.exports = { routes };
