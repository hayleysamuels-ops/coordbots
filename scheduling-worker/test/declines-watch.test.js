"use strict";
/**
 * The declines Slack poster.
 *
 * Ria does this by hand today. The bot replaces that toil, so the bar is
 * everything her posts carry, including the reason somebody gave.
 *
 * Every test runs against the redacted capture. The bot itself refuses to read
 * it, which is the point: the source gate is a property of the code, so these
 * exercise the parts around it with the reader driven directly.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const bot = require("../bots/declines-watch");
const { _internal } = bot;
const D = require("../lib/declines");
const INV = require("../lib/assignment-inventory");

const SNAPSHOT = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "fixtures", "poetic-interviews-2026-09-07_to_09-18.json"), "utf8"));
const src = fs.readFileSync(path.join(__dirname, "..", "bots", "declines-watch.js"), "utf8");

const NOW = new Date("2026-09-14T17:00:00Z");
const dayOf = (iso) => Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles",
  year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)).replace(/-/g, ""));

const readAll = (o) => D.readDeclines(Object.assign({
  snapshot: SNAPSHOT, personForEmail: INV.personForEmail, dayOf }, o || {}));

/* ---------------- the source gate ---------------- */

test("it cannot be pointed at the fixture, by construction", () => {
  // Not a config choice. There is no parameter that selects a source.
  assert.equal(/fixtures/.test(src), false, "no fixture path anywhere in the bot");
  assert.equal(/readFileSync/.test(src), false, "and it reads no files");
  assert.match(src, /calendar\.getSnapshot\(\{ now \}\)/, "the live feed is the only source");
});

test("a snapshot that is not live posts nothing and says so", () => {
  assert.match(src, /if \(!snapshot \|\| snapshot\.live !== true\)/);
  assert.match(src, /reason: "not_live"/);
  assert.match(src, /This bot never posts from the recorded snapshot/);
  // the flag being on does not authorise posting; the feed does
  assert.match(src, /The flag being on does not authorise posting\. The feed does\./);
});

test("a stale cache posts nothing", () => {
  assert.match(src, /if \(snapshot\.stale\)/);
  assert.match(src, /reason: "stale"/);
});

test("an unreadable calendar posts nothing and names the fault", () => {
  assert.match(src, /reason: "calendar_unavailable"/);
  assert.match(src, /kind: e\.kind \|\| "http"/);
});

/* ---------------- what never posts ---------------- */

test("machine accounts never reach a message", () => {
  // 64 of 85 declines in the capture. If these ever reach Slack the bot is
  // finished, socially.
  const r = readAll();
  assert.equal(r.suppressed, 64);
  r.entries.forEach((e) => e.declines.forEach((d) => {
    assert.equal(/^(forgeaccount|poeticaccount)\d+@/i.test(d.email || ""), false);
  }));
});

test("a session that has already ended never posts", () => {
  assert.match(src, /const live = read\.entries\.filter\(\(e\) => !e\.end \|\| Date\.parse\(e\.end\) > now\.getTime\(\)\)/);
  // and the reader has already dropped whole past days before that
  const past = readAll({ todayDay: 20260917 });
  past.entries.forEach((e) => assert.ok(dayOf(e.start) >= 20260917));
});

test("an event with no ashbyEventId is out of scope", () => {
  assert.match(src, /if \(!entry\.ashbyEventId\) continue;/);
  // 284 of 477 fixture events carry one; the rest are intro chats
  const withIds = SNAPSHOT.events.filter((e) => e.ashbyEventId).length;
  assert.ok(withIds > 0 && withIds < SNAPSHOT.events.length);
});

test("the bot and the rail agree on every tier, on the fixture", () => {
  // One classifier, one truth. If the two disagree that is a bug.
  const r = readAll();
  const tiers = {};
  r.entries.forEach((e) => e.declines.forEach((d) => { tiers[d.kind] = (tiers[d.kind] || 0) + 1; }));
  assert.deepEqual(tiers, { room: 5, human: 15, candidate: 1 },
    "and the human total is still 16 across the two human tiers");
  assert.equal(tiers.human + tiers.candidate, r.humanCount);
  assert.equal(tiers.room, r.roomCount);
});

/* ---------------- the message ---------------- */

