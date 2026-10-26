"use strict";

/**
 * The exact payload paths public/app.js dereferences.
 *
 * This exists because twice now a change passed a green unit suite and
 * still broke everything the user could see:
 *
 *   1. style.css shipped with an unterminated media query, so the browser
 *      discarded 485 of 488 lines and the page rendered unstyled.
 *   2. The scope refactor moved `totals`/`series` under `scopes.*`; one
 *      missed accessor crashed the server on boot. 37 tests passed,
 *      because none of them called computeOverview.
 *
 * Unit tests assert what a function returns. Nothing asserted that what
 * the server returns is what the page reads. That gap is this file: a
 * single declared contract, checked offline against a computed payload
 * (test/contract.test.js) and against the live deployment
 * (scripts/smoke.js), so a shape change fails in both places instead of
 * silently rendering an empty dashboard.
 *
 * `*` matches any single key, for maps keyed by period or scope.
 */

// Read from metrics so a new scope is covered by the contract the
// moment it exists, rather than when someone remembers to add it here.
const { SCOPE_KEYS } = require("./scopes");

const SCOPE_PATHS = [
  "totals.events",
  "totals.hours",
  "totals.candidates",
  "totals.roles",
  "totals.debriefs",
  "totals.meals",
  "totals.bookedAhead",
  "totals.bookedAheadHours",
  "totals.interviewerSlots",
  "totals.averagePanelSize",
  "totals.shortNotice",
  "totals.outOfHours",
  "totals.cancellations",
  "totals.reschedulesDerived",
  "totals.reschedulesObserved",
  "totals.dropOffs",
  "totals.excludedEvents",
  "totals.excludedJobEvents",
  "totals.unresolvedTitleEvents",
  "series.daily",
  "series.weekly",
  "series.monthly",
  "timeToSchedule.medianHours",
  "timeToSchedule.p90Hours",
  "timeToSchedule.sample",
  "timeToSchedule.directBookings",
  "excludedTitleBreakdown",
  "areasToWorkOn.clientAverage",
  "areasToWorkOn.byRole",
  "areasToWorkOn.byStage",
];

/**
 * The dynamic half of the contract.
 *
 * The static path list below is not enough, and this is exactly how the
 * dashboard went down twice: app.js does `payload.periods[state.period]`
 * and `payload.byRole[state.period]`, and nothing checked that the
 * runtime value of `state.period` actually resolves. The smoke test
 * certified a page that rendered "Cannot read properties of undefined
 * (reading 'current')" on load, because `periods.week` existed and it
 * never asked about the period the UI was actually set to.
 *
 * So: enumerate every (scope, period) combination the UI can reach —
 * taken from /api/config, which is now the single source of both lists —
 * and assert each one resolves. A period the server stops producing, or
 * a UI default pointing at a key that was never built, fails here.
 */
function dynamicClientPaths({ scopes, periods }) {
  const paths = [];
  for (const scope of scopes) {
    for (const period of periods) {
      // The Results group is period-keyed like the breakdowns, and the
      // page reads it through the same dynamic lookup.
      paths.push(`scopes.${scope}.results.${period}.current.bookingTurnaround.medianHours`);
      paths.push(`scopes.${scope}.results.${period}.current.stageGap.medianDays`);
      paths.push(`scopes.${scope}.results.${period}.current.shortNotice.share`);
      paths.push(`scopes.${scope}.results.${period}.current.cancellationWithoutRebook.share`);
      paths.push(`scopes.${scope}.results.${period}.current.rescheduleRate.share`);
      paths.push(`scopes.${scope}.results.${period}.deltaSuppressed`);
      paths.push(`scopes.${scope}.results.${period}.isBaseline`);
      paths.push(`scopes.${scope}.periods.${period}.current.events`);
      paths.push(`scopes.${scope}.periods.${period}.previous.events`);
      paths.push(`scopes.${scope}.periods.${period}.change.events`);
      paths.push(`scopes.${scope}.byRole.${period}`);
      paths.push(`scopes.${scope}.byStage.${period}`);
      paths.push(`scopes.${scope}.heatmap.${period}`);
    }
  }
  return paths;
}

function dynamicOverviewPaths({ scopes, periods }) {
  const paths = [];
  for (const scope of scopes) {
    for (const period of periods) {
      paths.push(`scopes.${scope}.periods.${period}.current.events`);
      paths.push(`scopes.${scope}.periods.${period}.change.events`);
    }
  }
  return paths;
}

const CLIENT_PATHS = [
  "clientId",
  "clientName",
  "timeZone",
  "generatedAt",
  "today",
  "currentWeek",
  "roster.configured",
  "roster.matched",
  "roster.unmatched",
  "roster.collisions",
  "roster.renames",
  "roster.reportUnmatched",
  "dataQuality.excludedTitleKeywords",
  "dataQuality.excludedJobTitles",
  ...SCOPE_KEYS.flatMap((scope) => SCOPE_PATHS.map((p) => `scopes.${scope}.${p}`)),
];

const OVERVIEW_SCOPE_PATHS = [
  "totals.events",
  "totals.hours",
  "totals.candidates",
  "totals.roles",
  "totals.debriefs",
  "totals.meals",
  "totals.bookedAhead",
  "totals.bookedAheadHours",
  "series.weekly",
  "byClient",
  // The window the overview header states. Taken from a live client's
  // own window rather than recomputed, so the header cannot describe a
  // range the figures were not drawn from.
  "window.from",
  "window.to",
];

const OVERVIEW_PATHS = [
  "generatedAt",
  "timeZone",
  "today",
  "currentWeek",
  "rosterUnmatchedEverywhere",
  ...SCOPE_KEYS.flatMap((scope) => OVERVIEW_SCOPE_PATHS.map((p) => `scopes.${scope}.${p}`)),
];

// Rows the by-client table renders; a missing key here is an empty column
// rather than a crash, which is exactly the kind of quiet break worth
// failing on.
const BY_CLIENT_ROW_KEYS = [
  "clientId",
  "clientName",
  "events",
  "hours",
  "candidates",
  "roles",
  "cancellations",
  "reschedules",
  "thisWeek",
  "lastWeek",
  "group",
  "status",
  "weekChange",
  "allEvents",
  "coordinatedEvents",
];

function resolve(object, path) {
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), object);
}

/** Returns the paths that are missing (undefined). `null` counts as present. */
function missingPaths(payload, paths) {
  return paths.filter((path) => resolve(payload, path) === undefined);
}

module.exports = {
  dynamicClientPaths,
  dynamicOverviewPaths,
  CLIENT_PATHS,
  OVERVIEW_PATHS,
  SCOPE_PATHS,
  BY_CLIENT_ROW_KEYS,
  missingPaths,
  resolve,
};
