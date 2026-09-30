"use strict";
// Public endpoint for Slack's interactivity: the "Schedule" button on
// calendar-checked posts. It's the only dashboard route outside Basic Auth, so
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
// Recording an approval never books anything (service.approveInSlack).
const crypto = require("crypto");

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

function createSlackInteractions({ service, slackApi, signingSecret, teamId, appId, channelId, approvers, now = () => Date.now(), log = console }) {
  const seen = new Map(), allowed = new Set(approvers.map(e => e.toLowerCase()));
  const when = ms => new Date(ms).toISOString();

  async function act(payload) {
    const action = payload.actions[0], message = payload.container || {};
    const reply = text => slackApi.threadReply({ channel: payload.channel.id, threadTs: message.message_ts, text });
    let value;
    try { value = JSON.parse(action.value); } catch (_) { return reply("This button couldn't be read. Nothing was recorded."); }
    const who = await slackApi.userInfo(payload.user.id).catch(() => null);
    const name = who?.name || "This user";
    if (!who?.email || !allowed.has(who.email.toLowerCase())) {
      log.warn(`[slack] Schedule click refused: ${payload.user.id} isn't an approver.`);
      return reply(`${name} isn't an approver for this client's interview schedules, so nothing was recorded. Ask an approver to confirm it.`);
    }
    try {
      const row = await service.approveInSlack({ draftId: value.d, digest: value.g, channelId: payload.channel.id, messageTs: message.message_ts,
        approver: { email: who.email.toLowerCase(), slackUserId: payload.user.id, name: who.name } });
      await slackApi.markApproved({ channel: payload.channel.id, ts: message.message_ts, row });
    } catch (e) {
      if (!e.status) log.warn(`[slack] Schedule click failed: ${e.message}`);
      return reply(e.status ? `${e.message} Nothing was recorded.` : "The approval couldn't be recorded. Nothing was recorded; try again.");
    }
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
    if (payload.type !== "block_actions" || payload.actions?.[0]?.action_id !== "schedule_option") return;
    if (payload.channel?.id !== channelId || !payload.container?.message_ts || !payload.user?.id) { log.warn("[slack] Schedule click ignored: not this client's channel."); return; }
    act(payload).catch(e => log.warn(`[slack] Schedule click handling failed: ${e.message}`));
  };
}

module.exports = { createSlackInteractions, verifySlackRequest };
