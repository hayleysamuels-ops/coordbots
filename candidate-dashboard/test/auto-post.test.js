"use strict";
// Auto-post (src/scheduling/auto-post.js): the switch and allowlist, posting
// once per submission, replacing posts made from earlier availability, never
// over an approval, and saying why when nothing is posted. Ashby, the worker,
// the solver and Slack are stand-ins; the service and store are real.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAutoPost, AUTO_POST_APPLICATIONS } = require("../src/scheduling/auto-post");
const { createService } = require("../src/scheduling/service");
const { createStore } = require("../src/scheduling/store");

const APP = "8dfd8f14-83c4-41f8-aaf1-416b75cb0892", SCHED = "c95bfecf-9e5c-4d61-8f32-2586d26fa96f";
const hayley = { userId: "u-hayley", name: "Hayley Samuels", email: "hayley@luminai.com" };
const W = (start, end) => ({ start, end });
const first = [W("2099-10-30T17:00:00.000Z", "2099-10-31T00:00:00.000Z")], second = [W("2099-11-02T17:00:00.000Z", "2099-11-03T00:00:00.000Z")];

function fixture(t, { on = true, found: initial } = {}) {
  let found = initial;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-auto-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir), posts = [];
  const service = createService({ store, candidates: async () => [{ applicationId: APP, candidateId: "candidate", candidateName: "TEST", jobTitle: "TEST", status: "Active" }],
    clientId: "luminai", routing: "client", channelId: "C0CONFIG", channelName: "luminai-rc-team", slack: async (plan, meta) => { posts.push({ plan, meta }); return { ts: `2.${posts.length}`, channel: "C0CONFIG" }; } });
  const ashby = { updatedAt: "2099-10-26T19:47:16.037Z", windows: first, loads: 0, fail: null };
  const availability = {
    requests: async applicationId => ({ candidateName: "TEST", requests: applicationId === APP ? [{ scheduleId: SCHED, updatedAt: ashby.updatedAt }] : [] }),
    load: async () => { ashby.loads++; if (ashby.fail) throw ashby.fail; return { scheduleId: SCHED, timezone: "America/Los_Angeles", windows: ashby.windows, requestUpdatedAt: ashby.updatedAt }; } };
  let n = 0;
  const optionOn = windows => {
    const start = windows[0].start.replace("17:00", "18:00"), end = windows[0].start.replace("17:00", "18:30");
    return { start, end, events: [{ title: "First Round", start, end, interviewer: { name: hayley.name } }] };
  };
  const calls = { suggester: 0, notices: [], replies: [], replaced: [] };
  const suggester = async ({ applicationId, scheduleId, steer }) => {
    calls.suggester++;
    assert.equal(applicationId, APP);assert.equal(scheduleId, SCHED);assert.deepEqual(steer, {});
    const submission = { scheduleId: SCHED, timezone: "America/Los_Angeles", windows: ashby.windows };
    const option = optionOn(ashby.windows);
    const result = { candidateName: "TEST", proposals: [option], ...(found ? found() : {}) };
    return { submission, result, index: found ? -1 : 0,
      post: (user, suggestion, origin) => service.postScheduleOption({ applicationId: APP, candidateId: "candidate", timezone: "America/Los_Angeles", option, optionNumber: 1, sourceRef: `full-schedule:${SCHED}:${++n}`,
        availabilitySource: "ashby", attendance: ["in_person"], rulesRevision: 1, calendarCheck: { checkedAt: Date.now(), flags: [[]] },
        bookingPlan: { applicationId: APP, interviewScheduleId: SCHED, sessions: [{ title: "First Round", start: option.start, end: option.end, interviewers: [hayley] }] }, submittedAvailability: submission, origin }, user) };
  };
  const slackApi = { notice: async x => calls.notices.push(x), threadReply: async x => calls.replies.push(x), markReplaced: async x => calls.replaced.push(x.row) };
  const auto = createAutoPost({ on, dataDir: dir, clientId: "luminai", channelId: "C0CONFIG", availability, suggester, service, store, slackApi, now: () => Date.parse("2099-10-26T20:00:00Z"), log: { warn() {} } });
  return { auto, store, service, posts, calls, ashby, dir, setFound: fn => { found = fn; } };
}
const rows = async store => (await store.list()).sort((a, b) => a.audit[0].at.localeCompare(b.audit[0].at));

