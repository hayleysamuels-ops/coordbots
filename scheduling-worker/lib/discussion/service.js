"use strict";
const crypto = require("crypto");
// Immutable content digests and revision checks use the existing work-trial
// shell's approval model. Slack review never creates booking approval.
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}
const digest = v => crypto.createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
function text(value, label, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(400, "Provide " + label);
  return value.trim();
}
function createService({ store, candidates, clientId, channelId, channelName, candidateChannels = {}, routing = "candidate", slack, booking = null, templateReader = null, sourceProposals = null }) {
  function destination(candidateId) {
    const route = routing === "client" ? { channelId, channelName: channelName || channelId } : candidateChannels[candidateId];
    return route && /^[CG][A-Z0-9]+$/.test(route.channelId || "") ? { channelId: route.channelId, channelName: route.channelName || route.channelId } : { channelId: null, channelName: "Candidate channel not configured" };
  }
  function actor(user) { if (!user?.canApprove || !user.id) fail(403, "Sign in with an individual scheduling approver account."); }
  async function candidate(applicationId) {
    const c = (await candidates()).find(c => c.applicationId === applicationId && c.status === "Active");
    if (!c) fail(409, "Active application is unavailable. Refresh the dashboard.");
    return c;
  }
  async function transition(row, state, details = {}) {
    const next = { ...row, ...details, state, revision: row.revision + 1 };
    if (!await store.replace(row.id, row.revision, next)) fail(409, "Draft changed. Refresh before approving.");
    return next;
  }
  async function current(id, input) {
    const row = await store.get(id);
    if (!row || row.clientId !== clientId) fail(404, "Draft not found");
    if (row.revision !== input.revision || row.digest !== input.digest || digest(row.plan) !== row.digest) fail(409, "Draft changed. Review the latest version.");
    return row;
  }
  return {
    status(user) {
      return { canApprove: !!user?.canApprove, clientId, channelName: channelName || channelId || "Not configured",
        slackReady: !!(clientId && slack), routing, bookingReady: !!booking,
        bookingMessage: booking ? "Connected" : "The Ashby booking connection is not ready. No invitations can be sent." };
    },
    async list() { return (await store.list()).filter(r => r.clientId === clientId).map(r => ({ ...r, destination: destination(r.plan.candidateId) })); },
    async sources() { return sourceProposals ? sourceProposals() : []; },
    async importSource(id, user) {
      actor(user);
      const row = (await this.sources()).find(r => r.id === id);
      if (!row) fail(404, "Source proposal not found");
      return this.draft({ applicationId: row.plan.applicationId, timezone: row.plan.timezone,
        notes: "Imported from tracker proposal " + row.id + ". " + (row.plan.blockers || []).map(b => b.message).join("; "),
        sessions: row.plan.events.map(e => ({ title: e.title, start: e.start, end: e.end,
          interviewers: e.interviewers.map(i => i.name || i.email).join(", "), location: e.room?.name || e.room?.resourceId || "Room / location to confirm" })) }, user);
    },
    async template(applicationId) {
      const c = await candidate(applicationId);
      if (!templateReader) fail(503, "Ashby interview-plan connection is not configured.");
      const result = await templateReader(applicationId);
      if (result.candidateId !== c.candidateId) fail(409, "Ashby candidate changed. Refresh the dashboard.");
      return result;
    },
    async draft(input, user) {
      actor(user);
      if (!clientId) fail(503, "Client scheduling identity is not configured.");
      const c = await candidate(input.applicationId);
      const timezone = text(input.timezone, "a timezone");
      try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch (_) { fail(400, "Invalid timezone"); }
      if (!Array.isArray(input.sessions) || !input.sessions.length || input.sessions.length > 30) fail(400, "Add 1–30 sessions");
      const sessions = input.sessions.map(s => {
        // Explicit offsets make the reviewed instant unambiguous; the UI displays
        // the full selected timezone again before the separate approval action.
        if (![s.start, s.end].every(v => typeof v === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v))) || Date.parse(s.start) >= Date.parse(s.end)) fail(400, "Session times must include an offset and end after they start");
        return { title: text(s.title, "a session title"), start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), interviewers: text(s.interviewers, "interviewers", 500), location: text(s.location, "a room or location") };
      });
      const plan = { candidateId: c.candidateId, applicationId: c.applicationId, candidateName: c.candidateName, jobTitle: c.jobTitle, timezone, sessions, notes: typeof input.notes === "string" ? input.notes.slice(0, 2000) : "", source: "coordinator_draft" };
      const row = { id: crypto.randomUUID(), clientId, revision: 1, state: "draft", plan, digest: digest(plan), bookingApproval: null,
        audit: [{ action: "drafted", by: user.id, at: new Date().toISOString() }] };
      if (!await store.insert(row)) fail(409, "An active discussion draft already exists. Review or reject it first."); return row;
    },
    async share(id, input, user) {
      actor(user);
      let row = await current(id, input);
      if (row.state !== "draft") fail(409, "This draft has already been submitted or needs reconciliation.");
      const { channelId } = destination(row.plan.candidateId);
      if (!clientId || !channelId || !slack) fail(503, "Configure this client's Slack destination first.");
      if (input.channelId !== channelId) fail(409, "Slack destination changed. Review it again.");
      const c = await candidate(row.plan.applicationId);
      if (templateReader) {
        const fresh = await templateReader(row.plan.applicationId);
        if (fresh.candidateId !== row.plan.candidateId) fail(409, "Candidate changed in Ashby. Review again.");
      }
      if (c.candidateId !== row.plan.candidateId) fail(409, "Candidate changed. Create a new draft.");
      // Persist the claim BEFORE posting. A timeout or crash must never result in
      // an automatic second post. Operators reconcile sharing/uncertain records.
      row = await transition(row, "sharing", { discussionApproval: { by: user.id, digest: row.digest, channelId, at: new Date().toISOString() },
        audit: [...row.audit, { action: "approved_for_discussion", by: user.id, at: new Date().toISOString() }] });
      try {
        const receipt = await slack(row.plan, { channelId, proposalId: row.id, approver: user.id });
        if (!receipt?.ts || receipt.channel !== channelId) throw new Error("Unverified Slack response");
        return await transition(row, "shared", { slack: receipt });
      } catch (_) {
        return transition(row, "discussion_uncertain", { issue: "Check Slack before trying again. The message may already have been delivered." });
      }
    },
    async reject(id, input, user) {
      actor(user); const row = await current(id, input);
      if (row.state !== "draft") fail(409, "Only an unsubmitted draft can be rejected.");
      return transition(row, "rejected", { audit: [...row.audit, { action: "rejected", by: user.id, at: new Date().toISOString() }] });
    },
    async approveBooking(id, input, user) {
      actor(user);
      const row = await current(id, input);
      if (!booking) fail(503, "Ashby booking is not connected. No approval was recorded and no invitation was sent.");
      // A future adapter must revalidate fresh availability and create a
      // separately approved shell proposal. Discussion approval is never reused.
      return booking.approve(row, input, user);
    },
    destination,
  };
}
module.exports = { createService, digest };
