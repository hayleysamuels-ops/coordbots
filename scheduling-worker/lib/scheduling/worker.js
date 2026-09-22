"use strict";

const { digest, validatePlan } = require("./proposal");
const { canApprove } = require("../../users");

// Executor contract is deliberately independent of Playwright. Tests exercise
// crash/retry and approval behavior without making real candidate bookings.
// The Ashby adapter must return verified receipts, not just successful clicks.
function createWorker({ store, executor, userByEmail, now = () => new Date().toISOString() }) {
  async function transition(row, state, details = {}) {
    const next = { ...row, ...details, state, revision: row.revision + 1, updatedAt: now(),
      audit: [...row.audit, { action: state, at: now(), by: "scheduling-worker" }] };
    if (!await store.replace(row.id, row.revision, next)) throw Object.assign(new Error("Proposal changed while processing"), { code: "REVISION_CONFLICT" });
    return next;
  }
  async function execute(id) {
    let row = await store.get(id);
    if (!row || row.state !== "approved") return { skipped: true };
    // A running row is NEVER automatically retried. A crash may have happened
    // after submission. It must be reconciled with Ashby first.
    try { row = await transition(row, "running", { startedAt: now() }); }
    catch (error) { if (error.code === "REVISION_CONFLICT") return { skipped: true }; throw error; }
    try {
      validatePlan(row.plan);
      if (!row.approval || row.approval.digest !== row.digest || digest(row.plan) !== row.digest)
        throw new Error("Approval does not match the plan");
      if (!canApprove(await userByEmail(row.approval.by))) throw new Error("Approver no longer has permission");
      if (row.plan.events.some((event) => Date.parse(event.start) <= Date.parse(now())))
        throw new Error("A proposed session has already started");
      const fresh = await executor.preflight(row.plan);
      if (!fresh || fresh.sourceFingerprint !== row.plan.sourceFingerprint || fresh.available !== true || fresh.ready !== true)
        throw new Error("Schedule, availability or booking setup changed; review again");
      // Store the intent before the first possible external write. This remains
      // available if the process dies between an Ashby click and our next save.
      row = await transition(row, "running", { operations: [{
        id: row.id + ":" + row.digest, state: "started", at: now(), digest: row.digest,
      }] });
      const receipt = await executor.book(row.plan, { operationId: row.operations[0].id });
      const verified = await executor.verify(row.plan, receipt);
      if (!verified || verified.matches !== true || verified.invitesConfirmed !== true || !verified.scheduleId)
        throw Object.assign(new Error("Calendar invitations were not verified"), { code: "INVITES_NOT_DISPATCHED" });
      row = await transition(row, "scheduled", { receipt: verified, operations: [{
        ...row.operations[0], state: "verified", completedAt: now(),
      }] });
      return row;
    } catch (error) {
      // Error messages from browsers may contain page data or signed URLs.
      // Record a bounded category, never raw browser/session diagnostics.
      const attempted = row.operations.length > 0;
      const deliveryMissing=error.code==="INVITES_NOT_DISPATCHED";
      return transition(row, "needs_review", { issue: deliveryMissing ? "invites_not_dispatched" : attempted ? "booking_uncertain" : "preflight_failed",
        issueMessage: deliveryMissing ? "Ashby stored the schedule, but calendar invitations were not dispatched. Send or reconcile them before retrying." : attempted ? "Check the resulting Ashby schedule before retrying." : "Review the source schedule, availability, approval and worker setup.",
        approval: null });
    }
  }
  return { execute };
}
module.exports = { createWorker };
