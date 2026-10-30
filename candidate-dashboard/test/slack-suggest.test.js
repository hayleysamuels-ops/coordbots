"use strict";
// Slack's "Suggest another time" and "Suggest different interviewer": the
// steer (suggestion.js), the solver and calendar inputs honouring it, the
// controls on the post, and the flow in slack-interactions.js: find first,
// withdraw only once a clean replacement exists, never over an approval.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { nextSuggestion, checkSuggestion, suggestionNote } = require("../src/scheduling/suggestion");
const { awayFromStarts } = require("../src/scheduling/option-variety");
const { proposeCalendarSchedule } = require("../src/scheduling/full-calendar-schedule");
const { createSlackInteractions } = require("../src/scheduling/slack-interactions");
const { createService } = require("../src/scheduling/service");
const { createStore, blocksRepost } = require("../src/scheduling/store");
const { createSlack, blockProblems } = require("../src/scheduling/slack");

const SCHED = "c95bfecf-9e5c-4d61-8f32-2586d26fa96f";
const hayley = { userId: "u-hayley", name: "Hayley Samuels", email: "hayley@luminai.com" }, joe = { userId: "u-joe", name: "Joe Penn", email: "joe@luminai.com" };
const bookingPlan = { applicationId: "app", interviewScheduleId: SCHED, sessions: [
  { title: "Onsite", start: "2099-10-30T18:00:00.000Z", end: "2099-10-30T18:30:00.000Z", interviewers: [hayley] },
  { title: "Onsite", start: "2099-10-30T18:30:00.000Z", end: "2099-10-30T19:00:00.000Z", interviewers: [joe] }] };
const submitted = { scheduleId: SCHED, timezone: "America/Los_Angeles", windows: [{ start: "2099-10-30T17:00:00.000Z", end: "2099-10-31T00:00:00.000Z" }] };
const postedRow = (extra = {}) => ({ id: "old", plan: { timezoneSource: "candidate_submitted", bookingPlan, submittedAvailability: submitted, sessions: bookingPlan.sessions }, ...extra });

// ---- the steer -----------------------------------------------------------------

test("each request adds one steer to those before it; a resubmission starts again", () => {
  const t1 = nextSuggestion(postedRow(), { kind: "time", by: "anna@carrara.is" });
  assert.deepEqual(t1, { replaces: "old", kind: "time", by: "anna@carrara.is", avoidStarts: ["2099-10-30T18:00:00.000Z"], excludeInterviewers: [] });
  const second = postedRow({ id: "new", plan: { ...postedRow().plan, suggestion: t1 } });
  const i2 = nextSuggestion(second, { kind: "interviewer", session: 1, by: "mary@carrara.is" });
  assert.deepEqual(i2.avoidStarts, ["2099-10-30T18:00:00.000Z"]);
  assert.deepEqual(i2.excludeInterviewers, [{ session: 1, userId: "u-joe", name: "Joe Penn" }]);
  assert.equal(i2.session, 1);assert.equal(i2.replaces, "new");
  assert.deepEqual(nextSuggestion(second, { kind: "interviewer", session: 1, by: "x", carry: false }).avoidStarts, []);
  assert.throws(() => nextSuggestion(postedRow(), { kind: "interviewer", session: 5, by: "x" }), { status: 409 });
  assert.throws(() => checkSuggestion({ ...t1, avoidStarts: ["later"] }));
  assert.equal(suggestionNote(i2), "Suggested in Slack by mary@carrara.is: a different interviewer for session 2, replacing the earlier post (draft new).");
});

// ---- the solver and calendar inputs -------------------------------------------

test("another time: never the same day within an hour of a start turned down; the search goes on past it", () => {
  assert.equal(awayFromStarts("2099-10-30T18:30:00Z", ["2099-10-30T18:00:00Z"], "America/Los_Angeles"), false);
  assert.equal(awayFromStarts("2099-10-30T19:00:00Z", ["2099-10-30T18:00:00Z"], "America/Los_Angeles"), true);
  assert.equal(awayFromStarts("2099-10-31T18:00:00Z", ["2099-10-30T18:00:00Z"], "America/Los_Angeles"), true);
  const now = Date.parse("2026-09-21T00:00Z"), interval = { start: "2026-09-28T13:00:00Z", end: "2026-09-28T21:00:00Z" }, a = { userId: "a", name: "A" };
  const input = { sessions: [{ sessionId: "one", title: "One", interviewId: "1", durationMinutes: 60, assignmentVerified: true, requiredCount: 1, eligibleInterviewers: [a] }],
    windows: [{ start: "2026-09-28T09:00", end: "2026-09-28T17:00" }], timezone: "America/New_York", now, limit: 1,
    calendars: [{ userId: "a", verified: true, coverageVerified: true, workingHoursVerified: true, checkedAt: now, coverage: [interval], busy: [], sessionWorkingWindows: { one: [interval] }, limits: { dailyLimit: null, weeklyLimit: null } }] };
  assert.equal(proposeCalendarSchedule(input).proposals[0].start, "2026-09-28T13:00:00.000Z");
  const away = proposeCalendarSchedule({ ...input, avoidStarts: ["2026-09-28T13:00:00Z"] });
  assert.equal(away.proposals[0].start, "2026-09-28T14:00:00.000Z");
  assert.throws(() => proposeCalendarSchedule({ ...input, avoidStarts: ["soon"] }));
});

