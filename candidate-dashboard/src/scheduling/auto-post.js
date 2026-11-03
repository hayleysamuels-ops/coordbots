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
const { createEventLog, statusOf } = require("./auto-post-events");

// TEST's application on the TEST job (Luminai): the only one auto-posted
// unless SCHEDULING_AUTO_POST_COMPOSE_JOBS is on.
const TEST_APPLICATION = "8dfd8f14-83c4-41f8-aaf1-416b75cb0892";
const ACTOR = { id: "Scheduling auto-post", canApprove: true };
const MAX_FAILED_ROUNDS = 3;
// A read that fails before a candidate's submission is even reached (their
// stage, their pending submissions) is retried every round, and given up on,
// loudly and by name, after READ_GIVE_UP rounds (30 minutes).
const READ_GIVE_UP = 6;
// A refusal waiting on a person in Ashby is checked again this often.
const PERSON_RECHECK_MS = 60 * 60 * 1000;
// Refusals only a person can clear, by editing the template or plan in Ashby.
// Errors raised on the dashboard carry needsPerson; the worker's are known
// by their words (worker/plan-reader.js, booking-routes.js).
const NEEDS_PERSON = [/ is a panel: /, /\bNone of the .+ is in the template\b/, /must come first/, /isn't supported\. /,
  /The template's activity isn't in the published plan/, /The template interviews no longer match the published plan/];
