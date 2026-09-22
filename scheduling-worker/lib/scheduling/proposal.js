"use strict";

const crypto = require("crypto");
const { canApprove } = require("../../users");
const DAY = require("../dateday");

// Approval is of immutable content, not of a candidate or an editable row.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])])
  );
  return value;
}
function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function requireValue(ok, message) { if (!ok) throw new Error(message); }
function instant(value) {
  return typeof value === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
}

function validatePlan(plan) {
  requireValue(plan && ["new", "replacement"].includes(plan.kind), "Unknown scheduling operation");
  for (const key of ["candidateId", "applicationId", "templateRevision", "sourceFingerprint", "timezone"])
    requireValue(typeof plan[key] === "string" && plan[key].trim(), "Missing " + key);
  try { new Intl.DateTimeFormat("en", { timeZone: plan.timezone }); }
  catch (_) { throw new Error("Invalid timezone"); }
  requireValue(["FDE", "FDS", "Sales", "Platform"].includes(plan.role), "Unknown role");
  const start = DAY.parseDay(plan.startDate), end = DAY.parseDay(plan.endDate);
  requireValue(start && end && end >= start && DAY.diffDays(start, end) <= 14, "Invalid trial date range");
  requireValue(Array.isArray(plan.events) && plan.events.length > 0 && plan.events.length <= 60, "Missing or excessive events");
  const keys = new Set();
  for (const event of plan.events) {
    requireValue(event.key && !keys.has(event.key), "Events need unique keys"); keys.add(event.key);
    requireValue(event.title && event.interviewId, "Missing session title or interview type");
    requireValue(instant(event.start) && instant(event.end) && Date.parse(event.start) < Date.parse(event.end), "Invalid session time");
    requireValue(Array.isArray(event.interviewers) && event.interviewers.length, "Missing interviewers");
    requireValue(event.interviewers.every((p) => p.userId && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)), "Missing verified interviewer identity");
    requireValue(new Set(event.interviewers.map((p) => p.userId)).size === event.interviewers.length, "Duplicate interviewer");
    requireValue(!event.requiresRoom || (event.room && event.room.resourceId), "Required room is missing");
    requireValue(event.conferencing && ["zoom","ashby"].includes(event.conferencing.provider) && event.conferencing.accountId,
      "Missing approved invitation delivery configuration");
    requireValue(Array.isArray(event.notify) && event.notify.every((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)), "Invalid invitation recipients");
    if (plan.kind === "replacement") requireValue(event.ashbyEventId && event.beforeFingerprint,
      "Replacement requires the original event and its fingerprint");
  }
  if (plan.kind === "replacement") requireValue(plan.ashbyScheduleId, "Replacement requires an Ashby schedule");
  requireValue(Array.isArray(plan.blockers), "Missing validation results");
  return plan;
}

// Pure capacity check. The caller must supply a complete, fresh trial snapshot;
// an unavailable snapshot is a blocker, never an empty calendar.
function capacityIssues(plan, trials) {
  if (!Array.isArray(trials)) return [{ code: "capacity_unknown", message: "Trial capacity could not be checked" }];
  const start = DAY.parseDay(plan.startDate), end = DAY.parseDay(plan.endDate);
  requireValue(start && end && end >= start && DAY.diffDays(start, end) <= 14, "Invalid trial date range");
  const issues = [];
  for (let day = start; day <= end; day = DAY.addDays(day, 1)) {
    const seen = new Map();
    for (const trial of trials) {
      if (trial.candidateId === plan.candidateId || trial.cancelled === true) continue;
      const a = DAY.parseDay(trial.startDate), b = DAY.parseDay(trial.endDate);
      if (!trial.candidateId || !a || !b || b < a || !trial.role) {
        if (!issues.some((x) => x.code === "capacity_unknown")) issues.push({ code: "capacity_unknown", message: "A trial has incomplete capacity data" });
        continue;
      }
      if (day >= a && day <= b) seen.set(trial.candidateId, trial);
    }
    if (seen.size >= 2) issues.push({ code: "daily_capacity", day, message: "Two trials already occupy this day" });
    if ([...seen.values()].some((trial) => trial.role === plan.role)) {
      issues.push({ code: "same_role", day, message: "Another " + plan.role + " trial occupies this day", overrideAllowed: true });
    }
  }
  return issues;
}

function draft(plan, actor, now = new Date().toISOString()) {
  requireValue(actor && actor.active && actor.email, "Active coordinator required");
  validatePlan(plan);
  const payload = copy(plan);
  return { id: crypto.randomUUID(), revision: 1, state: "draft", plan: payload,
    digest: digest(payload), approval: null, operations: [],
    createdAt: now, updatedAt: now, audit: [{ action: "drafted", by: actor.email, at: now }] };
}
function approve(proposal, actor, expectedDigest, reason, now = new Date().toISOString()) {
  requireValue(canApprove(actor), "Coordinator does not have approval permission");
  requireValue(proposal.state === "draft", "Only a draft can be approved");
  validatePlan(proposal.plan);
  requireValue(expectedDigest === proposal.digest && digest(proposal.plan) === proposal.digest, "Proposal changed; review the latest revision");
  requireValue(!proposal.plan.blockers.some((x) => x.code !== "same_role" || x.overrideAllowed !== true), "Resolve scheduling blockers first");
  const exceptions = proposal.plan.blockers.filter((x) => x.code === "same_role");
  requireValue(!exceptions.length || (typeof reason === "string" && reason.trim().length >= 10), "Explain why the same-role exception is unavoidable");
  const next = copy(proposal);
  next.state = "approved"; next.revision++; next.updatedAt = now;
  next.approval = { by: actor.email, at: now, digest: next.digest, exceptions,
    reason: exceptions.length ? reason.trim() : null };
  next.audit.push({ action: "approved", by: actor.email, at: now, digest: next.digest });
  return next;
}
function revise(proposal, plan, actor, now = new Date().toISOString()) {
  requireValue(actor && actor.active && actor.email, "Active coordinator required");
  requireValue(["draft", "approved", "needs_review"].includes(proposal.state), "Proposal cannot be edited in this state");
  requireValue(!proposal.operations.length, "Reconcile attempted bookings before creating a new revision");
  validatePlan(plan);
  requireValue(plan.candidateId === proposal.plan.candidateId && plan.applicationId === proposal.plan.applicationId,
    "A revision cannot change the candidate or application");
  const next = copy(proposal);
  next.plan = copy(plan); next.digest = digest(plan); next.approval = null;
  next.state = "draft"; next.revision++; next.updatedAt = now;
  next.audit.push({ action: "revised", by: actor.email, at: now });
  return next;
}

module.exports = { digest, validatePlan, capacityIssues, draft, approve, revise };
