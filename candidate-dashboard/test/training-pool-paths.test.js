"use strict";

const test = require("node:test");
const assert = require("node:assert");
const progress = require("../src/training/progress");

// Two paths sharing an interview title AND job, separated only by interviewer
// pool. This is Forus's Bug Bash case: Python and JavaScript are the same
// Ashby interview record on the same job, and the pool is recorded on only
// ~43% of events.

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const DAY = 86400000;
const TRAINEE = "user-trainee";
const TRAINER = "user-trainer";
const JOB = "job-swe";
const INTERVIEW = "interview-bugbash";
const PY = "pool-python";
const JS = "pool-javascript";

const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function event({ id, daysAgo = 5, pools = [], interviewers = [TRAINER, TRAINEE], status = "Complete" }) {
  return {
    id: `sched-${id}`,
    status,
    applicationId: "app-1",
    interviewEvents: [
      {
        id,
        interviewId: INTERVIEW,
        startTime: iso(daysAgo * DAY),
        endTime: iso(daysAgo * DAY - 3600000),
        interviewerUserIds: interviewers,
        interviewers: interviewers.map((u, i) => ({
          id: u,
          firstName: u,
          lastName: "",
          email: `${u}@x.com`,
          ...(pools[i] ? { interviewerPool: { id: pools[i], title: pools[i] } } : {}),
        })),
      },
    ],
  };
}

const pythonPath = {
  id: "path-py", label: "Bug Bash (Python)", interviewTitle: "Bug Bash",
  interviewIds: [INTERVIEW], jobId: JOB, jobTitle: "SWE",
  interviewerPoolId: PY, interviewerPoolTitle: "Bug Bash Engineers - Python",
  requiredShadows: 2, requiredReverseShadows: 2,
};
const jsPath = {
  ...pythonPath, id: "path-js", label: "Bug Bash (JavaScript)",
  interviewerPoolId: JS, interviewerPoolTitle: "Bug Bash Engineers - Javascript",
};

function enrolment(pathId, overrides = {}) {
  return {
    userId: TRAINEE, userName: "Trainee", userEmail: "t@x.com", pathId,
    enrolledAt: iso(90 * DAY), requiredShadows: null, requiredReverseShadows: null,
    state: "active", pause: null, archivedAt: null, sessionOverrides: {}, manualCredits: [],
    ...overrides,
  };
}

function run(schedules, enrolments, paths = [pythonPath, jsPath], eventPaths = {}) {
  return progress.computeTraining({
    schedules,
    jobByApplicationId: new Map([["app-1", { jobId: JOB, jobTitle: "SWE" }]]),
    paths, enrolments, ashbyTraining: [], now: NOW, stalledAfterDays: 30, eventPaths,
  });
}

test("a recorded pool sends the session to the matching path only", () => {
  const results = run([event({ id: "e1", pools: [PY, null] })], [enrolment("path-py"), enrolment("path-js")]);
  const py = results.find((r) => r.pathId === "path-py");
  const js = results.find((r) => r.pathId === "path-js");
  assert.strictEqual(py.shadows, 1, "Python path counts it");
  assert.strictEqual(js.sessions.length, 0, "JavaScript path must not even see it");
});

test("a session recorded against the sibling's pool is excluded, not left ambiguous", () => {
  const [js] = run([event({ id: "e1", pools: [PY, null] })], [enrolment("path-js")]);
  assert.strictEqual(js.sessions.length, 0);
  assert.strictEqual(js.needsPathChoice, 0);
});

test("no recorded pool, trainee on one path only: counted and labelled as assumed", () => {
  const [py] = run([event({ id: "e1" })], [enrolment("path-py")]);
  assert.strictEqual(py.shadows, 1);
  assert.strictEqual(py.poolAssumed, 1);
  assert.strictEqual(py.sessions[0].poolAssumed, true);
  assert.strictEqual(py.needsPathChoice, 0);
});

test("no recorded pool, trainee on BOTH paths: asked, and counted by neither", () => {
  const results = run([event({ id: "e1" })], [enrolment("path-py"), enrolment("path-js")]);
  assert.ok(results.every((r) => r.shadows === 0), "must not advance either path");
  assert.ok(results.every((r) => r.needsPathChoice === 1));
  const choices = results[0].sessions[0].pathChoices.map((c) => c.pathId).sort();
  assert.deepStrictEqual(choices, ["path-js", "path-py"]);
});

test("assigning an ambiguous event counts it for that path and removes it from the sibling", () => {
  const results = run(
    [event({ id: "e1" })],
    [enrolment("path-py"), enrolment("path-js")],
    [pythonPath, jsPath],
    { e1: "path-js" }
  );
  const py = results.find((r) => r.pathId === "path-py");
  const js = results.find((r) => r.pathId === "path-js");
  assert.strictEqual(js.shadows, 1, "assigned path counts it");
  assert.strictEqual(py.sessions.length, 0, "sibling must not see it at all");
  assert.ok(results.every((r) => r.needsPathChoice === 0));
});

test("an assignment pointing at a path the trainee isn't on counts for nobody", () => {
  const results = run([event({ id: "e1" })], [enrolment("path-py")], [pythonPath, jsPath], { e1: "path-js" });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].sessions.length, 0);
});

test("a path with no pool filter is unaffected by any of this", () => {
  const open = { ...pythonPath, id: "path-open", interviewerPoolId: null, interviewerPoolTitle: "" };
  const [r] = run([event({ id: "e1", pools: [JS, null] })], [enrolment("path-open")], [open]);
  assert.strictEqual(r.shadows, 1, "an unscoped path claims the session regardless of pool");
  assert.strictEqual(r.poolAssumed, 0);
});

test("the pool filter still respects cancellation and the enrolment cutoff", () => {
  const cancelled = run([event({ id: "c", pools: [PY, null], status: "Cancelled" })], [enrolment("path-py")]);
  assert.strictEqual(cancelled[0].sessions.length, 0);

  const tooEarly = run([event({ id: "old", pools: [PY, null], daysAgo: 120 })], [enrolment("path-py")]);
  assert.strictEqual(tooEarly[0].sessions.length, 0);
});

test("a discounted ambiguous session stops asking", () => {
  const results = run(
    [event({ id: "e1" })],
    [enrolment("path-py", { sessionOverrides: { e1: { discounted: true } } }), enrolment("path-js")]
  );
  const py = results.find((r) => r.pathId === "path-py");
  assert.strictEqual(py.needsPathChoice, 0);
  assert.strictEqual(py.sessions[0].counts, false);
});

test("sibling detection pairs only paths sharing an interview AND a job", () => {
  const otherJob = { ...jsPath, id: "path-other-job", jobId: "job-different" };
  const map = progress.siblingPathsByPathId([pythonPath, jsPath, otherJob]);
  assert.deepStrictEqual(map.get("path-py").map((p) => p.id), ["path-js"]);
  assert.deepStrictEqual(map.get("path-other-job").map((p) => p.id), []);
});

test("the sole-interviewer check still fires inside a pool-scoped path", () => {
  const [py] = run([event({ id: "solo", pools: [PY], interviewers: [TRAINEE] })], [enrolment("path-py")]);
  assert.strictEqual(py.needsConfirmation, 1);
  assert.strictEqual(py.shadows, 0);
});
