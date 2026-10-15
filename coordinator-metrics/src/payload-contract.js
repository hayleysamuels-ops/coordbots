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

const SCOPE_PATHS = [
  "totals.events",
  "totals.hours",
  "totals.candidates",
  "totals.roles",
  "totals.debriefs",
  "totals.meals",
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
  "periods.week.current.events",
  "periods.week.previous.events",
  "periods.week.change.events",
  "periods.month.current.events",
  "periods.quarter.current.events",
  "periods.all.current.events",
  "series.daily",
  "series.weekly",
  "series.monthly",
  "byRole.week",
  "byRole.month",
  "byRole.quarter",
  "byRole.all",
  "byStage.all",
  "heatmap.all",
  "timeToSchedule.medianHours",
  "timeToSchedule.p90Hours",
  "timeToSchedule.sample",
  "timeToSchedule.directBookings",
  "excludedTitleBreakdown",
];

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
  ...["all", "coordinated"].flatMap((scope) => SCOPE_PATHS.map((p) => `scopes.${scope}.${p}`)),
];

const OVERVIEW_SCOPE_PATHS = [
  "totals.events",
  "totals.hours",
  "totals.candidates",
  "totals.roles",
  "totals.debriefs",
  "totals.meals",
  "periods.week.current.events",
  "periods.week.change.events",
  "series.weekly",
  "byClient",
];

const OVERVIEW_PATHS = [
  "generatedAt",
  "timeZone",
  "today",
  "currentWeek",
  "rosterUnmatchedEverywhere",
  ...["all", "coordinated"].flatMap((scope) => OVERVIEW_SCOPE_PATHS.map((p) => `scopes.${scope}.${p}`)),
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
  CLIENT_PATHS,
  OVERVIEW_PATHS,
  SCOPE_PATHS,
  BY_CLIENT_ROW_KEYS,
  missingPaths,
  resolve,
};
