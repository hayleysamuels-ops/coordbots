"use strict";

const config = require("./config");
const ashby = require("./ashby");
const slackApi = require("./slack");
const store = require("./store");

/**
 * Decide what a parsed webhook should cause, without touching Slack or Ashby.
 * Kept pure so the rules are testable: see test/decide.test.js.
 *
 * Returns { act: boolean, reason: string }.
 */
function decide(event, deps) {
  const { wasHandled, archiveOn, channelPrefix } = deps;

  if (!channelPrefix) {
    return { act: false, reason: "CANDIDATE_CHANNEL_PREFIX is not set, so no channel is eligible" };
  }
  if (!event.outcome) {
    return { act: false, reason: `not a terminal event (status ${event.status || "unknown"})` };
  }
  if (!archiveOn.has(event.outcome)) {
    return { act: false, reason: `ARCHIVE_ON does not include "${event.outcome}"` };
  }
  if (!event.applicationId) {
    return { act: false, reason: "payload had no application id" };
  }
  if (!event.candidateName) {
    return { act: false, reason: "payload had no candidate name, so no channel can be resolved" };
  }
  if (wasHandled(event.applicationId, event.outcome)) {
    return { act: false, reason: "already handled this application and outcome" };
  }
  return { act: true, reason: "" };
}

/** Handle one webhook end to end. */
async function handleEvent(event) {
  const decision = decide(event, {
    wasHandled: store.wasHandled,
    archiveOn: config.archiveOn,
    channelPrefix: config.channelPrefix,
  });

  const who = event.candidateName || event.applicationId || "unknown candidate";

  if (!decision.act) {
    console.log(`[handler] Skipping ${who}: ${decision.reason}.`);
    return;
  }

  // A candidate interviewing for a second role keeps their channel.
  if (config.requireAllApplicationsClosed) {
    const stillLive = await ashby.hasOtherLiveApplication(event.candidateId, event.applicationId);
    if (stillLive === true) {
      console.log(`[handler] Leaving ${who}'s channel open: another application is still live.`);
      return;
    }
    if (stillLive === null && config.ashbyApiKey) {
      console.warn(`[handler] Could not confirm ${who} has no other live application. Proceeding.`);
    }
  }

  const expectedStem = slackApi.channelNameFor(event.candidateName);
  const matches = await slackApi.findCandidateChannels(event.candidateName);

  if (matches.length === 0) {
    console.log(`[handler] No live channel starting with #${expectedStem} for ${who}. Nothing to archive.`);
    store.markHandled(event.applicationId, event.outcome, { result: "no-channel", expectedName: expectedStem });
    return;
  }

  // More than one channel means a channel per role, and nothing in the payload
  // says which role this webhook was about. Archiving the wrong one closes a
  // live interview, so archive none and tell a human.
  if (matches.length > 1) {
    const names = matches.map((c) => "#" + c.name).join(", ");
    console.warn(
      `[handler] ${who} has ${matches.length} live channels (${names}). Archiving none: cannot tell which role this outcome belongs to.`
    );
    await slackApi.postFallback(
      `:warning: ${who} was ${event.outcome} in Ashby but has ${matches.length} open channels (${matches
        .map((c) => `<#${c.id}>`)
        .join(", ")}). I archived none of them, because nothing says which role the outcome was for. Close the right one by hand.`
    );
    return;
  }

  const channel = matches[0];

  if (config.dryRun) {
    console.log(
      `[handler] DRY RUN: would archive #${channel.name} (${channel.id}) because ${who} was ${event.outcome}. Set DRY_RUN=false to act.`
    );
    return;
  }

  const notice = slackApi.buildClosingNotice(event);
  try {
    const result = await slackApi.closeChannel(channel, notice);
    if (!result.archived) {
      console.warn(`[handler] Did not archive #${channel.name}: ${result.skippedReason}.`);
      return;
    }
    console.log(
      `[handler] Archived #${channel.name} for ${who} (${event.outcome}); notice ${result.posted ? "posted" : "not posted"}.`
    );
    store.markHandled(event.applicationId, event.outcome, {
      result: "archived",
      channel: channel.name,
      channelId: channel.id,
      outcome: event.outcome,
    });
  } catch (err) {
    console.error(`[handler] Failed to archive #${channel.name}: ${err.message}`);
    await slackApi.postFallback(
      `:warning: Could not archive <#${channel.id}> after ${who} was ${event.outcome} in Ashby: ${err.message}`
    );
  }
}

module.exports = { decide, handleEvent };