test("only TEST is allowlisted, and off means nothing is read or posted", async t => {
  assert.deepEqual(AUTO_POST_APPLICATIONS, [APP]);
  const f = fixture(t, { on: false });
  await f.auto.round();
  assert.equal(f.ashby.loads, 0);assert.equal(f.posts.length, 0);assert.equal(f.auto.on, false);
});

test("a new submission is posted once, as auto-post, with what it was built from", async t => {
  const f = fixture(t);
  await f.auto.round();
  assert.equal(f.posts.length, 1);
  const [row] = await rows(f.store);
  assert.equal(row.state, "shared");assert.equal(row.discussionApproval.by, "Scheduling auto-post");
  assert.match(row.plan.notes, /^Posted automatically when the candidate submitted availability\. Full schedule option 1/);
  assert.deepEqual(row.plan.submittedAvailability.windows, first);
  // The same updatedAt: nothing is read again.
  await f.auto.round();
  assert.equal(f.ashby.loads, 1);assert.equal(f.posts.length, 1);
  // updatedAt moves (our own drafts do this) but the submission is the same: read, not posted.
  f.ashby.updatedAt = "2099-10-26T21:00:00.000Z";
  await f.auto.round();
  assert.equal(f.ashby.loads, 2);assert.equal(f.posts.length, 1);assert.equal(f.calls.suggester, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, "auto-post.json"), "utf8"))[SCHED].outcome, "posted");
});

test("a resubmission replaces the open post made from the earlier availability", async t => {
  const f = fixture(t);
  await f.auto.round();
  f.ashby.updatedAt = "2099-10-27T09:00:00.000Z";f.ashby.windows = second;
  await f.auto.round();
  const [old, fresh] = await rows(f.store);
  assert.equal(old.state, "rejected");assert.equal(old.replaced.kind, "resubmitted");assert.equal(old.replaced.by, "Scheduling auto-post");assert.equal(old.replaced.withDraft, fresh.id);
  assert.equal(fresh.state, "shared");assert.deepEqual(fresh.plan.submittedAvailability.windows, second);
  assert.equal(f.calls.replaced.length, 1);assert.equal(f.calls.replaced[0].replaced.withDraft, fresh.id);
});

test("a post already open for this submission (posted by hand) is left alone", async t => {
  const f = fixture(t);
  await f.auto.round();
  fs.rmSync(path.join(f.dir, "auto-post.json"));
  await f.auto.round();
  assert.equal(f.posts.length, 1);assert.equal(f.calls.suggester, 1);
});

test("no clean option: one notice, and posts from earlier availability are still withdrawn", async t => {
  const f = fixture(t);
  await f.auto.round();
  f.setFound(() => ({ proposals: [{ flagCount: 2 }], reason: "x" }));
  f.ashby.updatedAt = "2099-10-27T09:00:00.000Z";f.ashby.windows = second;
  await f.auto.round();
  assert.equal(f.posts.length, 1);
  assert.match(f.calls.notices[0].text, /^Auto-post: TEST submitted availability, but every option has calendar clashes \(1 found\), so none was posted automatically\./);
  const [old] = await rows(f.store);
  assert.equal(old.state, "rejected");assert.equal(old.replaced.kind, "resubmitted");assert.equal(old.replaced.withDraft, undefined);
  assert.equal(f.calls.replaced.length, 1);
  const h = fixture(t, { found: () => ({ proposals: [], reason: "No agenda in template order fits." }) });
  await h.auto.round();
  assert.match(h.calls.notices[0].text, /^Auto-post: TEST submitted availability, but no agenda fits it \(No agenda in template order fits\.\)\. Nothing was posted\./);
  await h.auto.round();
  assert.equal(h.calls.notices.length, 1, "said once per submission");
});

