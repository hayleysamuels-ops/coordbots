"use strict";
// Public endpoint for Slack's Events API: an @mention of the bot in the thread
// of a proposal post, asking to change it ("@bot have Vamsi do Onsite 2
// instead of Joe"). Like the interactivity endpoint, it's outside Basic Auth,
// so every request must prove it came from Slack before anything is parsed:
// the same signature and timestamp check (verifySlackRequest), then the
// configured workspace and app.
//
// Only `app_mention` events are subscribed to (scope app_mentions:read): the
// bot never reads the rest of the channel. A mention counts only when it is
// in this client's channel, in a thread (a top-level mention isn't on a
// post), from a person (no bot messages, no edits). What it asks for is
// worked out by `onMention` (amend.js), which never trusts the text.
//
// Slack resends an event it thinks went unanswered, with a new signature, so
// each event_id is handled once. Slack wants an answer within three seconds:
// the work happens after the 200.
//
// SCHEDULING_AMEND off: the URL check is still answered, so the Slack app can
// be set up first, and every mention is ignored and logged.
const { verifySlackRequest } = require("./slack-interactions");

const KEEP_MS = 60 * 60 * 1000;

function createSlackEvents({ signingSecret, teamId, appId, channelId, on = false, onMention, now = () => Date.now(), log = console }) {
  const seenSignatures = new Map(), seenEvents = new Map();
  const once = id => {
    const at = now();
    for (const [k, t] of seenEvents) if (at - t > KEEP_MS) seenEvents.delete(k);
    if (seenEvents.has(id)) return false;
    seenEvents.set(id, at);
    return true;
  };

  // Express handler; needs the raw body (express.raw) mounted ahead of Basic Auth.
  return async function handle(req, res) {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const problem = verifySlackRequest({ rawBody, headers: req.headers, secret: signingSecret, now: now(), seen: seenSignatures });
    if (problem) { log.warn(`[slack] Event refused: ${problem}.`); return res.status(401).end(); }
    let body;
    try { body = JSON.parse(rawBody.toString("utf8")); } catch (_) { return res.status(400).end(); }
    // Slack checks the Request URL once, when it's entered in the app settings.
    if (body?.type === "url_verification" && typeof body.challenge === "string") return res.status(200).json({ challenge: body.challenge });
    if (body?.type !== "event_callback") return res.status(200).end();
    if (body.team_id !== teamId || body.api_app_id !== appId) { log.warn("[slack] Event refused: wrong workspace or app."); return res.status(403).end(); }
    res.status(200).end();
    const e = body.event || {};
    if (typeof body.event_id !== "string" || !once(body.event_id)) return;
    if (e.type !== "app_mention") return;
    if (!on) { log.log(`[slack] Mention ignored: SCHEDULING_AMEND is off (event ${body.event_id}).`); return; }
    if (e.channel !== channelId) { log.warn("[slack] Mention ignored: not this client's channel."); return; }
    if (e.bot_id || e.subtype || e.edited) return;
    if (typeof e.user !== "string" || !e.user || typeof e.text !== "string") return;
    // A reply in a thread: thread_ts is the post's ts, and differs from the reply's own.
    if (typeof e.thread_ts !== "string" || e.thread_ts === e.ts) { log.log(`[slack] Mention ignored: not in a thread (event ${body.event_id}).`); return; }
    try { await onMention({ eventId: body.event_id, user: e.user, text: e.text, channel: e.channel, threadTs: e.thread_ts, ts: e.ts }); }
    catch (err) { log.warn(`[slack] Mention handling failed (event ${body.event_id}): ${err.message}`); }
  };
}

module.exports = { createSlackEvents };
