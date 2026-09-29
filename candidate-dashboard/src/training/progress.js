"use strict";

// Derives interviewer training progress from scheduled interviews.
//
// Pure: every input is passed in, nothing here calls Ashby or touches disk,
// so the sequence rule and the counting rules are testable directly.
//
// WHY THIS IS DERIVED RATHER THAN READ FROM ASHBY
// ----------------------------------------------
// Ashby has a native interviewer-pool training path, and this app used to
// read it directly. Two limits make it unusable as the source of truth here:
//
//   1. An interviewer can be on only ONE Ashby training path at a time, so
//      anyone training on a second interview is invisible to it.
//   2. Confirmed against Forus's live org: of 29 interviewer pools exactly
//      one has a training path enabled, and all 12 of its trainees sit at
//      0 of 1 completed. There is nothing there to build on.
//
// So progress is computed from interviewSchedule.list instead — the same
// fetch listIssues() already pages through, so this adds no Ashby calls.
// Ashby's native path is still read, but only to flag disagreement (see
// attachAshbyNative below); it never feeds the counts.

const SHADOW = "Shadow";
const REVERSE_SHADOW = "ReverseShadow";

// Flattens schedules into the event shape the rules below need, keeping only
// events that could possibly count: the schedule wasn't cancelled and the
// interview has actually finished.
//
// "Not cancelled" is checked on the SCHEDULE, not the event — Ashby puts no
// status on an interview event at all (confirmed live: every one of 2,310
// events over 30 days had no status field), only on its parent schedule.
//
// Note what can't be checked: whether the trainee actually turned up. Ashby
// exposes no RSVP or response status anywhere on an event's interviewers —
// the full field set is id/firstName/lastName/email/globalRole/isEnabled/
// updatedAt/isFeedbackRequired/interviewerPool. Attendance is therefore a
// manual discount (store.setSessionOverride's `discounted`), not something
// this can detect. Same wall the README documents for "declined meetings".
function completedEvents(schedules, now) {
  const out = [];
  for (const schedule of schedules) {
    if (schedule.status === "Cancelled") continue;
    for (const event of schedule.interviewEvents || []) {
      if (!event.endTime || new Date(event.endTime).getTime() > now) continue;
      out.push({
        eventId: event.id,
        interviewId: event.interviewId,
        applicationId: schedule.applicationId,
        scheduleId: schedule.id,
        startTime: event.startTime,
        endTime: event.endTime,
        interviewerUserIds: event.interviewerUserIds || [],
        interviewers: event.interviewers || [],
      });
    }
  }
  return out;
}

// Effective requirement: a per-person override wins over the path's own
// number, and the path's own number defaults to 2+2 at creation (store.js).
function requirementsFor(enrolment, path) {
  return {
    shadows: Number.isFinite(enrolment.requiredShadows) ? enrolment.requiredShadows : path.requiredShadows,
    reverseShadows: Number.isFinite(enrolment.requiredReverseShadows)
      ? enrolment.requiredReverseShadows
      : path.requiredReverseShadows,
  };
}

// A session is "during a pause" if it happened at or after the pause began.
// Paused enrolments still RECORD sessions — they just don't count and are
// flagged, so a session run against a paused trainee is never silently lost
// and never silently restarts them.
function isDuringPause(enrolment, startTime) {
  if (enrolment.state !== "paused" || !enrolment.pause || !enrolment.pause.at) return false;
  return new Date(startTime).getTime() >= new Date(enrolment.pause.at).getTime();
}

