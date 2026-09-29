"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// The store writes to config.dataDir at require time, so point that at a temp
// directory before anything loads config.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "training-store-"));
process.env.DATA_DIR = TMP;
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;

const store = require("../src/training/store");

function freshPath(overrides = {}) {
  return store.upsertPath({
    interviewTitle: "Coding Interview",
    interviewIds: ["interview-a"],
    jobId: "job-1",
    jobTitle: "Backend Engineer",
    ...overrides,
  });
}

test("a new path defaults to 2 shadows and 2 reverse shadows", () => {
  const p = freshPath();
  assert.strictEqual(p.requiredShadows, 2);
  assert.strictEqual(p.requiredReverseShadows, 2);
  assert.strictEqual(p.label, "Coding Interview — Backend Engineer");
  store.removePath(p.id);
});

test("an explicit requirement on a path is kept, including zero", () => {
  const p = freshPath({ requiredShadows: 3, requiredReverseShadows: 0 });
  assert.strictEqual(p.requiredShadows, 3);
  assert.strictEqual(p.requiredReverseShadows, 0, "zero must not fall back to the default");
  store.removePath(p.id);
});

test("adding an interview id to a path is idempotent", () => {
  const p = freshPath();
  store.addInterviewIdToPath(p.id, "interview-b");
  store.addInterviewIdToPath(p.id, "interview-b");
  assert.deepStrictEqual(store.getPath(p.id).interviewIds, ["interview-a", "interview-b"]);
  store.removePath(p.id);
});

test("removing a path removes its enrolments too, so none are left orphaned", () => {
  const p = freshPath();
  store.enrol({ userId: "u1", userName: "One", pathId: p.id });
  store.enrol({ userId: "u2", userName: "Two", pathId: p.id });
  assert.strictEqual(store.listEnrolments().filter((e) => e.pathId === p.id).length, 2);

  store.removePath(p.id);
  assert.strictEqual(store.getPath(p.id), null);
  assert.strictEqual(store.listEnrolments().filter((e) => e.pathId === p.id).length, 0);
});

test("enrolling twice does not duplicate or reset the enrolment", () => {
  const p = freshPath();
  const first = store.enrol({ userId: "u1", userName: "One", pathId: p.id });
  const second = store.enrol({ userId: "u1", userName: "Renamed", pathId: p.id });
  assert.strictEqual(second.enrolledAt, first.enrolledAt, "re-enrolling must not restart their counting window");
  assert.strictEqual(store.listEnrolments().filter((e) => e.pathId === p.id).length, 1);
  store.removePath(p.id);
});

test("pausing records the date, and the reason and return date when given", () => {
  const p = freshPath();
  store.enrol({ userId: "u1", pathId: p.id });
  const paused = store.pause("u1", p.id, { reason: "Parental leave", expectedReturn: "2026-12-01" });

  assert.strictEqual(paused.state, "paused");
  assert.strictEqual(paused.pause.reason, "Parental leave");
  assert.strictEqual(paused.pause.expectedReturn, "2026-12-01");
  assert.ok(paused.pause.at, "the paused-on date is always recorded");

  const resumed = store.unpause("u1", p.id);
  assert.strictEqual(resumed.state, "active");
  assert.strictEqual(resumed.pause, null);
  store.removePath(p.id);
});

test("pausing with no reason still records the date", () => {
  const p = freshPath();
  store.enrol({ userId: "u1", pathId: p.id });
  const paused = store.pause("u1", p.id);
  assert.strictEqual(paused.pause.reason, "");
  assert.strictEqual(paused.pause.expectedReturn, null);
  assert.ok(paused.pause.at);
  store.removePath(p.id);
});

test("archiving and restoring round-trips", () => {
  const p = freshPath();
  store.enrol({ userId: "u1", pathId: p.id });
  assert.strictEqual(store.archive("u1", p.id).state, "archived");
  assert.ok(store.getEnrolment("u1", p.id).archivedAt);
  assert.strictEqual(store.unarchive("u1", p.id).state, "active");
  assert.strictEqual(store.getEnrolment("u1", p.id).archivedAt, null);
  store.removePath(p.id);
});

