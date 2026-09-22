"use strict";
/**
 * Bot 3 — readiness sweep.
 *
 * For every candidate with a trial coming up, post what is still not done. Only
 * the red items: green never appears, and if nothing is red nothing is posted.
 * This is the monitoring a coordinator does by hand today.
 *
 * Fires at T-72h and T-24h. A trial booked inside 72h fires on detection rather
 * than being skipped — its T-72 moment has already passed but is still owed,
 * and that is the case that actually bites.
 *
 * T-24 EDITS the T-72 message rather than posting again, so the channel shows
 * one list burning down instead of three copies. At most two posts per
 * candidate, which the notice table enforces structurally: there are only two
 * milestones, the table is keyed on (candidate, milestone), and a post only
 * happens when no message exists yet.
 *
 * That key used to include the derived trial start, which broke the guarantee
 * the moment any event moved — see the readiness_notice comment in
 * lib/botstore.js. A rescheduled trial now EDITS the existing message and
 * labels it as rescheduled, rather than starting a second thread of posts.
 */
const CONFIG = require("./readiness-sweep.config");
const EFFECTIVE = require("../lib/effective");
const { mapLimit } = require("../lib/http");
// For isBlankFor only: the laptop and desk check tests two sheet-owned fields
// against the sheet's own definition of an empty cell.
const SHEET = require("./sheet-sync.config");

const NAME = "readiness-sweep";
// Same cap as the tracker's panel prefetch. A tracker with thirty linked rows
// fetched one at a time can run past its own fifteen-minute slot.
const CONCURRENCY = 3;

/* ---------------- time ---------------- */
/** PT offset for a given instant, so a date-only row gets a sane clock time. */
function ptOffsetMinutes(date) {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", timeZoneName: "shortOffset",
  }).format(date);
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(s);
  if (!m) return -480;
  return Number(m[1]) * 60 + (m[1].startsWith("-") ? -Number(m[2] || 0) : Number(m[2] || 0));
}

/** When does this trial actually start? */
function trialStartAt(candidate, entry) {
  // A linked row has a real clock time from Ashby.
  if (EFFECTIVE.covers(entry, "startDate", candidate)) {
    const iso = entry.panel.trialStart;
    if (iso) return { at: new Date(iso), precise: true, key: iso };
    /* The panel covers this date and has none, which since 14 Sep means Ashby
       actively says the trial is not scheduled: cancelled, or waiting to be
       booked. That is an answer, not a gap, so it must NOT fall through to a
       stored date from before it was cancelled. Doing so posted T-72 and T-24
       reminders about trials that were not happening. */
    return null;
  }
  // Otherwise a stored date with no time. Trials start in the morning.
  const day = (candidate.values || {}).startDate;
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const guess = new Date(day + "T12:00:00Z");
  const off = ptOffsetMinutes(guess);
  const at = new Date(Date.parse(day + "T00:00:00Z") - off * 60000 +
    (CONFIG.assumedStartHourPT || 9) * 3600000);
  return { at, precise: false, key: day };
}

/* ---------------- checks ---------------- */
const applies = (check, position) => !check.roles || check.roles.indexOf(position) >= 0;

function isDone(check, value) {
  for (const d of check.done) {
    if (d === "*") {
      /* "any non-empty text", except where the check names a placeholder
         vocabulary. A desk reading "NOT YET" is absence written down, and
         counting it as an assignment is a green light for a thing nobody did.
         Only checks that opt in with blankAlso are affected; every other "*"
         check behaves exactly as before. */
      if (check.blankAlso) { if (!SHEET.isBlankFor(value, check)) return true; }
      else if (String(value == null ? "" : value).trim() !== "") return true;
    }
    else if (d === true) { if (value === true) return true; }
    else if (value === d) return true;
  }
  return false;
}

/** The keys a check reads. One by default; a few read several. */
const keysOf = (check) => check.keys || [check.key];

/**
 * A check over several keys is done only when every one of them is. Used by
 * the laptop and desk item, which reads the two values bot 10 syncs rather
 * than the status somebody has to remember to flip.
 */
function isDoneAll(check, values) {
  return keysOf(check).every((k) => isDone(check, values[k]));
}

/** Why it is red, in words a coordinator can act on. */
function redDetail(check, value) {
  const v = value === true ? "done" : String(value == null ? "" : value).trim();
  if (check.done[0] === "*") return "not named";
  if (check.done[0] === true) return "not ticked";
  if (!v) return "not set";
  return v.toLowerCase();
}

/** The same, for a check reading several keys: say which ones are missing. */
function redDetailAll(check, values) {
  const keys = keysOf(check);
  if (keys.length === 1) return redDetail(check, values[keys[0]]);
  const missing = keys.filter((k) => !isDone(check, values[k]));
  return missing.map((k) => (check.missingLabel || {})[k] || k).join(" and ");
}