// Builds every session for one enrolment, in chronological order, with the
// reason each one does or doesn't count. Classification is deliberately NOT
// applied here — counts have to be known first (see classify below).
function sessionsFor(enrolment, path, events, jobByApplicationId) {
  const interviewIds = new Set(path.interviewIds);
  const enrolledAtMs = new Date(enrolment.enrolledAt).getTime();
  const sessions = [];

  for (const event of events) {
    if (!interviewIds.has(event.interviewId)) continue;
    const job = jobByApplicationId.get(event.applicationId);
    if (!job || job.jobId !== path.jobId) continue;
    if (!event.interviewerUserIds.includes(enrolment.userId)) continue;
    // "Start from today": only sessions from enrolment onward count
    // automatically. Anything earlier is added deliberately as a manual
    // credit instead, so enrolling someone mid-training can never
    // retroactively complete them off the back of history.
    if (new Date(event.startTime).getTime() < enrolledAtMs) continue;

    // Defensive: this is persisted state that outlives deploys, so a record
    // written by an older build (or edited by hand) may be missing the field
    // entirely. Indexing undefined here would throw and take the whole
    // training section down with it.
    const override = (enrolment.sessionOverrides || {})[event.eventId] || {};
    // Sole interviewer means they RAN the interview, not shadowed it — a
    // trainee is an additional interviewer alongside the real one. Rather
    // than guess, this is surfaced for a human to resolve: it stays
    // uncounted until someone either sets a role on it or discounts it.
    const soleInterviewer = event.interviewerUserIds.length <= 1;
    const needsConfirmation = soleInterviewer && !override.role && !override.discounted;
    const duringPause = isDuringPause(enrolment, event.startTime);

    sessions.push({
      kind: "derived",
      eventId: event.eventId,
      scheduleId: event.scheduleId,
      applicationId: event.applicationId,
      at: event.startTime,
      endTime: event.endTime,
      interviewerCount: event.interviewerUserIds.length,
      coInterviewers: event.interviewers
        .filter((i) => i.id !== enrolment.userId)
        .map((i) => ({ id: i.id, name: `${i.firstName || ""} ${i.lastName || ""}`.trim() || i.email })),
      overrideRole: override.role || null,
      discounted: Boolean(override.discounted),
      note: override.note || "",
      needsConfirmation,
      duringPause,
      counts: !override.discounted && !needsConfirmation && !duringPause,
    });
  }

  for (const credit of enrolment.manualCredits || []) {
    sessions.push({
      kind: "manual",
      creditId: credit.id,
      at: credit.at,
      overrideRole: credit.role,
      discounted: false,
      note: credit.note || "",
      needsConfirmation: false,
      duringPause: false,
      counts: true,
    });
  }

  sessions.sort((a, b) => new Date(a.at) - new Date(b.at));
  return sessions;
}

// The sequence rule: with shadow and reverse shadow indistinguishable in the
// schedule data, the first N counting sessions are shadows and the next are
// reverse shadows. Sessions carrying an explicit role (a manual credit, or a
// session someone reclassified by hand) are assigned first and consume from
// their own bucket, so an out-of-order session can always be corrected
// without the rule fighting the correction.
function classify(sessions, requirements) {
  let shadows = 0;
  let reverseShadows = 0;

  for (const s of sessions) {
    if (!s.counts || !s.overrideRole) continue;
    s.role = s.overrideRole;
    if (s.role === REVERSE_SHADOW) reverseShadows += 1;
    else shadows += 1;
  }

  for (const s of sessions) {
    if (!s.counts || s.overrideRole) continue;
    if (shadows < requirements.shadows) {
      s.role = SHADOW;
      shadows += 1;
    } else {
      s.role = REVERSE_SHADOW;
      reverseShadows += 1;
    }
  }

  // Uncounted sessions still get a provisional label so the UI can show what
  // they WOULD have been, without them affecting the totals.
  for (const s of sessions) {
    if (!s.role) s.role = s.overrideRole || (shadows < requirements.shadows ? SHADOW : REVERSE_SHADOW);
  }

  return { shadows, reverseShadows };
}

// Ashby's native training path, attached purely as a cross-check. Never
// merged into the counts: it tracks at most one path per interviewer and is
// effectively unused at Forus, so a disagreement means "look at this",
// not "one of these is authoritative".
function attachAshbyNative(result, ashbyByUserId) {
  const native = ashbyByUserId.get(result.userId);
  if (!native) return result;
  const disagreements = [];
  if (native.isPaused && result.state !== "paused") {
    disagreements.push("Ashby has them paused; this tracker does not.");
  }
  if (!native.isPaused && result.state === "paused") {
    disagreements.push("Paused here, but not paused in Ashby.");
  }
  if (result.state === "complete" && native.interviewsCompleted < native.interviewsRequired) {
    disagreements.push(
      `Complete here, but Ashby's own path still shows ${native.interviewsCompleted} of ${native.interviewsRequired}.`
    );
  }
  return {
    ...result,
    ashbyNative: {
      poolTitle: native.poolTitle,
      stageRole: native.stageRole,
      interviewsCompleted: native.interviewsCompleted,
      interviewsRequired: native.interviewsRequired,
      isPaused: native.isPaused,
    },
    disagreements,
  };
}

/**
 * @param {object[]} schedules          raw interviewSchedule.list results
 * @param {Map}      jobByApplicationId applicationId -> { jobId, jobTitle }
 * @param {object[]} paths              store.listPaths()
 * @param {object[]} enrolments         store.listEnrolments()
 * @param {object[]} ashbyTraining      ashby.listInterviewerTraining() results
 * @param {number}   now                epoch ms
 * @param {number}   stalledAfterDays   no session for this long -> stalled
 */
