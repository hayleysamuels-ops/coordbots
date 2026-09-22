"use strict";
/**
 * Posts work trial declines to #poetic-rc-team as they are detected.
 *
 * Same reader and same classifier as the rail, so the two cannot disagree
 * about what a decline is. This module adds output and memory, nothing else.
 *
 * IT CANNOT POST FROM THE FIXTURE, and that is a property of the code rather
 * than a config choice. fetchLive() is the only source it will read, and a
 * snapshot without live:true is refused. Posting is authorised by the feed it
 * actually read, not by the flag being set: if those two disagree the bot
 * stays silent and says so in the run log.
 *
 * Ria does this by hand today. This replaces that toil; it is not a new
 * notification stream and should not read like one.
 */
const DECLINES = require("../lib/declines");
const INVENTORY = require("../lib/assignment-inventory");
const calendar = require("../lib/calendar");

const NAME = "declines-watch";
const LOOKUP_KIND = "decline_seen";
/* A channel that receives forty messages at once gets muted, and then the tool
   is worse than nothing. */
const MAX_POSTS_PER_RUN = 8;

/* ---------------- keys and state ---------------- */

/** One attendee on one session. The transition is tracked per pair. */
function seenKey(ashbyEventId, email) {
  return String(ashbyEventId) + "|" + DECLINES.normaliseAddress(email);
}

/* ---------------- copy ---------------- */

const fmtPT = (iso, opts) =>
  new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: "America/Los_Angeles" }, opts))
    .format(new Date(iso));

/** "Tue 15 Sept 17:00", in the office's time. */
function sessionWhen(iso) {
  return fmtPT(iso, { weekday: "short", day: "numeric", month: "short" }) + " " +
         fmtPT(iso, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * How long until it starts, so a reader can triage without arithmetic.
 * Deliberately coarse: an exact countdown implies a precision that a calendar
 * entry somebody may already have moved does not have.
 */
function timeToSession(startIso, now) {
  const ms = Date.parse(startIso) - now.getTime();
  if (!isFinite(ms)) return "";
  if (ms < 0) return "already started";
  const mins = Math.round(ms / 60000);
  if (mins < 90) return "in " + Math.max(1, Math.round(mins / 5) * 5) + " minutes";
  const hours = Math.round(mins / 60);
  if (hours < 24) return "in " + hours + " hour" + (hours === 1 ? "" : "s");
  const days = Math.round(hours / 24);
  if (days === 1) return "tomorrow";
  return "in " + days + " days";
}

/** The session name, without the candidate and role the summary repeats. */
function sessionName(summary) {
  const s = String(summary || "").replace(/^[A-Z]{2,4} WT:\s*/, "");
  const cut = s.indexOf(" - ");
  return (cut > 0 ? s.slice(0, cut) : s).trim() || "Session";
}

function rowUrl(base, candidateId) {
  return String(base || "").replace(/\/+$/, "") + "/#c=" + encodeURIComponent(candidateId);
}

/**
 * One message, matching the Work Trial Bots house style already in the
 * channel: bold name, middot separators, a tracker deep link, a quiet footer.
 *
 * It reports what the calendar says. It does not know why anybody declined and
 * never suggests one, and it never says a session is at risk.
 */
function buildMessage({ entry, decline, now, trackerBaseUrl }) {
  const who = entry.candidateName || entry.summary;
  const head = entry.candidateId && trackerBaseUrl
    ? "*<" + rowUrl(trackerBaseUrl, entry.candidateId) + "|" + who + ">*"
    : "*" + who + "*";
  const role = entry.role ? " · " + entry.role : "";
  const line1 = head + role + " · " + sessionName(entry.summary) + ", " + sessionWhen(entry.start);

  let line2;
  if (decline.kind === "room") {
    /* A fact about the resource's response, not a claim that no room exists. */
    line2 = "No room. `" + decline.label + "` declined.";
  } else if (decline.kind === "mainPartner") {
    line2 = "Main partner " + declineWho(decline) + " declined.";
  } else if (decline.kind === "candidate") {
    line2 = "The candidate declined.";
  } else {
    line2 = declineWho(decline) + " declined.";
  }

  const lines = [line1, line2];
  /* The reason, verbatim, with nothing added. Four live declines carry
     "Declined because I am out of office", and Ria's manual posts append
     "- OOO" for exactly these. A bot that drops it is a downgrade on what it
     replaces. */
  if (decline.comment) lines.push(String(decline.comment));
  lines.push("_" + timeToSession(entry.start, now) + "_");

  const text = who + ": " + line2;
  return {
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }],
  };
}

