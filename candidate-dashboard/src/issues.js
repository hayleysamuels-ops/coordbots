"use strict";

const config = require("./config");
const ashby = require("./ashby");
const dismissals = require("./dismissals");
const notes = require("./notes");
const { splitDismissed } = require("./scheduling/ready-queue");
const { hiddenEntries } = require("./hidden-list");

const thresholds = {
  feedbackOverdueHours: config.feedbackOverdueHours,
  needsSchedulingAlertHours: config.needsSchedulingAlertHours,
  staleFeedbackHours: config.staleFeedbackHours,
  staleSchedulingHours: config.staleSchedulingHours,
  interviewerLimitBuffer: config.interviewerLimitBuffer,
  sourcedLookbackDays: config.sourcedLookbackDays,
  availabilitySubmittedAlertHours: config.availabilitySubmittedAlertHours,
  rescheduleCountThreshold: config.rescheduleCountThreshold,
  offersSignedLookbackDays: config.offersSignedLookbackDays,
};

// Static, client-specific display config — never changes at runtime, so it's
// set once here rather than recomputed on every refresh. The frontend reads
// this to set the page title, header accent color, and a few section
// descriptions that would otherwise hardcode this client's specific
// keyword/threshold choices (see § Section descriptions in README) instead
// of deriving them from config, the way every other client-specific value
// in this app already does.
const appConfig = {
  dashboardTitle: config.dashboardTitle,
  clientAccentColor: config.clientAccentColor,
  disabledSections: config.disabledSections,
  onsiteStageKeywords: config.onsiteStageKeywords,
  sourceReferralKeywords: config.sourceReferralKeywords,
  sourceAgencyKeywords: config.sourceAgencyKeywords,
  displayTimeZone: config.displayTimeZone,
  schedulingEnabled: config.schedulingEnabled,
  trainingTrackerEnabled: config.trainingTrackerEnabled,
  trainingStalledAfterDays: config.trainingStalledAfterDays,
  trainingDefaultShadows: config.trainingDefaultShadows,
  trainingDefaultReverseShadows: config.trainingDefaultReverseShadows,
  // With the scheduling pilot on, the older queue is renamed to set it apart
  // from the "Ready to schedule" section; without it, the queue keeps its
  // original name.
  needsSchedulingLabel: config.schedulingEnabled ? "Scheduling not started" : "Needs scheduling",
  // The Remind button on Feedback Overdue rows (reminder-route.js); the page
  // also needs a Google sign-in before it shows it.
  remindersEnabled: config.remindersEnabled,
  // Interviewer Load: titles that count as interviews but not hours.
  interviewerLoadUntimed: config.interviewerLoadUntimedNames,
};

// Last reminder sent per interview, shown on its row (reminder-history.js).
const reminderHistory = config.remindersEnabled ? require("./reminder-history").createReminderHistory() : null;

let snapshot = {
  readyToSchedule: [],
  feedbackOverdue: [],
  needsScheduling: [],
  interviewerLimits: [],
  recentSourced: [],
  availabilitySubmitted: [],
  onsiteToday: [],
  interviewsToday: [],
  rescheduledInterviews: [],
  interviewerTraining: [],
  // Tracker-only (TRAINING_TRACKER_CLIENT_ID). trainingPaths/PathOptions/
  // Suggestions drive the configuration UI; ashbyNativeTraining holds Ashby's
  // own interviewer-pool training data, which with the tracker on is used
  // ONLY to flag disagreement on a card, never to compute progress.
  trainingPaths: [],
  trainingPathOptions: [],
  trainingSuggestions: [],
  ashbyNativeTraining: [],
  offersNotYetSent: [],
  offersAwaitingAcceptance: [],
  offersSigned: [],
  // { days, minInterviews, qualifying, top[] } once computed; null before.
  feedbackLeaderboard: null,
  interviewerLoad: null,
  departments: [],
  thresholds,
  appConfig,
};
let lastUpdated = null;
let lastError = null;

// Wraps a promise with duration logging so slow calls are visible per-call
// rather than conflated with the others they run alongside in Promise.allSettled.
async function timed(label, promise) {
  const start = Date.now();
  const result = await promise;
  console.log(`[issues] ${label} took ${Math.round((Date.now() - start) / 1000)}s`);
  return result;
}

