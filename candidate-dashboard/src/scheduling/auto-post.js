"use strict";
// Auto-post: when a candidate submits availability, post the best
// calendar-checked option to the client channel without anyone pressing Post.
// On only where SCHEDULING_AUTO_POST is exactly "on". Then, by default, only
// for TEST's application (TEST_APPLICATION), as since October 26. With
// SCHEDULING_AUTO_POST_COMPOSE_JOBS also exactly "on" (`wide`), for every job
// and stage on the worker's BOOKING_COMPOSE_JOBS instead: it only proposes,
// so it follows the propose list, not the send one. The second switch is off
// by default so that deploying never starts proposals for real candidates.
//
// Every five minutes (wide): the dashboard's own "Ready to schedule" list (every
// open submission, hidden rows included) is taken, and kept to applications
// whose job and current stage the worker's compose list allows, read fresh
// from the worker each round. Then, for each, the pending submissions in its
// current stage are listed from Ashby's API (cheap). At most ROUND_CAP
// submissions are worked on per round; the rest wait for the next. A schedule whose
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
// A round that fails, wholly or for some candidates (the worker's settings
// unreadable, its compose list invalid, Ashby unreadable), is said in the
// channel, once until it changes, and once more when rounds work again:
// someone may be waiting on a post that isn't coming.
//
// What was handled is kept in <DATA_DIR>/auto-post.json, per schedule (and
// the round's own failure state under "_round").
const fs = require("fs");
const path = require("path");
const { availabilityChange, postedAvailability } = require("./availability-gate");
const { blocksRepost } = require("./store");

// TEST's application on the TEST job (Luminai): the only one auto-posted
// unless SCHEDULING_AUTO_POST_COMPOSE_JOBS is on.
const TEST_APPLICATION = "8dfd8f14-83c4-41f8-aaf1-416b75cb0892";
const ACTOR = { id: "Scheduling auto-post", canApprove: true };
const MAX_FAILED_ROUNDS = 3;
// Submissions worked on per round (each a plan read and a calendar search,
// about a minute). More wait five minutes for the next round.
const ROUND_CAP = 3;

// A failure as people should read it: short, no stack, and Ashby's HTML
// error pages named for what they are.
const plainError = e => /Unexpected token '<'|<!DOCTYPE/i.test(String(e?.message)) ? "Ashby answered with a web page instead of data"
  : String(e?.message || e || "unknown error").replace(/\s+/g, " ").slice(0, 200).replace(/[.\s]+$/, "");

