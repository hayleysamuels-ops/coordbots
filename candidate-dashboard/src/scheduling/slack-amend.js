"use strict";
// Amending a proposal by @mention, Phase 1: one interviewer for another on
// one session, and only people Ashby lists as eligible for it. Behind
// SCHEDULING_AMEND (slack-events.js drops every mention while it's off).
//
//   1. Someone @mentions the bot in a post's thread. The post must be open:
//      the suggestion buttons' checks (service.suggestionSource: shared,
//      calendar-checked, not approved or replaced, still in the future).
//   2. A language model reads the request into one change from a closed set
//      (amend-interpret.js). The request text is data, never instructions:
//      the prompt says so, the answer can only be one checked tool call, and
//      everything it names is matched against the post and Ashby here.
//   3. Which session, from the post alone (amend.js whichSession). The thread
//      is then told what's being checked and roughly how long it takes, since
//      the plan read below runs 30 to 80 seconds.
//   4. Ashby's current eligible lists are read (booking review's plan read)
//      and the person settled against them (amend.js resolveChange). Anything
//      unclear is asked, never guessed; off-plan people are declined.
//   5. The change is restated with Confirm and Cancel. Only the person who
//      asked may press either (their Slack user ID, from Slack's signed event
//      and click). It lapses after 30 minutes; one per post at a time.
//   6. Confirm checks the post again (unchanged since the restatement) and
//      searches for a replacement: the post's own times and people, with the
//      one change (calendar-checked, as the buttons do). If that doesn't come
//      out clean (a clash, or availability or rules changed), the search
//      widens to any time with the same people, and the thread says the time
//      moved. Only a replacement with no calendar flags is posted, through
//      the buttons' path (slack-replace.js); else the post stays open.
//   7. The change stays as a standing request (requests.js): every later
//      rebuild for the schedule keeps that person on that session, until a
//      later amend or "Suggest different interviewer" on it, or booking
//      review's "Drop the Slack requests", says otherwise.
// Nothing is booked or sent: the replacement is a new post, which needs
// Schedule like any other.
//
// Pending amends are held in memory: a restart drops them, and Confirm on
// one then says to ask again. Nothing about them needs to survive one.
const crypto = require("crypto");
const { interpretRequest, plainRequest } = require("./amend-interpret");
const { resolveChange, whichSession, eligibleFor, sessionLabels, whenOf } = require("./amend");
const { nextSuggestion } = require("./suggestion");
const { availabilityChange } = require("./availability-gate");
const { replacePost } = require("./slack-replace");
const { withRequest, describeRequests, staleRequestText } = require("./requests");

const LAPSE_MS = 30 * 60 * 1000;