// Each group is fetched and can fail independently — a broken
// application.list call inside listRecentSourced() (say) no longer takes
// down listIssues()'s result with it just because they used to be awaited
// together in one Promise.all. Grouped by which underlying `ashby.js` call
// produces them, since that's the real unit of failure: listIssues()
// itself computes feedbackOverdue/needsScheduling/interviewerLimits/
// availabilitySubmitted/onsiteToday/interviewsToday/rescheduledInterviews
// from one shared `interviewSchedule.list` fetch, so those seven sink or
// swim together (splitting them further isn't meaningful — they share a
// root cause), same for offersNotYetSent/offersAwaitingAcceptance/
// offersSigned under listOffers(). recentSourced/departments/
// interviewerTraining each get their own group since each is one
// independent Ashby call.
// With the training tracker on, Interviewer Training is computed inside
// listIssues() (off the schedules it already fetched) rather than from its own
// Ashby call, so its keys ride on the schedule-driven group's freshness and
// failure status instead of the separate group below.
const TRAINING_KEYS = config.trainingTrackerEnabled
  ? ["interviewerTraining", "trainingPaths", "trainingPathOptions", "trainingSuggestions"]
  : [];

const SECTION_GROUPS = [
  {
    label: "Schedule-driven sections",
    keys: ["readyToSchedule", "feedbackOverdue", "needsScheduling", "interviewerLimits", "availabilitySubmitted", "onsiteToday", "interviewsToday", "rescheduledInterviews", ...TRAINING_KEYS],
    // Ashby's native training data is passed in from the PREVIOUS cycle's
    // snapshot - it is a cross-check shown on a card, never an input to the
    // counts, so being one refresh interval stale is harmless and it isn't
    // worth serialising the two groups to avoid.
    fetch: () => timed("listIssues", ashby.listIssues({ ashbyNativeTraining: snapshot.ashbyNativeTraining })),
    assign: (snap, result) => Object.assign(snap, result),
  },
  {
    label: "Recently Sourced",
    keys: ["recentSourced"],
    fetch: () => timed("listRecentSourced", ashby.listRecentSourced()),
    assign: (snap, result) => {
      snap.recentSourced = result;
    },
  },
  {
    label: "Departments",
    keys: ["departments"],
    fetch: () => timed("listDepartments", ashby.listDepartments()),
    assign: (snap, result) => {
      snap.departments = result;
    },
  },
  {
    // Same Ashby call either way; what changes is what it feeds. Without the
    // tracker it IS the Interviewer Training section, exactly as before.
    // With the tracker it becomes the cross-check the section flags
    // disagreements against (see training/progress.js attachAshbyNative).
    label: config.trainingTrackerEnabled ? "Ashby native training (cross-check)" : "Interviewer Training",
    keys: config.trainingTrackerEnabled ? ["ashbyNativeTraining"] : ["interviewerTraining"],
    fetch: () => timed("listInterviewerTraining", ashby.listInterviewerTraining()),
    assign: (snap, result) => {
      if (config.trainingTrackerEnabled) snap.ashbyNativeTraining = result;
      else snap.interviewerTraining = result;
    },
  },
  {
    label: "Offers",
    keys: ["offersNotYetSent", "offersAwaitingAcceptance", "offersSigned"],
    fetch: () => timed("listOffers", ashby.listOffers()),
    assign: (snap, result) => Object.assign(snap, result),
  },
];

// Only where it's on: switched off (DISABLED_SECTIONS=feedbackLeaderboard) it
// is never computed, so the ranking never reaches /api/issues (config.js).
if (config.feedbackLeaderboardEnabled) {
  SECTION_GROUPS.push({
    // Interviewer-centric like Interviewer Weekly Limits: no dismissals, no
    // entity filter. Its own group so its first, heavier read (every
    // scorecard in the window) never holds up the Dashboard tab.
    label: "Feedback leaderboard",
    keys: ["feedbackLeaderboard"],
    fetch: () => timed("listFeedbackLeaderboard", ashby.listFeedbackLeaderboard()),
    assign: (snap, result) => {
      snap.feedbackLeaderboard = result;
    },
  });
}

// Interviewer load (Interviewer Info tab): its own group so it never waits on
// the candidate reads. Off (DISABLED_SECTIONS=interviewerLoad), never computed.
if (config.interviewerLoadEnabled) {
  SECTION_GROUPS.push({
    label: "Interviewer load",
    keys: ["interviewerLoad"],
    fetch: () => timed("listInterviewerLoad", ashby.listInterviewerLoad()),
    assign: (snap, result) => {
      snap.interviewerLoad = result;
    },
  });
}

