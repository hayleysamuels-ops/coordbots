"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "coordmetrics-alerts-"));
process.env.CLIENTS = "acme";
process.env.ASHBY_API_KEY_ACME = "test-key";
process.env.CLIENT_TIMEZONE_ACME = "America/New_York";
process.env.SLACK_BOT_TOKEN = "";
process.env.CARRARA_COORDINATORS_ACME = "Maggie Stout";

const store = require("../src/db");
const metrics = require("../src/metrics");
const alerts = require("../src/alerts");

const DAY = 86400000;
const HOUR = 3600000;

// Midday UTC N days ago — well clear of any local-midnight edge in New York.
function at(daysAgo, plusHours = 0) {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setUTCHours(16, 0, 0, 0);
  return new Date(d.getTime() + plusHours * HOUR).toISOString();
}

let seq = 0;
// One interview, booked `waitHours` after the candidate entered the stage.
function seed({ daysAgo, waitHours, by = "Maggie Stout", feedback = true }) {
  seq += 1;
  const [first, last] = by.split(" ");
  store.writeSchedulePage(
    "acme",
    [
      {
        id: `sch-${seq}`,
        status: "Complete",
        applicationId: `app-${seq}`,
        interviewStageId: "stage-1",
        scheduledBy: { id: "u1", firstName: first, lastName: last },
        createdAt: at(daysAgo),
        updatedAt: at(daysAgo),
        interviewEvents: [
          {
            id: `evt-${seq}`,
            interviewId: "int-1",
            interviewScheduleId: `sch-${seq}`,
            interviewerUserIds: ["u2"],
            createdAt: at(daysAgo),
            updatedAt: at(daysAgo),
            startTime: at(daysAgo, 2),
            endTime: at(daysAgo, 3),
            hasSubmittedFeedback: feedback,
          },
        ],
      },
    ],
    new Date().toISOString()
  );
  store.db
    .prepare("INSERT INTO application_stages (client_id, application_id, stage_id, title, stage_number, entered_at, left_at) VALUES ('acme', ?, 'stage-1', 'Screen', 1, ?, NULL)")
    .run(`app-${seq}`, at(daysAgo, -waitHours));
}

test("significant(): 15% threshold with small-number guards", () => {
  assert.strictEqual(alerts.significant(6, 5), null, "+20% but only 1 more — noise");
  assert.strictEqual(alerts.significant(2, 3), null, "both sides under the minimum baseline");
  assert.strictEqual(alerts.significant(11, 10), null, "+10% is under threshold");

  const drop = alerts.significant(7, 10);
  assert.strictEqual(drop.direction, "down");
  assert.strictEqual(drop.pct, -30);
  assert.strictEqual(drop.severity, "major", "30% is twice the threshold");

  const rise = alerts.significant(20, 17);
  assert.strictEqual(rise.severity, "notable");

  assert.strictEqual(alerts.significant(5, 10, { watch: "up" }), null, "drops ignored when only rises matter");
  assert.strictEqual(alerts.significant(10.5, 10, { kind: "hours" }), null, "under an hour of movement");
  assert.ok(alerts.significant(14, 10, { kind: "hours", watch: "up" }));
});

test("windows(): current week excludes today; four baseline weeks behind it", () => {
  const w = alerts.windows("America/New_York");
  assert.strictEqual(w.baseline.length, 4);
  assert.strictEqual(w.baseline[0].to, w.current.from);
  assert.strictEqual(w.baseline[3].from, w.earliest);
  const today = metrics.localBuckets(new Date().toISOString(), "America/New_York").day;
  assert.strictEqual(w.current.to, today);
});

