"use strict";
/**
 * Bot 1 — live Ashby panel.
 *
 * Reads Ashby and returns the machine-knowable half of a work-trial row. It
 * NEVER writes: not to Ashby, and not to the tracker. The candidate-to-Ashby
 * link is stored on the tracker row itself, written by the coordinator's own
 * click through the ordinary candidate save path.
 *
 * Four states, and the distinctions matter:
 *
 *   live              fetched successfully
 *   stale             Ashby unreachable — last cached values, with their age
 *   notLinked         no ashbyCandidateId on the row
 *   linkedNotFound    the stored id no longer resolves (Poetic merges duplicate
 *                     candidate records routinely, which retires an id). This is
 *                     a definite answer from Ashby, not an outage, and the fix is
 *                     to re-link — so it must never look like "stale" or blank.
 *
 * A blank panel must never be readable as "nothing is scheduled".
 */
const CONFIG = require("./ashby-panel.config");
const PRE_TRIAL = require("./pre-trial-sessions.config");
const { mapLimit } = require("../lib/http");
const { deriveTrialWindow } = require("../lib/trialwindow");
const { createTitleResolver } = require("../lib/interviewtitles");

const NAME = "ashby-panel";
const CONCURRENCY = 5;

const norm = (s) => String(s || "").trim().toLowerCase();
const has = (haystack, needle) => norm(haystack).includes(norm(needle));

/**
 * Is this session the debrief?
 *
 * ASHBY'S OWN FLAG, AND NOTHING ELSE. There used to be a substring fallback on
 * the title, documented as "used only if Ashby's isDebrief flag is absent". It
 * could never behave that way: lib/interviewtitles.js coerced the flag with
 * !!iv.isDebrief, so "Ashby did not say" and "Ashby said no" arrived here as
 * the same false, and the fallback fired on an explicit no.
 *
 * What it cost: the FDS work trial plan contains a session called
 * "FDS WT: Runbook QA Debrief" with isDebrief false. It is part of the trial,
 * not the debrief. The substring matched it, so every FDS candidate scheduled
 * from that plan reported a debrief already booked. Nine applications carried
 * it. No debrief was actually missed — all nine had a real one too — but the
 * reminder to book it was silently switched off, and Ari Blumkin's real
 * debrief was created by a person two days before the trial with no prompt
 * from the sweep.
 *
 * Title text is not a reliable signal for this and the workspace proves it:
 * exactly one interview carries isDebrief, and the string "debrief" appears in
 * a session that is not one. If the flag ever goes missing the field reads NO
 * and the sweep over-reports, which is the safe direction to fail.
 */
function isDebriefSession(t) {
  return !!(t && t.isDebrief);
}

/* ---------------- cached id -> title lookups ---------------- */
// Interview titles now come from lib/interviewtitles.js, shared with the
// suggestion strip: both consumers classify sessions, so both need the titles.

async function stageTitle(ashby, botStore, stageId) {
  const hit = await botStore.lookupGet("stage", stageId);
  if (hit) return hit;
  const st = await ashby.getInterviewStage(stageId);
  const value = { title: st.title || "" };
  await botStore.lookupPut("stage", stageId, value);
  return value;
}

/* ---------------- helpers ---------------- */
function mapPosition(jobTitle) {
  for (const rule of CONFIG.positions || []) {
    if (has(jobTitle, rule.jobTitleContains)) return rule.position;
  }
  return null;
}

/** Which of a candidate's applications is the work trial one? */
function pickApplication(apps) {
  const withPos = apps.filter((a) => mapPosition((a.job || {}).title));
  const pool = withPos.length ? withPos : apps;
  const activeFirst = pool.filter((a) => a.status !== "Archived");
  const chosen = (activeFirst.length ? activeFirst : pool).slice().sort(
    (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)
  );
  return chosen[0] || null;
}

const liveSchedules = (schedules) => schedules.filter((s) => s.status !== "Cancelled");

// There is deliberately no eventWindow() here any more. Computing a window over
// a flat list of events is exactly the bug: it produced a start from the agent
// shadowing schedule and an end from the trial schedule. Windows belong to a
// single schedule and are computed in lib/trialwindow.js.

const UNKNOWN = (why) => ({ value: "UNKNOWN", detail: why });