// `candidates()`: the ready-to-schedule rows ({applicationId, jobId,
// candidateName, jobTitle}). `settings()`: the worker's booking settings
// (worker "booking-settings"). `stageTitle(applicationId)`: the application's
// current stage title, read only for jobs listed by stage.
function createAutoPost({ on = false, wide = false, dataDir, clientId, channelId, availability, suggester, service, store, slackApi,
  candidates, settings, stageTitle, cap = ROUND_CAP, now = () => Date.now(), log = console, intervalMs = 300000 }) {
  const file = path.join(dataDir, "auto-post.json");
  const load = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return {}; } };
  const save = state => { fs.writeFileSync(file + ".tmp", JSON.stringify(state, null, 2)); fs.renameSync(file + ".tmp", file); };
  const iso = () => new Date(now()).toISOString();
  const forSchedule = scheduleId => r => r.clientId === clientId && r.plan?.bookingPlan?.interviewScheduleId === scheduleId;
  const notice = text => slackApi.notice({ channel: channelId, text }).catch(e => log.warn(`[auto-post] Notice couldn't be posted: ${e.message}`));

  async function handle(applicationId, request, state) {
    const { scheduleId, updatedAt } = request, seen = state[scheduleId] || {};
    if (seen.updatedAt === updatedAt && (seen.done || seen.failedRounds >= MAX_FAILED_ROUNDS)) return "skipped";
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
    // A standing request that can't be kept leaves the open post where it is:
    // its buttons and thread are the ways out the notice names (a press
    // there rebuilds from the new availability).
    const keepOpen = found.result?.status === "request_unavailable";
    for (const r of keepOpen ? [] : open.filter(r => !sameAs(r))) {
      try { stale.push(await service.withdrawForSuggestion(r, { by: ACTOR.id, kind: "resubmitted" })); }
      catch (e) { log.warn(`[auto-post] ${r.id} wasn't withdrawn: ${e.message}`); }
    }
    let posted = null;
    if (found.index >= 0) {
      try { posted = await found.post(ACTOR, null, "auto"); }
      catch (e) { log.warn(`[auto-post] ${scheduleId}: the option couldn't be posted: ${e.message}`); await notice(`Auto-post: an option was found for ${found.result.candidateName || "a candidate"}, but it couldn't be posted (${e.message}). Post one from booking review on the dashboard.`); }
    } else {
      const r = found.result, name = r.candidateName || "a candidate";
      // A standing request (requests.js) that can't be kept is said with its ways out.
      await notice(r.status === "request_unavailable"
        ? `Auto-post: ${name} submitted availability, but nothing was posted. ${require("./requests").staleRequestText(r.requestFailure.request, r.requestFailure.why,
          { where: "notice", slackPost: await service.slackPostOpen({ applicationId, scheduleId }).catch(() => false) })}`
        : !r.proposals?.length
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

  // Which ready applications the compose list allows; throws when the list
  // can't be read or is invalid, which fails the whole round.
  async function allowed() {
    // Off: TEST alone, nothing else read, as before the compose list was used.
    if (!wide) return { rows: [{ applicationId: TEST_APPLICATION, candidateName: "TEST" }], problems: [] };
    const current = await settings();
    if (current?.composeJobs?.problem) throw new Error(`the worker's compose list is invalid (${current.composeJobs.problem})`);
    const jobs = current?.composeJobs?.jobs;
    if (!jobs || typeof jobs !== "object") throw new Error("the worker didn't say which jobs it may compose for");
    const rows = [...new Map((await candidates()).filter(r => r?.applicationId && r.jobId).map(r => [r.applicationId, r])).values()];
    const out = [], problems = [];
    for (const r of rows) {
      const stages = jobs[String(r.jobId).toLowerCase()];
      if (!stages) continue;
      if (stages === "all") { out.push(r); continue; }
      let title;
      try { title = await stageTitle(r.applicationId); }
      catch (e) { problems.push({ row: r, error: e }); continue; }
      if (stages.includes(String(title || "").trim().toLowerCase())) out.push(r);
    }
    return { rows: out, problems };
  }

  // The round's failures, said once until they change, and once when they clear.
  async function roundOutcome(state, problems) {
    const was = state._round?.failing || null;
    const key = problems.length ? problems.map(p => `${p.who}: ${p.why}`).sort().join("; ") : null;
    if (key === was) return;
    state._round = { failing: key, at: iso() };
    save(state);
    if (key) await notice(problems.length === 1 && problems[0].who === "round"
      ? `Auto-post couldn't run this round: ${problems[0].why}. Nothing was posted automatically. It tries again every five minutes; until then, post from booking review on the dashboard.`
      : `Auto-post couldn't check ${problems.length === 1 ? problems[0].who : `${problems.length} candidates`} this round (${[...new Set(problems.map(p => p.why))].join("; ")}). Nothing was posted for ${problems.length === 1 ? "them" : "those"}. It tries again every five minutes; until then, post from booking review on the dashboard.`);
    else await notice("Auto-post is running normally again.");
  }

  let running = null;
  async function round() {
    if (!on) return;
    if (running) return running;
    running = (async () => {
      const state = load(), problems = [];
      let ready;
      try { ready = await allowed(); }
      catch (e) { log.warn(`[auto-post] Round failed: ${e.message}`); return roundOutcome(state, [{ who: "round", why: plainError(e) }]); }
      for (const p of ready.problems) { log.warn(`[auto-post] Couldn't read ${p.row.applicationId}'s stage: ${p.error.message}`); problems.push({ who: p.row.candidateName || "a candidate", why: plainError(p.error) }); }
      let worked = 0;
      for (const row of ready.rows) {
        if (worked >= cap) { log.warn(`[auto-post] Round cap (${cap}) reached; the rest wait for the next round.`); break; }
        const applicationId = row.applicationId;
        let pending;
        try { pending = await availability.requests(applicationId); }
        catch (e) { log.warn(`[auto-post] Couldn't list ${applicationId}'s submissions: ${e.message}`); problems.push({ who: row.candidateName || "a candidate", why: plainError(e) }); continue; }
        for (const request of pending.requests || []) {
          if (worked >= cap) break;
          try { if (await handle(applicationId, { ...request, candidateName: pending.candidateName }, state) !== "skipped") worked++; }
          catch (e) { log.warn(`[auto-post] ${request.scheduleId}: ${e.message}`); problems.push({ who: pending.candidateName || row.candidateName || "a candidate", why: plainError(e) }); }
        }
      }
      return roundOutcome(load(), problems);
    })().finally(() => { running = null; });
    return running;
  }

  function start() {
    log.warn?.(`[auto-post] ${!on ? "off (SCHEDULING_AUTO_POST isn't \"on\")" : wide ? `on for the jobs and stages on the worker's BOOKING_COMPOSE_JOBS, at most ${cap} submissions a round`
      : "on for TEST only (SCHEDULING_AUTO_POST_COMPOSE_JOBS isn't \"on\")"}`);
    if (!on) return () => {};
    const first = setTimeout(() => round().catch(e => log.warn(`[auto-post] Round failed: ${e.message}`)), 60000);
    const timer = setInterval(() => round().catch(e => log.warn(`[auto-post] Round failed: ${e.message}`)), intervalMs);
    first.unref?.(); timer.unref?.();
    return () => { clearTimeout(first); clearInterval(timer); };
  }

  return { on, round, start };
}

module.exports = { createAutoPost, ROUND_CAP, TEST_APPLICATION };
