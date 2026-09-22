"use strict";
/**
 * Pre-trial sessions. Meant to be edited by coordinators.
 *
 * These are interviews that sit on the Work Trial *stage* in Ashby but happen
 * BEFORE the work trial itself. They are real sessions, they belong on the
 * card, and they must never set the trial date.
 *
 * Why this list has to exist at all: Ashby gives us no way to ask "is this
 * session part of the trial day". The stage is the only grouping, and the stage
 * holds both. So the distinction is made by interview TITLE, matched
 * case-insensitively on a substring — the same signal, and the same limitation,
 * as bots/ashby-panel.config.js. If someone renames an interview in Ashby, add
 * the new name here.
 *
 * CLASSIFY BY IDENTITY, NEVER BY DATE ORDER. "Skip the earliest session" is
 * wrong: on 3 Sept 2026 the shadowing was the *only* booked session on Sid
 * Panjwani's row, and skipping the first session would have left nothing, when
 * the correct reading was "shadowing 3 Sept, work trial not yet booked".
 *
 * Anything NOT listed here is treated as a core trial session. That is
 * deliberate: a session nobody has classified must not be silently dropped from
 * the trial date. But where an unlisted session is the *sole* basis for a trial
 * date, the row says so rather than asserting the date — see lib/trialwindow.js.
 *
 * Each entry carries a reason, who decided and when — the same fields the
 * pool-health suppressions carry. A session excluded from the trial date with no
 * note is how someone later mistakes a deliberate exclusion for this exact bug
 * coming back.
 */
module.exports = {
  /**
   * titleContains — matched against the interview title, case-insensitive
   *                 substring. First match wins.
   * label         — what the card calls this session.
   * reason        — why it is not the trial date
   * decidedBy     — who decided
   * decidedOn     — YYYY-MM-DD, so the card can show how old the decision is
   */
  sessions: [
    {
      titleContains: "agent shadow",
      label: "Agent shadowing",
      reason:
        "happens before the candidate comes onsite, so it is never the start of the trial. " +
        "Counting it as the trial date read Sid Panjwani's 8 Sept trial as 3 Sept and posted " +
        "him as an urgent unprepped trial three times.",
      decidedBy: "Tess Wicks",
      decidedOn: "2026-09-02",
    },
    {
      titleContains: "product demo",
      label: "Product Demo",
      reason:
        "a screening session that sits on the Work Trial stage but happens before the trial. " +
        "It carried the whole trial date on Danni El Tayeb's row and on Preston Vaughn's, whose " +
        "1-session Product Demo on 31 Aug read as the trial instead of the 10-session day on " +
        "10 Sept. Where a Product Demo is the ONLY session booked, the row now derives no trial " +
        "date at all rather than asserting a date that is not the trial.",
      decidedBy: "Hayley Samuels",
      decidedOn: "2026-09-09",
    },
  ],
};
