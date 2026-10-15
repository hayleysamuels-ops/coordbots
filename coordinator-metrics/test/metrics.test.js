"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "coordmetrics-metrics-"));
process.env.CLIENTS = "";

const store = require("../src/db");
const { computeClient } = require("../src/metrics");

const CLIENT = {
  id: "test",
  name: "Test Client",
  timeZone: "America/New_York",
  accentColor: null,
  excludedTitleKeywords: ["hold", "work time"],
};

function iso(daysFromNow, hourUTC = 15) {
  const d = new Date(Date.now() + daysFromNow * 86400000);
  d.setUTCHours(hourUTC, 0, 0, 0);
  return d.toISOString();
}

function seedEvent({ id, startDaysFromNow, interviewId = "int-real", scheduleId, createdDaysFromNow }) {
  store.writeSchedulePage(
    CLIENT.id,
    [
      {
        id: scheduleId || `sch-${id}`,
        status: "Complete",
        applicationId: "app-1",
        interviewStageId: "stage-1",
        scheduledBy: { id: "u1", firstName: "Coord", lastName: "Inator" },
        createdAt: iso(createdDaysFromNow ?? startDaysFromNow - 3),
        updatedAt: iso(startDaysFromNow),
        interviewEvents: [
          {
            id,
            interviewId,
            interviewScheduleId: scheduleId || `sch-${id}`,
            interviewerUserIds: ["u2", "u3"],
            createdAt: iso(createdDaysFromNow ?? startDaysFromNow - 3),
            updatedAt: iso(startDaysFromNow),
            startTime: iso(startDaysFromNow, 15),
            endTime: iso(startDaysFromNow, 16),
            hasSubmittedFeedback: true,
          },
        ],
      },
    ],
    new Date().toISOString()
  );
}

test.before(() => {
  store.writeReference(CLIENT.id, {
    interviews: [
      { id: "int-real", title: "Coding Interview", isDebrief: false },
      { id: "int-debrief", title: "Debrief", isDebrief: true },
      { id: "int-hold", title: "External Hold", isDebrief: false },
    ],
    jobs: [{ id: "job-1", title: "Software Engineer", status: "Open", departmentId: "dep-1" }],
    departments: [{ id: "dep-1", name: "Engineering" }],
    stages: [{ id: "stage-1", title: "Onsite", type: "Interview" }],
  });

  store.writeApplicationPage(CLIENT.id, [
    {
      id: "app-1",
      candidate: { id: "cand-1", name: "Ada Lovelace" },
      job: { id: "job-1" },
      status: "Active",
      currentInterviewStage: { id: "stage-1", title: "Onsite" },
      createdAt: iso(-100),
      updatedAt: iso(-1),
      hiringTeam: [{ role: "Recruiting Coordinator", firstName: "Coord", lastName: "Inator" }],
    },
  ]);
});

test("counts interviews and hours inside the period", () => {
  seedEvent({ id: "ev-past-1", startDaysFromNow: -2 });
  seedEvent({ id: "ev-past-2", startDaysFromNow: -4 });

  const payload = computeClient(CLIENT);
  assert.strictEqual(payload.totals.events, 2);
  assert.strictEqual(payload.totals.hours, 2); // one hour each
  assert.strictEqual(payload.periods.week.current.events, 2);
});

test("interviews already booked for the future are not counted as work done this week", () => {
  // This is the bug this test exists for: a "last 7 days" sum with no
  // upper bound swept in everything on the calendar for next month and
  // reported it as volume delivered.
  seedEvent({ id: "ev-future", startDaysFromNow: +20 });

  const payload = computeClient(CLIENT);
  assert.strictEqual(payload.periods.week.current.events, 2, "future interview must not land in the last-7-days total");
  assert.strictEqual(payload.totals.events, 3, "but it is still part of the 12-month series");

  const futureBucket = payload.series.daily.find((row) => row.key > payload.today);
  assert.ok(futureBucket, "the future interview should still appear in the daily series so the chart can show it");
});