function computeTraining({ schedules, jobByApplicationId, paths, enrolments, ashbyTraining, now, stalledAfterDays }) {
  const events = completedEvents(schedules, now);
  const pathsById = new Map(paths.map((p) => [p.id, p]));
  const ashbyByUserId = new Map((ashbyTraining || []).map((t) => [t.userId, t]));

  const results = [];
  for (const enrolment of enrolments) {
    const path = pathsById.get(enrolment.pathId);
    if (!path) continue; // path deleted out from under it; store.removePath prunes these

    const requirements = requirementsFor(enrolment, path);
    const sessions = sessionsFor(enrolment, path, events, jobByApplicationId);
    const { shadows, reverseShadows } = classify(sessions, requirements);

    const complete = shadows >= requirements.shadows && reverseShadows >= requirements.reverseShadows;
    const state =
      enrolment.state === "archived" ? "archived"
      : enrolment.state === "paused" ? "paused"
      : complete ? "complete"
      : "active";

    // Recency is measured from the last session that actually happened —
    // including ones that didn't count — because the question it answers is
    // "is this person being used?", not "is their progress advancing?".
    const lastSession = sessions.length ? sessions[sessions.length - 1] : null;
    const lastActivityAt = lastSession ? lastSession.at : enrolment.enrolledAt;
    const daysSinceActivity = (now - new Date(lastActivityAt).getTime()) / 86400000;

    const pendingDuringPause = sessions.filter((s) => s.duringPause).length;
    const needsConfirmation = sessions.filter((s) => s.needsConfirmation).length;

    results.push(
      attachAshbyNative(
        {
          key: `${enrolment.userId}:${enrolment.pathId}`,
          userId: enrolment.userId,
          userName: enrolment.userName,
          userEmail: enrolment.userEmail,
          pathId: path.id,
          pathLabel: path.label,
          interviewTitle: path.interviewTitle,
          jobTitle: path.jobTitle,
          enrolledAt: enrolment.enrolledAt,
          state,
          complete,
          pause: enrolment.pause,
          archivedAt: enrolment.archivedAt,
          requirements,
          // A per-person override is shown as such so an individual on 1+1
          // doesn't read as though the whole path changed.
          hasRequirementOverride:
            Number.isFinite(enrolment.requiredShadows) || Number.isFinite(enrolment.requiredReverseShadows),
          shadows,
          reverseShadows,
          sessions,
          lastActivityAt,
          daysSinceActivity: Math.round(daysSinceActivity),
          // Only an active trainee can be stalled — a paused or archived one
          // is inactive on purpose, and a complete one has nothing left to do.
          stalled: state === "active" && daysSinceActivity >= stalledAfterDays,
          pendingDuringPause,
          needsConfirmation,
          disagreements: [],
        },
        ashbyByUserId
      )
    );
  }

  results.sort((a, b) => (a.userName || "").localeCompare(b.userName || "") || a.pathLabel.localeCompare(b.pathLabel));
  return results;
}

// A new Ashby interview record sharing a path's title and job, not yet in
// that path's interviewIds. Ashby orgs accumulate duplicate interview records
// (Forus has 8 separate `[Forus] Coding Interview` records), so a path would
// otherwise silently stop counting when scheduling moves to a fresh copy.
// Surfaced as a suggestion rather than absorbed automatically — the
// duplicates aren't always equivalent.
function suggestedPathInterviews({ schedules, jobByApplicationId, paths, interviewTitleById, now }) {
  const events = completedEvents(schedules, now);
  const suggestions = [];
  for (const path of paths) {
    const known = new Set(path.interviewIds);
    const seen = new Map();
    for (const event of events) {
      if (known.has(event.interviewId)) continue;
      const title = interviewTitleById.get(event.interviewId);
      if (!title || title !== path.interviewTitle) continue;
      const job = jobByApplicationId.get(event.applicationId);
      if (!job || job.jobId !== path.jobId) continue;
      seen.set(event.interviewId, (seen.get(event.interviewId) || 0) + 1);
    }
    for (const [interviewId, eventCount] of seen) {
      suggestions.push({ pathId: path.id, pathLabel: path.label, interviewId, title: path.interviewTitle, eventCount });
    }
  }
  return suggestions;
}

module.exports = { computeTraining, suggestedPathInterviews, completedEvents, classify, SHADOW, REVERSE_SHADOW };
