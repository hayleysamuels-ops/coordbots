"use strict";
// Public endpoint for Slack's interactivity: the "Schedule" button on
// calendar-checked posts. It's the only dashboard API route outside Basic Auth, so
// every request must prove it came from Slack before anything is parsed:
//   1. X-Slack-Signature is HMAC-SHA256 of "v0:<timestamp>:<raw body>" with the
//      app's signing secret, compared in constant time.
//   2. X-Slack-Request-Timestamp is within five minutes, and a signature seen
//      in that window is refused, so a captured request can't be replayed.
//   3. The payload's workspace and app are the configured ones, the channel is
//      this client's channel, and the message is the one the draft was posted
//      as. Nothing in the payload chooses a channel, a draft or an approver.
// The clicking user is resolved to an email by Slack's own users.info, never
// taken from the payload, and must be on SCHEDULING_SLACK_APPROVERS.
// Recording an approval never books anything (service.approveInSlack). With
// `ashbyCheck`, an approved schedule is then composed in Ashby as a draft and
// left for a person to send (ashby-check.js); nothing is sent automatically.
//
// "Suggest another time" and the "Suggest different interviewer" menu (same
// approvers, same bindings) rebuild the option server-side from the
// candidate's current submission and the calendars, steered away from what
// was proposed (suggestion.js). The post stays open while that runs; only
// once a replacement with no calendar flags is found is it withdrawn
// (revision-checked: one approved meanwhile is left alone) and the new
// option posted. No replacement found, nothing changes and the thread says why.
const crypto = require("crypto");
const { nextSuggestion } = require("./suggestion");
const { availabilityChange } = require("./availability-gate");

const WINDOW_S = 300;

function verifySlackRequest({ rawBody, headers, secret, now = Date.now(), seen }) {
  const timestamp = headers["x-slack-request-timestamp"], signature = headers["x-slack-signature"];
  if (!secret || typeof timestamp !== "string" || typeof signature !== "string" || !/^\d{1,12}$/.test(timestamp) || !/^v0=[0-9a-f]{64}$/.test(signature)) return "missing or malformed signature";
  if (Math.abs(now / 1000 - Number(timestamp)) > WINDOW_S) return "stale timestamp";
  const expected = "v0=" + crypto.createHmac("sha256", secret).update(`v0:${timestamp}:`).update(rawBody).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return "bad signature";
  if (seen) {
    for (const [sig, at] of seen) if (now - at > WINDOW_S * 1000) seen.delete(sig);
    if (seen.has(signature)) return "replayed request";
    seen.set(signature, now);
  }
  return null;
}

