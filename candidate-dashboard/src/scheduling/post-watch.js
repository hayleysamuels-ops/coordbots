"use strict";
// Watching Ashby for open posts: an open Slack post is built from one
// interview request, and with most roles booked by hand in Ashby, that request
// is often booked, cancelled or left behind there while the post still offers
// Schedule and says nothing has been booked. Every five minutes, each open
// calendar-checked post whose first session is still ahead (expiry handles
// the rest) has its request read from Ashby's API (availability-source.js
// scheduleState: one application read and one schedule list, no browser).
// It's closed when Ashby shows, in this order:
//   booked     the request is Scheduled, WaitingOnFeedback or Complete: who
//              booked it and the booked times and interviewers, as Ashby has them
//   cancelled  the request was cancelled
//   inactive   the application isn't Active (archived, hired)
//   stage      the candidate has moved to another stage
// Anything else (still pending, a status we don't close on, the request
// missing from the list) leaves the post open; a press on it says why
// (availability-source.js notPendingText). A read that fails leaves it open
// too, and is tried again next sweep.
//
// Closing is service.closeFromAshby: rejected, with `closedInAshby`,
// revision-checked, so a post approved meanwhile is left alone (its Ashby
// check then refuses with the same cause). It never blocks a repost. The
// message loses its buttons and says what Ashby showed (slack.js
// markClosedInAshby). A press in the five minutes before is answered by the
// press's own check.
//
// Writes only our own record and our own Slack message.
const { BOOKED } = require("./availability-source");

// Why Ashby's state closes a post, or null to leave it open.
function closedReason(state) {
  const s = state?.schedule;
  if (s && BOOKED.has(s.status)) return { kind: "booked", status: s.status, by: s.scheduledBy || null, events: s.events || [] };
  if (s?.status === "Cancelled") return { kind: "cancelled" };
  if (state && state.applicationStatus !== "Active") return { kind: "inactive", status: state.applicationStatus };
  if (s && state.stageId && s.stageId && s.stageId !== state.stageId) return { kind: "stage" };
  return null;
}

function createPostWatch({ service, store, slackApi, availability, clientId, now = () => Date.now(), log = console, intervalMs = 300000 }) {
  let running = null;
  async function sweep() {
    if (running) return running;
    running = (async () => {
      const t = now();
      const open = (await store.list()).filter(r => r.clientId === clientId && r.state === "shared" && r.plan?.format === "calendar_checked"
        && Date.parse(r.plan.sessions?.[0]?.start) > t && r.plan.bookingPlan?.applicationId && r.plan.bookingPlan?.interviewScheduleId);
      let closed = 0, unread = 0;
      for (const row of open) {
        let state;
        try { state = await availability.scheduleState(row.plan.bookingPlan.applicationId, row.plan.bookingPlan.interviewScheduleId); }
        catch (e) { unread++; log.warn(`[post-watch] ${row.id}: Ashby couldn't be read (${e.message}); tried again next sweep.`); continue; }
        const why = closedReason(state);
        if (!why) continue;
        const done = await service.closeFromAshby(row, { at: new Date(now()).toISOString(), ...why });
        if (!done) { log.warn(`[post-watch] ${row.id} changed while it was being closed (${why.kind}); looked at again next sweep.`); continue; }
        closed++;
        log.warn(`[post-watch] ${row.id}: closed, ${why.kind} in Ashby.`);
        if (done.slack?.channel && done.slack?.ts) await slackApi.markClosedInAshby({ channel: done.slack.channel, ts: done.slack.ts, row: done })
          .catch(e => log.warn(`[post-watch] ${row.id} closed, but its Slack message couldn't be updated: ${e.message}`));
      }
      if (unread) log.warn(`[post-watch] ${unread} of ${open.length} open post${open.length === 1 ? "" : "s"} couldn't be checked in Ashby this sweep.`);
      return closed;
    })().finally(() => { running = null; });
    return running;
  }
  function start() {
    log.warn("[post-watch] on: open posts are checked against Ashby every five minutes, and closed when their request is booked, cancelled or left behind there");
    const first = setTimeout(() => sweep().catch(e => log.warn(`[post-watch] ${e.message}`)), 120000);
    const timer = setInterval(() => sweep().catch(e => log.warn(`[post-watch] ${e.message}`)), intervalMs);
    first.unref?.(); timer.unref?.();
    return () => { clearTimeout(first); clearInterval(timer); };
  }
  return { sweep, start };
}

module.exports = { createPostWatch, closedReason };
