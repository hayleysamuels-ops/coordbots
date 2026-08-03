"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");
const {
  enrichApplication,
  listSubmittedFeedback,
  getInterviewInfo,
  interviewExclusionReason,
  interviewIdForEvent,
  getScheduleEventIds,
  interviewLinks,
} = require("./ashby");
const { sendScorecardReminder } = require("./slack");

// Where to persist pending reminders. Override with DATA_DIR to point at a
// mounted volume on a cloud host so reminders survive restarts/redeploys.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const TICK_MS = 30 * 1000; // check for due reminders every 30s
const CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000; // drop finished reminders after 24h
const HOUR_MS = 60 * 60 * 1000;

// In-memory map keyed by interviewEventId. Mirrored to disk so a restart
// doesn't lose reminders that haven't fired yet.
//
// Each record holds a list of `stages` — one per configured reminder offset
// (e.g. 0h, 24h, 36h after the interview ends). Every stage fires
// independently and only DMs interviewers who still haven't submitted, so the
// nudges escalate until the scorecard is in.
let reminders = {};

function load() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      reminders = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) || {};
      migrateLegacy();
      console.log(`[reminders] Loaded ${Object.keys(reminders).length} from disk.`);
    }
  } catch (err) {
    console.error("[reminders] Failed to load store, starting empty:", err.message);
    reminders = {};
  }
}

// Upgrade records saved by the older single-reminder version (which used
// `sent`/`fireAt` instead of `stages`) so they don't break the scheduler.
function migrateLegacy() {
  for (const key of Object.keys(reminders)) {
    const r = reminders[key];
    if (!r.stages) {
      r.stages = [
        {
          hours: 0,
          fireAt: r.fireAt || Date.now(),
          sent: !!r.sent,
          sentAt: r.sentAt || null,
        },
      ];
      r.completedAt = r.sent ? r.sentAt || Date.now() : null;
      delete r.sent;
      delete r.fireAt;
      delete r.sentAt;
    }
  }
}

// Look up each queued reminder's interview and drop debriefs / non-scored
// sessions that were scheduled before we could classify them. Resolves the
// interviewId from the record, or via the schedule for older records that
// predate interviewId tracking. Best-effort — needs an ASHBY_API_KEY.
async function sweepExcluded() {
  if (!config.ashbyApiKey) return;
  let removed = 0;
  for (const key of Object.keys(reminders)) {
    const r = reminders[key];

    // Drop reminders whose event no longer exists on its schedule (the
    // interview was cancelled or the event was removed). An empty/known event
    // list that omits this event is the signal; a failed lookup (null) is not.
    const eventIds = await getScheduleEventIds(r.scheduleId);
    if (eventIds && !eventIds.includes(key)) {
      delete reminders[key];
      removed++;
      console.log(`[reminders] Pruned queued reminder for event ${key} (interview cancelled/removed).`);
      continue;
    }

    let interviewId = r.interviewId;
    if (!interviewId) {
      interviewId = await interviewIdForEvent(r.scheduleId, key);
      if (interviewId) r.interviewId = interviewId; // remember for next time
    }
    const info = await getInterviewInfo(interviewId);
    const reason = interviewExclusionReason(info);
    if (reason) {
      delete reminders[key];
      removed++;
      console.log(`[reminders] Pruned queued reminder for event ${key} (${reason}).`);
    } else if (info && info.title && r.interviewName === "your interview") {
      r.interviewName = info.title; // backfill name for nicer logs
    }
  }
  if (removed || Object.keys(reminders).length) save();
  if (removed) console.log(`[reminders] Sweep removed ${removed} excluded reminder(s).`);
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(reminders, null, 2));
  } catch (err) {
    console.error("[reminders] Failed to save store:", err.message);
  }
}

// Build the stage list for an event, preserving any stage already sent so a
// reschedule/update doesn't re-fire it. Not-yet-sent stages are re-timed off
// the (possibly new) end time.
function buildStages(endTime, existing) {
  const baseline =
    new Date(endTime).getTime() + config.reminderDelayMinutes * 60 * 1000;
  const prevStages = (existing && existing.stages) || [];
  return config.reminderScheduleHours.map((hours) => {
    const prev = prevStages.find((s) => s.hours === hours);
    if (prev && prev.sent) {
      return { hours, fireAt: prev.fireAt, sent: true, sentAt: prev.sentAt };
    }
    return { hours, fireAt: baseline + hours * HOUR_MS, sent: false, sentAt: null };
  });
}

