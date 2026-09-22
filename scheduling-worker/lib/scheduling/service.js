"use strict";
const P = require("./proposal");
const { canApprove } = require("../../users");
function fail(status, message) { throw Object.assign(new Error(message), { status }); }

// Providers are server-owned integrations. Clients can request constraints but
// cannot submit plans, clearance flags, availability or approval identities.
function createSchedulingService({ store, candidates, provider, proposalOnly = false, now = () => new Date().toISOString() }) {
  async function readiness() {
    if (!provider) return { ready: false, blockers: ["Ashby scheduling connection is not configured. No invitations can be sent."] };
    return provider.readiness();
  }
  async function candidate(id) {
    const c = (await candidates()).find(row => row.id === id);
    if (!c) fail(404, "Candidate not found");
    return c;
  }
  async function existing(id, revision) {
    const row = await store.get(id);
    if (!row) fail(404, "Proposal not found");
    if (!Number.isInteger(revision) || row.revision !== revision) fail(409, "Proposal changed. Refresh before continuing.");
    return row;
  }
  async function save(previous, next) {
    if (!await store.replace(previous.id, previous.revision, next)) fail(409, "Proposal changed. Refresh before continuing.");
    return next;
  }
  async function suggest(id, request, actor) {
    if (!actor?.active) fail(403, "Active coordinator required");
    const c = await candidate(id);
    if (!c.values?.ashbyCandidateId) fail(422, "Link this candidate to Ashby before suggesting a schedule.");
    if (!(await readiness()).ready) fail(503, "Ashby scheduling connection is not ready. No proposal or booking was created.");
    if (!request || !["new", "replacement"].includes(request.kind)) fail(400, "Choose a new schedule or replacement");
    const constraints = { kind: request.kind, startDate: request.startDate, endDate: request.endDate,
      timezone: request.timezone, startTime: request.startTime, sessionTitle: request.sessionTitle,
      ashbyScheduleId: request.ashbyScheduleId, ashbyEventId: request.ashbyEventId };
    if (!require("../dateday").parseDay(constraints.startDate) || !require("../dateday").parseDay(constraints.endDate)) fail(400, "Valid confirmed dates are required");
    try { new Intl.DateTimeFormat("en", { timeZone: constraints.timezone }); } catch (_) { fail(400, "Choose a valid timezone"); }
    if (!constraints.timezone) fail(400, "Timezone is required");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(constraints.startTime || "")) fail(400, "Choose a valid start time");
    if (!constraints.sessionTitle || !/^[^<>]{2,100}$/.test(constraints.sessionTitle)) fail(400, "Choose an Ashby session");
    const DAY = require("../dateday");
    const start = DAY.parseDay(constraints.startDate), end = DAY.parseDay(constraints.endDate);
    if (end < start || DAY.diffDays(start, end) > 14) fail(400, "Invalid trial date range");
    if (constraints.kind === "replacement" && (!constraints.ashbyScheduleId || !constraints.ashbyEventId)) fail(400, "Choose the declined Ashby event and schedule");
    const plan = await provider.suggest(c, constraints);
    if (plan.candidateId !== c.values.ashbyCandidateId) fail(422, "Ashby candidate does not match the linked record");
    const row = P.draft(plan, actor, now()); row.trackerCandidateId = id;
    if (!await store.insert(row)) fail(409, "An active proposal already exists for this Ashby candidate. Review or reject it first.");
    return row;
  }
  async function approve(id, input, actor) {
    if (!canApprove(actor)) fail(403, "Coordinator does not have approval permission");
    const row = await existing(id, input.revision);
    const c = await candidate(row.trackerCandidateId);
    if (c.values?.ashbyCandidateId !== row.plan.candidateId) fail(409, "Candidate link changed. Generate a new proposal.");
    if (!(await readiness()).ready) fail(503, "Ashby scheduling connection is not ready. Approval was not saved.");
    const fresh = await provider.revalidate(row.plan);
    if (!fresh || fresh.digest !== row.digest || fresh.ready !== true) fail(409, "Schedule or availability changed. Generate a new proposal.");
    let next;
    try { next = P.approve(row, actor, input.digest, input.reason, now()); }
    catch (error) { fail(422, error.message); }
    if (proposalOnly) next = { ...next, state: "suggestion_approved",
      audit: [...next.audit, { action: "saved_as_suggestion", by: actor.email, at: now() }] };
    return save(row, next);
  }
  async function reject(id, input, actor) {
    if (!actor?.active) fail(403, "Active coordinator required");
    const row = await existing(id, input.revision);
    if (!["draft", "approved", "needs_review"].includes(row.state) || row.operations.length) fail(409, "Execution has started. Reconcile the Ashby schedule before changing this proposal.");
    return save(row, { ...row, state: "rejected", approval: null, revision: row.revision + 1, updatedAt: now(),
      audit: [...row.audit, { action: "rejected", by: actor.email, at: now() }] });
  }
  return { readiness, suggest, approve, reject,
    async context(id, constraints = {}) {
      const c = await candidate(id);
      const source = provider && provider.context ? await provider.context(c) : { declines: [] };
      const dates={startDate:constraints.startDate||c.values?.startDate||"",endDate:constraints.endDate||c.values?.endDate||constraints.startDate||""};
      const resources=provider&&provider.resources ? await provider.resources(c,dates) : {};
      return { name: c.name, startDate: dates.startDate, endDate: dates.endDate, declines: source.declines || [], resources };
    },
    async list(id) { if (id) await candidate(id); return (await store.list()).filter(row => !id || row.trackerCandidateId === id); } };
}
module.exports = { createSchedulingService };
