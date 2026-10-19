"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "coordmetrics-metrics-"));
process.env.CLIENTS = "";

const store = require("../src/db");
const { computeClient: computeFull } = require("../src/metrics");

// The payload is split into scopes (all vs. Carrara-coordinated) with the
// client-level fields hoisted above them. These tests assert on the
// unfiltered scope, so this flattens it back to the shape they read.
function computeClient(client) {
  const payload = computeFull(client);
  return {
    ...payload.scopes.all,
    dataQuality: { ...payload.dataQuality, excludedTitleBreakdown: payload.scopes.all.excludedTitleBreakdown },
    today: payload.today,
    roster: payload.roster,
    scopes: payload.scopes,
  };
}

const CLIENT = {
  id: "test",
  name: "Test Client",
  timeZone: "America/New_York",
  accentColor: null,
  excludedTitleKeywords: ["hold", "work time"],
  excludedJobTitles: [],
  engagement: "carrara-scheduled",
  status: "active",
  isEnded: false,
  engagementStart: null,
  engagementEnd: null,
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
  assert.strictEqual(payload.totals.events, 2, "nor in the headline total — every total counts work DONE");
  assert.strictEqual(payload.totals.bookedAhead, 1, "it is counted separately as work already on the calendar");

  const futureBucket = payload.series.daily.find((row) => row.key > payload.today);
  assert.ok(futureBucket, "the future interview should still appear in the daily series so the chart can show it");
});

test("excludes holds by title but keeps debriefs", () => {
  seedEvent({ id: "ev-hold", startDaysFromNow: -3, interviewId: "int-hold" });
  seedEvent({ id: "ev-debrief", startDaysFromNow: -3, interviewId: "int-debrief" });

  const payload = computeClient(CLIENT);
  assert.strictEqual(payload.totals.excludedEvents, 1, "the hold should be excluded");
  assert.strictEqual(payload.totals.debriefs, 1, "the debrief should be counted");
  assert.strictEqual(payload.totals.events, 3, "two past + the debrief; the hold is dropped and the future one is booked-ahead");
  assert.strictEqual(payload.totals.bookedAhead, 1);
});

