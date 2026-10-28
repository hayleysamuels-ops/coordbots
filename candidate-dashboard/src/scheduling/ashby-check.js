"use strict";
// The Ashby check behind the Slack "Schedule" button. Once a schedule is
// approved in Slack (service.approveInSlack), the scheduling worker composes
// it in Ashby as the connected account and stops at Ashby's own Schedule
// button, which it never clicks (worker/booking-compose.js). On success the
// draft is left in Ashby for a person to open and send; any refusal deletes
// it. Nothing here sends invitations or candidate email.
//
// The state lives on the draft row as `ashbyCheck`, beside the approval, and
// every change is revision-checked:
//   too_close (approved less than two hours before the first interview: not
//     composed, since the sweep would delete it at once)
//   availability_changed (the candidate's submitted availability isn't what
//     the option was built from: nothing is made in Ashby; availability-gate.js)
//   queued → running → composed | skipped | refused | not_started | uncertain
//     | sent | booked_invites_pending | booked_invites_unknown | send_uncertain
//     (the last four only where the post announced Send, plan.send)
//   composed → sent | deleted | gone | delete_failed | superseded
//   send_uncertain → sent | booked_invites_pending | booked_invites_unknown
// A robot send is `sent` only when Ashby's API shows the schedule Scheduled
// *and* its page shows the invitations sent (October 20: a booking stood
// with "Pending invites", and the message wrongly said they went out). The
// sweep reads Ashby; nothing is ever retried.
// Checks run one at a time, in approval order. Nothing is retried: a check
// that may have left a draft says so and stops.
//
// The sweep (every five minutes) looks at each composed draft. A schedule
// that's been sent is recorded, with whether what was booked matches the
// approval. An unsent draft is deleted at whichever comes first: two hours
// before the first interview, or 24 hours after it was composed.
const UNSENT_BEFORE_FIRST_MS = 2 * 3600 * 1000, UNSENT_AFTER_COMPOSE_MS = 24 * 3600 * 1000;
const SENT_STATUSES = new Set(["Scheduled", "WaitingOnFeedback", "Complete"]);

function deleteByFor(plan, composedAt) {
  return new Date(Math.min(Date.parse(plan.sessions[0].start) - UNSENT_BEFORE_FIRST_MS, Date.parse(composedAt) + UNSENT_AFTER_COMPOSE_MS)).toISOString();
}

// What was booked against what was approved: each session's times and
// interviewers, in order. Returns the differences, [] when they match.
function compareBooked(plan, booked) {
  const want = plan.sessions.map(s => ({ start: s.start, end: s.end, interviewers: s.interviewers.map(i => i.email.toLowerCase()).sort() }));
  const got = booked?.events || [];
  if (got.length !== want.length) return [`${got.length} interview${got.length === 1 ? " was" : "s were"} booked, but ${want.length} ${want.length === 1 ? "was" : "were"} approved`];
  const diffs = [];
  want.forEach((w, i) => {
    const g = got[i];
    if (g.start !== w.start || g.end !== w.end) diffs.push(`session ${i + 1}'s time changed`);
    if (g.interviewers.join(",") !== w.interviewers.join(",")) diffs.push(`session ${i + 1}'s interviewers changed`);
  });
  return diffs;
}

const { availabilityChange } = require("./availability-gate");

