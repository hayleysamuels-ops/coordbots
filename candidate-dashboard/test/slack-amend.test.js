"use strict";
// Amending a post by @mention (slack-amend.js), end to end with a real service
// and store: restated before anything changes, confirmed only by the person
// who asked, then replaced through the suggestion buttons' path at the same
// times and with the same people but the one change. The model, Ashby's plan
// read and the calendar search are stubs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { createSlackAmend } = require("../src/scheduling/slack-amend");
const { createSlackInteractions } = require("../src/scheduling/slack-interactions");
const { createService } = require("../src/scheduling/service");
const { createStore } = require("../src/scheduling/store");
const { createSlack, blockProblems } = require("../src/scheduling/slack");
const { suggestionNote } = require("../src/scheduling/suggestion");

const SCHED = "c95bfecf-9e5c-4d61-8f32-2586d26fa96f", SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const P = (userId, name) => ({ userId, name, email: `${name.split(" ")[0].toLowerCase()}@luminai.com` });
const hayley = P("u-hayley", "Hayley Samuels"), joe = P("u-joe", "Joe Penn"), mary = P("u-mary", "Mary Petrino"), vamsi = P("u-vamsi", "Vamsi Chitters");
const bookingPlan = { applicationId: "app", interviewScheduleId: SCHED, sessions: [
  { title: "Onsite", interviewId: "i1", start: "2099-10-30T18:00:00.000Z", end: "2099-10-30T18:30:00.000Z", interviewers: [hayley] },
  { title: "Onsite", interviewId: "i2", start: "2099-10-30T18:30:00.000Z", end: "2099-10-30T19:00:00.000Z", interviewers: [joe] }] };
