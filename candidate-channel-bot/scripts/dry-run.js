"use strict";
/**
 * Calibration tool. Proves the naming convention matches the real workspace
 * before the bot is ever allowed to archive anything.
 *
 *   node scripts/dry-run.js --list
 *       Every live channel carrying the prefix, so you can eyeball the shape
 *       of the names actually in use.
 *
 *   node scripts/dry-run.js "Jane Smith" [archived|hired]
 *       The channel name the bot would derive for that candidate, whether such
 *       a channel exists, and the notice it would post.
 *
 * DRY_RUN is forced on here, so this script cannot archive a channel whatever
 * the environment says.
 */
process.env.DRY_RUN = "true";

require("dotenv").config();
const { WebClient } = require("@slack/web-api");
const config = require("../src/config");
const {
  channelNameFor,
  findCandidateChannels,
  buildClosingNotice,
  isEligibleChannelName,
} = require("../src/slack");

async function listPrefixed() {
  const slack = new WebClient(config.slackBotToken);
  const found = [];
  let cursor;
  do {
    const res = await slack.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 1000,
      cursor,
    });
    for (const channel of res.channels || []) {
      if (channel.name && channel.name.startsWith(config.channelPrefix)) found.push(channel);
    }
    cursor = res.response_metadata && res.response_metadata.next_cursor;
  } while (cursor);

  console.log(`Channels starting with "${config.channelPrefix}": ${found.length}\n`);
  for (const channel of found.sort((a, b) => a.name.localeCompare(b.name))) {
    const kind = channel.is_private ? "private" : "public";
    const member = channel.is_member ? "bot is in" : "bot is NOT in";
    console.log(`  #${channel.name}  (${kind}, ${member})`);
  }
  if (found.some((c) => c.is_private && !c.is_member)) {
    console.log("\nThe bot cannot post in a private channel it is not in. Invite it to those.");
  }
  console.log(
    "\nPrivate channels the bot has NOT been invited to are invisible to it and cannot\n" +
      "appear in this list at all. An empty or short list is not proof they do not exist."
  );
}

async function previewCandidate(name, outcome) {
  const stem = channelNameFor(name);
  console.log(`Candidate:        ${name}`);
  console.log(`Channel stem:     #${stem || "(none: the name produced no slug)"}  (plus any role suffix)`);

  if (!stem) return;

  if (!isEligibleChannelName(stem)) {
    console.log("Match in Slack:   blocked by CHANNEL_DENYLIST (the stem is denylisted)");
    return;
  }

  const matches = await findCandidateChannels(name);
  if (matches.length === 0) {
    console.log(`Match in Slack:   none found (already archived, never created, named differently,`);
    console.log(`                  or private and the bot has not been invited to it)`);
    return;
  }
  for (const c of matches) {
    console.log(`Match in Slack:   #${c.name} (${c.id}, ${c.is_private ? "private" : "public"})`);
  }
  if (matches.length > 1) {
    console.log(`\nMore than one channel matches, so the bot would archive NONE of them and`);
    console.log(`warn instead. Nothing in an Ashby webhook says which role a channel is for.`);
    return;
  }
  const channel = matches[0];
  console.log(`Would archive on: ${outcome}`);
  console.log(`\nNotice it would post:\n`);
  console.log(
    buildClosingNotice({
      outcome,
      candidateName: name,
      jobTitle: "Example Role",
      archiveReasonText: outcome === "archived" ? "Example archive reason" : "",
      candidateProfileUrl: "",
    })
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (!config.slackBotToken) {
    console.error("SLACK_BOT_TOKEN is not set. Fill .env first.");
    process.exit(1);
  }
  if (!config.channelPrefix) {
    console.error("CANDIDATE_CHANNEL_PREFIX is not set. Fill .env first.");
    process.exit(1);
  }

  if (args.length === 0 || args[0] === "--list") return listPrefixed();

  const outcome = (args[1] || "archived").toLowerCase();
  if (!["archived", "hired"].includes(outcome)) {
    console.error(`Unknown outcome "${outcome}". Use archived or hired.`);
    process.exit(1);
  }
  return previewCandidate(args[0], outcome);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