/** A person by name where the inventory knows them, by address where it does not. */
function declineWho(d) {
  if (d.personId) {
    const n = INVENTORY.displayName(d.personId);
    if (n) return n;
  }
  return d.label;
}

/* ---------------- the run ---------------- */

async function run(ctx) {
  const { slack, channelId, botStore, dryRun, now = new Date(), log = console.log } = ctx;
  const trackerBaseUrl = process.env.TRACKER_BASE_URL || "";

  /* THE SOURCE GATE. Only the live feed, and only when it says so. There is no
     parameter here that could point this at the fixture. */
  let snapshot;
  try {
    snapshot = await calendar.getSnapshot({ now });
  } catch (e) {
    return {
      outcome: "skipped",
      summary: { reason: "calendar_unavailable", kind: e.kind || "http" },
      message: { text: "Declines watch: the calendar could not be read (" +
        (e.kind || "http") + "), so nothing was posted. " + e.message },
    };
  }
  if (!snapshot || snapshot.live !== true) {
    /* The flag being on does not authorise posting. The feed does. */
    return {
      outcome: "skipped",
      summary: { reason: "not_live" },
      message: { text: "Declines watch: the calendar feed is not live, so nothing was posted. " +
        "This bot never posts from the recorded snapshot." },
    };
  }
  if (snapshot.stale) {
    return {
      outcome: "skipped",
      summary: { reason: "stale", ageMs: snapshot.stale.ageMs },
      message: { text: "Declines watch: the last calendar refresh failed, so the data may be " +
        "out of date and nothing was posted." },
    };
  }

  /* Candidates, for the name, the role and the deep link. */
  const candidates = await (ctx.getCandidates || (async () => []))();
  const eventIndex = {};
  const roleOf = {};
  for (const c of candidates) {
    const link = (c.values || {}).ashbyCandidateId;
    if (!link || !ctx.panelFor) continue;
    let entry = null;
    try { entry = await ctx.panelFor(link); } catch (e) { entry = null; }
    const ids = entry && entry.panel && entry.panel.interviewEventIds;
    if (!ids) continue;
    roleOf[c.id] = (c.values || {}).position || null;
    for (const id of ids) eventIndex[id] = { id: c.id, name: c.name || "Unnamed" };
  }

  const dayOf = (iso) => {
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
    return Number(d.replace(/-/g, ""));
  };
  const todayDay = dayOf(now.toISOString());

  const read = DECLINES.readDeclines({
    snapshot, eventIndex, todayDay, dayOf,
    personForEmail: INVENTORY.personForEmail,
    mainPartnerFor: (candidateId) => {
      const c = candidates.filter((x) => x.id === candidateId)[0];
      if (!c) return null;
      return INVENTORY.personFor((c.values || {}).driName);
    },
  });

  /* Sessions that have already ended never post: nobody can act on them. */
  const live = read.entries.filter((e) => !e.end || Date.parse(e.end) > now.getTime());

  /* What is new, by transition INTO declined. */
  const candidatesToPost = [];
  const writes = [];
  let firstRun = true;
  for (const entry of live) {
    entry.role = entry.candidateId ? roleOf[entry.candidateId] || null : null;
    for (const d of entry.declines) {
      if (!entry.ashbyEventId) continue;   // non-work-trial events are out of scope
      const key = seenKey(entry.ashbyEventId, d.email);
      const prev = await botStore.lookupGet(LOOKUP_KIND, key);
      if (prev) firstRun = false;
      const was = prev && prev.status;
      /* Declined, accepted, declined again IS a new decline. Declined twice in
         a row is not. */
      const isTransition = was !== "declined";
      writes.push({ key, value: { status: "declined", at: now.toISOString() } });
      if (isTransition) candidatesToPost.push({ entry, decline: d, key });
    }
  }

  /* THE BACKFILL. A first run sees everything at once and must post none of
     it. Absorbed, counted, and announced once so there is a timestamp in the
     channel saying the thing started: a bot whose correct first behaviour is
     indistinguishable from a broken one is its own defect. */
  const absorbed = firstRun ? candidatesToPost.length : 0;
  const toPost = firstRun ? [] : candidatesToPost;

  /* Most imminent first, and capped. */
  toPost.sort((a, b) => String(a.entry.start).localeCompare(String(b.entry.start)));
  const posting = toPost.slice(0, MAX_POSTS_PER_RUN);
  const suppressed = toPost.length - posting.length;

  const summary = {
    live: true,
    fetchedAt: snapshot.fetchedAt,
    sessions: live.length,
    declines: live.reduce((n, e) => n + e.declines.length, 0),
    machineSuppressed: read.suppressed,
    unresolved: read.unresolved,
    firstRun,
    absorbed,
    posted: 0,
    capSuppressed: suppressed,
  };

  if (dryRun) {
    return {
      outcome: "ok",
      summary,
      message: { text: "Declines watch (dry run): " +
        (firstRun ? absorbed + " existing declines would be absorbed, none posted."
                  : posting.length + " would post, " + suppressed + " held by the cap.") },
    };
  }

  /* Record before posting. A crash between the two must not repost. */
  for (const w of writes) await botStore.lookupPut(LOOKUP_KIND, w.key, w.value);

  if (firstRun) {
    /* One line, on the absorb run only. Not a heartbeat. */
    if (slack && channelId && absorbed >= 0) {
      await slack.postMessage({ channel: channelId,
        text: "Decline watch is on. Reading Poetic Interviews live. " + absorbed +
          " existing declines recorded, none reposted. New declines will appear here." });
    }
    log("[" + NAME + "] first run: absorbed " + absorbed + " existing declines, posted none");
    return { outcome: "ok", summary,
      message: { text: "Decline watch is on. " + absorbed + " existing declines recorded, none reposted." } };
  }

  for (const p of posting) {
    const msg = buildMessage({ entry: p.entry, decline: p.decline, now, trackerBaseUrl });
    if (slack && channelId) await slack.postMessage({ channel: channelId, text: msg.text, blocks: msg.blocks });
    summary.posted++;
  }
  if (suppressed && slack && channelId) {
    await slack.postMessage({ channel: channelId,
      text: suppressed + " more decline" + (suppressed === 1 ? "" : "s") +
        " not posted to keep this readable. They are on the rail." });
  }

  return {
    outcome: "ok",
    summary,
    message: { text: summary.posted + " decline" + (summary.posted === 1 ? "" : "s") + " posted" +
      (suppressed ? ", " + suppressed + " held by the cap" : "") + "." },
  };
}

module.exports = {
  name: NAME,
  title: "Declines watch",
  description:
    "Posts work trial declines to the channel as they are detected: rooms, main partners, " +
    "candidates and any other human. Machine laptop accounts never post, sessions that have " +
    "ended never post, and nothing posts twice. Reads the live calendar only, and refuses to " +
    "post from the recorded snapshot.",
  schedule: { timeZone: "America/Los_Angeles", everyMinutes: 10 },
  defaults: { enabled: true, dryRun: false },
  requires: ["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID", "GOOGLE_CAL_SA_KEY_B64", "POETIC_CALENDAR_ID"],
  dryRequires: ["GOOGLE_CAL_SA_KEY_B64", "POETIC_CALENDAR_ID"],
  run,
  _internal: { seenKey, sessionWhen, timeToSession, sessionName, buildMessage, declineWho,
               MAX_POSTS_PER_RUN, LOOKUP_KIND },
};
