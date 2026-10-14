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
//   queued → running → composed | skipped | refused | not_started | uncertain
//   composed → sent | deleted | gone | delete_failed | superseded
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

function createAshbyCheck({ store, worker, facts, slackApi, clientId, now = () => Date.now(), log = console, sweepMs = 300000 }) {
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

  async function run(id) {
    let row = await setCheck(id, stateIs("queued"), { state: "running", startedAt: iso() });
    if (!row) return;
    await show(row);
    const plan = row.plan.bookingPlan;
    // At most one composed draft per schedule: an earlier one is deleted first.
    const earlier = (await store.list()).filter(r => r.id !== id && r.clientId === clientId && r.ashbyCheck?.state === "composed" && r.plan.bookingPlan?.interviewScheduleId === plan.interviewScheduleId);
    let result, check;
    try {
      result = await worker.call("compose", { plan, supersedeDraftId: earlier[0]?.ashbyCheck.draftId || null });
    } catch (e) {
      // A 4xx means the worker refused before starting: no draft was made.
      check = e.status >= 400 && e.status < 500
        ? { state: "not_started", reason: e.message }
        : { state: "uncertain", reason: e.message || "The scheduling worker didn't answer." };
    }
    if (!check) {
      if (result?.status === "skipped") check = { state: "skipped", reason: result.reason };
      else if (result?.status === "composed" && result.cleanup?.kept && result.draftId) {
        const composedAt = iso();
        check = { state: "composed", draftId: result.draftId, composedAt, deleteBy: deleteByFor(plan, composedAt), from: result.wouldSend?.from || null, checks: (result.checks || []).map(c => c.name) };
      } else if (result?.status === "refused" || result?.status === "error") check = { state: "refused", step: result.step, reason: result.reason, draftId: result.draftId || null, cleanup: result.cleanup || null };
      else check = { state: "uncertain", reason: result?.reason || "The Ashby check gave no clear result.", draftId: result?.draftId || null };
    }
    row = await setCheck(id, stateIs("running"), check);
    if (!row) return;
    await show(row);
    if (check.state === "composed") await reply(row, `Ashby check passed: ${check.checks.join("; ")}.`);
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
    const queued = await setCheck(row.id, r => r.state === "discussion_approved" && !r.ashbyCheck, { state: "queued", queuedAt: iso() });
    if (!queued) return null;
    serially(() => run(row.id).catch(e => log.warn(`[ashby-check] ${row.id}: ${e.message}`)));
    return queued;
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
    try { result = await worker.call("discard-draft", { plan, draftId: check.draftId }); }
    catch (e) { result = { deleted: false, reason: e.message }; }
    const next = result?.deleted ? { ...check, state: "deleted", deletedAt: iso() }
      : result?.absent ? { ...check, state: "gone", goneSeenAt: iso() }
      : { ...check, state: "delete_failed", failedAt: iso(), reason: result?.reason || "the scheduling worker didn't delete it" };
    const done = await setCheck(row.id, stateIs("composed"), next);
    if (done) await show(done);
  }
  async function sweep() {
    const rows = (await store.list()).filter(r => r.clientId === clientId && r.ashbyCheck?.state === "composed");
    for (const row of rows) await serially(() => sweepOne(row).catch(e => log.warn(`[ashby-check] Sweep failed for ${row.id}: ${e.message}`)));
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