/* ---------------- the panel ---------------- */
async function build({ ashby, botStore, ashbyCandidateId }) {
  const candidate = await ashby.getCandidate(ashbyCandidateId); // may throw candidate_not_found

  const appIds = candidate.applicationIds || [];
  const apps = (
    await mapLimit(appIds, CONCURRENCY, (id) => ashby.getApplication(id).catch(() => null))
  ).filter(Boolean);
  const app = pickApplication(apps);

  if (!app) {
    return {
      candidateName: candidate.name || null,
      position: null,
      fields: emptyFields("no application found in Ashby for this candidate"),
    };
  }

  const position = mapPosition((app.job || {}).title);
  const schedules = await ashby.listSchedulesForApplication(app.id);

  // Stage titles for the stages this candidate actually has schedules on —
  // a couple of cached lookups, not the whole org's interview plans.
  const stageIds = [...new Set(schedules.map((s) => s.interviewStageId).filter(Boolean))];
  const stageNames = new Map();
  let stageLookupFailed = false;
  await mapLimit(stageIds, CONCURRENCY, async (id) => {
    try {
      stageNames.set(id, (await stageTitle(ashby, botStore, id)).title);
    } catch (e) {
      // If we cannot read a stage name we do not know whether this schedule is
      // the work trial. Saying "NO" here would read as "nothing is scheduled",
      // which is exactly the wrong answer to give.
      stageLookupFailed = true;
      stageNames.set(id, null);
    }
  });

  const onStage = (contains) =>
    liveSchedules(schedules).filter((s) => has(stageNames.get(s.interviewStageId), contains));

  /* --- work trial --- */
  const wtSchedules = onStage(CONFIG.workTrialStageContains);
  /* The same stage INCLUDING cancelled schedules. onStage runs liveSchedules
     first, which drops them, and a cancelled trial is positive information:
     somebody called it off. Counting only live schedules would make a
     candidate whose trial was cancelled look identical to one Ashby has never
     heard of, which is the distinction this whole thing turns on. */
  const wtAnyStatus = (schedules || []).filter((s) =>
    has(stageNames.get(s.interviewStageId), CONFIG.workTrialStageContains));

  // Titles for every session on the stage. These are needed BEFORE anything is
  // classified, because identity — not date order — decides what the trial is.
  // Cached and shared across candidates, so this is only slow the first time.
  const titles = createTitleResolver({ ashby, botStore, concurrency: CONCURRENCY });
  await titles.load(wtSchedules.flatMap((s) => (s.interviewEvents || []).map((e) => e.interviewId)));
  const titleLookupFailed = titles.incomplete();

  // The single derivation. Per-schedule windows, pre-trial sessions kept out of
  // the trial dates and recorded separately, unknowns flagged rather than
  // guessed. Every consumer of the trial date reads what comes out of here.
  const derived = deriveTrialWindow({
    schedules: wtSchedules, // already cancelled-filtered and on the Work Trial stage
    titleOf: (id) => titles.get(id),
    preTrialSessions: PRE_TRIAL.sessions,
  });
  const start = derived.trial.start;
  const end = derived.trial.end;

  /**
   * Three states, not two.
   *
   *   scheduled    a trial session is booked. The panel owns the dates.
   *   unscheduled  Ashby has a work-trial schedule and it carries no trial
   *                session: NeedsScheduling, WaitingOnCandidateBooking, or
   *                cancelled outright. POSITIVE information, and it must beat
   *                a stored date.
   *   unknown      no work-trial schedule at all. Ashby has nothing to say and
   *                a stored date stands, exactly as before.
   *
   * The middle one did not exist. effective() asked only whether the panel had
   * a date, so "Ashby says this is not scheduled" and "Ashby has not been
   * asked" both fell through to the same silent fallback, and a candidate
   * whose trial was cancelled kept rendering on the dates it had before.
   * Brandon Wagoner, 14 Sep: three cancelled schedules and two NeedsScheduling,
   * every one with no events, still showing 13 to 15 Sep on the board.
   */
  const scheduleState = start ? "scheduled"
                      : wtAnyStatus.length ? "unscheduled"
                      : "unknown";

  /* --- EBS: a schedule on the prior stage, and whether feedback came back --- */
  let ebs;
  if (position === "Sales") {
    ebs = { value: "N/A", detail: "Sales has no exceptional background stage" };
  } else {
    const ebsSchedules = onStage(CONFIG.ebsStageContains);
    const ebsEvents = ebsSchedules.flatMap((s) => s.interviewEvents || []);
    if (!ebsSchedules.length) {
      ebs = stageLookupFailed
        ? UNKNOWN("could not read stage names from Ashby")
        : { value: "NOT SCHEDULED", detail: "no schedule on the exceptional background stage" };
    } else {
      let feedback = [];
      try {
        feedback = await ashby.listFeedbackForApplication(app.id);
      } catch (e) {
        feedback = [];
      }
      const ebsEventIds = new Set(ebsEvents.map((e) => e.id));
      const ebsInterviewIds = new Set(ebsEvents.map((e) => e.interviewId));
      const submitted = feedback.filter(
        (f) =>
          f.submittedAt &&
          (ebsEventIds.has(f.interviewEventId) || ebsInterviewIds.has(f.interviewId))
      );
      ebs = submitted.length
        ? { value: "FEEDBACK IN", detail: submitted.length + " submission(s)" }
        : { value: "SCHEDULED, NO FEEDBACK", detail: "scheduled, feedback not submitted yet" };
    }
  }

  /* --- agent shadowing --- */
  // Now read off the classified pre-trial sessions rather than re-scanning the
  // events, so the field and the trial date can never disagree about what
  // shadowing is. The DATE is carried here: it is a real session a coordinator
  // has to run, so it must be visible on the card, just never as the trial date.
  let agentShadow;
  if (position === "FDS") {
    agentShadow = { value: "N/A", detail: "FDE and Sales only" };
  } else {
    const shadow = derived.preTrial.filter((p) => has(p.title, CONFIG.agentShadowTitleContains));
    agentShadow = shadow.length
      ? {
          value: "SCHEDULED",
          detail: shadow.map((p) => shortDate(p.start)).join(", ") + " · before the trial",
        }
      : titleLookupFailed || stageLookupFailed
      ? UNKNOWN("could not read interview titles from Ashby")
      : { value: "NOT SCHEDULED", detail: "no agent shadowing event on the work trial schedule" };
  }

  /* --- debrief: Ashby's own flag first, title only as a fallback --- */
  // Earliest debrief session, not a window: a window here would be another
  // flatten across schedules.
  const debriefStarts = [];
  for (const s of wtSchedules) {
    for (const e of s.interviewEvents || []) {
      const t = titles.get(e.interviewId);
      if (!t) continue;
      if (isDebriefSession(t)) {
        if (e.startTime) debriefStarts.push(e.startTime);
      }
    }
  }
  debriefStarts.sort();

  /* Every Ashby interview EVENT id on the work trial stage.
     Exposed because the declines rail joins calendar events to candidates on
     exactly this id, and without it seventeen declines listed as "Unmatched"
     with nothing but a summary. The panel has always had these; it simply
     never returned them.
     Ids only. No titles, no times, nothing a consumer could start deriving a
     trial date from: lib/trialwindow.js is the one place that decides what the
     trial is, and this must not become a second one. */
  const interviewEventIds = wtSchedules
    .flatMap((s) => (s.interviewEvents || []).map((e) => e.id))
    .filter(Boolean);

  return {
    candidateName: candidate.name || null,
    applicationId: app.id,
    interviewEventIds,
    jobTitle: (app.job || {}).title || null,
    currentStage: (app.currentInterviewStage || {}).title || null,
    applicationStatus: app.status || null,
    position,
    // Which stage the work trial sits on — used by the readiness sweep to tell
    // an unbooked work-trial session from an unrelated one.
    workTrialStageId: (wtSchedules[0] || {}).interviewStageId || null,
    trialStart: start,
    trialEnd: end,
    scheduleState,
    // Which schedule the window came from, so a wrong date can be traced back
    // to a real schedule in Ashby instead of to "some events".
    trialScheduleId: derived.trial.scheduleId,
    trialSessionCount: derived.trial.sessionCount,
    // Pre-trial sessions, recorded in full. Not the trial date, but never lost.
    preTrial: derived.preTrial,
    otherTrialSchedules: derived.otherTrial,
    // Things a person should look at: the pre-trial-after-trial invariant, a
    // trial date resting on one unclassified session, unreadable titles.
    dataFlags: derived.flags,
    fields: {
      position: {
        value: position || "UNKNOWN",
        detail: (app.job || {}).title ? "job: " + app.job.title : "no job title on the application",
      },
      workTrialScheduled: wtSchedules.length
        ? {
            value: "YES",
            detail:
              derived.scheduleCount + " schedule(s) on the Work Trial stage, " +
              derived.trial.sessionCount + " session(s) in the trial itself",
          }
        : stageLookupFailed
        ? UNKNOWN("could not read stage names from Ashby, so this is not a 'no'")
        : { value: "NO", detail: "no active schedule on the Work Trial stage" },
      trialDates: {
        /* NOT SCHEDULED rather than an em dash when Ashby actively says so: a
           dash reads as "nothing here", which is the thing that has to stop. */
        value: start ? shortDate(start) + (end ? " → " + shortDate(end) : "")
             : scheduleState === "unscheduled" ? "NOT SCHEDULED" : "—",
        detail: start
          ? derived.trial.sessionCount + " session(s) on one schedule" +
            (derived.otherTrial.length
              ? " · " + derived.otherTrial.length + " other schedule(s), not merged in"
              : "") +
            (derived.preTrial.length
              ? " · " + derived.preTrial.length + " pre-trial session(s) excluded"
              : "")
          : derived.preTrial.length
          ? derived.preTrial.length + " pre-trial session(s) booked, but no trial session yet. " +
            "a pre-trial session is never the trial date"
          : derived.unbooked.length
          ? "nothing booked yet on " + derived.unbooked.length + " schedule(s) at this stage"
          : "no scheduled events",
      },
      // Its own row on the card. A coordinator has to run this, so it must be
      // readable at a glance — and readable as NOT the trial date.
      preTrialSessions: derived.preTrial.length
        ? {
            value: derived.preTrial
              .map((p) => p.label + " " + shortDate(p.start))
              .join(" · "),
            detail: "happens before the trial · never counted in the trial dates",
          }
        : titleLookupFailed || stageLookupFailed
        ? UNKNOWN("could not read interview titles from Ashby")
        : { value: "NONE", detail: "no pre-trial sessions booked on the Work Trial stage" },
      ebs,
      agentShadow,
      debriefScheduled: debriefStarts.length
        ? { value: "YES", detail: shortDate(debriefStarts[0]) }
        : titleLookupFailed || stageLookupFailed
        ? UNKNOWN("could not read interview titles from Ashby")
        : { value: "NO", detail: "no debrief event on the work trial schedule" },
    },
  };
}

