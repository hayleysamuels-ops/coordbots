"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const P = require("../lib/scheduling/proposal");
const { createSchedulingStore } = require("../lib/scheduling/store");
const { createWorker } = require("../lib/scheduling/worker");
// Synthetic contract fixtures test approval/retry behavior, not Ashby's UI.
const actor = { email: "coordinator@example.com", active: true, can_approve: true };
function plan() { return { kind: "new", candidateId: "test", applicationId: "app", templateRevision: "v1", sourceFingerprint: "source", timezone: "America/Los_Angeles", role: "FDS", startDate: "2026-10-01", endDate: "2026-10-02", blockers: [], events: [{ key: "welcome", title: "Welcome", interviewId: "type", start: "2026-10-01T09:00:00-07:00", end: "2026-10-01T09:30:00-07:00", interviewers: [{ userId: "user", email: "interviewer@example.com" }], conferencing: { provider: "zoom", accountId: "zoom" }, notify: ["candidate@example.com"] }] }; }
function approved() { const row = P.draft(plan(), actor); return P.approve(row, actor, row.digest); }
function store(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-test-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return { dir, value: createSchedulingStore({ dir }) }; }
test("approval binds content, permissions and revision", () => {
  const row = P.draft(plan(), actor);
  assert.throws(() => P.approve(row, { ...actor, can_approve: false }, row.digest), /permission/);
  row.plan.events[0].title = "Changed";
  assert.throws(() => P.approve(row, actor, row.digest), /changed/);
  const next = P.revise(approved(), plan(), actor);
  assert.equal(next.approval, null); assert.equal(next.state, "draft");
});
test("unknown capacity blocks and same-role exception requires explanation", () => {
  const p = plan(); p.blockers = P.capacityIssues(p, null);
  let row = P.draft(p, actor); assert.throws(() => P.approve(row, actor, row.digest), /blockers/);
  p.blockers = P.capacityIssues(p, [{ candidateId: "other", role: "FDS", startDate: p.startDate, endDate: p.endDate }]);
  row = P.draft(p, actor); assert.throws(() => P.approve(row, actor, row.digest), /unavoidable/);
  assert.equal(P.approve(row, actor, row.digest, "Only candidate availability this month").state, "approved");
  p.blockers = P.capacityIssues(p, ["one", "two"].map(candidateId => ({ candidateId, role: "FDE", startDate: p.startDate, endDate: p.endDate })));
  row = P.draft(p, actor); assert.throws(() => P.approve(row, actor, row.digest, "Long explanation"), /blockers/);
});
test("required rooms and replacement source are mandatory", () => {
  const p = plan(); p.events[0].requiresRoom = true; assert.throws(() => P.validatePlan(p), /room/);
  p.events[0].room = { resourceId: "room" }; p.kind = "replacement";
  assert.throws(() => P.validatePlan(p), /original event/);
});
test("file store persists revisions and rejects stale writes", async t => {
  const { dir, value } = store(t), row = approved();
  assert.equal(await value.insert(row), true); assert.equal(await value.insert(row), false);
  const next = { ...row, revision: row.revision + 1, state: "running" };
  assert.equal(await value.replace(row.id, row.revision, next), true);
  assert.equal(await value.replace(row.id, row.revision, next), false);
  assert.equal((await createSchedulingStore({ dir }).get(row.id)).state, "running");
});
for (const mode of ["success", "changed", "revoked", "uncertain", "unverified"]) {
  test("worker execution: " + mode, async t => {
    const { value } = store(t), row = approved(); await value.insert(row); let calls = 0;
    const worker = createWorker({ store: value, now: () => "2026-09-17T12:00:00Z", userByEmail: async () => ({ ...actor, active: mode !== "revoked" }), executor: {
      preflight: async () => ({ sourceFingerprint: mode === "changed" ? "different" : "source", available: true, ready: true }),
      book: async () => { calls++; assert.equal((await value.get(row.id)).operations[0].state, "started"); if (mode === "uncertain") throw new Error("private browser details"); return {}; },
      verify: async () => ({ matches: true, invitesConfirmed: mode !== "unverified", scheduleId: "schedule" })
    } });
    await Promise.all([worker.execute(row.id), worker.execute(row.id)]);
    const result = await value.get(row.id);
    assert.equal(result.state, mode === "success" ? "scheduled" : "needs_review");
    assert.equal(calls, ["changed", "revoked"].includes(mode) ? 0 : 1);
    await worker.execute(row.id); assert.ok(calls <= 1);
    assert.ok(!JSON.stringify(result).includes("private browser details"));
    if (mode === "unverified") { assert.equal(result.issue, "invites_not_dispatched"); assert.match(result.issueMessage, /not dispatched/); }
    if (calls && mode !== "success") assert.throws(() => P.revise(result, plan(), actor), /Reconcile/);
  });
}
test("claim database errors are reported rather than mistaken for another worker", async () => {
  const worker = createWorker({ store: { get: async () => approved(), replace: async () => { throw new Error("database unavailable"); } } });
  await assert.rejects(worker.execute("id"), /database unavailable/);
});
test("different candidates cannot execute concurrently while resource checks are in flight",async t=>{
 const {value}=store(t),one=approved(),two=approved();two.plan.candidateId="other";
 await value.insert(one);await value.insert(two);
 assert.equal(await value.replace(one.id,one.revision,{...one,revision:one.revision+1,state:"running"}),true);
 assert.equal(await value.replace(two.id,two.revision,{...two,revision:two.revision+1,state:"running"}),false);
});
test("uncertain external writes block further execution until reconciliation",async t=>{
 const {value}=store(t),one=approved(),two=approved();two.plan.candidateId="other";
 await value.insert(one);await value.insert(two);
 await value.replace(one.id,one.revision,{...one,revision:one.revision+1,state:"needs_review",issue:"booking_uncertain"});
 assert.equal(await value.replace(two.id,two.revision,{...two,revision:two.revision+1,state:"running"}),false);
});
