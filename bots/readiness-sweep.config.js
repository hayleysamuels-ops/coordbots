"use strict";
/**
 * Bot 3 — readiness sweep. Meant to be edited by coordinators.
 *
 * The checks below mirror the tracker's own field schema: the same "done"
 * values, and the same role scope. A sweep that asked about fields the card
 * does not show would send someone looking for a control that is not there.
 *
 * ⚠ TWO SCOPES ARE WORTH A HUMAN CHECKING (they follow the card, not the brief):
 *   - AS docs, agent shadowing and the recording apply to FDE *and Sales*.
 *   - The 9pm DRI reminder applies to *every* role, not just FDS.
 * That is what the tracker shows today. Whether it is still correct is a
 * question for Sadiqeh, not a code change.
 */
// Bot 10 owns computer and desk, so its notion of an empty cell is the right
// one to test them against. Imported, not restated: two lists of what counts as
// blank would drift, and this one is already the sheet's.
const SHEET = require("./sheet-sync.config");

module.exports = {
  // Where a red item links to. #c=<rowId> opens the tracker with that card open.
  trackerBaseUrl: "https://work-trial-tracker-production.up.railway.app",

  // Slack member id of whoever is on shift, or null for nobody.
  // There is no rota in any system — shifts are informal (Tess US ET, Ria ET,
  // Cath overnight) — so this is a manual setting. Never @here.
  onShiftSlackUserId: null,

  // How often the sweep looks for due milestones.
  everyMinutes: 15,

  // A trial booked inside 72h fires on detection: its T-72 moment has already
  // passed, so it is owed immediately rather than skipped.
  milestones: [
    { key: "T-72", hoursBefore: 72 },
    { key: "T-24", hoursBefore: 24 },
  ],

  // A row with only a date (no linked Ashby schedule) has no clock time. Trials
  // start in the morning, so a date-only row is treated as starting at 09:00 PT.
  assumedStartHourPT: 9,

  /**
   * done  — values that count as finished. true means the checkbox is ticked,
   *         "*" means any non-empty text.
   * roles — which positions this applies to; omitted means all.
   */
  checks: [
    { key: "nda",              label: "NDA & Workplace Agreement", done: ["COMPLETED"] },
    { key: "rampLinear",       label: "Ramp + Linear ticket",      done: ["COMPLETED"] },
    /* Reads the real values rather than the status standing in for them.
     *
     * NOT because laptopDesk goes unmaintained. Production on 10 Sep 2026: 13
     * ASSIGNED, 1 REQUESTED, 23 empty. People do set it by hand, and an earlier
     * version of this comment said otherwise on no evidence.
     *
     * The reason is that since bot 10 started syncing columns E and G the
     * tracker holds the actual laptop and desk, and a check against the facts
     * beats a check against a status that has to be kept in step with them.
     * Both non-blank satisfies the item.
     *
     * The two signals barely overlap — 2 candidates carry both, 11 are ASSIGNED
     * with no computer or desk, 8 have a computer and desk without being
     * ASSIGNED — so this is a real change in what gets posted, not a tidy-up.
     *
     * WHY THAT IS SAFE, which is a different question from whether it is right:
     * the sweep is per candidate at T-72h and T-24h, so only candidates with an
     * upcoming trial are ever evaluated. Of the 11 rows that flip from done to
     * open, zero have an upcoming trial. The one live candidate affected is
     * Brandon Wagoner, 13 Sep, who flips from open to done, correctly. Nobody
     * gets chased for work they finished as a result of this landing.
     *
     * laptopDesk is NOT deleted or repurposed. It is still a field on the card
     * and still counts toward the progress bar via its own done list in
     * lib/fields.js. This changes what the sweep posts, nothing else.
     *
     * What was rejected, and why:
     *
     *   Mapping E/F/G onto laptopDesk would make bot 10 compute a status rather
     *   than copy a cell. Its whole model is that sheetSource records the cell a
     *   value came from, and a derived status has no cell behind it. Bot 10
     *   syncs, it does not infer.
     *
     *   Column F, "Laptop Cleared?", stays out. That is an IT clearance step,
     *   not an assignment, and folding it in here would conflate two questions.
     *
     * blankAlso is bot 10's own vocabulary for "this cell is empty", imported
     * rather than restated. Columns E and G carry the same list, so a desk
     * reading "NOT YET" is absence on both sides of the wire instead of being
     * an assignment here and a blank there.
     */
    { key: "laptopAssignment", keys: ["computer", "desk"],
      label: "Laptop & desk", done: ["*"], blankAlso: SHEET.NOT_YET_MARKERS,
      missingLabel: { computer: "no laptop", desk: "no desk" } },
    { key: "laptopChat",       label: "Laptop on Chat Slack",      done: ["YES"] },
    { key: "laptopInvites",    label: "Laptop on trial invites",   done: ["YES"] },
    { key: "calendarHold",     label: "Calendar hold sent",        done: ["YES"] },
    { key: "teamSlack",        label: "Team Slack updated",        done: ["COMPLETED"] },
    { key: "chatSlack",        label: "Chat Slack updated",        done: ["COMPLETED"] },
    /* blankAlso for the same reason as the laptop and desk item: driName is
       sheet-authoritative from column M, whose vocabulary includes "NOT YET".
       Without this, a partner literally named NOT YET counts as named — which
       is the exact swap sheet-sync.config.js was written to stop at the write
       side, left open here at the read side.
       No rows hold a marker value today (production, 10 Sep 2026), so this
       closes a gap in the code rather than changing any current answer. */
    { key: "driName",          label: "Main Partner / DRI named",  done: ["*"],
      blankAlso: SHEET.NOT_YET_MARKERS },
    // debriefRoom and presentationZoom were removed from the tracker's schema on
    // 9 Sep 2026. Their checks go with them: this sweep reads stored values
    // rather than the schema, so leaving them would have sent someone looking
    // for a control that is no longer on the card.
    { key: "himaReminder",     label: "Slack reminder for text intro", done: ["YES"] },
    { key: "fdeShareDocs",     label: "AS docs shared",            done: [true], roles: ["FDE","Sales"] },
    { key: "agentShadowSched", label: "Agent shadowing scheduled", done: ["CALL SCHEDULED","N/A"], roles: ["FDE","Sales"] },
    { key: "agentShadowRec",   label: "Agent shadow recording shared", done: ["SHARED","N/A"], roles: ["FDE","Sales"] },
    { key: "fds9pm",           label: "9pm DRI reminder",          done: [true] },
    { key: "debriefScheduled", label: "Debrief scheduled",         done: ["YES"] },
  ],
};