const submitted = { scheduleId: SCHED, timezone: "America/Los_Angeles", windows: [{ start: "2099-10-30T17:00:00.000Z", end: "2099-10-31T00:00:00.000Z" }] };
const sign = body => { const ts = Math.floor(Date.now() / 1000); return { "x-slack-request-timestamp": String(ts), "x-slack-signature": "v0=" + crypto.createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex") }; };
const swap = (session, replace, w) => ({ kind: "replace_interviewer", session, replace, with: w });
const until = async (fn, ms = 2000) => { for (let i = 0; i < ms / 10 && !fn(); i++) await new Promise(r => setTimeout(r, 10)); };

async function fixture(t, { reading = swap(2, "Joe", "Mary"), found, approve = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-amend-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir), posts = [];
  const service = createService({ store, candidates: async () => [{ applicationId: "app", candidateId: "candidate", candidateName: "TEST", jobTitle: "TEST", status: "Active" }],
    clientId: "luminai", routing: "client", channelId: "C0CONFIG", channelName: "luminai-rc-team", slack: async (plan, meta) => { posts.push({ plan, meta }); return { ts: `2.${posts.length}`, channel: "C0CONFIG" }; } });
  const option = { start: bookingPlan.sessions[0].start, end: bookingPlan.sessions[1].end, events: bookingPlan.sessions.map(s => ({ title: s.title, start: s.start, end: s.end, interviewer: { name: s.interviewers[0].name } })) };
  const coordinator = { id: "coordinator", canApprove: true };
  const first = await service.postScheduleOption({ applicationId: "app", candidateId: "candidate", timezone: "America/Los_Angeles", option, optionNumber: 1, sourceRef: "full-schedule:x:1", availabilitySource: "ashby",
    attendance: ["in_person", "in_person"], rulesRevision: 1, calendarCheck: { checkedAt: Date.now(), flags: [[], []] }, bookingPlan, submittedAvailability: submitted }, coordinator);
  const row = await store.get(first.id);
  if (approve) await service.approveInSlack({ draftId: row.id, digest: row.digest, channelId: "C0CONFIG", messageTs: row.slack.ts, approver: { email: "mary@carrara.is", slackUserId: "U0MARY", name: "Mary Petrino" } });

  const calls = { replies: [], prompts: [], settled: [], replaced: [], suggester: [], read: [], plans: 0, logs: [] };
  const clock = { now: Date.now() };
  const swapped = { ...option, events: option.events.map((e, i) => i === 1 ? { ...e, interviewer: { name: "Mary Petrino" } } : e) };
  const suggester = async input => {
    calls.suggester.push(input);
    const f = typeof found === "function" ? found(input) : found || { index: 0, result: { proposals: [swapped] } };
    return { submission: submitted, ...f, post: (u, suggestion) => service.postScheduleOption({ applicationId: "app", candidateId: "candidate", timezone: "America/Los_Angeles", option: swapped, optionNumber: 1, sourceRef: `full-schedule:x:${calls.suggester.length + 1}`,
      availabilitySource: "ashby", attendance: ["in_person", "in_person"], rulesRevision: 1, calendarCheck: { checkedAt: Date.now(), flags: [[], []] }, bookingPlan, submittedAvailability: submitted, suggestion }, u) };
  };
  const users = { U0ANNA: { email: "Anna@carrara.is", name: "Anna Jones" }, U0OTHER: { email: "someone@carrara.is", name: "Someone Else" }, U0JOE: { email: "joe@luminai.com", name: "Joe Penn" } };
  const slackApi = { userInfo: async id => users[id] || null, threadReply: async x => calls.replies.push(x.text), markReplaced: async x => calls.replaced.push(x.row), markApproved: async () => {},
    amendPrompt: async x => { calls.prompts.push(x); return `5.${calls.prompts.length}`; }, amendSettled: async x => calls.settled.push(x) };
  const facts = {
    resolveInterviewers: async list => ({ sessions: list.map((s, i) => ({ ...s, eligibleInterviewers: i === 0 ? [hayley] : [joe, mary] })) }),
    activeUsers: async () => [hayley, joe, mary, vamsi],
  };
  const log = { log: m => calls.logs.push(m), warn: m => calls.logs.push(m) };
  const amender = createSlackAmend({ service, slackApi, facts, timeZone: "America/Los_Angeles", now: () => clock.now, log, suggester,
    readPlan: async input => { calls.plans++; assert.deepEqual(input, { applicationId: "app", scheduleId: SCHED }); return { sessions: [{ interviewId: "i1" }, { interviewId: "i2" }] }; },
    interpret: async args => { calls.read.push(args); if (typeof reading === "function") return reading(args); return reading; } });
  const handler = createSlackInteractions({ service, slackApi, signingSecret: SECRET, teamId: "T0CARRARA", appId: "A0SCHED", channelId: "C0CONFIG", approvers: ["anna@carrara.is"], amender, log });
  const app = express(); app.post("/i", express.raw({ type: "application/x-www-form-urlencoded" }), handler);
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const mention = (text = "<@U0BOT> have <@U0MARY> take Onsite 2 instead of Joe", user = "U0ANNA", threadTs = row.slack.ts) =>
    amender.onMention({ eventId: `Ev${Math.random()}`, user, text, channel: "C0CONFIG", threadTs, ts: "3.1", botUserId: "U0BOT" });
  const press = async (yes, user = "U0ANNA", prompt = calls.prompts.at(-1), ts = `5.${calls.prompts.length}`) => {
    const before = { replies: calls.replies.length, settled: calls.settled.length };
    const body = "payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions", trigger_id: crypto.randomUUID(), team: { id: "T0CARRARA" }, api_app_id: "A0SCHED", user: { id: user }, channel: { id: "C0CONFIG" },
      container: { message_ts: ts, thread_ts: row.slack.ts }, actions: [{ action_id: yes ? "amend_confirm" : "amend_cancel", value: prompt.value }] }));
    await fetch(`http://127.0.0.1:${server.address().port}/i`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...sign(body) }, body });
    // Done at a reply, or at a settled restatement that isn't "Confirmed" (a confirm then replies).
    await until(() => calls.replies.length > before.replies || calls.settled.slice(before.settled).some(x => !/Confirmed by/.test(x.text)));
  };
  return { service, store, row, posts, calls, clock, mention, press };
}

