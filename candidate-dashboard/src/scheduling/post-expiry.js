"use strict";
// Expiry: an open Slack post whose first session has passed can no longer be
// approved or replaced (service.js postedRow refuses it), and nothing else
// clears it. Every five minutes, each such post is closed (service.expirePassed:
// rejected, with `expired`) and its message updated (slack.js markExpired):
// buttons gone, "Expired", nothing booked by the bot, and what was pressed on
// it, from post-presses.js: what was pressed and what came of it; nobody
// pressed anything; or, for a post made before presses were recorded, that
// it isn't known. A hand-booked post and a dropped one read differently only
// by that, since our records can't see Ashby's side; the digest counts them
// ("expired since the last digest").
//
// Writes only our own record and our own Slack message. On whenever Slack
// posting is: it changes nothing anyone could still act on.
const { pressesSentence } = require("./post-presses");

function createPostExpiry({ service, store, slackApi, presses, clientId, now = () => Date.now(), log = console, intervalMs = 300000, zone = "America/Los_Angeles" }) {
  const when = ms => new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(ms);
  let running = null;
  async function sweep() {
    if (running) return running;
    running = (async () => {
      const t = now(), at = new Date(t).toISOString(), since = presses.since();
      const due = (await store.list()).filter(r => r.clientId === clientId && r.state === "shared" && Date.parse(r.plan?.sessions?.[0]?.start) <= t);
      let expired = 0;
      for (const row of due) {
        const sentence = pressesSentence(presses.forDraft(row.id), { postedAt: Number(row.slack?.ts) * 1000, since, when });
        const done = await service.expirePassed(row, { at, presses: sentence });
        if (!done) { log.warn(`[expiry] ${row.id} changed while it was being expired; tried again next sweep.`); continue; }
        expired++;
        if (done.slack?.channel && done.slack?.ts) await slackApi.markExpired({ channel: done.slack.channel, ts: done.slack.ts, row: done })
          .catch(e => log.warn(`[expiry] ${row.id} expired, but its Slack message couldn't be updated: ${e.message}`));
      }
      if (expired) log.warn(`[expiry] Expired ${expired} post${expired === 1 ? "" : "s"} whose first session had passed.`);
      return expired;
    })().finally(() => { running = null; });
    return running;
  }
  function start() {
    log.warn("[expiry] on: open posts whose first session has passed are closed every five minutes");
    const first = setTimeout(() => sweep().catch(e => log.warn(`[expiry] ${e.message}`)), 90000);
    const timer = setInterval(() => sweep().catch(e => log.warn(`[expiry] ${e.message}`)), intervalMs);
    first.unref?.(); timer.unref?.();
    return () => { clearTimeout(first); clearInterval(timer); };
  }
  return { sweep, start };
}

module.exports = { createPostExpiry };