function emptyFields(reason) {
  const f = (v) => ({ value: v, detail: reason });
  return {
    position: f("UNKNOWN"),
    workTrialScheduled: f("—"),
    trialDates: f("—"),
    preTrialSessions: f("—"),
    ebs: f("—"),
    agentShadow: f("—"),
    debriefScheduled: f("—"),
  };
}

function shortDate(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Los_Angeles",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/* ---------------- entry points used by the server ---------------- */

/**
 * Returns { state, panel, fetchedAt, ... } and never throws for an expected
 * condition. The state is what the UI keys off.
 */
async function getPanel({ ashby, botStore, ashbyCandidateId, force }) {
  if (!ashbyCandidateId) return { state: "notLinked" };

  const cached = await botStore.panelGet(ashbyCandidateId);
  const ttlMs = (CONFIG.cacheMinutes || 15) * 60 * 1000;
  const fresh = cached && Date.now() - new Date(cached.fetchedAt).getTime() < ttlMs;
  if (fresh && !force) {
    return { state: "live", panel: cached.payload, fetchedAt: cached.fetchedAt, fromCache: true };
  }

  try {
    const panel = await build({ ashby, botStore, ashbyCandidateId });
    await botStore.panelPut(ashbyCandidateId, panel);
    const saved = await botStore.panelGet(ashbyCandidateId);
    return { state: "live", panel, fetchedAt: saved ? saved.fetchedAt : new Date().toISOString() };
  } catch (e) {
    // A retired id is a definite answer, not an outage. Different state,
    // different fix: re-link rather than wait.
    if (e.ashbyCode === "candidate_not_found") {
      return { state: "linkedNotFound", error: "candidate_not_found" };
    }
    // Anything else — timeout, 5xx, DNS — is Ashby being unreachable. Serve the
    // last known values with their age. Never blank.
    if (cached) {
      return {
        state: "stale",
        panel: cached.payload,
        fetchedAt: cached.fetchedAt,
        error: String(e.message || e),
      };
    }
    return { state: "stale", panel: null, fetchedAt: null, error: String(e.message || e) };
  }
}

/** Suggestions for a coordinator to confirm. Suggests only; never links. */
async function suggest({ ashby, name }) {
  const results = await ashby.searchCandidates(name);
  return (results || []).slice(0, 8).map((c) => ({
    id: c.id,
    name: c.name,
    email:
      (c.primaryEmailAddress && (c.primaryEmailAddress.value || c.primaryEmailAddress)) || null,
    applications: (c.applicationIds || []).length,
  }));
}

module.exports = { name: NAME, getPanel, suggest,
  _internal: { mapPosition, pickApplication, isDebriefSession } };