const needsPerson = e => e?.needsPerson === true || NEEDS_PERSON.some(re => re.test(String(e?.message || "")));

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
  candidates, settings, stageTitle, cap = ROUND_CAP, now = () => Date.now(), log = console, intervalMs = 300000, events }) {
  const file = path.join(dataDir, "auto-post.json");
  // Every failure, for the daily digest (auto-post-events.js).
  events ||= createEventLog(dataDir, { now, log });
  const load = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return {}; } };
  const save = state => { fs.writeFileSync(file + ".tmp", JSON.stringify(state, null, 2)); fs.renameSync(file + ".tmp", file); };
  const iso = () => new Date(now()).toISOString();
  const forSchedule = scheduleId => r => r.clientId === clientId && r.plan?.bookingPlan?.interviewScheduleId === scheduleId;
  const notice = text => slackApi.notice({ channel: channelId, text }).catch(e => log.warn(`[auto-post] Notice couldn't be posted: ${e.message}`));

  async function handle(applicationId, request, state) {
    const { scheduleId, updatedAt } = request, seen = state[scheduleId] || {};
    if (seen.updatedAt === updatedAt && (seen.done || seen.failedRounds >= MAX_FAILED_ROUNDS)) return "skipped";
    // Waiting on a person in Ashby: checked again hourly, or at once when the schedule changes.
    if (seen.updatedAt === updatedAt && seen.needsPerson && now() - Date.parse(seen.needsPerson.at) < PERSON_RECHECK_MS) return "skipped";
    const record = changes => { state[scheduleId] = { ...seen, ...changes, updatedAt, candidateName: request.candidateName || seen.candidateName || null, at: iso() }; save(state); };
    let current;
    try { current = await availability.load({ applicationId, scheduleId }); }
    catch (e) { return failed(e, "read the candidate's availability"); }
    async function failed(e, doing) {
      const who = request.candidateName || "a candidate";
      // A refusal only a person can clear (the template or plan in Ashby):
      // said at once, marked as such, and not retried every round.
      if (needsPerson(e)) {
        log.warn(`[auto-post] ${scheduleId}: needs a person: couldn't ${doing}: ${e.message}`);
        const told = seen.updatedAt === updatedAt && seen.needsPerson;
        // `at` is the last check; `since` the first, kept across the hourly
        // rechecks (and a changed schedule that still needs the same person),
        // so the digest can say how long it has waited.
        const since = seen.needsPerson?.since || seen.needsPerson?.at || iso();
        record({ done: false, failedRounds: 0, lastError: String(e.message).slice(0, 300), needsPerson: { at: iso(), since, why: String(e.message).slice(0, 500) } });
        if (!told) events.record({ kind: "needs_person", scheduleId, name: who, why: `couldn't ${doing}: ${plainError(e)}`, status: statusOf(e) });
        if (!told) await notice(`⚠️ Needs someone in Ashby: auto-post can't propose ${who}'s schedule until this is fixed. ${e.message} This won't fix itself. Auto-post checks again every hour and as soon as the schedule changes; or post from booking review once it's fixed.`);
        return "needs_person";
      }
      const rounds = (seen.updatedAt === updatedAt ? seen.failedRounds || 0 : 0) + 1;
      log.warn(`[auto-post] ${scheduleId}: couldn't ${doing} (round ${rounds}): ${e.message}`);
      record({ done: false, failedRounds: rounds, lastError: String(e.message).slice(0, 300), needsPerson: null });
      events.record({ kind: rounds >= MAX_FAILED_ROUNDS ? "gave_up" : "retry", scheduleId, name: who, why: `couldn't ${doing}: ${plainError(e)}`, status: statusOf(e) });
      if (rounds >= MAX_FAILED_ROUNDS) await notice(`Auto-post gave up on ${who} after ${rounds} tries (couldn't ${doing}: ${plainError(e)}). Their availability hasn't been posted: post an option from booking review on the dashboard.`);
      else pendingNow.set(scheduleId, { name: who, why: `couldn't ${doing}: ${plainError(e)}` });
      return "failed";
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

  // The ready rows to work on this round, cheapest checks first, so nobody
  // is read (or named in a failure) whose outcome is already settled:
  //   - a submission already handled (posted, or given up on loudly) is
  //     skipped without any read;
  //   - the compose list by job, then by current stage, whose title is read
  //     once per stage and kept (stage titles don't change between rounds).
  // Throws when the worker's list can't be read or is invalid, which fails
  // the whole round. A stage read that fails leaves that candidate's
  // eligibility unknown: they're retried, and named, like any read failure.
  const stageTitles = new Map(), readKey = r => r.scheduleId || r.applicationId;
  async function allowed(state) {
    // Off: TEST alone, nothing else read, as before the compose list was used.
    if (!wide) return { rows: [{ applicationId: TEST_APPLICATION, candidateName: "TEST" }], problems: [], ready: null };
    const current = await settings();
    if (current?.composeJobs?.problem) throw new Error(`the worker's compose list is invalid (${current.composeJobs.problem})`);
    const jobs = current?.composeJobs?.jobs;
    if (!jobs || typeof jobs !== "object") throw new Error("the worker didn't say which jobs it may compose for");
    const settled = r => {
      const seen = r.scheduleId && state[r.scheduleId], read = state._reads?.[readKey(r)];
      return (seen && seen.updatedAt === r.submittedAt && (seen.done || seen.failedRounds >= MAX_FAILED_ROUNDS)) || (read?.gaveUp && read.submittedAt === (r.submittedAt || null));
    };
    const out = new Map(), problems = [], all = await candidates();
    for (const r of all) {
      if (!r?.applicationId || !r.jobId || out.has(r.applicationId) || settled(r)) continue;
      const stages = jobs[String(r.jobId).toLowerCase()];
      if (!stages) continue;
      if (stages !== "all") {
        let title = r.currentStageId ? stageTitles.get(r.currentStageId) : undefined;
        if (title === undefined) {
          try { title = await stageTitle(r.applicationId); if (r.currentStageId) stageTitles.set(r.currentStageId, title); }
          catch (e) { problems.push({ row: r, error: e, doing: "read their stage" }); continue; }
        }
        if (!stages.includes(String(title || "").trim().toLowerCase())) continue;
      }
      out.set(r.applicationId, r);
    }
    // Every submission still open, for what carries over between rounds.
    return { rows: [...out.values()], problems, ready: new Set(all.filter(Boolean).map(readKey)) };
  }

  // Read failures before a submission is reached, per ready schedule (its
  // submission's updatedAt): rounds failed, and whether given up on (loudly).
  // A later successful read clears it; a new submission starts afresh.
  async function readFailed(state, row, error, doing) {
    const reads = state._reads ||= {}, key = readKey(row), was = reads[key];
    const fresh = !was || was.submittedAt !== (row.submittedAt || null);
    const entry = { name: row.candidateName || "a candidate", submittedAt: row.submittedAt || null, rounds: (fresh ? 0 : was.rounds) + 1, why: `couldn't ${doing}: ${plainError(error)}`, gaveUp: false };
    log.warn(`[auto-post] ${row.applicationId}: couldn't ${doing} (round ${entry.rounds}): ${error.message}`);
    events.record({ kind: entry.rounds >= READ_GIVE_UP ? "gave_up" : "retry", scheduleId: row.scheduleId || null, name: entry.name, why: entry.why, status: statusOf(error) });
    if (entry.rounds >= READ_GIVE_UP) {
      entry.gaveUp = true;
      await notice(`Auto-post gave up on ${entry.name} after ${entry.rounds} rounds (${Math.round(entry.rounds * intervalMs / 60000)} minutes; ${entry.why}). Their availability hasn't been posted: post an option from booking review on the dashboard.`);
    } else pendingNow.set(key, { name: entry.name, why: entry.why });
    reads[key] = entry;
  }
  const readCleared = (state, row) => { if (state._reads) delete state._reads[readKey(row)]; };

  // The channel is told when the set of candidates auto-post is stuck on
  // changes, by name, and never that all is well while anyone is: "running
  // normally again" only once nobody is outstanding.
  async function roundOutcome(state, roundError, pending) {
    const was = state._round?.failing || null;
    const names = [...pending.values()].map(p => `${p.name} (${p.why})`).sort();
    const key = roundError ? `round: ${roundError}` : names.length ? names.join("; ") : null;
    if (key === was) return;
    state._round = { failing: key, at: iso() };
    save(state);
    if (roundError) events.record({ kind: "round", scheduleId: null, name: null, why: roundError, status: null });
    if (roundError) await notice(`Auto-post couldn't run this round: ${roundError}. Nothing was posted automatically. It tries again every five minutes; until then, post from booking review on the dashboard.`);
    else if (names.length) await notice(`Auto-post is still waiting on ${names.length === 1 ? "one candidate whose availability hasn't" : `${names.length} candidates whose availability hasn't`} been posted: ${names.join("; ")}. It tries again every five minutes, and says so here if it gives up.`);
    else await notice("Auto-post is running normally again: everyone it was waiting on has been posted or handed back.");
  }

  let running = null, pendingNow = new Map();
  async function round() {
    if (!on) return;
    if (running) return running;
    running = (async () => {
      const state = load();
      pendingNow = new Map();
      let ready;
      try { ready = await allowed(state); }
      catch (e) { log.warn(`[auto-post] Round failed: ${e.message}`); return roundOutcome(state, plainError(e), pendingNow); }
      for (const p of ready.problems) await readFailed(state, p.row, p.error, p.doing);
      let worked = 0;
      for (const row of ready.rows) {
        if (worked >= cap) { log.warn(`[auto-post] Round cap (${cap}) reached; the rest wait for the next round.`); break; }
        const applicationId = row.applicationId;
        let pending;
        try { pending = await availability.requests(applicationId); }
        catch (e) { await readFailed(state, row, e, "list their submissions"); continue; }
        readCleared(state, row);
        for (const request of pending.requests || []) {
          if (worked >= cap) break;
          const name = pending.candidateName || row.candidateName;
          try { if (await handle(applicationId, { ...request, candidateName: name }, state) !== "skipped") worked++; }
          catch (e) {
            log.warn(`[auto-post] ${request.scheduleId}: ${e.message}`); pendingNow.set(request.scheduleId, { name: name || "a candidate", why: plainError(e) });
            events.record({ kind: "retry", scheduleId: request.scheduleId, name: name || "a candidate", why: plainError(e), status: statusOf(e) });
          }
        }
      }
      // Still retrying from an earlier round, though not reached this one (the
      // cap), while its submission is still open; read failures for
      // submissions no longer open are forgotten.
      if (ready.ready) {
        for (const [id, seen] of Object.entries(state)) if (!id.startsWith("_") && ready.ready.has(id) && !seen.done && seen.failedRounds > 0 && seen.failedRounds < MAX_FAILED_ROUNDS && !pendingNow.has(id))
          pendingNow.set(id, { name: seen.candidateName || "a candidate", why: String(seen.lastError || "retrying").slice(0, 200) });
        for (const id of Object.keys(state._reads || {})) if (!ready.ready.has(id)) delete state._reads[id];
      }
      save(state);
      return roundOutcome(state, null, pendingNow);
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

module.exports = { createAutoPost, ROUND_CAP, TEST_APPLICATION, MAX_FAILED_ROUNDS, needsPerson, plainError };