function evaluate({ candidate, entry, position }) {
  const stored = candidate.values || {};
  const reds = [];
  for (const check of CONFIG.checks) {
    if (!applies(check, position)) continue;
    /* Every key the check reads, each through the precedence chain. A panel
       answer still wins where PANEL_COVERS says so, exactly as before. */
    const values = {};
    for (const k of keysOf(check)) {
      values[k] = EFFECTIVE.resolve(candidate, k, entry, stored[k]);
    }
    if (!isDoneAll(check, values)) {
      reds.push({ key: check.key, label: check.label, detail: redDetailAll(check, values) });
    }
  }
  return reds;
}

/**
 * Sessions inside the trial that are not actually booked.
 *
 * The original idea was "an event with an unfilled interviewer slot", but that
 * does not exist in the data — across 389 real events, every one had an
 * interviewer. What does exist is schedule status, and the two states mean
 * different things to different people, so they are worded differently:
 *   NeedsScheduling           -> a coordinator has to book it
 *   WaitingOnCandidateBooking -> the candidate has to book it; this is a chase
 */
function sessionReds(schedules, stageId) {
  const onStage = schedules.filter((s) => s.interviewStageId === stageId);
  const needs = onStage.filter((s) => s.status === "NeedsScheduling").length;
  const waiting = onStage.filter((s) => s.status === "WaitingOnCandidateBooking").length;
  const out = [];
  if (needs) out.push({ key: "needsScheduling",
    label: needs + (needs > 1 ? " work-trial sessions still need" : " work-trial session still needs") + " scheduling",
    detail: "ours to book" });
  if (waiting) out.push({ key: "waitingOnCandidate",
    label: waiting + (waiting > 1 ? " sessions waiting" : " session waiting") + " on the candidate to book",
    detail: "chase the candidate" });
  return out;
}

/* ---------------- message ---------------- */
function rowUrl(candidateId) {
  return String(CONFIG.trackerBaseUrl || "").replace(/\/+$/, "") + "/#c=" + encodeURIComponent(candidateId);
}

function buildMessage({ candidate, position, startAt, precise, reds, milestone, rescheduled }) {
  const fmt = (d) => new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Los_Angeles", weekday: "short", day: "numeric",
    month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  const when = fmt(startAt);
  const url = rowUrl(candidate.id);
  const mention = CONFIG.onShiftSlackUserId ? "<@" + CONFIG.onShiftSlackUserId + "> " : "";

  const movedFrom = rescheduled && !isNaN(new Date(rescheduled))
    ? " _(rescheduled, was " + fmt(new Date(rescheduled)) + ")_"
    : rescheduled ? " _(rescheduled)_" : "";

  const header = "*" + candidate.name + "* · " + (position || "—") + " · trial " + when +
    (precise ? "" : " _(date only, assumed 09:00)_") + movedFrom;
  const lines = reds.map((r) => "• <" + url + "|" + r.label + "> " + r.detail);

  return {
    text: mention + candidate.name + ": " + reds.length + " item(s) outstanding before the trial",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: mention + header } },
      { type: "section", text: { type: "mrkdwn",
          text: "*Still outstanding* _(" + milestone + ")_\n" + lines.join("\n") } },
      { type: "context", elements: [{ type: "mrkdwn",
          text: reds.length + " red · updated " + new Intl.DateTimeFormat("en-GB", {
            timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false,
          }).format(new Date()) + " PT" }] },
    ],
  };
}