test("excludes holds by title but keeps debriefs", () => {
  seedEvent({ id: "ev-hold", startDaysFromNow: -3, interviewId: "int-hold" });
  seedEvent({ id: "ev-debrief", startDaysFromNow: -3, interviewId: "int-debrief" });

  const payload = computeClient(CLIENT);
  assert.strictEqual(payload.totals.excludedEvents, 1, "the hold should be excluded");
  assert.strictEqual(payload.totals.debriefs, 1, "the debrief should be counted");
  assert.strictEqual(payload.totals.events, 4, "two past + one future + the debrief, with the hold dropped");
});

test("resolves role and department through the application join", () => {
  const payload = computeClient(CLIENT);
  const role = payload.byRole.find((r) => r.title === "Software Engineer");
  assert.ok(role, "events should join through to their job");
  assert.strictEqual(role.department, "Engineering");
  assert.strictEqual(role.candidates, 1);
  assert.ok(!payload.byRole.some((r) => r.title === "Unknown role"), "nothing should fall out of the join");
});

test("counts interviewer seats, not just interviews", () => {
  const payload = computeClient(CLIENT);
  assert.strictEqual(payload.totals.interviewerSlots, payload.totals.events * 2);
  assert.strictEqual(payload.totals.averagePanelSize, 2);
});

test("a rescheduled event is recorded when its start time moves", () => {
  const before = store.db.prepare("SELECT COUNT(*) AS n FROM reschedules WHERE client_id = ?").get(CLIENT.id).n;

  // Same event id, different start time, as a later sync would see it.
  seedEvent({ id: "ev-past-1", startDaysFromNow: -1 });

  const after = store.db.prepare("SELECT COUNT(*) AS n FROM reschedules WHERE client_id = ?").get(CLIENT.id).n;
  assert.strictEqual(after, before + 1, "a changed start time should be recorded as one reschedule");
});

test("a cancelled schedule that is re-booked counts as a reschedule, not a cancellation", () => {
  const now = new Date().toISOString();

  store.writeSchedulePage(
    CLIENT.id,
    [
      {
        id: "sch-cancelled",
        status: "Cancelled",
        applicationId: "app-1",
        interviewStageId: "stage-1",
        createdAt: iso(-10),
        updatedAt: iso(-9),
        interviewEvents: [],
      },
      {
        id: "sch-rebooked",
        status: "Complete",
        applicationId: "app-1",
        interviewStageId: "stage-1",
        createdAt: iso(-8),
        updatedAt: iso(-8),
        interviewEvents: [],
      },
      {
        id: "sch-dropped",
        status: "Cancelled",
        applicationId: "app-2",
        interviewStageId: "stage-9",
        createdAt: iso(-6),
        updatedAt: iso(-5),
        interviewEvents: [],
      },
    ],
    now
  );

  const payload = computeClient(CLIENT);
  assert.strictEqual(payload.totals.reschedulesDerived, 1, "cancelled then re-booked at the same stage is a reschedule");
  assert.strictEqual(payload.totals.cancellations, 1, "cancelled with no successor is a real cancellation");
});

test("short-notice bookings are flagged separately from ordinary volume", () => {
  // Created 2 hours before it starts.
  const start = new Date(Date.now() - 86400000);
  const created = new Date(start.getTime() - 2 * 3600000);

  store.writeSchedulePage(
    CLIENT.id,
    [
      {
        id: "sch-rush",
        status: "Complete",
        applicationId: "app-1",
        interviewStageId: "stage-1",
        createdAt: created.toISOString(),
        updatedAt: start.toISOString(),
        interviewEvents: [
          {
            id: "ev-rush",
            interviewId: "int-real",
            interviewScheduleId: "sch-rush",
            interviewerUserIds: ["u2", "u3"],
            createdAt: created.toISOString(),
            updatedAt: start.toISOString(),
            startTime: start.toISOString(),
            endTime: new Date(start.getTime() + 3600000).toISOString(),
            hasSubmittedFeedback: false,
          },
        ],
      },
    ],
    new Date().toISOString()
  );

  const payload = computeClient(CLIENT);
  assert.strictEqual(payload.totals.shortNotice, 1);
});