test("end to end: volume drop, slower turnaround, per-coordinator, and clearing", () => {
  // Four baseline weeks: 10 interviews a week, booked 2h after request.
  for (let week = 1; week <= 4; week += 1) {
    for (let i = 0; i < 10; i += 1) seed({ daysAgo: 7 * week + 1 + (i % 6), waitHours: 2 });
  }
  // Current week: only 5 interviews, each waiting 10h to be booked.
  for (let i = 0; i < 5; i += 1) seed({ daysAgo: 1 + (i % 6), waitHours: 72 });
  // The client's own team books a pile this week. Not ours: it must not
  // mask our drop or show up as anyone's alert.
  for (let i = 0; i < 20; i += 1) seed({ daysAgo: 1 + (i % 6), waitHours: 2, by: "Client Person" });

  store.recordSyncRun("acme", "incremental", new Date().toISOString(), true, null);
  metrics.rebuild(); // runs alerts too

  const active = alerts.activeAlerts();
  const byMetric = (scope, metric) => active.find((a) => a.scope === scope && a.metric === metric);

  const volume = byMetric("client", "volume");
  assert.ok(volume, "client volume drop flagged");
  assert.strictEqual(volume.direction, "down");
  assert.match(volume.message, /we coordinated down 50%/);

  const turnaround = byMetric("client", "turnaround");
  assert.ok(turnaround, "client turnaround slowdown flagged");
  assert.match(turnaround.detail, /business hours/);

  assert.ok(byMetric("coordinator", "volume"), "Maggie's bookings drop flagged");
  assert.ok(byMetric("coordinator", "turnaround"), "Maggie's turnaround flagged");

  // Stocks have no snapshot history yet, so they stay quiet.
  assert.ok(!byMetric("client", "overdue_feedback"));

  // The banner hides coordinator alerts by default.
  assert.ok(alerts.activeAlerts({ includeCoordinators: false }).every((a) => a.scope !== "coordinator"));

  // Someone NOT on the roster never reaches client or coordinator alerts.
  assert.ok(!active.some((a) => a.subject === "Client Person"));

  // Volume recovers: top the current week back up to 10 with 2h turnarounds.
  for (let i = 0; i < 5; i += 1) seed({ daysAgo: 1 + (i % 6), waitHours: 2 });
  metrics.rebuild();
  const after = alerts.activeAlerts();
  assert.ok(!after.find((a) => a.scope === "client" && a.metric === "volume"), "volume alert cleared");
});

test("overdue scorecards alert against their own daily snapshots", () => {
  // A week and a half of history averaging 2 overdue scorecards a day.
  const insert = store.db.prepare(
    "INSERT OR REPLACE INTO alert_snapshots (client_id, metric, day, value) VALUES ('acme', 'overdue_feedback', ?, 2)"
  );
  for (let d = 1; d <= 10; d += 1) {
    insert.run(metrics.localBuckets(new Date(Date.now() - d * DAY).toISOString(), "America/New_York").day);
  }
  // Today: 8 interviews from 3 days ago with no scorecard.
  for (let i = 0; i < 8; i += 1) seed({ daysAgo: 3, waitHours: 2, feedback: false });

  alerts.evaluate();
  const fb = alerts.activeAlerts().find((a) => a.metric === "overdue_feedback");
  assert.ok(fb, "overdue scorecards flagged");
  assert.match(fb.detail, /^8 interviews/);
});

test("ended engagements never alert", () => {
  const config = require("../src/config");
  const client = config.clients.find((c) => c.id === "acme");
  client.isEnded = true;
  try {
    alerts.evaluate();
    assert.ok(alerts.activeAlerts().every((a) => a.clientId !== "acme"));
  } finally {
    client.isEnded = false;
  }
});

test("stale sync pauses a client's alerts instead of reporting a collapse", () => {
  const old = new Date(Date.now() - 3 * DAY).toISOString();
  store.db.prepare("DELETE FROM sync_runs").run();
  store.recordSyncRun("acme", "full", old, true, null);
  store.db.prepare("UPDATE sync_runs SET finished_at = ?").run(old);

  alerts.evaluate();
  const active = alerts.activeAlerts();
  assert.ok(active.find((a) => a.metric === "stale_sync"));
  assert.ok(!active.find((a) => a.scope === "client"), "client alerts resolved while data is stale");
});

test("digest text lists new and cleared alerts", () => {
  const text = alerts.digestText(
    [{ scope: "client", severity: "major", message: "Acme: interviews coordinated down 40%", detail: "6 vs 10" }],
    [{ message: "Acme: overdue scorecards up 50%" }]
  );
  assert.match(text, /1 new alert/);
  assert.match(text, /down 40%/);
  assert.match(text, /Back to normal/);
});
