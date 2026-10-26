"use strict";
// Auto-post: when a candidate submits availability, post the best
// calendar-checked option to the client channel without anyone pressing Post.
// On only where SCHEDULING_AUTO_POST is exactly "on", and only for the
// applications in AUTO_POST_APPLICATIONS (TEST for now).
//
// Every five minutes, for each allowed application, the pending submissions
// in its current stage are listed from Ashby's API (cheap). A schedule whose
// updatedAt hasn't moved since it was last handled is skipped. Otherwise its
// submission is read through the worker and compared with the one last
// handled (availability-gate.js availabilityChange: same zone and windows,
// leaving out windows that have started), so our own drafts, which also move
// updatedAt, and time passing never count as a resubmission.
//
// A new submission, in this order:
//   - an approved post for the schedule still in play (store.js blocksRepost)
//     and built from different availability: nothing is posted; that post's
//     thread is told once that the candidate changed their availability after
//     approval and a person needs to decide.
//   - an open post already built from this submission: nothing to do.
//   - otherwise the option is rebuilt exactly as booking review's Post does
//     (booking-routes.js router.suggestAgain, unsteered) and the first option
//     with no calendar flags is posted, as "Scheduling auto-post". Open posts
//     for the schedule built from other availability are withdrawn
//     (service.withdrawForSuggestion, kind "resubmitted") once the search is
//     done, whether or not a new option was found: approval would refuse them
//     anyway (the availability check).
//   - no clean option: one notice in the channel, saying why.
// A read that fails (worker busy, Google disconnected, session expired) is
// tried again on later rounds; after three failed rounds for the same
// updatedAt, one notice says so and that submission isn't tried again.
//
// What was handled is kept in <DATA_DIR>/auto-post.json, per schedule.
const fs = require("fs");
const path = require("path");
const { availabilityChange, postedAvailability } = require("./availability-gate");
const { blocksRepost } = require("./store");

// TEST's application on the TEST job (Luminai): the only one auto-posted so far.
const AUTO_POST_APPLICATIONS = ["8dfd8f14-83c4-41f8-aaf1-416b75cb0892"];
const ACTOR = { id: "Scheduling auto-post", canApprove: true };
const MAX_FAILED_ROUNDS = 3;