test("a clear request: named session first, then restated; only the asker confirms; replaced at the same times with only that change", async t => {
  const f = await fixture(t);
  await f.mention();
  // What reached the model: the bot's mention gone, people named, the sessions by label. Never the candidate.
  assert.equal(f.calls.read[0].text, "have @someone take Onsite 2 instead of Joe");
  assert.deepEqual(f.calls.read[0].sessions.map(s => [s.title, s.interviewer]), [["Onsite 1", "Hayley Samuels"], ["Onsite 2", "Joe Penn"]]);
  assert.doesNotMatch(JSON.stringify(f.calls.read[0]), /TEST|candidate/);
  assert.deepEqual(f.calls.replies, ["Checking Ashby for Onsite 2's eligible interviewers, about a minute."]);
  assert.equal(f.calls.prompts[0].text, "Replace Joe Penn with Mary Petrino on Onsite 2 (Fri, Oct 30, 11:30 AM–12:00 PM PDT)? Only Anna Jones can confirm. Nothing changes until then, and this lapses in 30 minutes.");
  assert.equal(f.calls.prompts[0].threadTs, f.row.slack.ts);

  await f.press(true, "U0OTHER");
  assert.equal(f.calls.replies.at(-1), "Only Anna Jones, who asked, can confirm this. Nothing was changed.");
  assert.equal(f.calls.suggester.length, 0);

  await f.press(true);
  assert.match(f.calls.settled[0].text, /^Replace Joe Penn with Mary Petrino on Onsite 2 .*\? Confirmed by Anna Jones\. Checking the calendars for the new option, about a minute\.$/);
  const [{ steer }] = f.calls.suggester;
  assert.deepEqual(steer.fixedStarts, bookingPlan.sessions.map(s => s.start));
  assert.deepEqual(steer.requireInterviewers, [{ session: 0, userId: "u-hayley", name: "Hayley Samuels" }, { session: 1, userId: "u-mary", name: "Mary Petrino" }]);
  assert.equal(steer.kind, "amend");
  // Joe stays out of Onsite 2 for later button presses.
  assert.deepEqual(steer.excludeInterviewers, [{ session: 1, userId: "u-joe", name: "Joe Penn" }]);
  const old = await f.store.get(f.row.id);
  assert.equal(old.state, "rejected");
  assert.equal(old.replaced.change, "replace Joe Penn with Mary Petrino on Onsite 2");
  const fresh = await f.store.get(old.replaced.withDraft);
  assert.equal(fresh.state, "shared");
  assert.equal(fresh.plan.suggestion.change.moved, false);
  assert.match(fresh.plan.notes, /^Amended in Slack by anna@carrara\.is: replace Joe Penn with Mary Petrino on Onsite 2, same times\. It replaces the earlier post \(draft /);
  assert.equal(fresh.plan.suggestion.requireInterviewers, undefined);
  assert.equal(f.calls.replies.at(-1), "Replaced: the new option has Mary Petrino on Onsite 2, at the same times. Nothing from this post was booked or sent.");

  // The confirmed restatement can't be pressed again.
  const settled = f.calls.settled.length;
  await f.press(true);
  assert.match(f.calls.settled[settled].text, /^This request is no longer waiting/);
  assert.equal(f.calls.suggester.length, 1);
});

test("the same times no longer come out clean: widened to any time with the same people, and the thread says the time moved", async t => {
  const f = await fixture(t, { found: input => input.steer.fixedStarts ? { index: -1, result: { status: "needs_attention", proposals: [{ flagCount: 1 }] } } : undefined });
  await f.mention(); await f.press(true);
  assert.equal(f.calls.suggester.length, 2);
  assert.equal(f.calls.suggester[1].steer.fixedStarts, undefined);
  assert.deepEqual(f.calls.suggester[1].steer.requireInterviewers, f.calls.suggester[0].steer.requireInterviewers);
  assert.equal(f.calls.replies.at(-1), "Replaced: the new option has Mary Petrino on Onsite 2, but the times moved because someone's calendar clashes at those times. Check the new post's times. Nothing from this post was booked or sent.");
  const fresh = (await f.store.list()).find(r => r.id !== f.row.id);
  assert.match(fresh.plan.notes, /no agenda at the earlier times fit, so the times moved/);
});

test("nothing clean at any time: the post stays open and says why", async t => {
  const f = await fixture(t, { found: () => ({ index: -1, result: { status: "needs_attention", proposals: [{ flagCount: 1 }, { flagCount: 1 }] } }) });
  await f.mention(); await f.press(true);
  assert.match(f.calls.replies.at(-1), /^Every agenda with Mary Petrino on Onsite 2 and everyone else unchanged has calendar clashes \(2 found\), so none was posted\. This post is still open/);
  assert.equal((await f.store.get(f.row.id)).state, "shared");
  const g = await fixture(t, { found: () => ({ index: -1, result: { status: "no_other_interviewer", reason: 'Mary Petrino can\'t take session 2 ("Onsite"): Mary Petrino can\'t be scheduled (Ashby weekly interview limit is 0).', proposals: [] } }) });
  await g.mention(); await g.press(true);
  assert.equal(g.calls.suggester.length, 1);
  assert.match(g.calls.replies.at(-1), /Ashby weekly interview limit is 0\)\. This post is still open\.$/);
});