test("resolves role and department through the application join", () => {
  const payload = computeClient(CLIENT);
  const role = payload.byRole.full.find((r) => r.title === "Software Engineer");
  assert.ok(role, "events should join through to their job");
  assert.strictEqual(role.department, "Engineering");
  assert.strictEqual(role.candidates, 1);
  assert.ok(!payload.byRole.full.some((r) => r.title === "Unknown role"), "nothing should fall out of the join");
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

// --- Role grouping ---------------------------------------------------------
//
// These pin the answers to a real audit of Luminai's Ashby job records:
// "Forward Deployed Engineer" exists three times at three levels, two
// "Deployment Strategist" reqs share a title exactly, several titles carry
// trailing whitespace, and a "TEST PIPELINE" req on Runlayer had collected
// two real interview events.

const ROLE_CLIENT = { ...CLIENT, id: "roles", excludedJobTitles: ["test", "test pipeline"] };

function seedJobEvent({ id, jobId, jobTitle, openedAt, startDaysFromNow = -3 }) {
  store.writeReference(ROLE_CLIENT.id, {
    interviews: [{ id: "int-real", title: "Coding Interview", isDebrief: false }],
    jobs: [{ id: jobId, title: jobTitle, status: "Open", departmentId: null, openedAt }],
    departments: [],
    stages: [],
  });
  store.writeApplicationPage(ROLE_CLIENT.id, [
    {
      id: `app-${id}`,
      candidate: { id: `cand-${id}`, name: "Someone" },
      job: { id: jobId },
      status: "Active",
      createdAt: iso(-100),
      updatedAt: iso(-1),
      hiringTeam: [],
    },
  ]);
  store.writeSchedulePage(
    ROLE_CLIENT.id,
    [
      {
        id: `sch-${id}`,
        status: "Complete",
        applicationId: `app-${id}`,
        interviewStageId: "stage-1",
        createdAt: iso(startDaysFromNow - 1),
        updatedAt: iso(startDaysFromNow),
        interviewEvents: [
          {
            id,
            interviewId: "int-real",
            interviewScheduleId: `sch-${id}`,
            interviewerUserIds: ["u2"],
            createdAt: iso(startDaysFromNow - 1),
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

test("related job titles are three rows, never merged into the parent role", () => {
  seedJobEvent({ id: "r-fde", jobId: "job-fde", jobTitle: "Forward Deployed Engineer", openedAt: iso(-300) });
  seedJobEvent({ id: "r-lead", jobId: "job-lead", jobTitle: "Forward Deployed Engineer, Team Lead", openedAt: iso(-200) });
  seedJobEvent({ id: "r-grad", jobId: "job-grad", jobTitle: "Forward Deployed Engineer - New Grad ", openedAt: iso(-250) });

  const payload = computeClient(ROLE_CLIENT);
  const fde = payload.byRole.full.filter((r) => r.title.startsWith("Forward Deployed Engineer"));
  assert.strictEqual(fde.length, 3, "three job records must stay three rows");
  assert.ok(fde.every((r) => r.events === 1), "each keeps its own count");
});

test("trailing whitespace is trimmed for display but never changes grouping", () => {
  const payload = computeClient(ROLE_CLIENT);
  assert.ok(
    payload.byRole.full.some((r) => r.title === "Forward Deployed Engineer - New Grad"),
    "the stored title ends in a space; the rendered one must not"
  );
  assert.ok(!payload.byRole.full.some((r) => r.title !== r.title.trim()), "no rendered title keeps stray whitespace");
});

test("two job records with the same title are numbered, oldest req first", () => {
  seedJobEvent({ id: "r-ds-old", jobId: "job-ds-old", jobTitle: "Deployment Strategist", openedAt: iso(-400) });
  seedJobEvent({ id: "r-ds-new", jobId: "job-ds-new", jobTitle: "Deployment Strategist", openedAt: iso(-50) });

  const payload = computeClient(ROLE_CLIENT);
  const ds = payload.byRole.full.filter((r) => r.title.startsWith("Deployment Strategist"));
  assert.strictEqual(ds.length, 2);
  assert.deepStrictEqual(
    ds.map((r) => r.title).sort(),
    ["Deployment Strategist (1)", "Deployment Strategist (2)"],
    "identical titles must be distinguishable on the page"
  );
  assert.strictEqual(ds.find((r) => r.title.endsWith("(1)")).jobId, "job-ds-old", "oldest req numbered first");
});

test("a test req is excluded from every total, not just hidden from the table", () => {
  const before = computeClient(ROLE_CLIENT);
  seedJobEvent({ id: "r-test", jobId: "job-test", jobTitle: "TEST PIPELINE", openedAt: iso(-100) });
  const after = computeClient(ROLE_CLIENT);

  assert.strictEqual(after.totals.events, before.totals.events, "a test req must not inflate the interview count");
  assert.strictEqual(after.totals.roles, before.totals.roles, "nor the role count");
  assert.strictEqual(after.totals.excludedJobEvents, 1, "and the exclusion is reported, not silent");
  assert.ok(!after.byRole.full.some((r) => r.title.toLowerCase().includes("test")));
});

test("exclusion is an exact title match, so a real Test Engineer role survives", () => {
  seedJobEvent({ id: "r-testeng", jobId: "job-testeng", jobTitle: "Test Engineer", openedAt: iso(-100) });

  const payload = computeClient(ROLE_CLIENT);
  assert.ok(
    payload.byRole.full.some((r) => r.title === "Test Engineer"),
    "a substring rule would have silently deleted this genuine role"
  );
});

// --- Unresolvable interview definitions ------------------------------------
//
// interview.list does not return every definition an org uses, and no flag
// makes it: Luminai's events referenced 118 ids it omits, Forus's 785,
// covering 88% of its events. An event with no resolvable title cannot be
// tested against the hold keywords, so holds get counted as interviews —
// silently, which is the part that matters.

const RESOLVE_CLIENT = { ...CLIENT, id: "resolve", excludedTitleKeywords: ["hold", "lunch"], excludedJobTitles: [] };

test("an event whose definition is missing is reported, not treated as a non-hold", () => {
  store.writeReference(RESOLVE_CLIENT.id, {
    interviews: [{ id: "known", title: "Coding Interview", isDebrief: false }],
    jobs: [{ id: "job-1", title: "Engineer", status: "Open" }],
    departments: [],
    stages: [],
  });
  store.writeApplicationPage(RESOLVE_CLIENT.id, [
    { id: "app-1", candidate: { id: "c1", name: "A" }, job: { id: "job-1" }, status: "Active",
      createdAt: iso(-50), updatedAt: iso(-1), hiringTeam: [] },
  ]);

  const mk = (id, interviewId) => ({
    id: `sch-${id}`, status: "Complete", applicationId: "app-1", interviewStageId: "stage-1",
    createdAt: iso(-4), updatedAt: iso(-3),
    interviewEvents: [{
      id, interviewId, interviewScheduleId: `sch-${id}`, interviewerUserIds: ["u1"],
      createdAt: iso(-4), updatedAt: iso(-3), startTime: iso(-3, 15), endTime: iso(-3, 16),
      hasSubmittedFeedback: true,
    }],
  });

  store.writeSchedulePage(RESOLVE_CLIENT.id, [mk("ev-known", "known"), mk("ev-missing", "not-in-our-table")], new Date().toISOString());

  const payload = computeClient(RESOLVE_CLIENT);
  assert.strictEqual(payload.totals.unresolvedTitleEvents, 1, "the untestable event must be counted and surfaced");
  assert.strictEqual(payload.totals.events, 2, "it still counts as an interview — it is real, just unnamed");
});

test("resolving the definition lets the hold rule finally apply to it", () => {
  // Exactly what syncInterviewDefinitions does: fill in the missing row.
  store.writeReference(RESOLVE_CLIENT.id, {
    interviews: [{ id: "not-in-our-table", title: "External Hold", isDebrief: false }],
  });

  const payload = computeClient(RESOLVE_CLIENT);
  assert.strictEqual(payload.totals.unresolvedTitleEvents, 0, "nothing is unresolvable any more");
  assert.strictEqual(payload.totals.events, 1, "the hold is now correctly excluded from the interview count");
  assert.strictEqual(payload.totals.excludedEvents, 1);
});

test("the excluded-title breakdown names what the keywords actually caught", () => {
  const payload = computeClient(RESOLVE_CLIENT);
  assert.deepStrictEqual(
    payload.dataQuality.excludedTitleBreakdown,
    [{ title: "External Hold", count: 1 }],
    "a keyword swallowing a real interview type has to be visible, not just counted"
  );
});

test("definition resolution records when it last ran, so staleness is visible", () => {
  store.setMeta(RESOLVE_CLIENT.id, "interview_definitions_resolved_at", "2026-10-15T12:00:00.000Z");
  const payload = computeClient(RESOLVE_CLIENT);
  assert.strictEqual(payload.dataQuality.definitionsResolvedAt, "2026-10-15T12:00:00.000Z");
});

// --- Meals -----------------------------------------------------------------

test("a candidate meal counts as an interview and is named as a sub-count", () => {
  // Checked against Forus's live data: all 469 meal events are attached to
  // a named candidate's application, 463 sit in an Onsite stage, and the
  // median has two interviewers. That is coordinated candidate time, not a
  // logistics block — but the total should still say what is inside it.
  const MEAL_CLIENT = { ...CLIENT, id: "meals", excludedTitleKeywords: ["hold", "work time"], excludedJobTitles: [] };

  store.writeReference(MEAL_CLIENT.id, {
    interviews: [
      { id: "m-lunch", title: "[Forus] Team Lunch", isDebrief: false },
      { id: "m-code", title: "Coding Interview", isDebrief: false },
      { id: "m-hold", title: "External Hold", isDebrief: false },
    ],
    jobs: [{ id: "job-1", title: "Engineer", status: "Open" }],
    departments: [],
    stages: [],
  });
  store.writeApplicationPage(MEAL_CLIENT.id, [
    { id: "app-1", candidate: { id: "c1", name: "A" }, job: { id: "job-1" }, status: "Active",
      createdAt: iso(-50), updatedAt: iso(-1), hiringTeam: [] },
  ]);

  const mk = (id, interviewId) => ({
    id: `sch-${id}`, status: "Complete", applicationId: "app-1", interviewStageId: "stage-1",
    createdAt: iso(-4), updatedAt: iso(-3),
    interviewEvents: [{
      id, interviewId, interviewScheduleId: `sch-${id}`, interviewerUserIds: ["u1", "u2"],
      createdAt: iso(-4), updatedAt: iso(-3), startTime: iso(-3, 15), endTime: iso(-3, 16),
      hasSubmittedFeedback: true,
    }],
  });
  store.writeSchedulePage(MEAL_CLIENT.id, [mk("e-lunch", "m-lunch"), mk("e-code", "m-code"), mk("e-hold", "m-hold")], new Date().toISOString());

  const payload = computeClient(MEAL_CLIENT);
  assert.strictEqual(payload.totals.events, 2, "the lunch and the interview count; the hold does not");
  assert.strictEqual(payload.totals.meals, 1, "and the lunch is labelled so the composition is visible");
  assert.strictEqual(payload.totals.excludedEvents, 1, "only the hold is excluded");
});

// --- Period-scoped breakdowns ----------------------------------------------

test("by-role, by-stage and heatmap are scoped per period, not just the full window", () => {
  const P = { ...CLIENT, id: "periods", excludedTitleKeywords: [], excludedJobTitles: [] };

  store.writeReference(P.id, {
    interviews: [{ id: "i1", title: "Interview", isDebrief: false }],
    jobs: [{ id: "job-recent", title: "Recent Role", status: "Open" }, { id: "job-old", title: "Old Role", status: "Open" }],
    departments: [],
    stages: [{ id: "st-1", title: "Onsite", type: "Interview" }],
  });
  store.writeApplicationPage(P.id, [
    { id: "app-recent", candidate: { id: "c1", name: "A" }, job: { id: "job-recent" }, status: "Active", createdAt: iso(-300), updatedAt: iso(-1), hiringTeam: [] },
    { id: "app-old", candidate: { id: "c2", name: "B" }, job: { id: "job-old" }, status: "Active", createdAt: iso(-300), updatedAt: iso(-1), hiringTeam: [] },
  ]);

  const mk = (id, appId, days) => ({
    id: `sch-${id}`, status: "Complete", applicationId: appId, interviewStageId: "st-1",
    createdAt: iso(days - 1), updatedAt: iso(days),
    interviewEvents: [{
      id, interviewId: "i1", interviewScheduleId: `sch-${id}`, interviewerUserIds: ["u1"],
      createdAt: iso(days - 1), updatedAt: iso(days), startTime: iso(days, 15), endTime: iso(days, 16),
      hasSubmittedFeedback: true,
    }],
  });

  store.writeSchedulePage(P.id, [
    mk("ev-2d", "app-recent", -2),     // inside every period
    mk("ev-200d", "app-old", -200),    // only inside "all"
    mk("ev-future", "app-recent", +10) // booked ahead — in no breakdown
  ], new Date().toISOString());

  const payload = computeClient(P);

  for (const key of ["week", "month", "quarter", "full"]) {
    assert.ok(Array.isArray(payload.byRole[key]), `byRole.${key} must exist`);
  }

  const roles = (k) => payload.byRole[k].map((r) => r.title).sort();
  assert.deepStrictEqual(roles("week"), ["Recent Role"], "the 200-day-old event is outside 7 days");
  assert.deepStrictEqual(roles("full"), ["Old Role", "Recent Role"], "both appear over 12 months");

  const total = (k) => payload.byRole[k].reduce((a, r) => a + r.events, 0);
  assert.strictEqual(total("week"), 1);
  assert.strictEqual(total("full"), 2, "the future event is excluded from breakdowns");

  assert.strictEqual(payload.byStage.week.length, 1);
  assert.ok(payload.heatmap.full.length >= 1);

  // The future event still belongs in the time series, so the chart can
  // draw it faded.
  assert.ok(payload.series.daily.some((r) => r.key > payload.today), "future work stays in the series");
});

// --- Coordinator roster ----------------------------------------------------

test("the coordinated scope counts only rostered schedulers, and matching is exact", () => {
  const R = {
    ...CLIENT,
    id: "roster",
    excludedTitleKeywords: [],
    excludedJobTitles: [],
    // "Anna Jones" as a SUBSTRING also hits "Giovanna Borgiotti" and
    // "Hanna Rocks", who are other people. Both are real names in the
    // live data, which is why matching is exact on the normalised name.
    coordinators: ["Anna Jones", "Departed Coordinator", "Never Scheduled Here"],
  };

  store.writeReference(R.id, {
    interviews: [{ id: "i1", title: "Interview", isDebrief: false }],
    jobs: [{ id: "j1", title: "Engineer", status: "Open" }],
    departments: [],
    stages: [],
  });
  store.writeApplicationPage(R.id, [
    { id: "a1", candidate: { id: "c1", name: "X" }, job: { id: "j1" }, status: "Active",
      createdAt: iso(-60), updatedAt: iso(-1), hiringTeam: [] },
  ]);

  const mk = (id, who, whoId) => ({
    id: `s-${id}`, status: "Complete", applicationId: "a1", interviewStageId: "st",
    createdAt: iso(-4), updatedAt: iso(-3),
    scheduledBy: { id: whoId, firstName: who.split(" ")[0], lastName: who.split(" ")[1], email: `${id}@x.com` },
    interviewEvents: [{
      id, interviewId: "i1", interviewScheduleId: `s-${id}`, interviewerUserIds: ["u1"],
      createdAt: iso(-4), updatedAt: iso(-3), startTime: iso(-3, 15), endTime: iso(-3, 16),
      hasSubmittedFeedback: true,
    }],
  });

  store.writeSchedulePage(R.id, [
    mk("ev-anna", "Anna Jones", "u-anna"),
    mk("ev-giovanna", "Giovanna Borgiotti", "u-gio"),   // contains "anna"
    mk("ev-hanna", "Hanna Rocks", "u-hanna"),           // contains "anna"
    mk("ev-departed", "Departed Coordinator", "u-dep"),
  ], new Date().toISOString());

  const payload = computeFull(R);
  assert.strictEqual(payload.scopes.all.totals.events, 4, "all activity sees every scheduler");
  assert.strictEqual(
    payload.scopes.coordinated.totals.events,
    2,
    "only Anna Jones and the departed coordinator count — substring lookalikes must not"
  );
});

test("a rostered name matching nothing is reported, never silently zero", () => {
  const payload = computeFull({
    ...CLIENT, id: "roster", excludedTitleKeywords: [], excludedJobTitles: [],
    coordinators: ["Anna Jones", "Departed Coordinator", "Never Scheduled Here"],
  });
  assert.deepStrictEqual(payload.roster.unmatched, ["Never Scheduled Here"]);
  assert.strictEqual(payload.roster.matched.length, 2);
});

test("work by a coordinator who has left still counts", () => {
  const payload = computeFull({
    ...CLIENT, id: "roster", excludedTitleKeywords: [], excludedJobTitles: [],
    coordinators: ["Departed Coordinator"],
  });
  assert.strictEqual(payload.scopes.coordinated.totals.events, 1);
});

test("one rostered name on two Ashby accounts is flagged as a collision", () => {
  // Two people sharing a name would otherwise merge into one figure with
  // nothing on screen to show it.
  store.writeSchedulePage("roster", [{
    id: "s-dup", status: "Complete", applicationId: "a1", interviewStageId: "st",
    createdAt: iso(-4), updatedAt: iso(-3),
    scheduledBy: { id: "u-anna-2", firstName: "Anna", lastName: "Jones", email: "other@x.com" },
    interviewEvents: [{
      id: "ev-dup", interviewId: "i1", interviewScheduleId: "s-dup", interviewerUserIds: ["u1"],
      createdAt: iso(-4), updatedAt: iso(-3), startTime: iso(-3, 15), endTime: iso(-3, 16),
      hasSubmittedFeedback: true,
    }],
  }], new Date().toISOString());

  const payload = computeFull({
    ...CLIENT, id: "roster", excludedTitleKeywords: [], excludedJobTitles: [], coordinators: ["Anna Jones"],
  });
  assert.strictEqual(payload.roster.collisions.length, 1);
  assert.strictEqual(payload.roster.collisions[0].userIds.length, 2);
});

// --- The overview roll-up --------------------------------------------------

test("rebuild() produces a working overview for both scopes", () => {
  // This exists because the scope refactor shipped a crash: one accessor
  // inside computeOverview used a different loop-variable name and was
  // missed by the rewrite, so the server died on boot with
  // "Cannot read properties of undefined (reading 'weekly')". Every unit
  // test passed, because nothing exercised computeOverview at all.
  const metrics = require("../src/metrics");
  const configModule = require("../src/config");

  const client = {
    id: "overview-check",
    name: "Overview Check",
    timeZone: "America/New_York",
    accentColor: null,
    excludedTitleKeywords: [],
    excludedJobTitles: [],
    coordinators: ["Anna Jones"],
  };

  store.writeReference(client.id, {
    interviews: [{ id: "i1", title: "Interview", isDebrief: false }],
    jobs: [{ id: "j1", title: "Engineer", status: "Open" }],
    departments: [],
    stages: [],
  });
  store.writeApplicationPage(client.id, [
    { id: "a1", candidate: { id: "c1", name: "X" }, job: { id: "j1" }, status: "Active",
      createdAt: iso(-60), updatedAt: iso(-1), hiringTeam: [] },
  ]);
  store.writeSchedulePage(client.id, [{
    id: "s1", status: "Complete", applicationId: "a1", interviewStageId: "st",
    createdAt: iso(-4), updatedAt: iso(-3),
    scheduledBy: { id: "u-anna", firstName: "Anna", lastName: "Jones", email: "anna@x.com" },
    interviewEvents: [{
      id: "e1", interviewId: "i1", interviewScheduleId: "s1", interviewerUserIds: ["u1"],
      createdAt: iso(-4), updatedAt: iso(-3), startTime: iso(-3, 15), endTime: iso(-3, 16),
      hasSubmittedFeedback: true,
    }],
  }], new Date().toISOString());

  // rebuild() iterates config.clients, so stand this client in for them.
  const original = configModule.clients.slice();
  configModule.clients.length = 0;
  configModule.clients.push(client);
  try {
    assert.doesNotThrow(() => metrics.rebuild(), "rebuild must not throw");
    const overview = metrics.getOverview();
    assert.ok(overview, "an overview payload must exist");
    for (const scope of ["all", "coordinated"]) {
      assert.ok(overview.scopes[scope], `overview.scopes.${scope} must exist`);
      assert.ok(Array.isArray(overview.scopes[scope].series.weekly), "the weekly roll-up must be built");
      assert.ok(Array.isArray(overview.scopes[scope].byClient));
    }
    assert.strictEqual(overview.scopes.all.totals.events, 1);
    assert.strictEqual(overview.scopes.coordinated.totals.events, 1);
    assert.strictEqual(overview.scopes.all.byClient[0].coordinatedEvents, 1);
  } finally {
    configModule.clients.length = 0;
    configModule.clients.push(...original);
  }
});


// --- Headline consistency --------------------------------------------------

test("the OVERVIEW headline and full-period totals agree too", () => {
  // The per-client version of this test passed while the overview was
  // still one hour out, because computeOverview builds totals and
  // periods with two separate reducers. Covering only the client payload
  // is the same blind spot that let the overview crash ship.
  const metricsModule = require("../src/metrics");
  const configModule = require("../src/config");
  const original = configModule.clients.slice();
  configModule.clients.length = 0;
  configModule.clients.push(CLIENT);
  try {
    metricsModule.rebuild();
    const overview = metricsModule.getOverview();
    // With no ended engagements configured these must agree. Once an
    // ended client exists they deliberately diverge: volume totals
    // include it, current-period figures do not.
    for (const scope of ["all", "coordinated"]) {
      const t = overview.scopes[scope].totals;
      const full = overview.scopes[scope].periods.full.current;
      assert.strictEqual(t.events, full.events, `overview ${scope}: events must match`);
      assert.strictEqual(t.hours, Math.round(full.hours), `overview ${scope}: hours must match`);
    }
  } finally {
    configModule.clients.length = 0;
    configModule.clients.push(...original);
  }
});

test("the headline total and the full-period total agree", () => {
  // They disagreed by 410 events and 274 hours on the live dashboard,
  // under near-identical labels ("Interviews coordinated, 12 months" vs
  // "Interviews, last 12 months"), because totals counted work booked
  // ahead and periods did not.
  const payload = computeFull(CLIENT);
  for (const scope of ["all", "coordinated"]) {
    const t = payload.scopes[scope].totals;
    const full = payload.scopes[scope].periods.full.current;
    assert.strictEqual(t.events, full.events, `${scope}: headline events must equal the full-period events`);
    assert.strictEqual(Math.round(t.hours), Math.round(full.hours), `${scope}: headline hours must equal full-period hours`);
  }
});

// --- Engagement type and status --------------------------------------------

test("an ended engagement is kept out of current-period figures and the trend", () => {
  // Both axes gate the roll-up. An ended client in a "this week" number
  // drags every current figure toward zero, and in the trend chart its
  // series stops dead and reads as collapsing output.
  const metricsModule = require("../src/metrics");
  const configModule = require("../src/config");

  const active = { ...CLIENT, id: "grp-active", coordinators: ["Anna Jones"] };
  const ended = {
    ...CLIENT,
    id: "grp-ended",
    name: "Ended Co",
    coordinators: ["Anna Jones"],
    status: "ended",
    isEnded: true,
    engagementStart: "2025-01-01",
    engagementEnd: "2025-06-30",
  };
  const clientScheduled = { ...CLIENT, id: "grp-cs", name: "Client Sched", coordinators: ["Anna Jones"], engagement: "client-scheduled" };

  const seed = (c, daysAgo) => {
    store.writeReference(c.id, {
      interviews: [{ id: "i1", title: "Interview", isDebrief: false }],
      jobs: [{ id: "j1", title: "Engineer", status: "Open" }],
      departments: [], stages: [],
    });
    store.writeApplicationPage(c.id, [
      { id: "a1", candidate: { id: "c1", name: "X" }, job: { id: "j1" }, status: "Active",
        createdAt: iso(-400), updatedAt: iso(-1), hiringTeam: [] },
    ]);
    store.writeSchedulePage(c.id, [{
      id: "s1", status: "Complete", applicationId: "a1", interviewStageId: "st",
      createdAt: iso(daysAgo - 1), updatedAt: iso(daysAgo),
      scheduledBy: { id: "u1", firstName: "Anna", lastName: "Jones", email: "a@x.com" },
      interviewEvents: [{
        id: "e1", interviewId: "i1", interviewScheduleId: "s1", interviewerUserIds: ["u2"],
        createdAt: iso(daysAgo - 1), updatedAt: iso(daysAgo),
        startTime: iso(daysAgo, 15), endTime: iso(daysAgo, 16), hasSubmittedFeedback: true,
      }],
    }], new Date().toISOString());
  };

  seed(active, -2);
  seed(clientScheduled, -2);
  // Inside the ended engagement's own window, long before "this week".
  const endedStart = new Date("2025-03-01T15:00:00.000Z").toISOString();
  store.writeReference(ended.id, {
    interviews: [{ id: "i1", title: "Interview", isDebrief: false }],
    jobs: [{ id: "j1", title: "Engineer", status: "Open" }], departments: [], stages: [],
  });
  store.writeApplicationPage(ended.id, [
    { id: "a1", candidate: { id: "c1", name: "X" }, job: { id: "j1" }, status: "Active",
      createdAt: endedStart, updatedAt: endedStart, hiringTeam: [] },
  ]);
  store.writeSchedulePage(ended.id, [{
    id: "s1", status: "Complete", applicationId: "a1", interviewStageId: "st",
    createdAt: endedStart, updatedAt: endedStart,
    scheduledBy: { id: "u1", firstName: "Anna", lastName: "Jones", email: "a@x.com" },
    interviewEvents: [{
      id: "e1", interviewId: "i1", interviewScheduleId: "s1", interviewerUserIds: ["u2"],
      createdAt: endedStart, updatedAt: endedStart,
      startTime: endedStart, endTime: new Date("2025-03-01T16:00:00.000Z").toISOString(),
      hasSubmittedFeedback: true,
    }],
  }], new Date().toISOString());

  const original = configModule.clients.slice();
  configModule.clients.length = 0;
  configModule.clients.push(active, clientScheduled, ended);
  try {
    metricsModule.rebuild();
    const o = metricsModule.getOverview().scopes.coordinated;

    assert.strictEqual(o.groups.core.clientIds.length, 1, "only the active carrara-scheduled client is core");
    assert.strictEqual(o.groups.clientScheduled.clientIds[0], "grp-cs");
    assert.strictEqual(o.groups.ended.clientIds[0], "grp-ended");

    // The share is computed inside the core group only.
    assert.strictEqual(o.groups.core.all, o.groups.core.coordinated, "core share spans only core clients");

    // Volume totals include the ended client; current-period figures do not.
    assert.strictEqual(o.totals.events, 3, "all three contribute to 12-month volume");
    assert.strictEqual(o.periods.week.current.events, 2, "the ended client is absent from this week");

    const endedWeek = new Date("2025-03-01").toISOString().slice(0, 10);
    assert.ok(
      !o.series.weekly.some((w) => w.key <= endedWeek),
      "the ended client's weeks must not appear in the trend"
    );
  } finally {
    configModule.clients.length = 0;
    configModule.clients.push(...original);
  }
});

test("an ended engagement reads its own window, not a rolling year", () => {
  const ended = {
    ...CLIENT, id: "grp-ended", name: "Ended Co", coordinators: ["Anna Jones"],
    status: "ended", isEnded: true, engagementStart: "2025-01-01", engagementEnd: "2025-06-30",
  };
  const payload = computeFull(ended);
  // A rolling 12-month window would exclude a March 2025 event outright.
  assert.strictEqual(payload.scopes.coordinated.totals.events, 1, "work inside the engagement still counts");
  assert.ok(payload.window.fixed, "the window is pinned to the engagement");
  assert.strictEqual(payload.engagementStart, "2025-01-01");
  assert.strictEqual(payload.engagementEnd, "2025-06-30");
});

test("a rostered name unmatched everywhere is still reported when another client has its own roster", () => {
  // Adding Profound, which has its own three-person roster, silently
  // cleared Sadiqeh Agah's "no matching work anywhere" warning: she is
  // not on Profound's roster, so she was absent from its unmatched list,
  // and an "unmatched at EVERY client" test then found a client where
  // she was not unmatched. A name must be judged only against the
  // clients whose roster claims her.
  const metricsModule = require("../src/metrics");
  const configModule = require("../src/config");

  const wide = { ...CLIENT, id: "rw-wide", name: "Wide", coordinators: ["Anna Jones", "Ghost Coordinator"] };
  const narrow = { ...CLIENT, id: "rw-narrow", name: "Narrow", coordinators: ["Anna Jones"] };

  for (const c of [wide, narrow]) {
    store.writeReference(c.id, {
      interviews: [{ id: "i1", title: "Interview", isDebrief: false }],
      jobs: [{ id: "j1", title: "Engineer", status: "Open" }], departments: [], stages: [],
    });
    store.writeApplicationPage(c.id, [
      { id: "a1", candidate: { id: "c1", name: "X" }, job: { id: "j1" }, status: "Active",
        createdAt: iso(-50), updatedAt: iso(-1), hiringTeam: [] },
    ]);
    store.writeSchedulePage(c.id, [{
      id: "s1", status: "Complete", applicationId: "a1", interviewStageId: "st",
      createdAt: iso(-4), updatedAt: iso(-3),
      scheduledBy: { id: "u1", firstName: "Anna", lastName: "Jones", email: "a@x.com" },
      interviewEvents: [{
        id: "e1", interviewId: "i1", interviewScheduleId: "s1", interviewerUserIds: ["u2"],
        createdAt: iso(-4), updatedAt: iso(-3), startTime: iso(-3, 15), endTime: iso(-3, 16), hasSubmittedFeedback: true,
      }],
    }], new Date().toISOString());
  }

  const original = configModule.clients.slice();
  configModule.clients.length = 0;
  configModule.clients.push(wide, narrow);
  try {
    metricsModule.rebuild();
    assert.deepStrictEqual(
      metricsModule.getOverview().rosterUnmatchedEverywhere,
      ["Ghost Coordinator"],
      "a name rostered somewhere and matching nothing there must stay reported"
    );
  } finally {
    configModule.clients.length = 0;
    configModule.clients.push(...original);
  }
});

// --- Results metrics -------------------------------------------------------

test("the delta is suppressed when the prior period is too small", () => {
  // Below 30 prior events a percentage change is noise wearing a
  // signal's clothing, so no delta is shown at all.
  const payload = computeFull(CLIENT);
  for (const key of ["week", "month", "quarter", "full"]) {
    const block = payload.scopes.all.results[key];
    assert.ok(block, `results.${key} must exist`);
    if (block.priorEvents != null && block.priorEvents < 30) {
      assert.strictEqual(block.deltaSuppressed, true, `${key}: delta must be suppressed on ${block.priorEvents} prior events`);
    }
  }
});

test("the full period is the baseline and carries no prior comparison", () => {
  const payload = computeFull(CLIENT);
  const full = payload.scopes.all.results.full;
  assert.strictEqual(full.isBaseline, true);
  assert.strictEqual(full.prior, null, "a baseline must not invent a prior period to compare against");
  assert.strictEqual(full.deltaSuppressed, true);
});

test("every Results metric declares which direction is an improvement", () => {
  // The UI colours by improvement, not by sign — a down arrow must not
  // read as red on a metric where down is the goal.
  const d = computeFull(CLIENT).scopes.all.results.full.direction;
  for (const metric of ["bookingTurnaround", "stageGap", "shortNotice", "cancellationWithoutRebook", "rescheduleRate"]) {
    assert.strictEqual(d[metric], "lower", `${metric} must declare its direction`);
  }
});

test("a metric with no data reports null, never zero", () => {
  // Zero turnaround and "no turnaround measured" are different claims,
  // and the second must not render as a perfect score.
  const empty = { ...CLIENT, id: "empty-results", coordinators: ["Nobody At All"] };
  const r = computeFull(empty).scopes.coordinated.results.full.current;
  assert.strictEqual(r.bookingTurnaround.medianHours, null);
  assert.strictEqual(r.shortNotice.share, null);
  assert.strictEqual(r.cancellationWithoutRebook.share, null);
  assert.strictEqual(r.rescheduleRate.share, null);
});

test("the areas-to-work-on panel only surfaces groups above the client's own average", () => {
  const a = computeFull(CLIENT).scopes.all.areasToWorkOn;
  assert.ok(a, "the panel data must exist");
  if (a.clientAverage != null) {
    for (const row of [...a.byRole, ...a.byStage]) {
      assert.ok(row.total >= a.minGroupSize, `${row.name} is below the minimum group size`);
      assert.ok(row.share > a.clientAverage, `${row.name} is not worse than the client average`);
    }
  }
});
