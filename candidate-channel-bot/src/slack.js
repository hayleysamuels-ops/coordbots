"use strict";

const { WebClient } = require("@slack/web-api");
const config = require("./config");

const slack = new WebClient(config.slackBotToken);

/**
 * Turn a candidate's name into the channel-name half that follows the prefix.
 * Accents are folded ("Zoë" -> "zoe"), anything Slack disallows becomes a
 * hyphen, and runs of hyphens collapse.
 */
function slugify(name) {
  return (name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/**
 * The stem of this candidate's channel name: the prefix plus their slug.
 *
 * This is deliberately NOT the whole channel name. Luminai's channels carry a
 * role suffix a human wrote (#hiring-ben-choi-fde), and the suffix is an
 * abbreviation nothing can derive: "Forward Deployed Engineer" is "fde" only
 * because somebody typed it that way, and the same job also exists as
 * "Forward Deployed Engineer, Team Lead". So the bot matches on this stem and
 * accepts whatever follows.
 */
function channelNameFor(candidateName) {
  const slug = slugify(candidateName);
  if (!slug) return "";
  return `${config.channelPrefix}${slug}`.slice(0, 80);
}

/**
 * The guard that keeps this bot off every channel that is not a candidate
 * channel. A channel is only ever eligible when the prefix is configured and
 * the channel's own name starts with it.
 */
function isEligibleChannelName(name) {
  if (!config.channelPrefix) return false;
  if (!name) return false;
  if (!name.startsWith(config.channelPrefix)) return false;
  // Carrying the prefix is not enough. A channel on the explicit denylist is
  // never a candidate channel, whatever its name looks like.
  if (config.channelDenylist.has(name.toLowerCase())) return false;
  return true;
}

// conversations.list is slow and rate limited, so the name -> channel map is
// cached for a few minutes and rebuilt on a miss.
let cache = { builtAt: 0, byName: new Map() };

function cacheIsFresh() {
  const ttlMs = config.channelCacheTtlMinutes * 60 * 1000;
  return cache.builtAt > 0 && Date.now() - cache.builtAt < ttlMs;
}

async function buildChannelCache() {
  const byName = new Map();
  let cursor;
  do {
    const res = await slack.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 1000,
      cursor,
    });
    for (const channel of res.channels || []) {
      if (channel.name) byName.set(channel.name, channel);
    }
    cursor = res.response_metadata && res.response_metadata.next_cursor;
  } while (cursor);

  cache = { builtAt: Date.now(), byName };
  console.log(`[slack] Channel cache built: ${byName.size} live channels.`);
  return cache;
}

/**
 * Does this channel name belong to this candidate?
 *
 * The channel is either exactly the stem, or the stem followed by a hyphen and
 * a role suffix. The hyphen is load bearing: without it the stem
 * "hiring-ben-choi" would also swallow a channel belonging to a "Ben Choit".
 */
function channelMatchesStem(name, stem) {
  if (!name || !stem) return false;
  return name === stem || name.startsWith(stem + "-");
}

function collectMatches(stem) {
  const out = [];
  for (const channel of cache.byName.values()) {
    if (channelMatchesStem(channel.name, stem)) out.push(channel);
  }
  return out;
}

/**
 * Every live channel belonging to a candidate. Usually one; zero when the
 * channel was never created or is already archived; more than one when the
 * candidate has a channel per role. The caller decides what to do about that,
 * because this function cannot tell which role the webhook was about.
 */
async function findCandidateChannels(candidateName) {
  const stem = channelNameFor(candidateName);
  if (!stem || !isEligibleChannelName(stem)) return [];

  let justBuilt = false;
  if (!cacheIsFresh()) {
    await buildChannelCache();
    justBuilt = true;
  }

  let matches = collectMatches(stem);

  // A channel created since the cache was built will not be in it, so rebuild
  // once before concluding it does not exist. Skipped when the cache was just
  // built, so a candidate with no channel cannot make every webhook re-list the
  // whole workspace.
  if (matches.length === 0 && !justBuilt) {
    await buildChannelCache();
    matches = collectMatches(stem);
  }
  return matches;
}

function buildClosingNotice({ outcome, candidateName, jobTitle, archiveReasonText, candidateProfileUrl }) {
  const who = candidateName ? `*${candidateName}*` : "This candidate";
  const role = jobTitle ? ` for *${jobTitle}*` : "";
  const lines = [];

  if (outcome === "hired") {
    lines.push(`:tada: ${who} was hired${role}. Congratulations, all!`);
  } else {
    const reason = archiveReasonText ? ` (${archiveReasonText})` : "";
    lines.push(`:books: ${who}'s application${role} was archived in Ashby${reason}.`);
  }

  lines.push("");
  lines.push("Archiving this channel. Nothing is deleted: the history stays searchable, and any member can unarchive it if the process reopens.");

  if (candidateProfileUrl) {
    lines.push("");
    lines.push(`:bust_in_silhouette: <${candidateProfileUrl}|View the Ashby profile>`);
  }
  return lines.join("\n");
}

/** Join a public channel so the bot can post in it. Private channels need an invite. */
async function ensureMembership(channel) {
  if (channel.is_member) return true;
  if (channel.is_private) {
    console.warn(`[slack] #${channel.name} is private and the bot is not a member. Invite it to post there.`);
    return false;
  }
  if (!config.autoJoinPublic) return false;
  try {
    await slack.conversations.join({ channel: channel.id });
    return true;
  } catch (err) {
    console.warn(`[slack] Could not join #${channel.name}: ${err.message}`);
    return false;
  }
}

/**
 * Post the closing notice (when enabled) and archive the channel.
 * Returns { archived, posted, skippedReason }.
 */
async function closeChannel(channel, notice) {
  if (!isEligibleChannelName(channel.name)) {
    return { archived: false, posted: false, skippedReason: "channel name failed the prefix guard" };
  }

  let posted = false;
  if (config.postClosingNotice && notice) {
    const member = await ensureMembership(channel);
    if (member) {
      try {
        await slack.chat.postMessage({ channel: channel.id, text: notice, unfurl_links: false });
        posted = true;
      } catch (err) {
        // A failed notice must not stop the archive, which is the actual job.
        console.warn(`[slack] Could not post the closing notice in #${channel.name}: ${err.message}`);
      }
    }
  }

  try {
    await slack.conversations.archive({ channel: channel.id });
  } catch (err) {
    const code = err.data && err.data.error;
    if (code === "already_archived") {
      console.log(`[slack] #${channel.name} was already archived.`);
      return { archived: true, posted, skippedReason: "" };
    }
    throw err;
  }

  // The channel is gone from the live set, so drop it from the cache.
  cache.byName.delete(channel.name);
  return { archived: true, posted, skippedReason: "" };
}

async function postFallback(text) {
  if (!config.fallbackSlackChannel) return;
  try {
    await slack.chat.postMessage({
      channel: config.fallbackSlackChannel,
      text,
      unfurl_links: false,
    });
  } catch (err) {
    console.warn(`[slack] Could not post to the fallback channel: ${err.message}`);
  }
}

module.exports = {
  slugify,
  channelNameFor,
  isEligibleChannelName,
  channelMatchesStem,
  findCandidateChannels,
  buildClosingNotice,
  closeChannel,
  postFallback,
};
