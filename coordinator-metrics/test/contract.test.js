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
const { CLIENT_PATHS, OVERVIEW_PATHS, BY_CLIENT_ROW_KEYS, missingPaths } = require("../src/payload-contract");

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