// ---- the post's controls ---------------------------------------------------------

const slackFor = calls => createSlack("x", async (url, o) => { calls.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ ok: true, ts: "9.9", channel: "C0CONFIG" }) }; }, { displayTimeZone: "America/Los_Angeles", interactive: true });
const checkedPlan = (extra = {}) => ({ candidateId: "candidate", candidateName: "TEST", jobTitle: "TEST", timezone: "America/Los_Angeles", format: "calendar_checked", timezoneSource: "candidate_submitted", notes: "n",
  sessions: bookingPlan.sessions.map((s, i) => ({ title: s.title, start: s.start, end: s.end, interviewers: s.interviewers[0].name, location: "x", people: [{ name: s.interviewers[0].name }] })),
  bookingPlan, submittedAvailability: submitted, ...extra });

test("the suggestion controls sit beside Schedule only on a post a rebuild can start from, within Slack's limits", async () => {
  const calls = [], slack = slackFor(calls);
  await slack(checkedPlan(), { channelId: "C0CONFIG", proposalId: "d".repeat(36), approver: "c", digest: "f".repeat(64) });
  const actions = calls[0].blocks.find(b => b.type === "actions");
  assert.deepEqual(actions.elements.map(e => e.action_id), ["schedule_option", "suggest_time", "suggest_interviewer"]);
  const menu = actions.elements[2];
  assert.deepEqual(menu.options.map(o => o.text.text), ["1. 11:00 AM – 11:30 AM (PDT) Onsite – Hayley Samuels", "2. 11:30 AM – 12:00 PM (PDT) Onsite – Joe Penn"]);
  assert.deepEqual(JSON.parse(menu.options[1].value), { d: "d".repeat(36), g: "f".repeat(64), i: 1 });
  assert.deepEqual(blockProblems(calls[0]), []);
  calls.length = 0;
  await slack(checkedPlan({ submittedAvailability: undefined }), { channelId: "C0CONFIG", proposalId: "d1", approver: "c", digest: "g" });
  assert.deepEqual(calls[0].blocks.find(b => b.type === "actions").elements.map(e => e.action_id), ["schedule_option"]);
  assert.match(blockProblems({ blocks: [{ type: "actions", elements: [{ type: "static_select", action_id: "x", placeholder: { type: "plain_text", text: "p" }, options: [{ text: { type: "plain_text", text: "o" }, value: "v".repeat(151) }] }] }] })[0], /value is 151 characters \(Slack allows 150\)/);
});

test("a replaced post shows who asked and what for, with no buttons", async () => {
  const calls = [], slack = slackFor(calls);
  await slack.markReplaced({ channel: "C0CONFIG", ts: "1.2", row: { id: "old", plan: checkedPlan(), replaced: { by: "anna@carrara.is", kind: "interviewer", session: 1, at: "2099-10-26T22:00:00Z" } } });
  const update = calls[0];
  assert.equal(update.blocks.some(b => b.type === "actions"), false);
  assert.match(update.blocks.at(-1).text.text, /^\*Replaced\* at Oct 26, 3:00 PM PDT: anna@carrara\.is asked for a different interviewer for session 2, and a new option was posted below\. Nothing from this message was booked or sent\.$/);
  assert.doesNotMatch(update.blocks[0].text.text, /press Schedule/);
});