/* ---------------- the sweep ---------------- */
async function run(ctx) {
  const { ashby, slack, channelId, botStore, panelFor, getCandidates,
          dryRun, now = new Date(), log = console.log } = ctx;

  const candidates = await getCandidates();
  const results = [];

  // Phase 1 — panels, three at a time. Cached 15 minutes, so this is usually
  // cheap, but a cold tracker fetched serially is what runs past the slot.
  const withPanels = await mapLimit(candidates, CONCURRENCY, async (c) => {
    const linked = (c.values || {}).ashbyCandidateId;
    let entry = null;
    if (linked && panelFor) {
      try { entry = await panelFor(linked); } catch (e) { entry = null; }
    }
    return { c, entry, linked };
  });

  // Phase 2 — who is owed a milestone. Cheap, local, and deliberately serial.
  const due = [];
  for (const { c, entry, linked } of withPanels) {
    const start = trialStartAt(c, entry);
    if (!start) continue;                                   // no date at all
    if (start.at.getTime() <= now.getTime()) continue;      // trial already begun

    // Every milestone this candidate has already been spoken to about, at any
    // date. Not scoped to the current trial_start: that is what let a reschedule
    // buy a fresh set of posts.
    const notices = await botStore.noticesFor(c.id);
    const handled = new Set(notices.map((n) => n.milestone));
    const hoursOut = (start.at.getTime() - now.getTime()) / 3600000;
    const owed = (CONFIG.milestones || []).filter(
      (m) => hoursOut <= m.hoursBefore && !handled.has(m.key)
    );
    if (!owed.length) continue;
    due.push({ c, entry, linked, start, notices, owed });
  }

  // Phase 3 — schedules, only for those actually owed a message, three at a
  // time. Fetching these for every candidate would waste most of the calls.
  const prepared = await mapLimit(due, CONCURRENCY, async (d) => {
    let sessions = [];
    if (d.linked && d.entry && d.entry.panel && d.entry.panel.applicationId) {
      try {
        const schedules = await ashby.listSchedulesForApplication(d.entry.panel.applicationId);
        sessions = sessionReds(schedules, d.entry.panel.workTrialStageId || null);
      } catch (e) {
        log("[" + NAME + "] schedule read failed for " + d.c.name + ": " + e.message);
      }
    }
    return { ...d, sessions };
  });

  // Phase 4 — decide and speak. Serial on purpose: posting order should be
  // stable, and the notice writes must not race each other.
  for (const { c, entry, start, notices, owed, sessions } of prepared) {
    // The closest milestone owed is the one we speak as. Every earlier one that
    // has also passed is marked handled in the same breath — otherwise a trial
    // detected inside 24h would report T-24 now and then re-report T-72 on the
    // next tick, which is a second post rather than one list burning down.
    const milestone = owed[owed.length - 1].key;

    // A DRY RUN MUST NOT CONSUME A MILESTONE.
    //
    // Recording a notice is what marks a milestone spoken for: the next live
    // run finds it handled and stays silent, for good. Doing that from a dry
    // run means a preview silently decides that a real message will never be
    // sent — the bot goes quiet and looks like it is working. It also makes
    // dry-run unsafe as the thing it exists to be: the way you check what the
    // bot would say before letting it say it.
    //
    // So this is a no-op in dry run, and the same candidates are re-evaluated
    // on the next tick. Re-evaluating is exactly what a preview should do.
    const settle = async (ts, redCount) => {
      if (dryRun) return;
      for (const m of owed) await botStore.recordNotice(c.id, m.key, start.key, ts, redCount);
    };

    // Did the trial move since we last spoke about this candidate? The edit
    // says so, otherwise a header date silently changing under a message is
    // indistinguishable from the bug this replaced.
    const priorStart = (notices.find((n) => n.trialStart) || {}).trialStart || null;
    const rescheduled = priorStart && priorStart !== start.key ? priorStart : null;

    const position = EFFECTIVE.resolve(c, "position", entry, (c.values || {}).position);
    const reds = evaluate({ candidate: c, entry, position }).concat(sessions);

    if (!reds.length) {
      // Nothing red: post nothing, but remember the milestone passed so it is
      // not re-evaluated every fifteen minutes. In dry run settle() is a no-op,
      // so this costs a re-evaluation per tick and consumes nothing.
      await settle(null, 0);
      results.push({ candidate: c.name, milestone, reds: 0, action: "nothing to say" });
      continue;
    }

    const msg = buildMessage({ candidate: c, position, startAt: start.at,
      precise: start.precise, reds, milestone, rescheduled });
    const existingTs = (notices.find((n) => n.slackTs) || {}).slackTs || null;

    if (dryRun) {
      await settle(existingTs, reds.length);
      results.push({ candidate: c.name, milestone, reds: reds.length,
        action: existingTs ? "would edit" : "would post",
        items: reds.map((r) => r.label + ": " + r.detail), message: msg });
      continue;
    }

    if (existingTs) {
      await slack.updateMessage({ channel: channelId, ts: existingTs, text: msg.text, blocks: msg.blocks });
      await settle(existingTs, reds.length);
      results.push({ candidate: c.name, milestone, reds: reds.length, action: "edited", ts: existingTs });
    } else {
      const posted = await slack.postMessage({ channel: channelId, text: msg.text, blocks: msg.blocks });
      await settle(posted.ts, reds.length);
      results.push({ candidate: c.name, milestone, reds: reds.length, action: "posted", ts: posted.ts });
    }
  }

  const acted = results.filter((r) => r.action !== "nothing to say");
  return {
    outcome: dryRun ? "dry_run" : "ok",
    summary: { candidatesChecked: candidates.length, acted: acted.length, results },
    message: acted.length ? { previews: acted.map((r) => r.message).filter(Boolean) } : null,
  };
}

module.exports = {
  name: NAME,
  title: "Readiness sweep",
  description: "Posts what is still not done before a work trial, at T-72h and T-24h.",
  schedule: { timeZone: "America/Los_Angeles", everyMinutes: CONFIG.everyMinutes || 15 },
  defaults: { enabled: true, dryRun: true },
  run,
  _internal: { evaluate, trialStartAt, sessionReds, isDone, isDoneAll, redDetailAll, buildMessage },
};
