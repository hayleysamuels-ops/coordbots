"use strict";
/**
 * The trial-date derivation, focused on what happens when every session on a
 * schedule is excluded.
 *
 * The rule these pin: an excluded session is never a fallback. A row with only
 * a Product Demo booked has no trial date — not the demo's date with a warning
 * attached, which is how "a session that is not the trial became the trial
 * date" kept coming back under new names.
 */
const { test } = require("node:test");
const assert = require("node:assert");

const { deriveTrialWindow } = require("../lib/trialwindow");
const PRE_TRIAL = require("../bots/pre-trial-sessions.config");

const STAGE = "stage-wt";
const ev = (interviewId, day, h) => ({
  interviewId,
  startTime: day + "T" + String(h).padStart(2, "0") + ":00:00.000Z",
  endTime: day + "T" + String(h + 1).padStart(2, "0") + ":00:00.000Z",
});
const sched = (id, status, events) => ({
  id, status, interviewStageId: STAGE, interviewEvents: events,
});
const TITLES = {
  demo: { title: "Product Demo", isDebrief: false },
  shadow: { title: "Agent Shadowing", isDebrief: false },
  core1: { title: "Working Session", isDebrief: false },
  core2: { title: "Pairing", isDebrief: false },
  debrief: { title: "Debrief", isDebrief: true },
};
const derive = (schedules) => deriveTrialWindow({
  schedules, stageId: STAGE,
  titleOf: (id) => TITLES[id] || null,
  preTrialSessions: PRE_TRIAL.sessions,
});

test("Product Demo is on the exclusion list, matched on title", () => {
  const rules = PRE_TRIAL.sessions.map((s) => s.titleContains);
  assert.ok(rules.includes("product demo"), "expected a product demo rule, got " + rules.join(", "));
  PRE_TRIAL.sessions.forEach((s) => {
    assert.ok(s.reason && s.decidedBy && s.decidedOn,
      s.titleContains + " must carry a reason, who decided and when");
  });
});

test("a row whose only session is a Product Demo derives no trial date", () => {
  const out = derive([sched("s1", "Scheduled", [ev("demo", "2026-09-10", 17)])]);

  assert.equal(out.trial.start, null, "no date at all");
  assert.equal(out.trial.end, null);
  assert.equal(out.trial.scheduleId, null);
  assert.equal(out.trial.sessionCount, 0);

  // The session does not vanish — somebody still has to run it.
  assert.equal(out.preTrial.length, 1);
  assert.equal(out.preTrial[0].label, "Product Demo");
  assert.equal(out.preTrial[0].start, "2026-09-10T17:00:00.000Z");
  assert.ok(out.preTrial[0].reason, "and it says why it is not the trial");
});

test("no date is returned WITH a flag pretending otherwise", () => {
  const out = derive([sched("s1", "Scheduled", [ev("demo", "2026-09-10", 17)])]);
  const codes = out.flags.map((f) => f.code);
  assert.ok(!codes.includes("unclassified_session"),
    "a single excluded session is classified, not unclassified: " + codes.join(", "));
  assert.equal(out.trial.start, null, "and the date stays absent");
});

test("an excluded session is never a fallback, even as the only thing booked", () => {
  // Both kinds of exclusion, nothing else. Still no trial date.
  const out = derive([
    sched("s1", "Scheduled", [ev("demo", "2026-09-10", 17)]),
    sched("s2", "Scheduled", [ev("shadow", "2026-09-08", 14)]),
  ]);
  assert.equal(out.trial.start, null);
  assert.equal(out.preTrial.length, 2);
  assert.deepEqual(out.preTrial.map((p) => p.label), ["Agent shadowing", "Product Demo"]);
});

test("a real trial alongside a Product Demo keeps the real trial's window", () => {
  const out = derive([
    sched("s-demo", "Complete", [ev("demo", "2026-08-31", 16)]),
    sched("s-trial", "Scheduled", [
      ev("core1", "2026-09-14", 16), ev("core2", "2026-09-14", 18), ev("core1", "2026-09-15", 16),
    ]),
  ]);
  assert.equal(out.trial.start, "2026-09-14T16:00:00.000Z");
  assert.equal(out.trial.end, "2026-09-15T17:00:00.000Z");
  assert.equal(out.trial.sessionCount, 3);
  assert.deepEqual(out.preTrial.map((p) => p.label), ["Product Demo"]);
  // The demo schedule has no core sessions, so it is not a rival trial schedule.
  assert.equal(out.otherTrial.length, 0);
  assert.ok(!out.flags.map((f) => f.code).includes("multiple_trial_schedules"));
});

test("a Product Demo booked inside the trial schedule is split out, not counted", () => {
  const out = derive([sched("s1", "Scheduled", [
    ev("demo", "2026-09-12", 16),      // earlier, and excluded
    ev("core1", "2026-09-14", 16),
    ev("core2", "2026-09-14", 18),
  ])]);
  assert.equal(out.trial.start, "2026-09-14T16:00:00.000Z", "the demo does not pull the start earlier");
  assert.equal(out.trial.sessionCount, 2);
  assert.deepEqual(out.preTrial.map((p) => p.label), ["Product Demo"]);
});

test("agent shadowing is still excluded — the original case", () => {
  const out = derive([
    sched("s-shadow", "Scheduled", [ev("shadow", "2026-09-03", 14)]),
    sched("s-trial", "Scheduled", [ev("core1", "2026-09-08", 16), ev("core2", "2026-09-08", 18)]),
  ]);
  assert.equal(out.trial.start, "2026-09-08T16:00:00.000Z");
  assert.deepEqual(out.preTrial.map((p) => p.label), ["Agent shadowing"]);
});

test("an unlisted single session is still treated as the trial, and flagged", () => {
  // The exclusion list is not a licence to drop anything unclassified: an
  // unknown session stays core, with the warning that it may not be the trial.
  const out = derive([sched("s1", "Scheduled", [ev("core1", "2026-09-10", 16)])]);
  assert.equal(out.trial.start, "2026-09-10T16:00:00.000Z");
  assert.ok(out.flags.map((f) => f.code).includes("unclassified_session"));
});