test("Cancel, a lapse, and a second person's request while one waits", async t => {
  let f = await fixture(t);
  await f.mention(); await f.press(false);
  assert.match(f.calls.settled.at(-1).text, /\? Cancelled by Anna Jones; nothing was changed\.$/);
  assert.equal(f.calls.suggester.length, 0);

  f = await fixture(t);
  await f.mention();
  await f.mention("<@U0BOT> swap Hayley for Joe", "U0OTHER");
  assert.match(f.calls.replies.at(-1), /^Anna Jones has a change waiting to be confirmed on this post: Replace Joe Penn with Mary Petrino on Onsite 2 .*\? Only they can confirm or cancel it; it lapses at /);
  assert.equal(f.calls.prompts.length, 1);
  f.clock.now += 31 * 60 * 1000;
  await f.press(true);
  assert.match(f.calls.settled.at(-1).text, /Not confirmed within 30 minutes, so nothing was changed\. Ask again if it's still wanted\.$/);
  assert.equal(f.calls.suggester.length, 0);

  // The asker's own newer request replaces their earlier one.
  f = await fixture(t);
  await f.mention(); await f.mention();
  assert.equal(f.calls.prompts.length, 2);
  assert.match(f.calls.settled.at(-1).text, /Replaced by a newer request, so nothing was changed\.$/);
  await f.press(true, "U0ANNA", f.calls.prompts[0], "5.1");
  assert.match(f.calls.settled.at(-1).text, /^This request is no longer waiting/);
});

test("asked, not guessed; off-plan declined; and nothing read on a post that can't change", async t => {
  let f = await fixture(t, { reading: swap(null, "Joe", "Vamsi") });
  await f.mention();
  assert.equal(f.calls.replies.at(-1), "You asked to replace Joe Penn with Vamsi Chitters on Onsite 2 (Fri, Oct 30, 11:30 AM–12:00 PM PDT). Vamsi Chitters isn't eligible for Onsite 2 in Ashby; off-plan interviewers aren't supported yet. Nothing was changed.");
  assert.ok(f.calls.logs.some(l => /^\[amend\] Declined an off-plan interviewer on draft .*, session 2/.test(l)));
  assert.equal(f.calls.prompts.length, 0);

  // Which session isn't clear: asked before Ashby is read.
  f = await fixture(t, { reading: swap(null, null, "Mary") });
  await f.mention();
  assert.match(f.calls.replies.at(-1), /^Which session should Mary take: Onsite 1 \(.*\) or Onsite 2 \(.*\)\?$/);
  assert.equal(f.calls.plans, 0);

  f = await fixture(t, { approve: true });
  await f.mention();
  assert.match(f.calls.replies.at(-1), /^This draft can't be replaced from Slack\.|already approved/);
  assert.equal(f.calls.read.length, 0);

  f = await fixture(t);
  await f.mention(undefined, "U0ANNA", "1.999");
  assert.equal(f.calls.replies.at(-1), "This thread isn't an interview schedule post, so there's nothing here I can change.");
});

test("an unreadable request and a failed service are worded apart", async t => {
  let f = await fixture(t, { reading: () => { throw Object.assign(new Error("The request couldn't be read."), { kind: "understanding", status: 503 }); } });
  await f.mention();
  assert.equal(f.calls.replies.at(-1), `The request couldn't be read. Nothing was changed. Say who should come off, who should go on and which session, for example "have Vamsi take Onsite 2 instead of Joe".`);
  const service = "The bot couldn't reach the service that reads requests, so nothing was changed. This isn't about how the request was worded: try the same request again later, or tell whoever looks after the dashboard.";
  f = await fixture(t, { reading: () => { throw Object.assign(new Error(service), { kind: "service", status: 503 }); } });
  await f.mention();
  assert.equal(f.calls.replies.at(-1), service);
  assert.equal(f.calls.plans, 0);
});

test("the restatement's buttons and the replaced post's wording, within Slack's limits", async () => {
  const calls = [];
  const slack = createSlack("x", async (url, o) => { calls.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ ok: true, ts: "7.7" }) }; }, { displayTimeZone: "America/Los_Angeles", interactive: true });
  assert.equal(await slack.amendPrompt({ channel: "C0CONFIG", threadTs: "1.1", text: "Replace Joe Penn with Mary Petrino on Onsite 2 (Fri)? Only Anna Jones can confirm.", value: JSON.stringify({ a: crypto.randomUUID() }) }), "7.7");
  assert.equal(calls[0].thread_ts, "1.1");
  assert.deepEqual(calls[0].blocks[1].elements.map(e => e.action_id), ["amend_confirm", "amend_cancel"]);
  assert.deepEqual(blockProblems(calls[0]), []);
  await slack.amendSettled({ channel: "C0CONFIG", ts: "7.7", text: "Cancelled." });
  assert.equal(calls[1].blocks.some(b => b.type === "actions"), false);
  const plan = { candidateName: "TEST", jobTitle: "TEST", timezone: "America/Los_Angeles", format: "calendar_checked", notes: "n", sessions: [{ title: "Onsite", start: "2099-10-30T18:00:00.000Z", end: "2099-10-30T18:30:00.000Z", interviewers: "Joe Penn", location: "x", people: [{ name: "Joe Penn" }] }] };
  await slack.markReplaced({ channel: "C0CONFIG", ts: "1.2", row: { id: "old", plan, replaced: { by: "anna@carrara.is", kind: "amend", session: 0, change: "replace Joe Penn with Mary Petrino on Onsite", at: "2099-10-26T22:00:00Z" } } });
  assert.match(calls[2].blocks.at(-1).text.text, /anna@carrara\.is asked to replace Joe Penn with Mary Petrino on Onsite, and a new option was posted below\./);
  assert.equal(suggestionNote({ kind: "amend", by: "a@b", replaces: "d", change: { label: "Onsite 2", out: joe, in: mary, moved: true } }),
    "Amended in Slack by a@b: replace Joe Penn with Mary Petrino on Onsite 2; no agenda at the earlier times fit, so the times moved. It replaces the earlier post (draft d).");
});