// `readPlan` is booking review's ({applicationId, scheduleId}) => full plan;
// `suggester` its suggestAgain. `interpret` defaults to the model call with
// this dashboard's key; tests pass a stub.
function createSlackAmend({ service, slackApi, facts, readPlan, suggester, timeZone, apiKey = "", model, interpret = null, now = () => Date.now(), log = console }) {
  const pending = new Map(), working = new Set();
  const read = interpret || (args => interpretRequest({ ...args, apiKey, model, log }));
  const clock = ms => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(ms));
  const settle = (p, text) => slackApi.amendSettled({ channel: p.channel, ts: p.promptTs, text }).catch(e => log.warn(`[amend] Couldn't update the restatement on ${p.postId}: ${e.message}`));
  const live = postId => { const p = pending.get(postId); return p && p.expires > now() ? p : null; };
  function lapse(p) {
    if (pending.get(p.postId) !== p) return;
    pending.delete(p.postId);
    settle(p, `${p.restatement} Not confirmed within 30 minutes, so nothing was changed. Ask again if it's still wanted.`);
  }

  // Steps 1 to 5. Errors with a status are said in the thread as they are;
  // anything else is logged and said plainly.
  async function onMention(m) {
    const reply = text => slackApi.threadReply({ channel: m.channel, threadTs: m.threadTs, text });
    const post = await service.postInThread(m.channel, m.threadTs);
    if (!post) { log.log(`[amend] Mention ignored: thread ${m.threadTs} isn't a schedule post (event ${m.eventId}).`); return reply("This thread isn't an interview schedule post, so there's nothing here I can change."); }
    if (working.has(post.id)) return reply("I'm still working on an earlier request on this post. Wait for that answer, then ask again.");
    working.add(post.id);
    try {
      const who = await slackApi.userInfo(m.user).catch(() => null);
      if (!who?.email) return await reply("Slack didn't say who asked, so nothing was changed. Try again.");
      const name = who.name || who.email;
      const row = await service.suggestionSource({ draftId: post.id, digest: post.digest, channelId: m.channel, messageTs: m.threadTs });
      const waiting = live(row.id);
      if (waiting && waiting.user !== m.user) return await reply(`${waiting.name} has a change waiting to be confirmed on this post: ${waiting.restatement} Only they can confirm or cancel it; it lapses at ${clock(waiting.expires)}.`);
      const sessions = row.plan.bookingPlan.sessions, labels = sessionLabels(sessions);

      // What leaves the dashboard: the request with mentions named, and each
      // session's label, time and interviewer's name. Never the candidate.
      const text = await plainRequest(m.text, { botUserId: m.botUserId, nameOf: async id => (await slackApi.userInfo(id))?.name || null });
      let interpreted;
      try { interpreted = await read({ text, sessions: sessions.map((s, i) => ({ title: labels[i], when: whenOf(s, timeZone), interviewer: s.interviewers?.[0]?.name || "nobody" })) }); }
      catch (e) {
        if (e.kind === "understanding") return await reply(`${e.message} Nothing was changed. Say who should come off, who should go on and which session, for example "have Vamsi take ${labels.at(-1)} instead of ${sessions.at(-1).interviewers?.[0]?.name?.split(" ")[0] || "Joe"}".`);
        return await reply(e.message);
      }
      const which = whichSession(interpreted, { sessions, timeZone });
      if (which.ask) return await reply(which.ask);
      if (which.decline) return await reply(which.decline);

      await reply(`Checking Ashby for ${which.label}'s eligible interviewers, about a minute.`);
      const plan = await readPlan({ applicationId: row.plan.applicationId, scheduleId: row.plan.bookingPlan.interviewScheduleId });
      const eligible = await eligibleFor(sessions, plan, facts.resolveInterviewers);
      const settled = await resolveChange(interpreted, { sessions, eligible, findPeople: async () => facts.activeUsers(), timeZone });
      if (settled.ask) return await reply(settled.ask);
      if (settled.decline) {
        if (settled.offPlan) log.log(`[amend] Declined an off-plan interviewer on draft ${row.id}, session ${settled.offPlan.session + 1} (event ${m.eventId}).`);
        return await reply(settled.decline);
      }
      // The read took a while: the post must still be the one restated.
      await service.suggestionSource({ draftId: row.id, digest: row.digest, channelId: m.channel, messageTs: m.threadTs });

      // Someone else's restatement may have landed during the read.
      const earlier = pending.get(row.id);
      if (earlier && earlier.user !== m.user && live(row.id)) return await reply(`${earlier.name} has a change waiting to be confirmed on this post: ${earlier.restatement} Only they can confirm or cancel it; it lapses at ${clock(earlier.expires)}.`);
      if (earlier) { pending.delete(row.id); settle(earlier, `${earlier.restatement} Replaced by a newer request, so nothing was changed.`); }
      const p = { id: crypto.randomUUID(), postId: row.id, digest: row.digest, channel: m.channel, threadTs: m.threadTs, user: m.user, name, email: who.email.toLowerCase(),
        change: settled.change, restatement: settled.restatement, expires: now() + LAPSE_MS };
      p.promptTs = await slackApi.amendPrompt({ channel: m.channel, threadTs: m.threadTs, value: JSON.stringify({ a: p.id }),
        text: `${settled.restatement} Only ${name} can confirm. Nothing changes until then, and this lapses in 30 minutes.` });
      pending.set(row.id, p);
      setTimeout(() => lapse(p), LAPSE_MS).unref?.();
      log.log(`[amend] Restated a change to draft ${row.id}, session ${settled.change.session + 1}, for confirmation (event ${m.eventId}).`);
    } catch (e) {
      if (e.status) return reply(`${e.message} Nothing was changed.`);
      log.warn(`[amend] Request on draft ${post.id} failed (event ${m.eventId}): ${e.message}`);
      return reply("Something went wrong reading Ashby or the calendars, so nothing was changed. Try again in a few minutes.");
    } finally { working.delete(post.id); }
  }

  // Confirm (yes) or Cancel on a restatement.
  async function press(payload, yes) {
    const threadTs = payload.container?.thread_ts || payload.message?.thread_ts || payload.container.message_ts;
    const reply = text => slackApi.threadReply({ channel: payload.channel.id, threadTs, text });
    let value;
    try { value = JSON.parse(payload.actions[0].value); } catch (_) { return reply("This button couldn't be read. Nothing was changed."); }
    const p = [...pending.values()].find(x => x.id === value?.a);
    if (!p || p.promptTs !== payload.container.message_ts || p.channel !== payload.channel.id) {
      await slackApi.amendSettled({ channel: payload.channel.id, ts: payload.container.message_ts, text: "This request is no longer waiting (it lapsed, was replaced, or the dashboard restarted). Nothing was changed; ask again if it's still wanted." }).catch(() => {});
      return;
    }
    if (p.expires <= now()) return lapse(p);
    if (payload.user.id !== p.user) {
      log.log(`[amend] ${yes ? "Confirm" : "Cancel"} refused on draft ${p.postId}: ${payload.user.id} didn't ask.`);
      return reply(`Only ${p.name}, who asked, can ${yes ? "confirm" : "cancel"} this. Nothing was changed.`);
    }
    pending.delete(p.postId);
    if (!yes) { log.log(`[amend] Cancelled on draft ${p.postId}.`); return settle(p, `${p.restatement} Cancelled by ${p.name}; nothing was changed.`); }
    await settle(p, `${p.restatement} Confirmed by ${p.name}. Checking the calendars for the new option, about a minute.`);
    return apply(p, reply);
  }

  // Step 6: the replacement, through the suggestion buttons' path.
  async function apply(p, reply) {
    if (!suggester) return reply("Suggesting another option isn't connected on this dashboard. Nothing was changed.");
    if (working.has(p.postId)) return reply("Another request on this post is still running, so nothing was changed. Ask again once it's answered.");
    working.add(p.postId);
    const { change } = p, what = `${change.in.name} on ${change.label}`;
    try {
      const row = await service.suggestionSource({ draftId: p.postId, digest: p.digest, channelId: p.channel, messageTs: p.threadTs });
      const sessions = row.plan.bookingPlan.sessions;
      // Everyone stays where they are but the one change; the first search
      // also keeps every session's time.
      const requireInterviewers = sessions.map((s, i) => i === change.session ? { session: i, userId: change.in.userId, name: change.in.name } : { session: i, userId: s.interviewers[0].userId, name: s.interviewers[0].name });
      const fixedStarts = sessions.map(s => s.start);
      // The change becomes a standing request (requests.js), replacing any
      // earlier one for that session; later rebuilds keep it.
      const requested = withRequest(row.plan.requested, { session: change.session, interviewId: sessions[change.session].interviewId, label: change.label,
        userId: change.in.userId, name: change.in.name, by: p.email, byName: p.name });
      const find = (record, fixed) => suggester({ applicationId: row.plan.applicationId, scheduleId: row.plan.bookingPlan.interviewScheduleId,
        steer: { ...record, requireInterviewers, requested, ...(fixed ? { fixedStarts } : {}) } });
      // Another session's standing request that can't be kept is worded with
      // the ways out; this change's own person failing is said plainly.
      const blockedText = r => r.status === "request_unavailable" && r.requestFailure.request.session !== change.session
        ? `${staleRequestText(r.requestFailure.request, r.requestFailure.why, { where: "slack" })} This post is still open.` : `${r.reason} This post is still open.`;
      const others = requested.filter(r => r.session !== change.session), keeping = others.length ? `, ${describeRequests(others)}` : "";
      let record = nextSuggestion(row, { kind: "amend", session: change.session, by: p.email, change });
      let found = await find(record, true);
      // The candidate resubmitted since this post: earlier steers don't carry over.
      if (row.plan.suggestion && found.submission && availabilityChange(row.plan.submittedAvailability, found.submission, now())) {
        record = nextSuggestion(row, { kind: "amend", session: change.session, by: p.email, change, carry: false });
        found = await find(record, true);
      }
      let moved = null;
      if (found.index < 0) {
        if (["no_other_interviewer", "request_unavailable"].includes(found.result.status)) return await reply(blockedText(found.result));
        moved = found.result.proposals?.length ? "someone's calendar clashes at those times" : "those times no longer fit the candidate's availability and the rules";
        found = await find(record, false);
        if (found.index < 0) {
          const r = found.result;
          return await reply(["no_other_interviewer", "request_unavailable"].includes(r.status) ? blockedText(r)
            : !r.proposals?.length ? `No agenda with ${what}${keeping} and everyone else unchanged fits: ${r.reason || "the candidate's availability and the rules leave none"} This post is still open.`
            : `Every agenda with ${what}${keeping} and everyone else unchanged has calendar clashes (${r.proposals.length} found), so none was posted. This post is still open; an option with clashes can be posted from booking review on the dashboard.`);
        }
      }
      record = { ...record, change: { ...record.change, moved: !!moved } };
      const text = await replacePost({ service, slackApi, log, row, found, record, by: p.email, kind: "amend", session: change.session,
        change: `replace ${change.out.name} with ${change.in.name} on ${change.label}`, channel: p.channel, ts: p.threadTs,
        done: moved ? `Replaced: the new option has ${what}, but the times moved because ${moved}. Check the new post's times. Nothing from this post was booked or sent.`
          : `Replaced: the new option has ${what}, at the same times. Nothing from this post was booked or sent.` });
      log.log(`[amend] Draft ${p.postId} replaced for an amend${moved ? " (times moved)" : ""}.`);
      return await reply(text);
    } catch (e) {
      if (!e.status) log.warn(`[amend] Applying the change to draft ${p.postId} failed: ${e.message}`);
      return reply(e.status ? `${e.message} Nothing was changed.` : "The change couldn't be made. Nothing was changed; try again.");
    } finally { working.delete(p.postId); }
  }

  return { onMention, press };
}

module.exports = { createSlackAmend };
