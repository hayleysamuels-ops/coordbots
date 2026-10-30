"use strict";
// Replacing a Slack post with a new option, once one has been found: shared by
// the suggestion buttons (slack-interactions.js) and @mention amends
// (slack-amend.js), so both withdraw, post and link the same way.
//
// The post is withdrawn first (revision-checked: one approved meanwhile is
// left alone, and nothing is posted), then the replacement is posted, linked
// to it, and the old post shown as replaced. Returns what to tell the thread;
// a refused withdrawal throws, for the caller to answer.
async function replacePost({ service, slackApi, log = console, row, found, record, by, kind, session = null, change = null, channel, ts, done }) {
  const withdrawn = await service.withdrawForSuggestion(row, { by, kind, session, change });
  let posted;
  // canApprove here only lets the replacement be posted: Schedule on it
  // still checks the clicker against the approvers.
  try { posted = await found.post({ id: by, canApprove: true }, record); }
  catch (e) {
    log.warn(`[slack] Replacement for ${row.id} couldn't be posted: ${e.message}`);
    await slackApi.markReplaced({ channel, ts, row: withdrawn }).catch(err => log.warn(`[slack] Couldn't mark ${row.id} replaced: ${err.message}`));
    return `Another option was found, but it couldn't be posted (${e.message}). This post has been withdrawn: post an option from booking review on the dashboard.`;
  }
  const linked = (await service.recordReplacement(row.id, posted.id)) || withdrawn;
  await slackApi.markReplaced({ channel, ts, row: linked }).catch(e => log.warn(`[slack] Couldn't mark ${row.id} replaced: ${e.message}`));
  if (posted.state !== "shared") return `Replaced, but Slack didn't confirm the new post (${posted.issue || "no answer"}). Check the channel, then reconcile it on the dashboard.`;
  return done;
}

module.exports = { replacePost };