function createAshbyCheck({ store, worker, facts, slackApi, clientId, availability = null, now = () => Date.now(), log = console, sweepMs = 300000, pause = ms => new Promise(r => setTimeout(r, ms)) }) {
  let chain = Promise.resolve();
  const serially = task => (chain = chain.then(task, task));
  const iso = () => new Date(now()).toISOString();

  // Set ashbyCheck on the latest revision, if `when(row)` still holds. A
  // revision conflict rereads and tries once more.
  async function setCheck(id, when, check) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await store.get(id);
      if (!row || !when(row)) return null;
      const next = { ...row, ashbyCheck: { ...check, at: iso() }, revision: row.revision + 1,
        audit: [...(row.audit || []), { action: `ashby_check_${check.state}`, at: iso() }] };
      if (await store.replace(id, row.revision, next)) return next;
    }
    return null;
  }
  // The approved Slack message, showing this check's state. A failed update
  // is logged: the state is already recorded.
  async function show(row) {
    if (!row?.slack?.channel || !row.slack.ts) return;
    await slackApi.markApproved({ channel: row.slack.channel, ts: row.slack.ts, row }).catch(e => log.warn(`[ashby-check] Slack update failed for ${row.id}: ${e.message}`));
  }
  async function reply(row, text) {
    if (!row?.slack?.channel || !row.slack.ts || !text) return;
    await slackApi.threadReply({ channel: row.slack.channel, threadTs: row.slack.ts, text }).catch(e => log.warn(`[ashby-check] Slack reply failed for ${row.id}: ${e.message}`));
  }
  const stateIs = (...states) => row => states.includes(row.ashbyCheck?.state);

  const tooClose = plan => now() >= Date.parse(plan.sessions[0].start) - UNSENT_BEFORE_FIRST_MS;

  // A booked schedule's state from what Ashby's page shows for its invites.
  const bookedState = invites => invites?.state === "sent" ? "sent" : invites?.state === "pending" ? "booked_invites_pending" : "booked_invites_unknown";
  const emailSentence = check => ({ sent: " Ashby accepted the candidate's confirmation email.", not_sent: " The candidate's confirmation email was NOT sent: send it by hand from the schedule in Ashby.", off: " The confirmation email is off for this schedule." })[check.confirmationEmailSent] || "";
  const invitesReply = check => check.state === "sent"
    ? `Sent by clicking Schedule once, from the connected Ashby account. Ashby shows it Scheduled and its invitations sent${check.differences?.length ? `, but it differs from this approval: ${check.differences.join("; ")}` : ", matching this approval"}.`
    : check.state === "booked_invites_pending"
      ? `Booked in Ashby, but the invitations were NOT sent: Ashby shows them pending (${(check.invites?.evidence || []).join("; ")}). Send them by hand from the schedule's page in Ashby. Nothing will be retried.`
      : `Booked in Ashby, but whether the invitations went out is unknown (${(check.invites?.evidence || []).join("; ") || "nothing shown"}). Check the schedule's page in Ashby and send them by hand if they're pending.`;
  const invitesAndEmailReply = check => invitesReply(check) + emailSentence(check);
  // What Ashby's schedule page shows for the invites, from the worker (read
  // only). Unknown when the worker can't say.
  async function readInvites(row) {
    try {
      const r = await worker.call("invite-status", { plan: row.plan.bookingPlan, proposalId: row.id });
      return r?.invites?.state ? r.invites : { state: "unknown", evidence: [r?.reason || "the worker didn't read it"] };
    } catch (e) { log.warn(`[ashby-check] Couldn't read ${row.id}'s invite status: ${e.message}`); return null; }
  }

  // After the robot's one Send click: what Ashby's API shows. Read up to three
  // times, ten seconds apart (Ashby can take a moment); `sent` with what
  // differs from the approval, or null when it doesn't show as sent yet.
  async function readBackSent(plan) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await pause(10000);
      try {
        const booked = await facts.scheduleState(plan.applicationId, plan.interviewScheduleId);
        if (booked && SENT_STATUSES.has(booked.status)) return { differences: compareBooked(plan, booked) };
      } catch (e) { log.warn(`[ashby-check] Couldn't read the schedule after sending: ${e.message}`); }
    }
    return null;
  }

  // Before anything is made in Ashby: the candidate's submitted availability
  // must still be what the option was built from (availability-gate.js).
  // null when it is, or when there's nothing to compare (times a coordinator
  // entered); otherwise the check's end state. Any doubt starts nothing.
  async function checkAvailability(row) {
    const plan = row.plan, posted = plan.submittedAvailability;
    if (plan.timezoneSource !== "candidate_submitted") return null;
    if (!posted) return { state: "not_started", reason: "This option was posted before posts recorded the candidate's availability, so it can't be confirmed unchanged. Post a fresh option." };
    if (posted.scheduleId !== plan.bookingPlan.interviewScheduleId) return { state: "not_started", reason: "The availability this option was built from belongs to a different scheduling activity." };
    if (!availability) return { state: "not_started", reason: "The candidate's availability can't be read here, so it couldn't be confirmed unchanged." };
    let current;
    try { current = await availability.load({ applicationId: plan.bookingPlan.applicationId, scheduleId: posted.scheduleId }); }
    catch (e) { return { state: "not_started", reason: `The candidate's availability couldn't be read to confirm it's unchanged: ${String(e.message || "no reason given").replace(/\.?$/, ".")}` }; }
    const change = availabilityChange(posted, current, now());
    if (change) log.warn(`[ashby-check] ${row.id}: not composed, ${change}.`);
    return change ? { state: "availability_changed", reason: change } : null;
  }

  async function run(id) {
    // Checked again at its turn: waiting in the queue can bring it inside.
    const waiting = await store.get(id);
    if (waiting?.ashbyCheck?.state === "queued" && tooClose(waiting.plan.bookingPlan)) {
      const done = await setCheck(id, stateIs("queued"), { state: "too_close" });
      if (done) await show(done);
      return;
    }
    let row = await setCheck(id, stateIs("queued"), { state: "running", startedAt: iso() });
    if (!row) return;
    await show(row);
    const changed = await checkAvailability(row);
    if (changed) {
      row = await setCheck(id, stateIs("running"), changed);
      if (row) await show(row);
      return;
    }
    const plan = row.plan.bookingPlan;
    // At most one composed draft per schedule: an earlier one is deleted first.
    const earlier = (await store.list()).filter(r => r.id !== id && r.clientId === clientId && r.ashbyCheck?.state === "composed" && r.plan.bookingPlan?.interviewScheduleId === plan.interviewScheduleId);
    let result, check;
    try {
      result = await worker.call("compose", { plan, supersedeDraftId: earlier[0]?.ashbyCheck.draftId || null, proposalId: id });
    } catch (e) {
      // A 4xx means the worker refused before starting: no draft was made.
      // Otherwise, where this post could send, it may have: never "nothing
      // was sent".
      check = e.status >= 400 && e.status < 500
        ? { state: "not_started", reason: e.message }
        : plan.send === true
          ? { state: "send_uncertain", sentBy: "robot", reason: `the scheduling worker didn't give a result (${e.message || "no answer"})` }
          : { state: "uncertain", reason: e.message || "The scheduling worker didn't answer." };
    }
    if (!check) {
      if (result?.status === "skipped") check = { state: "skipped", reason: result.reason };
      else if (result?.status === "composed" && result.cleanup?.kept && result.draftId) {
        const composedAt = iso();
        check = { state: "composed", draftId: result.draftId, composedAt, deleteBy: deleteByFor(plan, composedAt), from: result.wouldSend?.from || null,
          confirmationEmail: result.confirmationEmail === "off" ? "off" : "on", checks: (result.checks || []).map(c => c.name), ...(result.sendSkipped ? { sendSkipped: result.sendSkipped } : {}) };
      } else if (result?.status === "sent" || result?.status === "send_uncertain") {
        // The robot clicked Schedule once. Whatever its own reading, Ashby's API decides.
        const reply = result.send?.reply, readBack = await readBackSent(plan);
        const said = reply ? `Ashby answered HTTP ${reply.status}${reply.accepted ? ", accepted" : `, not accepted${reply.errors?.length ? `: ${reply.errors.join("; ")}` : ""}`}` : result.send?.blockedByGuard ? "the write guard blocked it" : "no answer from Ashby";
        const invites = result.invites?.state ? result.invites : { state: "unknown", evidence: ["the worker didn't read it"] };
        // The confirmation email, from Ashby's answer to its own request only.
        const ce = result.send?.confirmationEmail;
        const confirmationEmailSent = result.confirmationEmail === "off" || ce?.expected === false ? "off" : ce?.reply?.accepted ? "sent" : ce ? "not_sent" : "unknown";
        check = { sentBy: "robot", draftId: result.draftId || null, attemptedAt: result.send?.at || iso(), confirmationEmail: result.confirmationEmail === "off" ? "off" : "on", from: result.wouldSend?.from || null,
          confirmationEmailSent,
          ...(readBack ? { state: bookedState(invites), sentSeenAt: iso(), differences: readBack.differences, invites } : { state: "send_uncertain", reason: said }) };
      } else if (result?.status === "refused" || result?.status === "error") check = { state: "refused", step: result.step, reason: result.reason, draftId: result.draftId || null, cleanup: result.cleanup || null };
      else check = { state: "uncertain", reason: result?.reason || "The Ashby check gave no clear result.", draftId: result?.draftId || null };
    }
    row = await setCheck(id, stateIs("running"), check);
    if (!row) return;
    await show(row);
    if (check.state === "composed") await reply(row, `Ashby check passed: ${check.checks.join("; ")}.`);
    // The daily send cap, once each time it's reached (the worker says which
    // skipped send is the first at the cap): one notice in the channel.
    if (check.state === "composed" && result?.sendCap?.firstAtCap && row.slack?.channel)
      await slackApi.notice({ channel: row.slack.channel, text: `The robot's daily send cap is reached (${result.sendCap.count} sends in the last 24 hours; the cap is ${result.sendCap.cap}). Approved schedules are composed in Ashby but not sent until ${result.sendCap.resetsAtText || result.sendCap.resetsAt}: a person needs to send each one from its draft.` }).catch(e => log.warn(`[ashby-check] Cap notice couldn't be posted: ${e.message}`));
    if (check.sentBy === "robot" && ["sent", "booked_invites_pending", "booked_invites_unknown"].includes(check.state)) await reply(row, invitesAndEmailReply(check));
    if (check.state === "send_uncertain") await reply(row, `The send may have gone (${check.reason}). Check the schedule in Ashby; nothing will be retried.`);
    if (result?.superseded?.draftId) {
      for (const old of earlier.filter(r => r.ashbyCheck.draftId === result.superseded.draftId)) {
        const done = await setCheck(old.id, stateIs("composed"), { ...old.ashbyCheck, state: "superseded", supersededAt: iso(), by: id, draftDeleted: result.superseded.deleted === true });
        if (done) await show(done);
      }
    }
  }

  // After an approval: queue a check if the post carries a plan. Returns the
  // row as recorded (for the Slack message), or null when there's no check.
  async function start(row) {
    if (!row.plan?.bookingPlan) return null;
    if (tooClose(row.plan.bookingPlan)) return setCheck(row.id, r => r.state === "discussion_approved" && !r.ashbyCheck, { state: "too_close" });
    const queued = await setCheck(row.id, r => r.state === "discussion_approved" && !r.ashbyCheck, { state: "queued", queuedAt: iso() });
    if (!queued) return null;
    serially(() => run(row.id).catch(e => log.warn(`[ashby-check] ${row.id}: ${e.message}`)));
    return queued;
  }

  // A send that wasn't confirmed: recorded as sent once Ashby shows it, and
  // otherwise left alone. Its draft is never deleted and nothing is retried.
  async function sweepUncertainSend(row) {
    const plan = row.plan.bookingPlan;
    let booked;
    try { booked = await facts.scheduleState(plan.applicationId, plan.interviewScheduleId); }
    catch (e) { log.warn(`[ashby-check] Couldn't read ${row.id}'s schedule: ${e.message}`); return; }
    if (!booked || !SENT_STATUSES.has(booked.status)) return;
    const invites = await readInvites(row);
    if (!invites) return;
    const done = await setCheck(row.id, stateIs("send_uncertain"), { ...row.ashbyCheck, state: bookedState(invites), sentSeenAt: iso(), differences: compareBooked(plan, booked), invites });
    if (done) { await show(done); await reply(done, invitesReply(done.ashbyCheck)); }
  }
  // A robot send recorded as sent before invitations needed evidence (October
  // 20): read what Ashby shows, and correct the message if they weren't sent.
  async function sweepUnevidencedSend(row) {
    const invites = await readInvites(row);
    if (!invites) return;
    const done = await setCheck(row.id, r => r.ashbyCheck?.state === "sent" && r.ashbyCheck.sentBy === "robot" && !r.ashbyCheck.invites, { ...row.ashbyCheck, state: bookedState(invites), invites, invitesCheckedAt: iso() });
    if (!done) return;
    await show(done);
    if (done.ashbyCheck.state !== "sent") await reply(done, `Correction: this message said the invitations and the confirmation email went out. ${invitesReply(done.ashbyCheck)}`);
  }
  // One composed draft: sent, or due for deleting, or left alone.
  async function sweepOne(row) {
    const plan = row.plan.bookingPlan, check = row.ashbyCheck;
    let booked;
    try { booked = await facts.scheduleState(plan.applicationId, plan.interviewScheduleId); }
    catch (e) { log.warn(`[ashby-check] Couldn't read ${row.id}'s schedule: ${e.message}`); return; }
    if (booked && SENT_STATUSES.has(booked.status)) {
      const differences = compareBooked(plan, booked);
      const done = await setCheck(row.id, stateIs("composed"), { ...check, state: "sent", sentSeenAt: iso(), differences });
      if (done) await show(done);
      return;
    }
    if (now() < Date.parse(check.deleteBy)) return;
    let result;
    try { result = await worker.call("discard-draft", { plan, draftId: check.draftId, proposalId: row.id }); }
    catch (e) { result = { deleted: false, reason: e.message }; }
    const next = result?.deleted ? { ...check, state: "deleted", deletedAt: iso() }
      : result?.absent ? { ...check, state: "gone", goneSeenAt: iso() }
      : { ...check, state: "delete_failed", failedAt: iso(), reason: result?.reason || "the scheduling worker didn't delete it" };
    const done = await setCheck(row.id, stateIs("composed"), next);
    if (done) await show(done);
  }
  async function sweep() {
    const unevidenced = r => r.ashbyCheck?.state === "sent" && r.ashbyCheck.sentBy === "robot" && !r.ashbyCheck.invites;
    const rows = (await store.list()).filter(r => r.clientId === clientId && (["composed", "send_uncertain"].includes(r.ashbyCheck?.state) || unevidenced(r)));
    for (const row of rows) await serially(() => (unevidenced(row) ? sweepUnevidencedSend(row) : row.ashbyCheck.state === "send_uncertain" ? sweepUncertainSend(row) : sweepOne(row)).catch(e => log.warn(`[ashby-check] Sweep failed for ${row.id}: ${e.message}`)));
  }

  // At start-up: a check recorded as queued or running was cut off by a
  // restart. One that was running may have left a draft, so it's uncertain
  // and says so; one still queued never reached Ashby.
  async function recover() {
    for (const row of (await store.list()).filter(r => r.clientId === clientId && ["queued", "running"].includes(r.ashbyCheck?.state))) {
      const done = row.ashbyCheck.state === "running"
        ? await setCheck(row.id, stateIs("running"), { state: "uncertain", reason: "The dashboard restarted while the check was running." })
        : await setCheck(row.id, stateIs("queued"), { state: "not_started", reason: "The dashboard restarted before the check started." });
      if (done) await show(done);
    }
  }

  function startSweeping() {
    const timer = setInterval(() => sweep().catch(e => log.warn(`[ashby-check] Sweep failed: ${e.message}`)), sweepMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { start, sweep, recover, startSweeping, idle: () => chain };
}

module.exports = { createAshbyCheck, deleteByFor, compareBooked, UNSENT_BEFORE_FIRST_MS, UNSENT_AFTER_COMPOSE_MS };