const allStagesSent = (r) => r.stages.every((s) => s.sent);

/**
 * Apply a parsed webhook: upsert or cancel reminders per interview event.
 * Async because it looks up each event's interview to skip debriefs and
 * non-scored sessions (their name/debrief status aren't in the webhook).
 */
async function applyWebhook(parsed) {
  for (const r of parsed.reminders) {
    const key = r.interviewEventId;

    if (r.cancelled) {
      if (reminders[key]) {
        delete reminders[key];
        console.log(`[reminders] Cancelled reminders for event ${key}.`);
      }
      continue;
    }

    // Skip debriefs / events that don't need a scorecard, and drop any reminder
    // we may have scheduled for this event before it was reclassified.
    const info = await getInterviewInfo(r.interviewId);
    const reason = interviewExclusionReason(info);
    if (reason) {
      if (reminders[key]) {
        delete reminders[key];
        console.log(`[reminders] Removed reminders for event ${key} (${reason}).`);
      } else {
        console.log(`[reminders] Skipping event ${key} (${reason}); no scorecard reminders.`);
      }
      continue;
    }

    // Nobody required to give feedback (e.g. all shadowers) — nothing to remind.
    if (!r.interviewers.length) {
      if (reminders[key]) delete reminders[key];
      console.log(`[reminders] Skipping event ${key}; no interviewers require feedback.`);
      continue;
    }

    const existing = reminders[key];
    // Already fully processed — don't resurrect.
    if (existing && existing.stages && allStagesSent(existing)) continue;

    const stages = buildStages(r.endTime, existing);
    reminders[key] = {
      interviewEventId: key,
      interviewId: r.interviewId,
      scheduleId: r.scheduleId,
      applicationId: r.applicationId,
      interviewName: (info && info.title) || r.interviewName,
      endTime: r.endTime,
      feedbackLink: r.feedbackLink,
      interviewers: r.interviewers,
      // carry over enrichment if we already had it
      candidateName: existing ? existing.candidateName : undefined,
      jobTitle: existing ? existing.jobTitle : undefined,
      stages,
      completedAt: null,
    };

    const pending = stages
      .filter((s) => !s.sent)
      .map((s) => `${s.hours}h→${new Date(s.fireAt).toISOString()}`)
      .join(", ");
    console.log(
      `[reminders] Scheduled ${r.interviewers.length} interviewer(s) for event ${key}; pending stages: ${pending || "none"}.`
    );
  }

  // Reconcile cancellations: Ashby sends the schedule's full current event set
  // on each update, and a cancelled schedule arrives with NO events. So any
  // queued reminder for this schedule whose event is no longer present was
  // cancelled/removed — drop it (this is what stops reminders for interviews
  // that were cancelled before they happened).
  if (parsed.scheduleId) {
    const present = new Set(parsed.presentEventIds || []);
    for (const key of Object.keys(reminders)) {
      if (reminders[key].scheduleId === parsed.scheduleId && !present.has(key)) {
        delete reminders[key];
        console.log(
          `[reminders] Cancelled reminders for event ${key} — no longer on schedule ${parsed.scheduleId}.`
        );
      }
    }
  }

  save();
}

/**
 * Given a reminder, return only the interviewers who have NOT yet submitted
 * their scorecard for this interview event.
 *
 * We ask Ashby for all submitted feedback on the application, then match each
 * interviewer against it by Ashby user id (preferred) or email. When a feedback
 * record carries an interviewEventId, we require it to match this event so we
 * don't suppress a reminder because the person filed feedback for a *different*
 * interview on the same application. If the record has no event id, we fall
 * back to an email/id match within the application.
 *
 * If we can't verify (no ASHBY_API_KEY, or the API call failed),
 * listSubmittedFeedback returns null and we remind everyone — better a
 * redundant nudge than a missed scorecard.
 */
