"use strict";

const store = require("./store");
const progress = require("./progress");
const titleCache = require("./interviewTitleCache");
const { mapWithConcurrency } = require("../concurrency");

// Ties the persisted store, the pure progress rules, and Ashby's interview
// titles together into the one payload the dashboard renders.
//
// Called from ashby.js's listIssues() with the schedules and applications it
// has ALREADY fetched, so the whole tracker costs no extra interviewSchedule
// or application.info calls. The only calls it can make on its own are
// interview.info lookups for interview titles it has never seen, and those
// are cached permanently (see interviewTitleCache.js).

// Resolves titles for every interview referenced by a completed event.
// `fetchInterview` is injected (rather than requiring ashby.js) purely to
// keep this module free of a circular dependency - ashby.js requires this
// one. Failures are swallowed per interview: an unresolvable title degrades
// the picker's labels, it never breaks counting, which runs off interviewIds.
// How many unseen interview titles to resolve in a single refresh cycle.
//
// Bounded deliberately: a cold cache faces ~360 unseen interviews at Forus,
// and that refresh cycle is ALREADY rate-limited by its ~1,800
// application.info calls (confirmed live - 429s with backoff on a first
// run). Dumping another 360 calls into it would make an existing problem
// worse for every other section on the page.
//
// Capping is safe because titles only feed the path PICKER and the
// duplicate-interview suggestion. Counting runs off resolved interviewIds
// and is completely unaffected by an unresolved title, so a cold cache warms
// over a few cycles rather than degrading anything.
const TITLE_RESOLVE_LIMIT_PER_CYCLE = 60;

async function resolveInterviewTitles(interviewIds, fetchInterview) {
  const allUnknown = titleCache.missing(interviewIds);
  if (!allUnknown.length) return titleCache.asMap();

  const unknown = allUnknown.slice(0, TITLE_RESOLVE_LIMIT_PER_CYCLE);
  console.log(
    `[training] resolving ${unknown.length} unseen interview title(s)` +
      (allUnknown.length > unknown.length ? `, ${allUnknown.length - unknown.length} deferred to a later cycle` : "")
  );
  await mapWithConcurrency(unknown, 6, async (id) => {
    try {
      const result = await fetchInterview(id);
      if (result && result.title) titleCache.set(id, result.title);
    } catch (err) {
      console.warn(`[training] interview.info failed for ${id}:`, err.message);
    }
  });
  titleCache.flush();
  return titleCache.asMap();
}

// Every (interview title, job) pair that actually got scheduled in the
// lookback window - this is what the "add a path" picker offers.
//
// Built from observed events rather than from interview.list on purpose:
// interview.list returns only a fraction of an org's interviews (103 of 364
// at Forus), and most of what it does return is dormant - all 8 of Forus's
// "[Forus] Coding Interview" records produced zero events in 60 days.
// Offering the full catalogue would bury the handful of interviews anyone
// actually trains on.
function pathOptions({ schedules, jobByApplicationId, interviewTitleById, existingPaths, now }) {
  const events = progress.completedEvents(schedules, now);
  const claimed = new Set();
  for (const p of existingPaths) for (const id of p.interviewIds) claimed.add(`${id}:${p.jobId}`);

  const byKey = new Map();
  for (const event of events) {
    const title = interviewTitleById.get(event.interviewId);
    const job = jobByApplicationId.get(event.applicationId);
    if (!title || !job) continue;
    const key = `${title} ${job.jobId}`;
    const entry = byKey.get(key) || {
      interviewTitle: title,
      jobId: job.jobId,
      jobTitle: job.jobTitle,
      interviewIds: new Set(),
      eventCount: 0,
      shadowedEventCount: 0,
      alreadyConfigured: false,
    };
    entry.interviewIds.add(event.interviewId);
    entry.eventCount += 1;
    // Events with more than one interviewer are where shadowing can happen
    // at all - surfaced so the picker can lead with interviews that plausibly
    // involve training, rather than one-on-one screens that never do.
    if (event.interviewerUserIds.length > 1) entry.shadowedEventCount += 1;
    if (claimed.has(`${event.interviewId}:${job.jobId}`)) entry.alreadyConfigured = true;
    byKey.set(key, entry);
  }

  return [...byKey.values()]
    .map((e) => ({ ...e, interviewIds: [...e.interviewIds], label: `${e.interviewTitle} - ${e.jobTitle}` }))
    .sort((a, b) => b.shadowedEventCount - a.shadowedEventCount || b.eventCount - a.eventCount);
}