test("a null requirement restores the path's own number rather than pinning the current one", () => {
  const p = freshPath();
  store.enrol({ userId: "u1", pathId: p.id });
  store.setRequirements("u1", p.id, { shadows: 1, reverseShadows: 1 });
  assert.strictEqual(store.getEnrolment("u1", p.id).requiredShadows, 1);

  store.setRequirements("u1", p.id, { shadows: null, reverseShadows: null });
  assert.strictEqual(store.getEnrolment("u1", p.id).requiredShadows, null);
  assert.strictEqual(store.getEnrolment("u1", p.id).requiredReverseShadows, null);
  store.removePath(p.id);
});

test("a session override that is cleared on every field is deleted, not left as an empty husk", () => {
  const p = freshPath();
  store.enrol({ userId: "u1", pathId: p.id });
  store.setSessionOverride("u1", p.id, "event-1", { role: "ReverseShadow" });
  assert.strictEqual(store.getEnrolment("u1", p.id).sessionOverrides["event-1"].role, "ReverseShadow");

  store.setSessionOverride("u1", p.id, "event-1", { role: null, discounted: false, note: "" });
  assert.ok(!("event-1" in store.getEnrolment("u1", p.id).sessionOverrides));
  store.removePath(p.id);
});

test("a session override updates one field without clearing the others", () => {
  const p = freshPath();
  store.enrol({ userId: "u1", pathId: p.id });
  store.setSessionOverride("u1", p.id, "event-1", { role: "Shadow" });
  store.setSessionOverride("u1", p.id, "event-1", { discounted: true });
  const override = store.getEnrolment("u1", p.id).sessionOverrides["event-1"];
  assert.strictEqual(override.role, "Shadow", "setting `discounted` must not wipe the role");
  assert.strictEqual(override.discounted, true);
  store.removePath(p.id);
});

test("manual credits are added and removed by id", () => {
  const p = freshPath();
  store.enrol({ userId: "u1", pathId: p.id });
  store.addManualCredit("u1", p.id, { role: "Shadow", note: "done before we tracked it" });
  store.addManualCredit("u1", p.id, { role: "ReverseShadow" });
  const credits = store.getEnrolment("u1", p.id).manualCredits;
  assert.strictEqual(credits.length, 2);

  store.removeManualCredit("u1", p.id, credits[0].id);
  assert.deepStrictEqual(
    store.getEnrolment("u1", p.id).manualCredits.map((c) => c.role),
    ["ReverseShadow"]
  );
  store.removePath(p.id);
});

test("an unrecognised manual credit role falls back to Shadow rather than storing junk", () => {
  const p = freshPath();
  store.enrol({ userId: "u1", pathId: p.id });
  store.addManualCredit("u1", p.id, { role: "nonsense" });
  assert.strictEqual(store.getEnrolment("u1", p.id).manualCredits[0].role, "Shadow");
  store.removePath(p.id);
});

test("mutating an enrolment that does not exist returns null instead of throwing", () => {
  assert.strictEqual(store.pause("nobody", "nowhere"), null);
  assert.strictEqual(store.archive("nobody", "nowhere"), null);
  assert.strictEqual(store.setRequirements("nobody", "nowhere", { shadows: 1 }), null);
  assert.strictEqual(store.addManualCredit("nobody", "nowhere", { role: "Shadow" }), null);
});

test("state survives a reload from disk", () => {
  const p = freshPath();
  store.enrol({ userId: "u1", userName: "Persisted Person", pathId: p.id });
  store.pause("u1", p.id, { reason: "Out" });

  store._reload();
  const reloaded = store.getEnrolment("u1", p.id);
  assert.strictEqual(reloaded.userName, "Persisted Person");
  assert.strictEqual(reloaded.state, "paused");
  assert.strictEqual(reloaded.pause.reason, "Out");
  store.removePath(p.id);
});

test("a corrupt store file degrades to empty rather than crashing the server", () => {
  fs.writeFileSync(store._file, "{ this is not json");
  store._reload();
  assert.deepStrictEqual(store.listPaths(), []);
  assert.deepStrictEqual(store.listEnrolments(), []);
});
