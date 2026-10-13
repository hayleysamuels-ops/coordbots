"use strict";
/**
 * Channel-name derivation and the prefix guard. The guard is the only thing
 * standing between a bad candidate name and an archived #general, so it is
 * tested from both directions.
 */
process.env.CANDIDATE_CHANNEL_PREFIX = "cand-";
// Luminai really does have #hiring-nyc-event sitting in the candidate-channel
// namespace, which is why the denylist exists. Spelled with this file's prefix.
process.env.CHANNEL_DENYLIST = "cand-nyc-event, #Cand-Team-Standup";
process.env.ASHBY_WEBHOOK_SECRET = "test-secret";
process.env.SLACK_BOT_TOKEN = "xoxb-test";

const { test } = require("node:test");
const assert = require("node:assert");

const {
  slugify,
  channelNameFor,
  isEligibleChannelName,
  channelMatchesStem,
  buildClosingNotice,
} = require("../src/slack");

test("a plain name becomes a hyphenated slug", () => {
  assert.equal(slugify("Jane Smith"), "jane-smith");
});

test("accents are folded to ASCII", () => {
  assert.equal(slugify("Zoë Müller"), "zoe-muller");
});

test("punctuation and double spaces collapse to single hyphens", () => {
  assert.equal(slugify("Mary-Jane  O'Connor, Jr."), "mary-jane-o-connor-jr");
});

test("a name with nothing sluggable yields an empty slug, and so no channel name", () => {
  assert.equal(slugify("!!!"), "");
  assert.equal(channelNameFor("!!!"), "");
});

test("the channel name is the prefix plus the slug", () => {
  assert.equal(channelNameFor("Jane Smith"), "cand-jane-smith");
});

test("channel names are capped at Slack's 80 character limit", () => {
  const name = channelNameFor("Bartholomew ".repeat(12));
  assert.ok(name.length <= 80, `expected <= 80 chars, got ${name.length}`);
});

test("only channels carrying the prefix are eligible", () => {
  assert.equal(isEligibleChannelName("cand-jane-smith"), true);
  assert.equal(isEligibleChannelName("general"), false);
  assert.equal(isEligibleChannelName("hiring-cand-jane-smith"), false);
  assert.equal(isEligibleChannelName(""), false);
  assert.equal(isEligibleChannelName(undefined), false);
});

/* --------------------------------------------------------------- copy */

test("the hired notice names the candidate and role", () => {
  const text = buildClosingNotice({
    outcome: "hired",
    candidateName: "Jane Smith",
    jobTitle: "Product Engineer",
    candidateProfileUrl: "https://app.ashbyhq.com/candidates/c1",
  });
  assert.match(text, /Jane Smith/);
  assert.match(text, /Product Engineer/);
  assert.match(text, /hired/);
});

test("the archived notice includes the archive reason when Ashby sent one", () => {
  const text = buildClosingNotice({
    outcome: "archived",
    candidateName: "Jane Smith",
    jobTitle: "Product Engineer",
    archiveReasonText: "Rejected after onsite",
  });
  assert.match(text, /Rejected after onsite/);
  assert.match(text, /archived/);
});

test("the notice says the history survives, so the channel does not look deleted", () => {
  const text = buildClosingNotice({ outcome: "archived", candidateName: "Jane Smith" });
  assert.match(text, /searchable/);
  assert.match(text, /unarchive/);
});

test("Carrara copy carries no em dashes", () => {
  for (const outcome of ["hired", "archived"]) {
    const text = buildClosingNotice({
      outcome,
      candidateName: "Jane Smith",
      jobTitle: "Product Engineer",
      archiveReasonText: "Rejected after onsite",
      candidateProfileUrl: "https://app.ashbyhq.com/candidates/c1",
    });
    assert.ok(!text.includes("—"), `em dash in the ${outcome} notice`);
  }
});

/**
 * Stem matching. Real candidate channels carry a role suffix a human wrote
 * (#hiring-ben-choi-fde), so an exact-name lookup finds nothing. These tests
 * pin the matching rule, including the hyphen that stops one candidate's stem
 * swallowing another's channel.
 */

test("a channel with a role suffix matches the stem", () => {
  assert.ok(channelMatchesStem("cand-ben-choi-fde", "cand-ben-choi"));
});

test("a channel with no suffix matches the stem exactly", () => {
  assert.ok(channelMatchesStem("cand-ben-choi", "cand-ben-choi"));
});

test("a multi-part role suffix still matches", () => {
  assert.ok(channelMatchesStem("cand-ben-choi-fde-new-grad", "cand-ben-choi"));
});

test("a longer name is not swallowed by a shorter one's stem", () => {
  // The bug the hyphen prevents: Ben Choit is not Ben Choi.
  assert.ok(!channelMatchesStem("cand-ben-choit-pm", "cand-ben-choi"));
  assert.ok(!channelMatchesStem("cand-ben-choix", "cand-ben-choi"));
});

test("a different candidate does not match", () => {
  assert.ok(!channelMatchesStem("cand-jane-smith-fde", "cand-ben-choi"));
});

test("an empty stem matches nothing", () => {
  // Belt and braces: an unset prefix must never make every channel eligible.
  assert.ok(!channelMatchesStem("cand-ben-choi-fde", ""));
  assert.ok(!channelMatchesStem("general", ""));
});

test("an empty channel name matches nothing", () => {
  assert.ok(!channelMatchesStem("", "cand-ben-choi"));
});

test("the stem is the prefix plus the slug, with no role suffix invented", () => {
  assert.equal(channelNameFor("Ben Choi"), "cand-ben-choi");
});

/* ----------------------------------------------------------- denylist */

test("a denylisted channel is not eligible even though it carries the prefix", () => {
  assert.equal(isEligibleChannelName("cand-nyc-event"), false);
});

test("the denylist is matched case-insensitively and ignores a leading hash", () => {
  assert.equal(isEligibleChannelName("cand-team-standup"), false);
});

test("denylisting one channel does not affect real candidate channels", () => {
  assert.equal(isEligibleChannelName("cand-alicia-graham-strategy-lead"), true);
});

test("a candidate whose name collides with a denylisted channel cannot close it", () => {
  // "Nyc Event" slugs straight onto the event channel's name.
  assert.equal(channelNameFor("Nyc Event"), "cand-nyc-event");
  assert.equal(isEligibleChannelName(channelNameFor("Nyc Event")), false);
});