// The last refresh's inputs, kept so progress can be recomputed at SERVE
// time without re-fetching anything from Ashby.
//
// This is what makes a pause/override/enrol visible on the very next poll
// instead of up to REFRESH_INTERVAL_MINUTES later - the same reason
// issues.js applies dismissals and notes at serve time rather than at
// refresh time. Recomputing is pure in-memory work over the cached events
// (roughly 2,300 events against a few dozen enrolments), so it is cheap
// enough to run on every /api/issues poll.
let lastInputs = null;

// Recomputes from the last refresh's Ashby data and the CURRENT store state.
// Returns null before the first successful refresh, in which case callers
// keep serving whatever the snapshot already holds.
function recompute() {
  if (!lastInputs) return null;
  const now = Date.now();
  const paths = store.listPaths();
  const entries = progress.computeTraining({
    schedules: lastInputs.schedules,
    jobByApplicationId: lastInputs.jobByApplicationId,
    paths,
    enrolments: store.listEnrolments(),
    ashbyTraining: lastInputs.ashbyNativeTraining || [],
    now,
    stalledAfterDays: lastInputs.stalledAfterDays,
  });
  return {
    interviewerTraining: entries,
    trainingPaths: paths,
    trainingPathOptions: pathOptions({
      schedules: lastInputs.schedules,
      jobByApplicationId: lastInputs.jobByApplicationId,
      interviewTitleById: titleCache.asMap(),
      existingPaths: paths,
      now,
    }),
    trainingSuggestions: progress.suggestedPathInterviews({
      schedules: lastInputs.schedules,
      jobByApplicationId: lastInputs.jobByApplicationId,
      paths,
      interviewTitleById: titleCache.asMap(),
      now,
    }),
  };
}

/**
 * @param {object[]} schedules           raw interviewSchedule.list results
 * @param {Map}      jobByApplicationId  applicationId -> { jobId, jobTitle }
 * @param {object[]} ashbyNativeTraining ashby.listInterviewerTraining() results, cross-check only
 * @param {function} fetchInterview      async (interviewId) => interview.info results
 * @param {number}   stalledAfterDays
 */
async function build({ schedules, jobByApplicationId, ashbyNativeTraining, fetchInterview, stalledAfterDays }) {
  const now = Date.now();
  const paths = store.listPaths();
  const enrolments = store.listEnrolments();

  const events = progress.completedEvents(schedules, now);
  const interviewTitleById = await resolveInterviewTitles(
    events.map((e) => e.interviewId),
    fetchInterview
  );

  lastInputs = { schedules, jobByApplicationId, ashbyNativeTraining, stalledAfterDays };

  const entries = progress.computeTraining({
    schedules,
    jobByApplicationId,
    paths,
    enrolments,
    ashbyTraining: ashbyNativeTraining || [],
    now,
    stalledAfterDays,
  });

  return {
    interviewerTraining: entries,
    trainingPaths: paths,
    trainingPathOptions: pathOptions({ schedules, jobByApplicationId, interviewTitleById, existingPaths: paths, now }),
    trainingSuggestions: progress.suggestedPathInterviews({
      schedules,
      jobByApplicationId,
      paths,
      interviewTitleById,
      now,
    }),
  };
}

module.exports = { build, recompute, pathOptions, resolveInterviewTitles };
