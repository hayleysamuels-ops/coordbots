"use strict";
/**
 * THE one place that decides what the work trial's start and end are.
 *
 * Two things live here, and both were bugs before they did:
 *
 * 1. WINDOWS ARE PER SCHEDULE. Never across them.
 *    Sid Panjwani had two Scheduled schedules on the Work Trial stage — agent
 *    shadowing (1 session, 3 Sept) and the real trial (9 sessions, 8 Sept).
 *    Flattening every event and taking the earliest start with the latest end
 *    produced 3 Sept 14:30 -> 8 Sept 20:15: a start from one schedule and an
 *    end from another. That is worse than a wrong date, because no single real
 *    thing has those bounds and nothing on the card can be checked against
 *    reality. So each schedule gets its own window, and the trial window is
 *    taken from the trial schedule alone.
 *
 * 2. CLASSIFICATION IS BY SESSION IDENTITY, NOT DATE ORDER.
 *    See bots/pre-trial-sessions.config.js for why, and for the list.
 *
 * Unlisted sessions count as core — but an unlisted session that is the SOLE
 * basis for a trial date gets flagged instead of asserted. That is what makes
 * this general rather than a patch for the word "shadowing".
 *
 * "Product Demo" was that example — Danni El Tayeb's trial date came from a
 * single one — and on 9 Sept 2026 it was added to the pre-trial list outright,
 * so those rows now derive NO trial date rather than a flagged one. The flag
 * still exists for the next unlisted session nobody has ruled on yet.
 *
 * An excluded session is never a fallback. Where every session on the stage is
 * pre-trial, there is no trial date, full stop: returning the excluded
 * session's date with a warning attached is how "a session that is not the
 * trial became the trial date" kept coming back under new names.
 *
 * This module is required by both consumers that derive a trial date — bot 1's
 * panel and the suggestion strip. They each had their own copy of the flatten,
 * so they each had the bug.
 */

const norm = (s) => String(s || "").trim().toLowerCase();
const has = (haystack, needle) => norm(haystack).includes(norm(needle));

/** Which pre-trial rule does this interview title match, if any? */
function preTrialRule(title, sessions) {
  for (const s of sessions || []) {
    if (s.titleContains && has(title, s.titleContains)) return s;
  }
  return null;
}

/**
 * Statuses that mean "this schedule is not still ahead of us". Cancelled never
 * reaches the ranking (it is filtered out entirely), but it belongs in the set
 * so nothing here can ever read a cancelled schedule as live.
 *
 * Deliberately a list of FINISHED states rather than an allowlist of live ones:
 * an unfamiliar status that Ashby adds later should count as live, because
 * "still to come" is the safer default for a session someone may have to run.
 */
const FINISHED = new Set(["Complete", "WaitingOnFeedback", "Cancelled"]);
const isLive = (schedule) => !FINISHED.has(String((schedule || {}).status || ""));

/** Earliest start and latest end across a set of events — one schedule's worth. */
function windowOf(events) {
  const starts = events.map((e) => e.startTime).filter(Boolean).sort();
  const ends = events.map((e) => e.endTime).filter(Boolean).sort();
  return { start: starts[0] || null, end: ends[ends.length - 1] || null };
}

/**
 * Derive the trial window.
 *
 *   schedules         raw Ashby interviewSchedule objects
 *   stageId           optional: keep only schedules on this stage
 *   titleOf(id)       -> { title, isDebrief } or null when Ashby would not say
 *   preTrialSessions  the config list
 *
 * Returns:
 *   trial       { start, end, scheduleId, sessionCount }  — nulls when nothing booked
 *   preTrial    [{ label, title, start, end, scheduleId, reason, decidedBy, decidedOn }]
 *   otherTrial  [{ scheduleId, start, end, sessionCount }] — core schedules we did not pick
 *   unbooked    [{ scheduleId, status }] — on the stage, no sessions on it yet
 *   flags       [{ level: "error"|"warn", code, text }]
 */