const entryFor = (match, opts) => {
  const r = readAll(Object.assign({ todayDay: 20260907 }, opts));
  const e = r.entries.find((x) => match.test(x.summary));
  assert.ok(e, "no entry matching " + match);
  return e;
};

test("a room message names the room in backticks", () => {
  const e = entryFor(/Debrief - Ari Blumkin/);
  const d = e.declines.find((x) => x.kind === "room");
  e.candidateName = "Ari Blumkin"; e.candidateId = "c1"; e.role = "FDS";
  const m = _internal.buildMessage({ entry: e, decline: d, now: NOW,
    trackerBaseUrl: "https://tracker.example" });
  const t = m.blocks[0].text.text;
  assert.match(t, /\*<https:\/\/tracker\.example\/#c=c1\|Ari Blumkin>\* · FDS · Debrief, Tue 15 Sept 17:00/);
  assert.match(t, /No room\. `1 Beach-3-Invariant \(6\) \[Zoom\]` declined\./);
  // a fact about the resource's response, not a claim about the building
  assert.equal(/no room exists|fully booked|at risk/i.test(t), false);
});

test("a main partner message says so, and names the person", () => {
  const e = entryFor(/Build Time - Ahmet Hatip/);
  const d = e.declines.find((x) => /^liam@/i.test(x.email));
  d.kind = "mainPartner"; d.personId = "liam";
  e.candidateName = "Ahmet Hatip"; e.role = "FDE";
  const t = _internal.buildMessage({ entry: e, decline: d, now: NOW }).blocks[0].text.text;
  assert.match(t, /Main partner Liam declined\./);
  assert.equal(/plain/.test(t), false);
});

test("a candidate message says the candidate declined", () => {
  const e = entryFor(/Preston Vaughn/);
  const d = e.declines.find((x) => x.kind === "candidate");
  assert.ok(d, "Preston's decline is the external one");
  e.candidateName = "Preston Vaughn"; e.role = "Sales";
  const t = _internal.buildMessage({ entry: e, decline: d, now: NOW }).blocks[0].text.text;
  assert.match(t, /The candidate declined\./);
  assert.equal(/external-\d+@redacted\.invalid/.test(t), false, "never the raw address");
});

test("any other human declines by name", () => {
  const e = entryFor(/Customer Exec Presentation - Ari Blumkin/);
  const d = e.declines.find((x) => x.kind === "human");
  const t = _internal.buildMessage({ entry: e, decline: d, now: NOW }).blocks[0].text.text;
  assert.match(t, / declined\.$|declined\.\n/);
  assert.match(t, /Ben Mittelberger declined\./);
});

test("THE COMMENT IS CARRIED, verbatim and on its own line", () => {
  // Four live declines read "Declined because I am out of office", and Ria's
  // manual posts append "- OOO" for exactly these. A bot that drops the reason
  // is a downgrade on what it replaces.
  const e = entryFor(/Build Time - Ahmet Hatip/);
  const d = Object.assign({}, e.declines[0], { comment: "Declined because I am out of office" });
  const t = _internal.buildMessage({ entry: e, decline: d, now: NOW }).blocks[0].text.text;
  const lines = t.split("\n");
  assert.equal(lines[2], "Declined because I am out of office", "its own line, untouched");
  assert.equal(/OOO|out sick|reason:/i.test(lines[2].replace("out of office", "")), false,
    "nothing interpreted or added");
  // and absent when there is none
  const without = _internal.buildMessage({ entry: e, decline: e.declines[0], now: NOW });
  assert.equal(without.blocks[0].text.text.split("\n").length, 3);
});

test("every message ends with a time to session", () => {
  assert.equal(_internal.timeToSession("2026-09-14T17:30:00Z", NOW), "in 30 minutes");
  assert.equal(_internal.timeToSession("2026-09-14T20:00:00Z", NOW), "in 3 hours");
  assert.equal(_internal.timeToSession("2026-09-15T17:00:00Z", NOW), "tomorrow");
  assert.equal(_internal.timeToSession("2026-09-17T17:00:00Z", NOW), "in 3 days");
  assert.equal(_internal.timeToSession("2026-09-14T16:00:00Z", NOW), "already started");
});

test("no em dashes and no at-risk language anywhere in the copy", () => {
  const strings = src.match(/"[^"\n]*"/g) || [];
  for (const s of strings) {
    assert.equal(s.includes("—"), false, "em dash: " + s);
    assert.equal(/at risk|in trouble|urgent/i.test(s), false, "overstates: " + s);
  }
});

test("no automatic mentions in v1", () => {
  assert.equal(/<!here>|<!channel>|<@U/.test(src), false,
    "a bot that mentions people on a schedule trains them to mute it");
});

/* ---------------- never twice ---------------- */

test("the dedupe key is the event and the attendee, normalised", () => {
  const k = _internal.seenKey("evt-1", "ANTONY@WithForge.com");
  assert.equal(k, "evt-1|antony@poetic.com", "one person, two domains, one key");
  assert.equal(_internal.seenKey("evt-1", "antony@poetic.com"), k);
  assert.notEqual(_internal.seenKey("evt-2", "antony@poetic.com"), k);
});

test("it posts on a transition INTO declined, not on the state", () => {
  assert.match(src, /const isTransition = was !== "declined";/);
  assert.match(src, /Declined, accepted, declined again IS a new decline\./);
});

test("the record is written before anything is posted", () => {
  // A crash between the two must not repost.
  const i = src.indexOf("for (const w of writes) await botStore.lookupPut");
  const j = src.indexOf("await slack.postMessage");
  assert.ok(i > 0 && j > i, "record first, post second");
});

test("state lives in the run log's store, not in memory", () => {
  assert.match(src, /botStore\.lookupGet\(LOOKUP_KIND, key\)/);
  assert.match(src, /botStore\.lookupPut\(LOOKUP_KIND, w\.key, w\.value\)/);
  assert.equal(_internal.LOOKUP_KIND, "decline_seen");
});

test("KYRO KOHAN: two candidate records, one calendar event, one post", () => {
  /* Two tracker rows exist for one person, cmu2uxgrq23im and cmu2uy7ht1dje,
     both firing the readiness sweep. The dedupe key is the event and the
     attendee, so a duplicate candidate cannot produce a duplicate decline.
     The fixture never had this case, which is why it is asserted rather than
     assumed. */
  const evId = "evt-kyro";
  const a = _internal.seenKey(evId, "liam@poetic.com");
  const b = _internal.seenKey(evId, "liam@poetic.com");
  assert.equal(a, b, "the candidate id is not part of the key, so duplicates collapse");
  assert.equal(/candidateId.*seenKey|seenKey.*candidateId/.test(src), false,
    "and it must never become part of it");
});

/* ---------------- the backfill ---------------- */

test("the first run posts none and records everything", () => {
  assert.match(src, /const absorbed = firstRun \? candidatesToPost\.length : 0;/);
  assert.match(src, /const toPost = firstRun \? \[\] : candidatesToPost;/);
});

test("the first run announces itself once, so silence is not ambiguous", () => {
  // A bot whose correct first behaviour is indistinguishable from a broken one
  // is its own defect.
  assert.match(src, /Decline watch is on\. Reading Poetic Interviews live\. " \+ absorbed \+\s*\n?\s*" existing declines recorded, none reposted\. New declines will appear here\./);
  assert.match(src, /One line, on the absorb run only\. Not a heartbeat\./);
});

test("a batch is capped, most imminent first, and the rest are named", () => {
  assert.equal(_internal.MAX_POSTS_PER_RUN, 8);
  assert.match(src, /toPost\.sort\(\(a, b\) => String\(a\.entry\.start\)\.localeCompare\(String\(b\.entry\.start\)\)\)/);
  assert.match(src, /not posted to keep this readable\. They are on the rail\./);
});

/* ---------------- registration ---------------- */

test("the bot is registered and needs its own credentials", () => {
  const botsSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "bots.js"), "utf8");
  assert.match(botsSrc, /require\("\.\.\/bots\/declines-watch"\)/);
  assert.deepEqual(bot.requires,
    ["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID", "GOOGLE_CAL_SA_KEY_B64", "POETIC_CALENDAR_ID"]);
  assert.deepEqual(bot.dryRequires, ["GOOGLE_CAL_SA_KEY_B64", "POETIC_CALENDAR_ID"]);
  assert.equal(bot.requires.includes("GOOGLE_SA_KEY_B64"), false, "not the sheet reader's key");
  assert.equal(bot.defaults.enabled, true);
  assert.equal(bot.defaults.dryRun, false);
});