// Per-section-key { lastUpdated, lastError } — every key in a given
// SECTION_GROUPS entry always shares the same value (they refresh
// together), but this is keyed by the individual frontend-facing section
// key rather than by group so getSnapshot()/app.js don't need to know the
// grouping, just "what's this key's own status." A group that fails keeps
// its keys' previous lastUpdated (last known-good data stays visible,
// stamped with when it was actually last fetched, not the failed attempt's
// time) and records the new lastError; a group that succeeds stamps both.
const sectionStatus = {};
for (const group of SECTION_GROUPS) {
  for (const key of group.keys) sectionStatus[key] = { lastUpdated: null, lastError: null };
}

// Item counts per key, for the "committed" log line below — group.keys'
// values are always arrays (every SECTION_GROUPS entry's assign() writes
// arrays into snapshot), so this is safe without per-key type checking.
// Most sections are arrays (logged as a count). The feedback leaderboard is
// an object; log how many people qualified and how many are shown instead
// of `undefined`.
function describeCounts(group) {
  return group.keys
    .map((key) => {
      const value = snapshot[key];
      if (value && !Array.isArray(value) && Array.isArray(value.top)) return `${key}=${value.top.length} shown of ${value.qualifying} qualifying`;
      if (value && !Array.isArray(value) && Array.isArray(value.rows)) return `${key}=${value.rows.length} interviewers, ${value.rows.filter((r) => r.week.done + r.week.booked === 0).length} with none this week`;
      return `${key}=${(value || []).length}`;
    })
    .join(", ");
}

// Commits ONE group's result the instant it settles, independent of how
// long any other group takes — this is the actual point of per-group
// failure isolation. An earlier version awaited Promise.allSettled() over
// all five fetches and only committed results in one batch afterward,
// which meant a single slow group (confirmed live: listIssues taking 523s
// against Profound while listDepartments/listRecentSourced/listOffers had
// all finished in under 90s) silently held back every OTHER group's
// already-finished data too — /api/issues kept serving all-empty,
// lastUpdated: null snapshots for that entire 523s despite deploy logs
// showing those faster groups had long since completed. Each group now
// writes its own data/sectionStatus (and logs it) the moment ITS OWN fetch
// resolves or rejects, with no dependency on its siblings.
async function refreshOneGroup(group) {
  try {
    const result = await group.fetch();
    group.assign(snapshot, result);
    const now = new Date();
    for (const key of group.keys) sectionStatus[key] = { lastUpdated: now, lastError: null };
    console.log(`[issues] ${group.label} committed (${describeCounts(group)})`);
    return { group, ok: true };
  } catch (err) {
    const message = (err && err.message) || String(err);
    console.warn(`[issues] ${group.label} refresh failed, serving stale data:`, message);
    for (const key of group.keys) {
      sectionStatus[key] = { lastUpdated: sectionStatus[key].lastUpdated, lastError: message };
    }
    return { group, ok: false, message };
  }
}

// Guards against overlapping refreshes — a refresh triggered while one is
// already in flight (interval tick, or the manual "Refresh now" button)
// just attaches to the one already running instead of starting a duplicate.
// Cleared in a `finally` so it can never wedge open even if something
// inside refreshOneGroup throws somewhere unexpected outside its own
// try/catch (it shouldn't — every group's own errors are already caught
// there — but this is the backstop, not the primary mechanism).
let refreshPromise = null;