function createSlackInteractions({ service, slackApi, signingSecret, teamId, appId, channelId, approvers, ashbyCheck = null, suggester = null, now = () => Date.now(), log = console }) {
  const seen = new Map(), allowed = new Set(approvers.map(e => e.toLowerCase())), suggesting = new Set();
  const when = ms => new Date(ms).toISOString();
  // The clicking user, from Slack's users.info, if they're an approver; else
  // the thread is told and null returned.
  async function approverFor(payload, reply, what) {
    const who = await slackApi.userInfo(payload.user.id).catch(() => null);
    if (who?.email && allowed.has(who.email.toLowerCase())) return { ...who, email: who.email.toLowerCase() };
    log.warn(`[slack] ${what} refused: ${payload.user.id} isn't an approver.`);
    await reply(`${who?.name || "This user"} isn't an approver for this client's interview schedules, so nothing was ${what === "Schedule click" ? "recorded" : "changed"}. Ask an approver to do it.`);
    return null;
  }

  // Anyone in the client's channel may shape a proposal (the suggestion
  // buttons, and from Phase 1 an @mention reply); only approvers book one
  // (Schedule). The click's channel is checked before this runs, so this only
  // needs who it is, from Slack's users.info, for the record.
  async function memberFor(payload, reply) {
    const who = await slackApi.userInfo(payload.user.id).catch(() => null);
    if (who?.email) return { ...who, email: who.email.toLowerCase() };
    log.warn(`[slack] Suggestion refused: ${payload.user.id} couldn't be identified.`);
    await reply("Slack didn't say who asked, so nothing was changed. Try again.");
    return null;
  }

  async function act(payload) {
    const action = payload.actions[0], message = payload.container || {};
    const reply = text => slackApi.threadReply({ channel: payload.channel.id, threadTs: message.message_ts, text });
    let value;
    try { value = JSON.parse(action.value); } catch (_) { return reply("This button couldn't be read. Nothing was recorded."); }
    const who = await approverFor(payload, reply, "Schedule click");
    if (!who) return;
    try {
      const row = await service.approveInSlack({ draftId: value.d, digest: value.g, channelId: payload.channel.id, messageTs: message.message_ts,
        approver: { email: who.email, slackUserId: payload.user.id, name: who.name } });
      // Queued first, so the message never briefly says "book by hand" for a
      // schedule that's about to be checked.
      const queued = ashbyCheck ? await ashbyCheck.start(row).catch(e => { log.warn(`[slack] The Ashby check couldn't be queued: ${e.message}`); return null; }) : null;
      await slackApi.markApproved({ channel: payload.channel.id, ts: message.message_ts, row: queued || row });
    } catch (e) {
      if (!e.status) log.warn(`[slack] Schedule click failed: ${e.message}`);
      return reply(e.status ? `${e.message} Nothing was recorded.` : "The approval couldn't be recorded. Nothing was recorded; try again.");
    }
  }

  // Why no replacement was posted, from the rebuilt result.
  function noneText(result, what) {
    if (result.status === "no_other_interviewer") return `${result.reason} This post is still open.`;
    if (!result.proposals?.length) return `No other option fits for ${what}: ${result.reason || "the candidate's availability and the rules leave none"} This post is still open.`;
    return `Every other option for ${what} has calendar clashes (${result.proposals.length} found), so none was posted. This post is still open; an option with clashes can be posted from booking review on the dashboard.`;
  }

  async function suggest(payload, kind) {
    const action = payload.actions[0], message = payload.container || {};
    const reply = text => slackApi.threadReply({ channel: payload.channel.id, threadTs: message.message_ts, text });
    let value;
    try { value = JSON.parse(kind === "time" ? action.value : action.selected_option?.value); } catch (_) { return reply("This control couldn't be read. Nothing was changed."); }
    if (typeof value?.d !== "string" || typeof value.g !== "string" || (kind === "interviewer" && !Number.isInteger(value.i))) return reply("This control couldn't be read. Nothing was changed.");
    const who = await memberFor(payload, reply);
    if (!who) return;
    if (!suggester) return reply("Suggesting another option isn't connected on this dashboard. Nothing was changed.");
    // One search per post at a time; a second click while it runs is dropped.
    if (suggesting.has(value.d)) return;
    suggesting.add(value.d);
    const what = kind === "time" ? "another time" : `a different interviewer for session ${value.i + 1}`;
    try {
      const row = await service.suggestionSource({ draftId: value.d, digest: value.g, channelId: payload.channel.id, messageTs: message.message_ts });
      let steer = nextSuggestion(row, { kind, session: kind === "interviewer" ? value.i : null, by: who.email });
      await reply(`Looking for ${what}, asked by ${who.name || who.email}. This post stays open until a replacement is ready.`);
      const find = s => suggester({ applicationId: row.plan.applicationId, scheduleId: row.plan.bookingPlan.interviewScheduleId, steer: s });
      let found = await find(steer);
      // The candidate resubmitted since this post: earlier steers don't carry over.
      if (row.plan.suggestion && found.submission && availabilityChange(row.plan.submittedAvailability, found.submission, now())) {
        steer = nextSuggestion(row, { kind, session: kind === "interviewer" ? value.i : null, by: who.email, carry: false });
        found = await find(steer);
      }
      if (found.index < 0) return await reply(noneText(found.result, what));
      const withdrawn = await service.withdrawForSuggestion(row, { by: who.email, kind, session: kind === "interviewer" ? value.i : null });
      let posted;
      // canApprove here only lets the replacement be posted: Schedule on it
      // still checks the clicker against the approvers.
      try { posted = await found.post({ id: who.email, canApprove: true }, steer); }
      catch (e) {
        log.warn(`[slack] Replacement for ${row.id} couldn't be posted: ${e.message}`);
        await slackApi.markReplaced({ channel: payload.channel.id, ts: message.message_ts, row: withdrawn }).catch(err => log.warn(`[slack] Couldn't mark ${row.id} replaced: ${err.message}`));
        return await reply(`Another option was found, but it couldn't be posted (${e.message}). This post has been withdrawn: post an option from booking review on the dashboard.`);
      }
      const linked = (await service.recordReplacement(row.id, posted.id)) || withdrawn;
      await slackApi.markReplaced({ channel: payload.channel.id, ts: message.message_ts, row: linked }).catch(e => log.warn(`[slack] Couldn't mark ${row.id} replaced: ${e.message}`));
      if (posted.state !== "shared") return await reply(`Replaced, but Slack didn't confirm the new post (${posted.issue || "no answer"}). Check the channel, then reconcile it on the dashboard.`);
      return await reply(`Replaced: the new option (${what}) is posted in the channel. Nothing from this post was booked or sent.`);
    } catch (e) {
      if (!e.status) log.warn(`[slack] Suggestion failed: ${e.message}`);
      return reply(e.status ? `${e.message} Nothing was changed.` : "Another option couldn't be found. Nothing was changed; try again.");
    } finally { suggesting.delete(value.d); }
  }

  // Express handler; needs the raw body (express.raw) mounted ahead of Basic Auth.
  return async function handle(req, res) {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const problem = verifySlackRequest({ rawBody, headers: req.headers, secret: signingSecret, now: now(), seen });
    if (problem) { log.warn(`[slack] Interaction refused: ${problem}.`); return res.status(401).end(); }
    let payload;
    try { payload = JSON.parse(new URLSearchParams(rawBody.toString("utf8")).get("payload")); } catch (_) { return res.status(400).end(); }
    if (payload?.team?.id !== teamId || payload?.api_app_id !== appId) { log.warn("[slack] Interaction refused: wrong workspace or app."); return res.status(403).end(); }
    // Slack wants an answer within three seconds; the work happens after it.
    res.status(200).end();
    const actionId = payload.type === "block_actions" ? payload.actions?.[0]?.action_id : null;
    if (!["schedule_option", "suggest_time", "suggest_interviewer"].includes(actionId)) return;
    if (payload.channel?.id !== channelId || !payload.container?.message_ts || !payload.user?.id) { log.warn("[slack] Click ignored: not this client's channel."); return; }
    if (actionId === "schedule_option") act(payload).catch(e => log.warn(`[slack] Schedule click handling failed: ${e.message}`));
    else suggest(payload, actionId === "suggest_time" ? "time" : "interviewer").catch(e => log.warn(`[slack] Suggestion handling failed: ${e.message}`));
  };
}

module.exports = { createSlackInteractions, verifySlackRequest };