test("an approved post still in play: nothing is posted; its thread is told once", async t => {
  const f = fixture(t);
  await f.auto.round();
  const [row] = await rows(f.store);
  await f.service.approveInSlack({ draftId: row.id, digest: row.digest, channelId: "C0CONFIG", messageTs: row.slack.ts, approver: { email: "anna@carrara.is", slackUserId: "U0ANNA", name: "Anna Jones" } });
  f.ashby.updatedAt = "2099-10-27T09:00:00.000Z";f.ashby.windows = second;
  await f.auto.round();
  assert.equal(f.posts.length, 1);assert.equal(f.calls.suggester, 1);
  assert.equal(f.calls.replies.length, 1);assert.equal(f.calls.replies[0].threadTs, row.slack.ts);
  assert.match(f.calls.replies[0].text, /^The candidate changed their availability after this was approved\. Nothing new was posted automatically/);
  f.ashby.updatedAt = "2099-10-27T10:00:00.000Z";
  await f.auto.round();
  assert.equal(f.calls.replies.length, 1, "told once");
});

test("a read that keeps failing is tried three rounds, then said once and left", async t => {
  const f = fixture(t);
  f.ashby.fail = Object.assign(new Error("Ashby is busy."), { status: 409 });
  for (let i = 0; i < 5; i++) await f.auto.round();
  assert.equal(f.ashby.loads, 3);
  assert.equal(f.calls.notices.length, 1);
  assert.match(f.calls.notices[0].text, /couldn't be handled after 3 tries \(couldn't read the candidate's availability: Ashby is busy\.\)\. Nothing was posted\./);
  // A new submission is tried afresh.
  f.ashby.fail = null;f.ashby.updatedAt = "2099-10-27T09:00:00.000Z";
  await f.auto.round();
  assert.equal(f.posts.length, 1);
});

test("a standing Slack request that can't be kept: the open post stays, and the notice names both ways out", async t => {
  const f = fixture(t);
  await f.auto.round();
  const request = { session: 0, interviewId: "i1", label: "First Round", userId: "u-v", name: "Vamsi Chitters", by: "anna@carrara.is", byName: "Anna Jones" };
  f.setFound(() => ({ status: "request_unavailable", requestFailure: { request, why: "not_eligible" }, proposals: [], reason: "x" }));
  f.ashby.updatedAt = "2099-10-27T09:00:00.000Z";f.ashby.windows = second;
  await f.auto.round();
  assert.equal(f.calls.notices[0].text, 'Auto-post: TEST submitted availability, but nothing was posted. Vamsi Chitters was requested for First Round by Anna Jones, but Ashby no longer lists Vamsi Chitters as eligible for First Round, so no new option can keep that request. To keep it, make Vamsi Chitters eligible for First Round again in Ashby, then post an option from booking review. To drop it instead, on the open post for this candidate, choose First Round under "Suggest different interviewer" so anyone eligible can take it, or @mention the bot in its thread naming who should take First Round; or press "Drop" next to this request in booking review on the dashboard, so anyone eligible can take First Round. Other requests are kept either way.');
  const [old] = await rows(f.store);
  assert.equal(old.state, "shared");
  assert.equal(f.calls.replaced.length, 0);
});

test("a stale request with only a typed-in post open: the notice points to booking review, not to Slack", async t => {
  const f = fixture(t);
  await f.auto.round();
  // The open post was built from coordinator-typed times: Slack can't rebuild it.
  const [open] = await rows(f.store);
  await f.store.replace(open.id, open.revision, { ...open, revision: open.revision + 1, plan: { ...open.plan, timezoneSource: "coordinator_entered" } });
  const request = { session: 0, interviewId: "i1", label: "First Round", userId: "u-v", name: "Vamsi Chitters", by: "anna@carrara.is", byName: "Anna Jones" };
  f.setFound(() => ({ status: "request_unavailable", requestFailure: { request, why: "Ashby daily interview limit is 0" }, proposals: [], reason: "x" }));
  f.ashby.updatedAt = "2099-10-27T09:00:00.000Z";f.ashby.windows = second;
  await f.auto.round();
  assert.match(f.calls.notices[0].text, /To keep it, raise Vamsi Chitters's daily interview limit above 0 in Ashby, then post an option from booking review\. To drop it instead, press "Drop" next to this request in booking review on the dashboard, so anyone eligible can take First Round\. Other requests are kept either way\.$/);
  assert.doesNotMatch(f.calls.notices[0].text, /Suggest different interviewer|@mention/);
});