async function filterAlreadySubmitted(reminder) {
  const submitted = await listSubmittedFeedback(reminder.applicationId);
  if (!submitted) return { recipients: reminder.interviewers, verified: false };

  const hasSubmitted = (interviewer) =>
    submitted.some((f) => {
      const eventMatches = f.interviewEventId
        ? f.interviewEventId === reminder.interviewEventId
        : true;
      if (!eventMatches) return false;
      const byId =
        f.submitterUserId &&
        interviewer.userId &&
        f.submitterUserId === interviewer.userId;
      const byEmail =
        f.submitterEmail &&
        interviewer.email &&
        f.submitterEmail.toLowerCase() === interviewer.email.toLowerCase();
      return Boolean(byId || byEmail);
    });

  const recipients = reminder.interviewers.filter((interviewer) => {
    if (hasSubmitted(interviewer)) {
      console.log(
        `[reminders] ${interviewer.email} already submitted for event ${reminder.interviewEventId}; skipping.`
      );
      return false;
    }
    return true;
  });
  return { recipients, verified: true };
}

// Fire one stage of a reminder: DM everyone who still hasn't submitted.
async function fireStage(reminder, stage, stageIndex) {
  // Best-effort enrichment for a nicer message.
  if (!reminder.candidateName || !reminder.jobTitle) {
    const enriched = await enrichApplication(reminder.applicationId);
    reminder.candidateName = reminder.candidateName || enriched.candidateName;
    reminder.jobTitle = reminder.jobTitle || enriched.jobTitle;
  }

  const { recipients, verified } = await filterAlreadySubmitted(reminder);

  // Mark this stage done regardless of outcome.
  stage.sent = true;
  stage.sentAt = Date.now();

  if (recipients.length === 0) {
    // Everyone submitted (verified). No point in any later stages.
    if (verified) {
      reminder.stages.forEach((s) => {
        if (!s.sent) {
          s.sent = true;
          s.sentAt = Date.now();
        }
      });
      console.log(
        `[reminders] Event ${reminder.interviewEventId}: all submitted — remaining reminders cancelled.`
      );
    } else {
      console.log(
        `[reminders] Event ${reminder.interviewEventId}: no recipients for this stage.`
      );
    }
    return;
  }

  const { scorecardUrl, briefingUrl } = interviewLinks(
    reminder.interviewEventId,
    reminder.feedbackLink
  );

  const context = {
    candidateName: reminder.candidateName,
    jobTitle: reminder.jobTitle,
    scorecardUrl,
    briefingUrl,
    reminderNumber: stageIndex + 1, // 1-based: 1 = at end, 2 = first follow-up, ...
    totalReminders: reminder.stages.length,
    hoursSinceEnd: stage.hours,
  };

  console.log(
    `[reminders] Event ${reminder.interviewEventId}: firing reminder #${context.reminderNumber} (${stage.hours}h) to ${recipients.length} interviewer(s).`
  );

  for (const interviewer of recipients) {
    try {
      await sendScorecardReminder(interviewer, context);
    } catch (err) {
      console.error(
        `[reminders] Failed to send to ${interviewer.email}:`,
        err.message
      );
    }
  }
}

async function tick() {
  const now = Date.now();
  let changed = false;

  for (const key of Object.keys(reminders)) {
    const r = reminders[key];
    if (!r.stages) continue; // safety

    // Fire any due, unsent stages (there may be several after downtime).
    for (let i = 0; i < r.stages.length; i++) {
      const stage = r.stages[i];
      if (!stage.sent && stage.fireAt <= now) {
        await fireStage(r, stage, i);
        changed = true;
      }
    }

    if (allStagesSent(r) && !r.completedAt) {
      r.completedAt = now;
      changed = true;
    }

    // Clean up finished reminders after a grace period.
    if (r.completedAt && now - r.completedAt > CLEANUP_AFTER_MS) {
      delete reminders[key];
      changed = true;
    }
  }

  if (changed) save();
}

async function start() {
  load();
  // Clear out any debriefs / non-scored sessions queued before we could
  // classify them, BEFORE the first tick so they never fire.
  try {
    await sweepExcluded();
  } catch (e) {
    console.error("[reminders] sweep error:", e.message);
  }
  // Run once on boot to catch anything already due, then on an interval.
  tick().catch((e) => console.error("[reminders] tick error:", e.message));
  setInterval(
    () => tick().catch((e) => console.error("[reminders] tick error:", e.message)),
    TICK_MS
  );
  const schedule = config.reminderScheduleHours.join("h, ") + "h";
  console.log(
    `[reminders] Scheduler started (tick every ${TICK_MS / 1000}s; reminders at ${schedule} after interview end).`
  );
}

module.exports = { start, applyWebhook, tick, load, sweepExcluded, _state: () => reminders };
