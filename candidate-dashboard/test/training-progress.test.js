"use strict";

const test = require("node:test");
const assert = require("node:assert");

const progress = require("../src/training/progress");

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const DAY = 86400000;
const TRAINEE = "user-trainee";
const TRAINER = "user-trainer";
const JOB = "job-backend";
const INTERVIEW = "interview-coding-a";

function iso(msAgo) {
  return new Date(NOW - msAgo).toISOString();
}

// One finished, non-cancelled event with the trainee on the panel alongside a
// real interviewer - the shape a shadow actually takes in Ashby.
function event({ id, daysAgo, interviewers = [TRAINER, TRAINEE], interviewId = INTERVIEW, status = "Complete", applicationId = "app-1" }) {
  return {
    id: `sched-${id}`,
    status,
    applicationId,
    interviewEvents: [
      {
        id,
        interviewId,
        startTime: iso(daysAgo * DAY),
        endTime: iso(daysAgo * DAY - 3600000),
        interviewerUserIds: interviewers,
        interviewers: interviewers.map((u) => ({ id: u, firstName: u, lastName: "", email: `${u}@x.com` })),
      },
    ],
  };
}

const PATH = {
  id: "path-1",
  label: "Coding Interview - Backend Engineer",
  interviewTitle: "Coding Interview",
  interviewIds: [INTERVIEW],
  jobId: JOB,
  jobTitle: "Backend Engineer",
  requiredShadows: 2,
  requiredReverseShadows: 2,
};

function enrolment(overrides = {}) {
  return {
    userId: TRAINEE,
    userName: "Trainee Person",
    userEmail: "trainee@x.com",
    pathId: "path-1",
    enrolledAt: iso(60 * DAY),
    requiredShadows: null,
    requiredReverseShadows: null,
    state: "active",
    pause: null,
    archivedAt: null,
    sessionOverrides: {},
    manualCredits: [],
    ...overrides,
  };
}

function run(schedules, enrolments = [enrolment()], paths = [PATH], ashbyTraining = []) {
  return progress.computeTraining({
    schedules,
    jobByApplicationId: new Map([
      ["app-1", { jobId: JOB, jobTitle: "Backend Engineer" }],
      ["app-other-job", { jobId: "job-other", jobTitle: "Other Role" }],
    ]),
    paths,
    enrolments,
    ashbyTraining,
    now: NOW,
    stalledAfterDays: 30,
  });
}

test("the sequence rule assigns the first two sessions as shadows and the next two as reverse shadows", () => {
  const [result] = run([
    event({ id: "e1", daysAgo: 20 }),
    event({ id: "e2", daysAgo: 15 }),
    event({ id: "e3", daysAgo: 10 }),
    event({ id: "e4", daysAgo: 5 }),
  ]);

  assert.strictEqual(result.shadows, 2);
  assert.strictEqual(result.reverseShadows, 2);
  assert.deepStrictEqual(
    result.sessions.map((s) => s.role),
    ["Shadow", "Shadow", "ReverseShadow", "ReverseShadow"]
  );
  assert.strictEqual(result.state, "complete");
  assert.strictEqual(result.complete, true);
});

test("sessions are classified in chronological order, not the order Ashby returned them", () => {
  const [result] = run([
    event({ id: "late", daysAgo: 2 }),
    event({ id: "early", daysAgo: 30 }),
  ]);
  assert.deepStrictEqual(result.sessions.map((s) => s.eventId), ["early", "late"]);
});

test("a cancelled schedule never counts", () => {
  const [result] = run([
    event({ id: "e1", daysAgo: 10 }),
    event({ id: "cancelled", daysAgo: 5, status: "Cancelled" }),
  ]);
  assert.strictEqual(result.shadows, 1);
  assert.strictEqual(result.sessions.length, 1);
});

test("an interview that has not finished yet does not count", () => {
  const future = event({ id: "future", daysAgo: 0 });
  future.interviewEvents[0].endTime = new Date(NOW + DAY).toISOString();
  const [result] = run([future]);
  assert.strictEqual(result.sessions.length, 0);
});

test("a session for the same interview on a different job does not count", () => {
  const [result] = run([event({ id: "wrong-job", daysAgo: 5, applicationId: "app-other-job" })]);
  assert.strictEqual(result.sessions.length, 0);
});

test("a session on a different interview does not count", () => {
  const [result] = run([event({ id: "other", daysAgo: 5, interviewId: "interview-somewhere-else" })]);
  assert.strictEqual(result.sessions.length, 0);
});