// ---- the flow, end to end with a real service and store --------------------------

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const sign = body => { const ts = Math.floor(Date.now() / 1000); return { "x-slack-request-timestamp": String(ts), "x-slack-signature": "v0=" + crypto.createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex") }; };

async function fixture(t, { found } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-suggest-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir), posts = [];
  const service = createService({ store, candidates: async () => [{ applicationId: "app", candidateId: "candidate", candidateName: "TEST", jobTitle: "TEST", status: "Active" }],
    clientId: "luminai", routing: "client", channelId: "C0CONFIG", channelName: "luminai-rc-team", slack: async (plan, meta) => { posts.push({ plan, meta }); return { ts: `2.${posts.length}`, channel: "C0CONFIG" }; } });
  const option = { start: bookingPlan.sessions[0].start, end: bookingPlan.sessions[1].end, events: bookingPlan.sessions.map((s, i) => ({ title: s.title, start: s.start, end: s.end, interviewer: { name: s.interviewers[0].name } })) };
  const user = { id: "coordinator", canApprove: true };
  const first = await service.postScheduleOption({ applicationId: "app", candidateId: "candidate", timezone: "America/Los_Angeles", option, optionNumber: 1, sourceRef: "full-schedule:x:1", availabilitySource: "ashby",
    attendance: ["in_person", "in_person"], rulesRevision: 1, calendarCheck: { checkedAt: Date.now(), flags: [[], []] }, bookingPlan, submittedAvailability: submitted }, user);
  const calls = { replies: [], replaced: [], suggester: [] };
  const later = { ...option, start: "2099-10-31T18:00:00.000Z", events: option.events.map(e => ({ ...e, start: e.start.replace("10-30", "10-31"), end: e.end.replace("10-30", "10-31") })) };
  const suggester = async input => {
    calls.suggester.push(input);
    const f = typeof found === "function" ? await found(input, { service, store }) : found || { index: 0, result: { proposals: [later] } };
    return { submission: submitted, ...f, post: (u, suggestion) => service.postScheduleOption({ applicationId: "app", candidateId: "candidate", timezone: "America/Los_Angeles", option: later, optionNumber: 1, sourceRef: "full-schedule:x:2",
      availabilitySource: "ashby", attendance: ["in_person", "in_person"], rulesRevision: 1, calendarCheck: { checkedAt: Date.now(), flags: [[], []] }, bookingPlan, submittedAvailability: submitted, suggestion }, u) };
  };
  const slackApi = { userInfo: async id => ({ U0ANNA: { email: "Anna@carrara.is", name: "Anna Jones" } })[id] || { email: "someone@carrara.is", name: "Someone" },
    threadReply: async x => calls.replies.push(x.text), markReplaced: async x => calls.replaced.push(x.row), markApproved: async () => {} };
  const handler = createSlackInteractions({ service, slackApi, signingSecret: SECRET, teamId: "T0CARRARA", appId: "A0SCHED", channelId: "C0CONFIG", approvers: ["anna@carrara.is"], suggester, log: { warn() {} } });
  const app = express(); app.post("/i", express.raw({ type: "application/x-www-form-urlencoded" }), handler);
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const row = await store.get(first.id);
  const press = async (action, user = "U0ANNA") => {
    const body = "payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions", team: { id: "T0CARRARA" }, api_app_id: "A0SCHED", user: { id: user }, channel: { id: "C0CONFIG" }, container: { message_ts: row.slack.ts }, actions: [action] }));
    await fetch(`http://127.0.0.1:${server.address().port}/i`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...sign(body) }, body });
    for (let i = 0; i < 100 && !calls.replies.some(r => /^(Replaced|Every other|No |Another option|This |.*isn't an approver|.*Nothing was changed)/.test(r)); i++) await new Promise(r => setTimeout(r, 10));
  };
  const timeAction = { action_id: "suggest_time", value: JSON.stringify({ d: row.id, g: row.digest }) };
  const personAction = i => ({ action_id: "suggest_interviewer", selected_option: { value: JSON.stringify({ d: row.id, g: row.digest, i }) } });
  return { service, store, row, posts, calls, press, timeAction, personAction };
}

test("another time: found, then the post is withdrawn and the new option posted with its steer", async t => {
  const f = await fixture(t);
  await f.press(f.timeAction);
  assert.deepEqual(f.calls.suggester[0], { applicationId: "app", scheduleId: SCHED, steer: { replaces: f.row.id, kind: "time", by: "anna@carrara.is", avoidStarts: ["2099-10-30T18:00:00.000Z"], excludeInterviewers: [], requested: [], released: null } });
  const old = await f.store.get(f.row.id);
  assert.equal(old.state, "rejected");assert.equal(old.replaced.by, "anna@carrara.is");assert.equal(old.replaced.kind, "time");
  assert.equal(blocksRepost(old), false);
  const fresh = (await f.store.list()).find(r => r.id !== f.row.id);
  assert.equal(fresh.state, "shared");assert.equal(fresh.plan.suggestion.replaces, f.row.id);
  assert.equal(old.replaced.withDraft, fresh.id);
  assert.match(fresh.plan.notes, /^Suggested in Slack by anna@carrara\.is: another time, replacing the earlier post/);
  assert.equal(f.calls.replaced.length, 1);
  assert.match(f.calls.replies[0], /^Looking for another time, asked by Anna Jones\. This post stays open/);
  assert.match(f.calls.replies.at(-1), /^Replaced: the new option \(another time\) is posted in the channel\./);
  // The withdrawn post can't be approved or replaced again.
  await assert.rejects(f.service.approveInSlack({ draftId: f.row.id, digest: f.row.digest, channelId: "C0CONFIG", messageTs: f.row.slack.ts, approver: { email: "anna@carrara.is", slackUserId: "U0ANNA" } }), /replaced by another suggestion \(asked by anna@carrara\.is\)\. Use the newer post\./);
});

test("a different interviewer: the chosen session's person is left out", async t => {
  const f = await fixture(t);
  await f.press(f.personAction(1));
  assert.deepEqual(f.calls.suggester[0].steer.excludeInterviewers, [{ session: 1, userId: "u-joe", name: "Joe Penn" }]);
  assert.equal(f.calls.suggester[0].steer.session, 1);
  assert.match(f.calls.replies.at(-1), /^Replaced: the new option \(a different interviewer for session 2\)/);
});

test("nothing clean found: the post stays open and the thread says why", async t => {
  for (const [result, said] of [
    [{ status: "no_other_interviewer", reason: 'No one other than Joe Penn is eligible for session 2 ("Onsite").', proposals: [] }, /^No one other than Joe Penn is eligible for session 2 \("Onsite"\)\. This post is still open\.$/],
    [{ status: "needs_attention", proposals: [{ flagCount: 1 }, { flagCount: 2 }] }, /^Every other option for another time has calendar clashes \(2 found\), so none was posted\. This post is still open/],
    [{ status: "no_calendar_fit", reason: "No agenda fits.", proposals: [] }, /^No other option fits for another time: No agenda fits\. This post is still open\.$/]]) {
    const f = await fixture(t, { found: { index: -1, result } });
    await f.press(f.timeAction);
    assert.match(f.calls.replies.at(-1), said);
    assert.equal((await f.store.get(f.row.id)).state, "shared");
    assert.equal(f.posts.length, 1);assert.equal(f.calls.replaced.length, 0);
  }
});

test("approved while the search ran: never withdrawn, and the replacement never posted", async t => {
  const f = await fixture(t, { found: async (input, { service, store }) => {
    const row = (await store.list())[0];
    await service.approveInSlack({ draftId: row.id, digest: row.digest, channelId: "C0CONFIG", messageTs: row.slack.ts, approver: { email: "mary@carrara.is", slackUserId: "U0MARY", name: "Mary Petrino" } });
    return { index: 0, result: { proposals: [{}] } };
  } });
  await f.press(f.timeAction);
  assert.equal((await f.store.get(f.row.id)).state, "discussion_approved");
  assert.equal(f.posts.length, 1);assert.equal(f.calls.replaced.length, 0);
  assert.match(f.calls.replies.at(-1), /approved by Mary Petrino while another option was being found, so it wasn't replaced\. Nothing was changed\.$/);
});

test("anyone in the channel can ask, but Schedule on the replacement stays approvers-only; a post without the candidate's submission can't be rebuilt from Slack", async t => {
  let f = await fixture(t);
  await f.press(f.timeAction, "U0OTHER");
  assert.equal(f.calls.suggester.length, 1);
  assert.match(f.calls.replies.at(-1), /^Replaced: the new option \(another time\) is posted in the channel\./);
  const replacement = (await f.store.list()).find(r => r.id !== f.row.id && r.state !== "replaced" && r.plan?.suggestion);
  assert.equal(replacement.plan.suggestion.by, "someone@carrara.is");
  const before = f.calls.replies.length;
  await f.press({ action_id: "schedule_option", value: JSON.stringify({ d: replacement.id, g: replacement.digest }) }, "U0OTHER");
  assert.match(f.calls.replies[before], /^Someone isn't an approver for this client's interview schedules, so nothing was recorded\./);
  assert.equal((await f.store.get(replacement.id)).slackApproval ?? null, null);
  f = await fixture(t);
  const option = { start: bookingPlan.sessions[0].start, end: bookingPlan.sessions[1].end, events: bookingPlan.sessions.map(s => ({ title: s.title, start: s.start, end: s.end, interviewer: { name: s.interviewers[0].name } })) };
  const typed = await f.service.postScheduleOption({ applicationId: "app", candidateId: "candidate", timezone: "America/Los_Angeles", option, optionNumber: 1, sourceRef: "full-schedule:x:typed", availabilitySource: "manual",
    attendance: ["in_person", "in_person"], rulesRevision: 1, calendarCheck: { checkedAt: Date.now(), flags: [[], []] }, bookingPlan, submittedAvailability: submitted }, { id: "coordinator", canApprove: true });
  const row = await f.store.get(typed.id);
  await assert.rejects(f.service.suggestionSource({ draftId: row.id, digest: row.digest, channelId: "C0CONFIG", messageTs: row.slack.ts }), /wasn't built from the candidate's submitted availability/);
});