async function refresh() {
  if (refreshPromise) {
    console.log("[issues] refresh already in progress, skipping duplicate trigger");
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const callCountBefore = ashby.getApiCallCount();
      const byEndpointBefore = ashby.getApiCallCountByEndpoint();
      const results = await Promise.all(SECTION_GROUPS.map(refreshOneGroup));
      const callCountThisCycle = ashby.getApiCallCount() - callCountBefore;
      const byEndpointAfter = ashby.getApiCallCountByEndpoint();
      const byEndpointThisCycle = Object.keys(byEndpointAfter)
        .map((endpoint) => [endpoint, byEndpointAfter[endpoint] - (byEndpointBefore[endpoint] || 0)])
        .filter(([, count]) => count > 0);

      // Top-level lastUpdated/lastError are a coarse, whole-refresh-cycle
      // summary for the header only, computed after every group has
      // individually settled — per-section freshness/errors (committed
      // above, as each group finishes, not here) are what actually drive
      // each section's own timestamp display and are never blocked on this.
      const succeeded = results.filter((r) => r.ok).map((r) => r.group.label);
      const failed = results.filter((r) => !r.ok).map((r) => r.group.label);
      if (succeeded.length) lastUpdated = new Date();
      lastError = failed.length ? `${failed.length} of ${SECTION_GROUPS.length} refresh group(s) failed: ${failed.join(", ")}` : null;

      console.log(
        `[issues] refresh cycle complete: ${snapshot.feedbackOverdue.length} feedback overdue, ` +
          `${snapshot.needsScheduling.length} needs scheduling, ` +
          `${[...snapshot.feedbackOverdue, ...snapshot.needsScheduling].filter((e) => e.isStale).length} of those stale, ` +
          `${snapshot.interviewerLimits.length} nearing interview limit, ` +
          `${snapshot.recentSourced.length} recently sourced, ` +
          `${snapshot.availabilitySubmitted.length} availability submitted, ` +
          `${snapshot.onsiteToday.length} onsite today, ` +
          `${snapshot.interviewsToday.length} interviews today, ` +
          `${snapshot.rescheduledInterviews.length} rescheduled interviews, ` +
          `${snapshot.interviewerTraining.length} interviewer training entries, ` +
          `${snapshot.offersNotYetSent.length} offers not yet sent, ` +
          `${snapshot.offersAwaitingAcceptance.length} offers awaiting acceptance, ` +
          `${snapshot.offersSigned.length} offers signed` +
          (config.feedbackLeaderboardEnabled
            ? `, ${snapshot.feedbackLeaderboard ? snapshot.feedbackLeaderboard.qualifying : "?"} qualifying for the feedback leaderboard`
            : ", feedback leaderboard off") +
          (failed.length ? ` (failed: ${failed.join(", ")})` : "")
      );
      console.log(
        `[issues] refresh cycle used ${callCountThisCycle} Ashby API calls (` +
          byEndpointThisCycle.map(([endpoint, count]) => `${endpoint}=${count}`).join(", ") +
          `)`
      );
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

function start() {
  refresh();
  setInterval(refresh, config.refreshIntervalMinutes * 60 * 1000);
}

// Apply dismissals at serve time (not refresh time) so a dismiss takes effect
// on the very next poll, without waiting for the background refresh. Candidate
// sections filter on candidateId; the interviewer section on userId. Ready to
// schedule filters on its own per-submission key (see ready-queue.js), never
// on candidateId, and also returns its hidden rows so the section can count
// them after the dashboard's entity filters.
function applyDismissals(snap) {
  const keepCandidate = (x) => !dismissals.isDismissed(`candidate:${x.candidateId}`);
  const keepInterviewer = (x) => !dismissals.isDismissed(`interviewer:${x.userId}`);
  const ready = splitDismissed(snap.readyToSchedule, dismissals.isDismissed);
  return {
    ...snap,
    // The Action queue's Hidden & snoozed tab (see hidden-list.js), built from
    // the snapshot before anything below is filtered out.
    hidden: hiddenEntries(dismissals.list(), snap, hiddenKeys()),
    readyToSchedule: ready.visible,
    readyToScheduleHidden: ready.hidden,
    feedbackOverdue: snap.feedbackOverdue.filter(keepCandidate),
    needsScheduling: snap.needsScheduling.filter(keepCandidate),
    recentSourced: snap.recentSourced.filter(keepCandidate),
    availabilitySubmitted: snap.availabilitySubmitted.filter(keepCandidate),
    onsiteToday: snap.onsiteToday.filter(keepCandidate),
    interviewsToday: snap.interviewsToday.filter(keepCandidate),
    rescheduledInterviews: snap.rescheduledInterviews.filter(keepCandidate),
    interviewerLimits: snap.interviewerLimits.filter(keepInterviewer),
    // The tracker's cards have no dismiss control, so a leftover
    // interviewer:<userId> dismissal from the Ashby-native section (or from
    // Interviewer Weekly Limits, which shares the key space) would hide a
    // trainee with no way to bring them back. Enrolment is explicit and
    // archiving is the tracker's own "stop showing this person", so
    // dismissals simply don't apply when it's on.
    interviewerTraining: config.trainingTrackerEnabled
      ? snap.interviewerTraining
      : snap.interviewerTraining.filter(keepInterviewer),
    offersNotYetSent: snap.offersNotYetSent.filter(keepCandidate),
    offersAwaitingAcceptance: snap.offersAwaitingAcceptance.filter(keepCandidate),
    offersSigned: snap.offersSigned.filter(keepCandidate),
  };
}

// Which sections each kind of dismissal key can hide a row from.
function hiddenKeys() {
  return {
    candidateKeys: CANDIDATE_NOTE_KEYS,
    interviewerKeys: config.trainingTrackerEnabled ? ["interviewerLimits"] : ["interviewerLimits", "interviewerTraining"],
    disabledSections: config.disabledSections,
  };
}

// The name on the dashboard for a dismissal key right now (null if it's on
// nothing), saved with a dismissal so the Hidden & snoozed tab can still name
// it after it drops off the dashboard.
function nameForKey(key) {
  const [entry] = hiddenEntries([{ key }], snapshot, hiddenKeys());
  return (entry && entry.name) || null;
}

// Every candidate-keyed section key applyDismissals' keepCandidate filter
// above applies to — reused here so a note is attached to a candidate
// wherever they appear. Interviewer Weekly Limits/Training are keyed by
// userId, not candidateId, and have no note concept, so neither is in this
// list.
const CANDIDATE_NOTE_KEYS = [
  "feedbackOverdue",
  "needsScheduling",
  "recentSourced",
  "availabilitySubmitted",
  "onsiteToday",
  "interviewsToday",
  "rescheduledInterviews",
  "offersNotYetSent",
  "offersAwaitingAcceptance",
  "offersSigned",
];

// Attaches each candidate's locally-stored note (see notes.js) at serve
// time, same as applyDismissals above, so a saved/deleted note takes effect
// on the very next poll. Deliberately runs independently of
// applyDismissals — it doesn't consult dismissals.isDismissed at all — so a
// note's presence is never gated on, or cleared by, dismiss/undismiss/a
// snooze expiring. Run AFTER applyDismissals (on whatever survives that
// filter) purely so there's less to map over, not because ordering affects
// the result either way.
function applyNotes(snap) {
  const withNote = (x) => ({ ...x, note: notes.get(x.candidateId) });
  const result = { ...snap };
  for (const key of CANDIDATE_NOTE_KEYS) {
    result[key] = (snap[key] || []).map(withNote);
  }
  return result;
}

// Training progress is recomputed at serve time, not refresh time, from the
// last refresh's cached Ashby data plus the CURRENT store state - so an
// enrol/pause/override/manual credit lands on the very next poll instead of
// up to REFRESH_INTERVAL_MINUTES later. Exactly the reasoning behind
// applyDismissals/applyNotes above. Before the first successful refresh
// there's nothing cached yet, and the snapshot's own values are served
// unchanged.
function applyTraining(snap) {
  if (!config.trainingTrackerEnabled) return snap;
  const fresh = require("./training/compute").recompute();
  return fresh ? { ...snap, ...fresh } : snap;
}

function applyReminders(snap) {
  return reminderHistory ? reminderHistory.apply(snap) : snap;
}

function getSnapshot() {
  return {
    ...applyReminders(applyNotes(applyDismissals(applyTraining(snapshot)))),
    lastUpdated,
    lastError,
    // Shallow-copied, unlike snapshot's own fields above — those get
    // replaced wholesale by group.assign() (a new array/object reassigned
    // to snapshot.<key>, never mutated in place), so a caller's earlier
    // getSnapshot() result is naturally immune to a later refresh. sectionStatus
    // is mutated in place instead (`sectionStatus[key] = {...}` on the same
    // object), so without this copy, any caller holding onto a snapshot
    // across an await would see a LATER refresh's values silently bleed
    // into what should have been a frozen-in-time result (confirmed via a
    // test harness that captured a mid-refresh snapshot, then awaited the
    // rest of the cycle before asserting on it — the earlier capture had
    // already changed underneath it). No route in server.js currently has
    // an await between calling this and serializing the response, so this
    // isn't reachable today, but it's a correctness footgun waiting for the
    // first one that does.
    sectionStatus: { ...sectionStatus },
  };
}

module.exports = { start, getSnapshot, refresh, nameForKey, reminderHistory };
