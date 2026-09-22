"use strict";
/**
 * Bot 1 — live Ashby panel. Meant to be edited by coordinators; it is all
 * plain lists and plain strings, matched case-insensitively.
 *
 * Everything matched here is matched on a TITLE, because the Ashby API does not
 * expose interviewer-pool wiring on any endpoint. There is no way to ask "which
 * interview draws from the Agent Shadowing pool", so the interview's own title
 * is the only available signal. If someone renames an interview in Ashby, add
 * the new name here.
 */
module.exports = {
  // Ashby job title  ->  the tracker's Position value. First match wins.
  positions: [
    { jobTitleContains: "forward deployed engineer", position: "FDE" },
    { jobTitleContains: "forward deployed strategist", position: "FDS" },
    { jobTitleContains: "sales", position: "Sales" },
  ],

  // Interview stage titles. These exist in the FDE, FDS and Sales plans.
  workTrialStageContains: "work trial",
  // The prior-stage screen the tracker calls "Exception BG screen" (EBS).
  // Sales has no such stage, so Sales trials will show "n/a".
  ebsStageContains: "exceptional background",

  // Interview titles inside the work trial schedule.
  agentShadowTitleContains: "agent shadow", // FDE (and Sales) only
  // debriefTitleContains was removed on 11 Sep. It matched
  // "FDS WT: Runbook QA Debrief", a session inside the FDS trial, and switched
  // off the debrief reminder for every FDS candidate on that plan. Ashby's
  // isDebrief flag is the only signal now. Do not reintroduce a title match
  // here: the workspace has exactly one interview with the flag set, and the
  // word "debrief" in a title has been shown not to mean it.

  // How long a fetched panel is considered fresh.
  cacheMinutes: 15,

  /**
   * Suggestion strip: how long after a trial ends it still counts as live work.
   * A trial that finished two days ago still needs a debrief booked and feedback
   * chased. One from six weeks ago is somebody parked at the stage — worth
   * knowing about, but not a row to create today.
   *
   * Candidates past this window are not hidden, only moved behind an expandable
   * line at the bottom of the strip.
   */
  suggestRecentDays: 7,

  // Row flag: nobody has touched the row for this many days AND the trial starts
  // within this many days. A display state only — nothing is written.
  // This is deliberately blunt. Bot 3 answers "what exactly is incomplete";
  // this only answers "has anyone looked at this candidate lately".
  flagUntouchedDays: 3,
  flagTrialWithinDays: 5,
};
