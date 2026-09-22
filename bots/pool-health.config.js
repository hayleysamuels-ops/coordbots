"use strict";
/**
 * Bot 6 — pool health report. This file is meant to be edited by coordinators.
 * Nothing here needs a code change to understand; it is plain lists.
 */
module.exports = {
  // A pool is in the report if its title contains this...
  titleContains: "Work Trial",

  // ...or if it is named here exactly. Use this for pools that belong in the
  // report but are not named "Work Trial ...".
  extraIncludes: [
    "FDE Onsite Presentation Attendee",
  ],

  // Pools to leave out entirely, even if they match the rule above.
  excludes: [],

  // Someone appearing in this many of the pools is flagged under Concentration.
  concentrationThreshold: 3,

  /**
   * Checks to switch off completely. A check listed here never appears in the
   * report, for any pool or person, now or in future — it is not an
   * acknowledgement of today's findings, it turns the question off.
   *
   * Valid checks: "unstaffable" | "spof" | "concentration" | "newly-paused"
   *               | "capacity"
   *
   * Each entry carries a reason, who decided and when — the same fields a
   * suppression carries. A check switched off with no note is how someone later
   * mistakes a deliberate silence for a bug, or for a suppression that was never
   * agreed.
   *
   * The report footer lists whatever is switched off, and the Slack thread shows
   * the reason and how old the decision is, so a quiet report is never mistaken
   * for a clean week. Delete an entry here to turn a check back on.
   */
  disabledChecks: [
    {
      check: "spof",
      reason: "static finding, already documented in the August brief",
      decidedBy: "Hayley Samuels",
      decidedOn: "2026-08-31",
    },
  ],

  /**
   * Known and accepted findings. These drop out of the report body and collapse
   * into one line at the bottom, expandable in the Slack thread.
   *
   *   check   — which finding to suppress: "unstaffable" | "spof" |
   *             "concentration" | "newly-paused" | "capacity"
   *   pool    — pool title it applies to (omit for person-only suppressions)
   *   person  — person's name it applies to (used by "concentration")
   *   reason      — why this is accepted
   *   decidedBy   — who decided
   *   decidedOn   — YYYY-MM-DD, so the report can show how old the decision is
   *
   * A suppression hides ONE check for ONE target. Suppressing "unstaffable" for
   * a pool does not hide that same pool showing up as a single point of failure.
   */
  suppressions: [
    {
      check: "unstaffable",
      pool: "FDE Work Trial - Laptop",
      reason: "laptops are not assigned through Ashby pools",
      decidedBy: "Poetic IT",
      decidedOn: "2026-08-28",
    },
    {
      // Same accepted fact as above, applied to the capacity section so the
      // pool stops appearing as "0/wk" every week.
      check: "capacity",
      pool: "FDE Work Trial - Laptop",
      reason: "laptops are not assigned through Ashby pools, so it has no capacity to report",
      decidedBy: "Hayley Samuels",
      decidedOn: "2026-08-31",
    },
  ],

  // Acknowledgements older than this get a "worth revisiting" marker.
  staleSuppressionMonths: 6,
};
