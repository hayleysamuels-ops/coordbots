"use strict";

/**
 * The offline half of the payload contract.
 *
 * scripts/smoke.js checks the deployed server against the same declared
 * paths; this checks a locally computed payload, so a shape change fails
 * at `npm test` rather than after a deploy. It exists because the scope
 * refactor moved `totals` and `series` under `scopes.*` and nothing in
 * the suite noticed that the page could no longer read them.
 */

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "coordmetrics-contract-"));
process.env.CLIENTS = "";

const store = require("../src/db");
const metrics = require("../src/metrics");
const configModule = require("../src/config");
const {
  CLIENT_PATHS,
  OVERVIEW_PATHS,
  BY_CLIENT_ROW_KEYS,
  dynamicClientPaths,
  dynamicOverviewPaths,
  missingPaths,
  resolve,
} = require("../src/payload-contract");

const SCOPE_KEYS = ["all", "coordinated"];

const CLIENT = {
  id: "contract",
  name: "Contract Client",
  timeZone: "America/New_York",
  accentColor: null,
  excludedTitleKeywords: ["hold"],
  excludedJobTitles: ["test"],
  coordinators: ["Anna Jones"],
  hasOwnRoster: true,
};

function iso(daysFromNow, hourUTC = 15) {
  const d = new Date(Date.now() + daysFromNow * 86400000);
  d.setUTCHours(hourUTC, 0, 0, 0);
  return d.toISOString();
}

test.before(() => {
  store.writeReference(CLIENT.id, {
    interviews: [{ id: "i1", title: "Coding Interview", isDebrief: false }],
    jobs: [{ id: "j1", title: "Engineer", status: "Open", departmentId: "d1" }],
    departments: [{ id: "d1", name: "Engineering" }],
    stages: [{ id: "st1", title: "Onsite", type: "Interview" }],
  });
  store.writeApplicationPage(CLIENT.id, [
    { id: "a1", candidate: { id: "c1", name: "X" }, job: { id: "j1" }, status: "Active",
      createdAt: iso(-60), updatedAt: iso(-1), hiringTeam: [] },
  ]);
  store.writeSchedulePage(CLIENT.id, [{
    id: "s1", status: "Complete", applicationId: "a1", interviewStageId: "st1",
    createdAt: iso(-4), updatedAt: iso(-3),
    scheduledBy: { id: "u1", firstName: "Anna", lastName: "Jones", email: "anna@x.com" },
    interviewEvents: [{
      id: "e1", interviewId: "i1", interviewScheduleId: "s1", interviewerUserIds: ["x", "y"],
      createdAt: iso(-4), updatedAt: iso(-3), startTime: iso(-3, 15), endTime: iso(-3, 16),
      hasSubmittedFeedback: true,
    }],
  }], new Date().toISOString());
});

test("a client payload exposes every path app.js reads", () => {
  const payload = metrics.computeClient(CLIENT);
  const missing = missingPaths(payload, CLIENT_PATHS);
  assert.deepStrictEqual(missing, [], `app.js would read undefined at: ${missing.join(", ")}`);
});

test("the overview payload exposes every path app.js reads", () => {
  const original = configModule.clients.slice();
  configModule.clients.length = 0;
  configModule.clients.push(CLIENT);
  try {
    metrics.rebuild();
    const overview = metrics.getOverview();
    const missing = missingPaths(overview, OVERVIEW_PATHS);
    assert.deepStrictEqual(missing, [], `app.js would read undefined at: ${missing.join(", ")}`);

    // The overview has its OWN period loop, separate from the per-client
    // one. It was missed when "12 months" was added, so the landing tab
    // threw for two and a half hours while the client tabs were fine.
    const dyn = missingPaths(overview, dynamicOverviewPaths({ scopes: SCOPE_KEYS, periods: metrics.PERIOD_KEYS }));
    assert.deepStrictEqual(dyn, [], `overview undefined at: ${dyn.join(", ")}`);

    const onLoad = resolve(overview, `scopes.coordinated.periods.${metrics.DEFAULT_PERIOD}.current.events`);
    assert.ok(Number.isFinite(onLoad), "overview does not render in its default state");

    for (const scope of ["all", "coordinated"]) {
      for (const row of overview.scopes[scope].byClient) {
        const absent = BY_CLIENT_ROW_KEYS.filter((k) => row[k] === undefined);
        assert.deepStrictEqual(absent, [], `by-client row missing columns: ${absent.join(", ")}`);
      }
    }
  } finally {
    configModule.clients.length = 0;
    configModule.clients.push(...original);
  }
});

test("a client payload resolves for every period the UI can select", () => {
  // The static path list is not enough: app.js reads
  // payload.periods[state.period] dynamically, and a period the server
  // never built is undefined at render time. That exact gap took the
  // dashboard down twice — once with periods.all missing from the
  // per-client loop, then again with it missing from the overview loop.
  const payload = metrics.computeClient(CLIENT);
  const missing = missingPaths(payload, dynamicClientPaths({ scopes: SCOPE_KEYS, periods: metrics.PERIOD_KEYS }));
  assert.deepStrictEqual(missing, [], `undefined at: ${missing.join(", ")}`);
});

test("a client payload renders in the DEFAULT state the page loads in", () => {
  const payload = metrics.computeClient(CLIENT);
  const onLoad = resolve(payload, `scopes.coordinated.periods.${metrics.DEFAULT_PERIOD}.current.events`);
  assert.ok(Number.isFinite(onLoad), `default period "${metrics.DEFAULT_PERIOD}" does not resolve on first paint`);
});

test("the server's default period is one it actually produces", () => {
  assert.ok(
    metrics.PERIOD_KEYS.includes(metrics.DEFAULT_PERIOD),
    `default period "${metrics.DEFAULT_PERIOD}" is not in ${metrics.PERIOD_KEYS.join(", ")}`
  );
});

test("no period key collides with a scope key", () => {
  // "all" meaning both "every scope" and "the full window" is what made
  // the collision invisible twice. Keep the two vocabularies disjoint.
  const clash = metrics.PERIOD_KEYS.filter((k) => SCOPE_KEYS.includes(k));
  assert.deepStrictEqual(clash, [], `period key(s) also used as scope keys: ${clash.join(", ")}`);
});

test("headline numbers are real numbers, not NaN or undefined", () => {
  const payload = metrics.computeClient(CLIENT);
  for (const scope of ["all", "coordinated"]) {
    const t = payload.scopes[scope].totals;
    for (const key of ["events", "hours", "candidates", "roles", "interviewerSlots"]) {
      assert.ok(Number.isFinite(t[key]), `scopes.${scope}.totals.${key} is ${t[key]}`);
    }
  }
  assert.strictEqual(payload.scopes.all.totals.events, 1);
  assert.strictEqual(payload.scopes.coordinated.totals.events, 1);
});