test("sessions before the enrolment date do not count automatically", () => {
  const [result] = run([event({ id: "old", daysAgo: 90 }), event({ id: "new", daysAgo: 5 })]);
  assert.strictEqual(result.sessions.length, 1);
  assert.strictEqual(result.sessions[0].eventId, "new");
});

test("a trainee who was the only interviewer is flagged for confirmation instead of counted", () => {
  // They ran the interview rather than shadowing it - Ashby cannot tell the
  // difference, so this must not silently advance their progress.
  const [result] = run([event({ id: "solo", daysAgo: 5, interviewers: [TRAINEE] })]);
  assert.strictEqual(result.needsConfirmation, 1);
  assert.strictEqual(result.shadows, 0);
  assert.strictEqual(result.sessions[0].counts, false);
});

test("confirming an ambiguous session by setting its role makes it count", () => {
  const [result] = run(
    [event({ id: "solo", daysAgo: 5, interviewers: [TRAINEE] })],
    [enrolment({ sessionOverrides: { solo: { role: "Shadow" } } })]
  );
  assert.strictEqual(result.needsConfirmation, 0);
  assert.strictEqual(result.shadows, 1);
});

test("a discounted session is excluded - the manual stand-in for Ashby having no RSVP data", () => {
  const [result] = run(
    [event({ id: "e1", daysAgo: 10 }), event({ id: "noshow", daysAgo: 5 })],
    [enrolment({ sessionOverrides: { noshow: { discounted: true } } })]
  );
  assert.strictEqual(result.shadows, 1);
  assert.strictEqual(result.sessions.find((s) => s.eventId === "noshow").counts, false);
});

test("an explicit role override wins over the sequence rule and consumes from its own bucket", () => {
  const [result] = run(
    [
      event({ id: "e1", daysAgo: 20 }),
      event({ id: "e2", daysAgo: 15 }),
      event({ id: "e3", daysAgo: 10 }),
    ],
    [enrolment({ sessionOverrides: { e1: { role: "ReverseShadow" } } })]
  );
  assert.strictEqual(result.reverseShadows, 1);
  assert.strictEqual(result.shadows, 2);
  assert.strictEqual(result.sessions.find((s) => s.eventId === "e1").role, "ReverseShadow");
});

test("a session during a pause is recorded and flagged but does not count, and does not unpause", () => {
  const [result] = run(
    [event({ id: "during-pause", daysAgo: 2 })],
    [enrolment({ state: "paused", pause: { at: iso(10 * DAY), reason: "On leave", expectedReturn: null } })]
  );
  assert.strictEqual(result.state, "paused");
  assert.strictEqual(result.pendingDuringPause, 1);
  assert.strictEqual(result.shadows, 0);
  assert.strictEqual(result.sessions.length, 1, "the session is recorded, not discarded");
});

test("a session from before the pause began still counts", () => {
  const [result] = run(
    [event({ id: "before-pause", daysAgo: 20 })],
    [enrolment({ state: "paused", pause: { at: iso(10 * DAY), reason: "", expectedReturn: null } })]
  );
  assert.strictEqual(result.shadows, 1);
  assert.strictEqual(result.pendingDuringPause, 0);
});

test("a per-person requirement override replaces the path's requirement", () => {
  const [result] = run(
    [event({ id: "e1", daysAgo: 10 }), event({ id: "e2", daysAgo: 5 })],
    [enrolment({ requiredShadows: 1, requiredReverseShadows: 1 })]
  );
  assert.deepStrictEqual(result.requirements, { shadows: 1, reverseShadows: 1 });
  assert.strictEqual(result.hasRequirementOverride, true);
  assert.strictEqual(result.complete, true, "1 + 1 is enough for an overridden trainee");
});

test("manual credits count toward their stated role and are not re-sequenced", () => {
  const [result] = run(
    [event({ id: "e1", daysAgo: 5 })],
    [
      enrolment({
        manualCredits: [
          { id: "c1", role: "Shadow", at: iso(40 * DAY), note: "before we started tracking" },
          { id: "c2", role: "ReverseShadow", at: iso(35 * DAY), note: "" },
        ],
      }),
    ]
  );
  assert.strictEqual(result.reverseShadows, 1);
  assert.strictEqual(result.shadows, 2, "one manual shadow plus the derived session");
});

test("an active trainee with no recent session is stalled; a paused one never is", () => {
  const [active] = run([event({ id: "old", daysAgo: 45 })]);
  assert.strictEqual(active.stalled, true);
  assert.strictEqual(active.daysSinceActivity, 45);

  const [paused] = run(
    [event({ id: "old", daysAgo: 45 })],
    [enrolment({ state: "paused", pause: { at: iso(1 * DAY), reason: "", expectedReturn: null } })]
  );
  assert.strictEqual(paused.stalled, false);
});