function createAutoPost({ on = false, dataDir, clientId, channelId, availability, suggester, service, store, slackApi,
  applications = AUTO_POST_APPLICATIONS, now = () => Date.now(), log = console, intervalMs = 300000 }) {
  const file = path.join(dataDir, "auto-post.json");
  const load = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return {}; } };
  const save = state => { fs.writeFileSync(file + ".tmp", JSON.stringify(state, null, 2)); fs.renameSync(file + ".tmp", file); };
  const iso = () => new Date(now()).toISOString();
  const forSchedule = scheduleId => r => r.clientId === clientId && r.plan?.bookingPlan?.interviewScheduleId === scheduleId;
  const notice = text => slackApi.notice({ channel: channelId, text }).catch(e => log.warn(`[auto-post] Notice couldn't be posted: ${e.message}`));

  async function handle(applicationId, request, state) {
    const { scheduleId, updatedAt } = request, seen = state[scheduleId] || {};
    if (seen.updatedAt === updatedAt && (seen.done || seen.failedRounds >= MAX_FAILED_ROUNDS)) return;
    const record = changes => { state[scheduleId] = { ...seen, ...changes, updatedAt, at: iso() }; save(state); };
    let current;
    try { current = await availability.load({ applicationId, scheduleId }); }
    catch (e) { return failed(e, "read the candidate's availability"); }
    async function failed(e, doing) {
      const rounds = (seen.updatedAt === updatedAt ? seen.failedRounds || 0 : 0) + 1;
      log.warn(`[auto-post] ${scheduleId}: couldn't ${doing} (round ${rounds}): ${e.message}`);
      record({ done: false, failedRounds: rounds, lastError: String(e.message).slice(0, 300) });
      if (rounds >= MAX_FAILED_ROUNDS) await notice(`Auto-post: the candidate's availability for ${request.candidateName || "a candidate"} couldn't be handled after ${rounds} tries (couldn't ${doing}: ${e.message}). Nothing was posted. Post an option from booking review on the dashboard.`);
    }
    // The same submission as last time (our own drafts move updatedAt too).
    if (seen.availability && !availabilityChange(seen.availability, current, now())) return record({ done: true, failedRounds: 0 });
    const rows = (await store.list()).filter(forSchedule(scheduleId));
    const sameAs = r => r.plan.submittedAvailability && !availabilityChange(r.plan.submittedAvailability, current, now());
    const approved = rows.find(r => r.state === "discussion_approved" && blocksRepost(r));
    if (approved) {
      if (!sameAs(approved) && seen.toldApproved !== approved.id) {
        await slackApi.threadReply({ channel: approved.slack.channel, threadTs: approved.slack.ts,
          text: "The candidate changed their availability after this was approved. Nothing new was posted automatically: a person needs to decide whether this schedule still stands." }).catch(e => log.warn(`[auto-post] Thread reply failed: ${e.message}`));
        return record({ done: true, failedRounds: 0, availability: postedAvailability(current), toldApproved: approved.id, outcome: "approved_post_exists" });
      }
      return record({ done: true, failedRounds: 0, availability: postedAvailability(current), outcome: "approved_post_exists" });
    }
    const open = rows.filter(r => r.state === "shared");
    if (open.some(sameAs)) return record({ done: true, failedRounds: 0, availability: postedAvailability(current), outcome: "already_posted" });
    let found;
    try { found = await suggester({ applicationId, scheduleId, steer: {} }); }
    catch (e) { return failed(e, "build an option"); }
    // The submission the option was built from must be the one just read.
    if (!found.submission || availabilityChange(postedAvailability(current), found.submission, now())) return failed(new Error("the availability changed while the option was being built"), "build an option");
    const stale = [];
    for (const r of open.filter(r => !sameAs(r))) {
      try { stale.push(await service.withdrawForSuggestion(r, { by: ACTOR.id, kind: "resubmitted" })); }
      catch (e) { log.warn(`[auto-post] ${r.id} wasn't withdrawn: ${e.message}`); }
    }
    let posted = null;
    if (found.index >= 0) {
      try { posted = await found.post(ACTOR, null, "auto"); }
      catch (e) { log.warn(`[auto-post] ${scheduleId}: the option couldn't be posted: ${e.message}`); await notice(`Auto-post: an option was found for ${found.result.candidateName || "a candidate"}, but it couldn't be posted (${e.message}). Post one from booking review on the dashboard.`); }
    } else {
      const r = found.result, name = r.candidateName || "a candidate";
      await notice(!r.proposals?.length
        ? `Auto-post: ${name} submitted availability, but no agenda fits it (${r.reason || "no reason given"}). Nothing was posted. Check the availability in booking review.`
        : `Auto-post: ${name} submitted availability, but every option has calendar clashes (${r.proposals.length} found), so none was posted automatically. One with clashes can be posted from booking review.`);
    }
    for (const w of stale) {
      const linked = posted ? (await service.recordReplacement(w.id, posted.id)) || w : w;
      await slackApi.markReplaced({ channel: w.slack.channel, ts: w.slack.ts, row: linked }).catch(e => log.warn(`[auto-post] Couldn't mark ${w.id} replaced: ${e.message}`));
    }
    log.warn(`[auto-post] ${scheduleId}: ${posted ? `posted ${posted.id}` : "nothing posted"}${stale.length ? `; withdrew ${stale.length} earlier post(s)` : ""}.`);
    return record({ done: true, failedRounds: 0, availability: postedAvailability(current), outcome: posted ? "posted" : "no_clean_option", ...(posted ? { posted: posted.id } : {}) });
  }

  let running = null;
  async function round() {
    if (!on) return;
    if (running) return running;
    running = (async () => {
      const state = load();
      for (const applicationId of applications) {
        let pending;
        try { pending = await availability.requests(applicationId); }
        catch (e) { log.warn(`[auto-post] Couldn't list ${applicationId}'s submissions: ${e.message}`); continue; }
        for (const request of pending.requests || []) {
          try { await handle(applicationId, { ...request, candidateName: pending.candidateName }, state); }
          catch (e) { log.warn(`[auto-post] ${request.scheduleId}: ${e.message}`); }
        }
      }
    })().finally(() => { running = null; });
    return running;
  }

  function start() {
    log.warn?.(`[auto-post] ${on ? `on for ${applications.length} application(s)` : "off (SCHEDULING_AUTO_POST isn't \"on\")"}`);
    if (!on) return () => {};
    const first = setTimeout(() => round().catch(e => log.warn(`[auto-post] Round failed: ${e.message}`)), 60000);
    const timer = setInterval(() => round().catch(e => log.warn(`[auto-post] Round failed: ${e.message}`)), intervalMs);
    first.unref?.(); timer.unref?.();
    return () => { clearTimeout(first); clearInterval(timer); };
  }

  return { on, round, start };
}

module.exports = { createAutoPost, AUTO_POST_APPLICATIONS };
