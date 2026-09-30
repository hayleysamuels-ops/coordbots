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
    // `meta` is only ever passed by server code (postScheduleOption below), never
    // from a request body, so a browser can't label its own draft as an option.
    async draft(input, user, meta = {}) {
      actor(user);
      if (!clientId) fail(503, "Client scheduling identity is not configured.");
      const c = await candidate(input.applicationId);
      const timezone = text(input.timezone, "a timezone");
      try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch (_) { fail(400, "Invalid timezone"); }
      if (!Array.isArray(input.sessions) || !input.sessions.length || input.sessions.length > 30) fail(400, "Add 1–30 sessions");
      // meta.people (server code only, like meta.source) is, per session, the
      // one interviewer the calendar-checked solver assigned. Exactly one: an
      // eligible alternative from the Ashby plan was never calendar-checked and
      // must not appear in the post beside a checked name.
      if (meta.people && (!Array.isArray(meta.people) || meta.people.length !== input.sessions.length || meta.people.some(list => !Array.isArray(list) || list.length !== 1 || typeof list[0]?.name !== "string" || !list[0].name.trim()))) fail(500, "Each calendar-checked session needs exactly one assigned interviewer.");
      const sessions = input.sessions.map((s, i) => {
        // Explicit offsets make the reviewed instant unambiguous; the UI displays
        // the full selected timezone again before the separate approval action.
        if (![s.start, s.end].every(v => typeof v === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v))) || Date.parse(s.start) >= Date.parse(s.end)) fail(400, "Session times must include an offset and end after they start");
        return { title: text(s.title, "a session title"), start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), interviewers: text(s.interviewers, "interviewers", 500), location: text(s.location, "a room or location"), ...(meta.people ? { people: meta.people[i].map(p => ({ name: p.name.trim() })) } : {}) };
      });
      const plan = { candidateId: c.candidateId, applicationId: c.applicationId, candidateName: c.candidateName, jobTitle: c.jobTitle, timezone, sessions, notes: typeof input.notes === "string" ? input.notes.slice(0, 2000) : "", source: meta.source || "coordinator_draft", timezoneSource: meta.timezoneSource || "coordinator_entered", ...(meta.sourceRef ? { sourceRef: meta.sourceRef } : {}), ...(meta.rulesRevision ? { rulesRevision: meta.rulesRevision } : {}), ...(meta.format ? { format: meta.format } : {}) };
      const row = { id: crypto.randomUUID(), clientId, revision: 1, state: "draft", plan, digest: digest(plan), bookingApproval: null,
        audit: [{ action: "drafted", by: user.id, at: new Date().toISOString() }] };
      if (!await store.insert(row)) fail(409, meta.sourceRef ? "This option was already posted to Slack, or another discussion draft for this candidate is still open. Check the channel and the Scheduling tab." : "An active discussion draft already exists. Review or reject it first."); return row;
    },
    // Posts one Full schedule option from booking review through the same
    // draft -> share path as a coordinator draft, so it gets the same
    // claim-before-posting, revision/digest and Ashby candidate checks. The
    // option has already been rebuilt server-side by the caller. The channel is
    // only ever destination()'s, from this client's config.
    // `attendance` is one "in_person" | "video" per option event, from this
    // client's scheduling rules (rules.js), never from the browser. It only
    // labels the Location line; nothing books a room or creates a link.
    // `calendarCheck` is set only for options the server built against Google
    // free/busy (booking-routes calendarChecked); it changes the wording, not
    // the posting path.
    async postScheduleOption({ applicationId, candidateId, timezone, option, optionNumber, sourceRef, availabilitySource, attendance, rulesRevision, calendarCheck = null }, user) {
      actor(user);
      const c = await candidate(applicationId);
      if (c.candidateId !== candidateId) fail(409, "Candidate changed in Ashby. Suggest the full schedule again.");
      const { channelId, channelName: name } = destination(c.candidateId);
      // Checked before drafting so a missing destination doesn't leave a draft
      // behind that blocks this candidate's next post.
      if (!clientId || !channelId || !slack) fail(503, "Configure this client's Slack destination first.");
      if ((await store.list()).some(r => r.clientId === clientId && r.plan.sourceRef === sourceRef && r.state !== "rejected")) fail(409, "This option was already posted to Slack. Check the channel.");
      if (!Array.isArray(attendance) || attendance.length !== option.events.length || attendance.some(a => !["in_person", "video"].includes(a))) fail(503, "Interviewer attendance could not be confirmed from this client's scheduling rules.");
      const source = availabilitySource === "ashby" ? "candidate-submitted availability" : "coordinator-entered availability";
      const checked = calendarCheck ? `Checked against interviewers' primary Google calendars at ${new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(calendarCheck.checkedAt))}.${calendarCheck.meetingHoursAssumed ? " Meeting hours are assumed from client rules, not verified." : ""} Other calendars, breaks and non-zero interview limits were not checked.` : "Not calendar-checked: suggested interviewers are eligible choices, not confirmed available.";
      const row = await this.draft({ applicationId, timezone,
        notes: `Full schedule option ${optionNumber} from booking review, built from ${source}. ${checked} Nothing has been booked and no invitations have been sent.`,
        sessions: option.events.map((e, i) => ({ title: e.title, start: e.start, end: e.end,
          interviewers: `${e.interviewer.name} (${calendarCheck ? "free on primary calendar" : "suggested, not calendar-checked"})`.slice(0, 500),
          location: attendance[i] === "video" ? "Video link required" : "Room / location to confirm" })) },
        user, { source: "full_schedule_option", sourceRef, rulesRevision, timezoneSource: availabilitySource === "ashby" ? "candidate_submitted" : "coordinator_entered",
          // Calendar-checked options use the Slack format with the Ashby link and
          // the solver's assigned interviewer per session, by name (see
          // slack.js for why plain). Never the eligible alternatives.
          ...(calendarCheck ? { format: "calendar_checked", people: option.events.map(e => [{ name: e.interviewer.name }]) } : {}) });
      try {
        const shared = await this.share(row.id, { revision: row.revision, digest: row.digest, channelId }, user);
        return { id: shared.id, state: shared.state, issue: shared.issue || null, channelName: name };
      } catch (e) {
        // share() only throws before its claim, so nothing was posted. Reject
        // the unposted draft so it doesn't block the next attempt.
        const left = await store.get(row.id);
        if (left?.state === "draft") await this.reject(row.id, { revision: left.revision, digest: left.digest }, user).catch(() => {});
        throw e;
      }
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