test("recency is measured from the last session that happened, even one that did not count", () => {
  const [result] = run(
    [event({ id: "counted", daysAgo: 50 }), event({ id: "discounted", daysAgo: 2 })],
    [enrolment({ sessionOverrides: { discounted: { discounted: true } } })]
  );
  assert.strictEqual(result.daysSinceActivity, 2, "they were used 2 days ago, whether or not it counted");
  assert.strictEqual(result.stalled, false);
});

test("a trainee with no sessions at all measures recency from their enrolment date", () => {
  const [result] = run([], [enrolment({ enrolledAt: iso(40 * DAY) })]);
  assert.strictEqual(result.daysSinceActivity, 40);
  assert.strictEqual(result.stalled, true);
});

test("an archived enrolment stays archived regardless of progress", () => {
  const [result] = run(
    [event({ id: "e1", daysAgo: 20 }), event({ id: "e2", daysAgo: 15 }), event({ id: "e3", daysAgo: 10 }), event({ id: "e4", daysAgo: 5 })],
    [enrolment({ state: "archived", archivedAt: iso(DAY) })]
  );
  assert.strictEqual(result.state, "archived");
});

test("an enrolment whose path no longer exists is dropped rather than crashing", () => {
  const results = run([event({ id: "e1", daysAgo: 5 })], [enrolment({ pathId: "path-deleted" })]);
  assert.strictEqual(results.length, 0);
});

test("two enrolled trainees on the same event both get credit", () => {
  const second = "user-trainee-2";
  const results = run(
    [event({ id: "shared", daysAgo: 5, interviewers: [TRAINER, TRAINEE, second] })],
    [enrolment(), enrolment({ userId: second, userName: "Second Trainee" })]
  );
  assert.strictEqual(results.length, 2);
  assert.ok(results.every((r) => r.shadows === 1));
});

test("Ashby's native training path is attached as a cross-check and flags disagreement", () => {
  const native = {
    userId: TRAINEE,
    poolTitle: "Bug Bash Engineers - Javascript",
    stageRole: "Shadow",
    interviewsCompleted: 0,
    interviewsRequired: 1,
    isPaused: true,
  };
  const [result] = run([event({ id: "e1", daysAgo: 5 })], [enrolment()], [PATH], [native]);

  assert.strictEqual(result.ashbyNative.poolTitle, "Bug Bash Engineers - Javascript");
  assert.ok(
    result.disagreements.some((d) => d.includes("Ashby has them paused")),
    "Ashby says paused, the tracker says active - that has to surface"
  );
  assert.strictEqual(result.shadows, 1, "Ashby's own count never feeds the tracker's count");
});

test("no Ashby native entry means no disagreements, not a false one", () => {
  const [result] = run([event({ id: "e1", daysAgo: 5 })]);
  assert.deepStrictEqual(result.disagreements, []);
  assert.strictEqual(result.ashbyNative, undefined);
});

test("a new same-titled Ashby interview record for the same job is suggested, not absorbed", () => {
  const suggestions = progress.suggestedPathInterviews({
    schedules: [event({ id: "e1", daysAgo: 5, interviewId: "interview-coding-b" })],
    jobByApplicationId: new Map([["app-1", { jobId: JOB, jobTitle: "Backend Engineer" }]]),
    paths: [PATH],
    interviewTitleById: new Map([
      [INTERVIEW, "Coding Interview"],
      ["interview-coding-b", "Coding Interview"],
    ]),
    now: NOW,
  });
  assert.strictEqual(suggestions.length, 1);
  assert.strictEqual(suggestions[0].interviewId, "interview-coding-b");
  assert.strictEqual(suggestions[0].pathId, "path-1");
});

test("a same-titled interview on a different job is not suggested", () => {
  const suggestions = progress.suggestedPathInterviews({
    schedules: [event({ id: "e1", daysAgo: 5, interviewId: "interview-coding-b", applicationId: "app-other-job" })],
    jobByApplicationId: new Map([["app-other-job", { jobId: "job-other", jobTitle: "Other Role" }]]),
    paths: [PATH],
    interviewTitleById: new Map([[INTERVIEW, "Coding Interview"], ["interview-coding-b", "Coding Interview"]]),
    now: NOW,
  });
  assert.deepStrictEqual(suggestions, []);
});