function deriveTrialWindow({ schedules, stageId, titleOf, preTrialSessions }) {
  const cfg = preTrialSessions || [];
  const resolve = titleOf || (() => null);

  // A cancelled schedule is not a thing that is happening. This is also why
  // Shukran Amdeen's panel correctly declined to answer — see README.
  const live = (schedules || []).filter((s) => s.status !== "Cancelled");
  const onStage = stageId ? live.filter((s) => s.interviewStageId === stageId) : live;

  let titlesIncomplete = false;

  // Classify every session, keeping it attached to the schedule it belongs to.
  // A schedule can legitimately hold both kinds — shadowing has been booked
  // inside the trial schedule before now — so the split is per event, and the
  // schedule's own window is built from its CORE events only.
  const classified = onStage.map((s) => {
    const core = [], pre = [];
    for (const e of s.interviewEvents || []) {
      const t = resolve(e.interviewId);
      if (!t || t.title == null) {
        // We do not know what this session is. It stays core — dropping an
        // unknown session from the trial date is the dangerous direction — but
        // the row will say the classification is incomplete.
        titlesIncomplete = true;
        core.push({ event: e, title: null, rule: null });
        continue;
      }
      const rule = preTrialRule(t.title, cfg);
      (rule ? pre : core).push({ event: e, title: t.title, rule });
    }
    return {
      schedule: s, core, pre,
      coreWindow: windowOf(core.map((x) => x.event)),
    };
  });

  // Pre-trial sessions: recorded, labelled, and never folded into the window.
  // They must not vanish from the card — a coordinator still has to run them.
  const preTrial = [];
  for (const c of classified) {
    for (const x of c.pre) {
      preTrial.push({
        label: (x.rule && x.rule.label) || x.title,
        title: x.title,
        start: x.event.startTime || null,
        end: x.event.endTime || null,
        scheduleId: c.schedule.id,
        reason: (x.rule && x.rule.reason) || null,
        decidedBy: (x.rule && x.rule.decidedBy) || null,
        decidedOn: (x.rule && x.rule.decidedOn) || null,
      });
    }
  }
  preTrial.sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));

  // Which core schedule IS the trial, when there is more than one?
  //
  // By content, not by date order: the fullest schedule wins, ties broken by the
  // earliest start. A work trial day is a long schedule — nine or fourteen
  // sessions here — while a lone session on the same stage is a screening or a
  // debrief. Preston Vaughn is the case that settled it: a Complete 1-session
  // "Product Demo" on 31 Aug and the real Scheduled 10-session trial on 10 Sept.
  // Picking the earliest read his trial as 31 Aug; picking the fullest reads it
  // as 10 Sept, which is what his row and both milestones need.
  //
  // Since 9 Sept 2026 that particular schedule no longer reaches this ranking at
  // all — Product Demo is pre-trial, so it contributes no core sessions. The
  // rule stays because it is not about that title: any single unlisted session
  // on the stage can still rival a real trial schedule.
  //
  // Note this is still identity, not "skip the first" — it looks at what a
  // schedule contains. It assumes a multi-day trial is one schedule, which is
  // true across all 20 rows at this stage today; a trial genuinely split into
  // two schedules would need this rule revisited, and would raise
  // multiple_trial_schedules below, which is where you would notice.
  //
  // SCHEDULE STATUS IS A TIE-BREAK, NOT THE PRIMARY KEY, and that ordering is
  // load-bearing. Preferring a live schedule first looks safer but is not: on
  // 4 Sept 2026 Joe Khosbayar's real trial was a WaitingOnFeedback 9-session
  // schedule on 3 Sept, while the only Scheduled schedule on his stage was a
  // 1-session Debrief on 4 Sept. Ranking by liveness would have made his
  // debrief the trial date — the same "a session that is not the trial became
  // the trial date" bug, arriving through status instead of through flattening.
  // Where session counts genuinely tie, the still-to-come schedule wins.
  const withCore = classified
    .filter((c) => c.core.length && c.coreWindow.start)
    .sort((a, b) =>
      b.core.length - a.core.length ||
      Number(isLive(b.schedule)) - Number(isLive(a.schedule)) ||
      String(a.coreWindow.start).localeCompare(String(b.coreWindow.start))
    );

  const chosen = withCore[0] || null;
  const trial = chosen
    ? {
        start: chosen.coreWindow.start,
        end: chosen.coreWindow.end,
        scheduleId: chosen.schedule.id,
        sessionCount: chosen.core.length,
        // Surfaced so "the window came from a finished schedule" is checkable
        // on the row rather than being a property only the ranking knows.
        status: chosen.schedule.status || null,
        live: isLive(chosen.schedule),
      }
    : { start: null, end: null, scheduleId: null, sessionCount: 0, status: null, live: false };

  const otherTrial = withCore.slice(1).map((c) => ({
    scheduleId: c.schedule.id,
    status: c.schedule.status || null,
    start: c.coreWindow.start,
    end: c.coreWindow.end,
    sessionCount: c.core.length,
    // Named, because these are exactly the sessions a person may need to rule
    // on — "Product Demo" turned up here three times on 4 Sept 2026.
    titles: c.core.map((x) => x.title).filter(Boolean),
  }));

  const unbooked = classified
    .filter((c) => !c.core.length && !c.pre.length)
    .map((c) => ({ scheduleId: c.schedule.id, status: c.schedule.status || null }));

  /* ---------------- flags ---------------- */
  const flags = [];

  // THE INVARIANT. A pre-trial session always happens before the trial. If one
  // does not, this is not a case to handle — it is bad data: something is
  // mis-titled, or sitting on the wrong candidate. Say so on the row.
  if (trial.start) {
    for (const p of preTrial) {
      if (p.start && p.start >= trial.start) {
        flags.push({
          level: "error",
          code: "pre_trial_after_trial",
          text:
            (p.label || "a pre-trial session") + " is scheduled at or after the trial starts. " +
            "Pre-trial sessions always come first, so this is a data error. Check whether the " +
            "session is mis-titled or on the wrong candidate.",
        });
      }
    }
  }

  // An unlisted session carrying the whole trial date on its own. A real trial
  // day is many sessions, so one session on its own is suspect — that is how
  // "Product Demo" became a trial date before it was listed. Do not assert it:
  // say it is unclassified and let a person rule.
  //
  // Only fires when a schedule was actually chosen. If every session was
  // excluded there is no date to qualify, and a flag here would read as "we
  // have a date, but" when the answer is that there is none.
  if (chosen && chosen.core.length === 1) {
    const only = chosen.core[0];
    flags.push({
      level: "warn",
      code: "unclassified_session",
      text:
        "unclassified session, may not be the trial. The trial date rests on a single session, " +
        (only.title ? '"' + only.title + '"' : "whose title Ashby would not return") +
        ". It is not in the pre-trial list, so it is being treated as the trial.",
    });
  }

  // More than one schedule has sessions on it. Usually harmless (a debrief
  // booked as its own schedule looks like this), but the window came from one
  // of them and a coordinator should be able to see that.
  if (withCore.length > 1) {
    flags.push({
      level: "warn",
      code: "multiple_trial_schedules",
      text:
        withCore.length + " schedules on the Work Trial stage have sessions. The trial window is " +
        "taken from the fullest one only (" + trial.sessionCount + " session(s), " +
        (trial.status || "status unknown") + "); not merged in: " +
        otherTrial
          .map(
            (o) =>
              o.sessionCount + " session(s)" +
              (o.titles.length ? " (" + o.titles.join(", ") + ")" : "") +
              (o.start ? " from " + o.start.slice(0, 10) : "") +
              (o.status ? ", " + o.status : "")
          )
          .join("; ") + ".",
    });
  }

  if (titlesIncomplete) {
    flags.push({
      level: "warn",
      code: "titles_incomplete",
      text:
        "could not read every interview title from Ashby, so some sessions could not be " +
        "classified. They are counted as trial sessions, so this is not a 'no'.",
    });
  }

  return { trial, preTrial, otherTrial, unbooked, flags, scheduleCount: onStage.length };
}

module.exports = { deriveTrialWindow, _internal: { preTrialRule, windowOf } };
