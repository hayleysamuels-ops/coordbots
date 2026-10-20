"use strict";
// The Ashby check after a Slack approval (src/scheduling/ashby-check.js): its
// states, one check at a time, the earlier draft replaced, the sweep (sent,
// or deleted unsent at the deadline), recovery after a restart, and what the
// Slack message says in each state. The worker, Ashby and Slack are stand-ins.
const { test } = require("node:test"), assert = require("node:assert/strict");
const { createAshbyCheck, deleteByFor, compareBooked } = require("../src/scheduling/ashby-check");
const { createSlack } = require("../src/scheduling/slack");
const { bookingPlanForPost } = require("../src/scheduling/booking-plan");

const SCHED = "18599066-1d55-493a-8c2f-1e970b04f86c";
const bookingPlan = { applicationId: "app-1", interviewScheduleId: SCHED, activityTitle: "First Round Interview Schedule",
  sessions: [
    { title: "First Round", start: "2099-10-15T19:00:00.000Z", end: "2099-10-15T19:30:00.000Z", interviewers: [{ email: "hayley@luminai.com" }] },
    { title: "First Round", start: "2099-10-15T19:30:00.000Z", end: "2099-10-15T20:00:00.000Z", interviewers: [{ email: "mary@luminai.com" }] }] };
const row = (id, extra = {}) => ({ id, clientId: "luminai", revision: 3, state: "discussion_approved", audit: [], slack: { channel: "C1", ts: `1.${id}` },
  slackApproval: { email: "anna@carrara.is", name: "Anna Jones", at: "2099-01-01T17:00:00Z" },
  plan: { candidateName: "TEST", jobTitle: "TEST", bookingPlan, sessions: [] }, ...extra });

function memoryStore(rows) {
  const data = Object.fromEntries(rows.map(r => [r.id, structuredClone(r)]));
  return { data, list: async () => Object.values(data).map(r => structuredClone(r)), get: async id => structuredClone(data[id] || null),
    replace: async (id, revision, next) => { if (data[id]?.revision !== revision) return false; data[id] = structuredClone(next); return true; } };
}
function setup({ rows = [row("d1")], compose, discard, inviteStatus = null, booked = null, at = Date.parse("2099-10-14T12:00:00Z") } = {}) {
  const store = memoryStore(rows), calls = [], shown = [], replies = [];
  let clock = at;
  const worker = { call: async (action, payload) => { calls.push({ action, payload });
    if (action === "compose") return typeof compose === "function" ? compose(payload) : compose;
    if (action === "invite-status") return typeof inviteStatus === "function" ? inviteStatus(payload) : inviteStatus;
    return typeof discard === "function" ? discard(payload) : discard; } };
  const facts = { scheduleState: async () => (typeof booked === "function" ? booked() : booked) };
  const slackApi = { markApproved: async ({ row }) => { shown.push(row.ashbyCheck?.state); }, threadReply: async ({ text }) => { replies.push(text); } };
  const pauses = [];
  const check = createAshbyCheck({ store, worker, facts, slackApi, clientId: "luminai", now: () => clock, log: { warn() {} }, pause: async ms => { pauses.push(ms); } });
  return { store, calls, shown, replies, pauses, check, tick: ms => { clock += ms; } };
}
const composed = { status: "composed", draftId: "dr-1", cleanup: { deleted: false, kept: true, draftId: "dr-1" }, wouldSend: { from: "Anna Jones <anna@luminai.com>" }, checks: [{ name: "a" }, { name: "b" }] };

test("an approval is queued, run, and left composed in Ashby with its delete deadline", async () => {
  const s = setup({ compose: composed });
  const queued = await s.check.start((await s.store.list())[0]);
  assert.equal(queued.ashbyCheck.state, "queued");
  await s.check.idle();
  const c = s.store.data.d1.ashbyCheck;
  assert.equal(c.state, "composed");assert.equal(c.draftId, "dr-1");assert.equal(c.from, "Anna Jones <anna@luminai.com>");
  // 24 hours after composing comes before 2 hours before the interview here.
  assert.equal(c.deleteBy, "2099-10-15T12:00:00.000Z");
  assert.deepEqual(s.shown, ["running", "composed"]);
  assert.deepEqual(s.calls, [{ action: "compose", payload: { plan: bookingPlan, supersedeDraftId: null, proposalId: "d1" } }]);
  assert.match(s.replies[0], /^Ashby check passed: a; b\.$/);
  // Approving twice never queues a second check.
  assert.equal(await s.check.start(s.store.data.d1), null);
});

test("an approval less than two hours before the first interview isn't composed, even if the queue brings it inside", async () => {
  // First interview 2099-10-15T19:00Z; two hours before is 17:00Z.
  const s = setup({ compose: composed, at: Date.parse("2099-10-15T17:30:00Z") });
  const done = await s.check.start((await s.store.list())[0]);
  assert.equal(done.ashbyCheck.state, "too_close");
  await s.check.idle();
  assert.equal(s.calls.length, 0);assert.equal(s.store.data.d1.ashbyCheck.state, "too_close");
  // Exactly at the line counts as too close.
  const edge = setup({ compose: composed, at: Date.parse("2099-10-15T17:00:00Z") });
  assert.equal((await edge.check.start((await edge.store.list())[0])).ashbyCheck.state, "too_close");
  // Queued in time, but its turn comes too late: still not composed.
  let t;
  t = setup({ rows: [row("d1"), row("d2", { plan: { ...row("d2").plan, bookingPlan: { ...bookingPlan, interviewScheduleId: "other" } } })],
    at: Date.parse("2099-10-15T16:59:00Z"), compose: async () => { t.tick(5 * 60000); return composed; } });
  for (const r of await t.store.list()) await t.check.start(r);
  await t.check.idle();
  assert.equal(t.store.data.d1.ashbyCheck.state, "composed");
  assert.equal(t.store.data.d2.ashbyCheck.state, "too_close");assert.equal(t.calls.length, 1);
  assert.deepEqual(t.shown.slice(-1), ["too_close"]);
});

test("the delete deadline is whichever comes first: two hours before the first interview, or a day after composing", () => {
  assert.equal(deleteByFor(bookingPlan, "2099-10-15T10:00:00.000Z"), "2099-10-15T17:00:00.000Z");
  assert.equal(deleteByFor(bookingPlan, "2099-10-13T10:00:00.000Z"), "2099-10-14T10:00:00.000Z");
});

test("each worker answer becomes a state: skipped, refused, not started, uncertain", async () => {
  const cases = [
    [{ status: "skipped", reason: "The Ashby check is switched off on the scheduling worker (BOOKING_COMPOSE)." }, "skipped"],
    [{ status: "refused", step: "compose session 1", reason: "The composer shows times in \"MDT\", not EDT.", draftId: "dr-1", cleanup: { deleted: true } }, "refused"],
    [() => { throw Object.assign(Error("Ashby is busy checking an approved schedule."), { status: 409 }); }, "not_started"],
    [() => { throw Object.assign(Error("The operation was aborted due to timeout")); }, "uncertain"],
    [{ status: "uncertain", reason: "The Ashby check ran past its deadline and was stopped.", draftId: "dr-1" }, "uncertain"],
    [{ status: "composed", draftId: "dr-1", cleanup: { deleted: true } }, "uncertain"],
  ];
  for (const [answer, state] of cases) {
    const s = setup({ compose: answer });
    await s.check.start((await s.store.list())[0]);await s.check.idle();
    assert.equal(s.store.data.d1.ashbyCheck.state, state, JSON.stringify(answer));
  }
});

test("a post without a plan isn't checked, and checks run one at a time in approval order", async () => {
  const s = setup({ rows: [row("d1", { plan: { candidateName: "TEST", jobTitle: "TEST", sessions: [] } })], compose: composed });
  assert.equal(await s.check.start((await s.store.list())[0]), null);
  assert.equal(s.calls.length, 0);
  let active = 0, most = 0;
  const t = setup({ rows: [row("d1"), row("d2", { plan: { ...row("d2").plan, bookingPlan: { ...bookingPlan, interviewScheduleId: "other" } } })],
    compose: async () => { active++;most = Math.max(most, active);await new Promise(r => setTimeout(r, 20));active--;return composed; } });
  for (const r of await t.store.list()) await t.check.start(r);
  await t.check.idle();
  assert.equal(most, 1);assert.deepEqual(t.calls.map(c => c.payload.plan.interviewScheduleId), [SCHED, "other"]);
});

test("a later approval for the same schedule replaces the earlier draft, and the earlier message says so", async () => {
  const earlier = row("d1", { ashbyCheck: { state: "composed", draftId: "dr-old", composedAt: "2099-10-14T11:00:00.000Z", deleteBy: "2099-10-15T11:00:00.000Z" } });
  const s = setup({ rows: [earlier, row("d2")], compose: { ...composed, draftId: "dr-new", cleanup: { kept: true }, superseded: { draftId: "dr-old", deleted: true } } });
  await s.check.start(s.store.data.d2);await s.check.idle();
  assert.equal(s.calls[0].payload.supersedeDraftId, "dr-old");
  assert.equal(s.store.data.d2.ashbyCheck.draftId, "dr-new");
  assert.equal(s.store.data.d1.ashbyCheck.state, "superseded");assert.equal(s.store.data.d1.ashbyCheck.draftDeleted, true);
});

test("the sweep records a sent schedule, with whether it matches, and never deletes it", async () => {
  const left = { state: "composed", draftId: "dr-1", composedAt: "2099-10-14T11:00:00.000Z", deleteBy: "2099-10-14T11:30:00.000Z" };
  const match = { status: "Scheduled", events: bookingPlan.sessions.map(x => ({ start: x.start, end: x.end, interviewers: x.interviewers.map(i => i.email) })) };
  const s = setup({ rows: [row("d1", { ashbyCheck: left })], booked: match, discard: () => assert.fail("a sent schedule's draft must not be deleted") });
  await s.check.sweep();
  assert.equal(s.store.data.d1.ashbyCheck.state, "sent");assert.deepEqual(s.store.data.d1.ashbyCheck.differences, []);
  const changed = structuredClone(match);changed.events[1].interviewers = ["someone@luminai.com"];
  assert.deepEqual(compareBooked(bookingPlan, changed), ["session 2's interviewers changed"]);
  assert.deepEqual(compareBooked(bookingPlan, { events: [match.events[0]] }), ["1 interview was booked, but 2 were approved"]);
});

test("an unsent draft is left alone until its deadline, then deleted, and a failed delete says so", async () => {
  const left = { state: "composed", draftId: "dr-1", composedAt: "2099-10-14T11:00:00.000Z", deleteBy: "2099-10-14T13:00:00.000Z" };
  const waiting = { status: "CandidateAvailabilitySubmitted", events: [] };
  const s = setup({ rows: [row("d1", { ashbyCheck: left })], booked: waiting, discard: p => ({ deleted: true, draftId: p.draftId }) });
  await s.check.sweep();
  assert.equal(s.store.data.d1.ashbyCheck.state, "composed");assert.equal(s.calls.length, 0);
  s.tick(3600 * 1000);await s.check.sweep();
  assert.equal(s.store.data.d1.ashbyCheck.state, "deleted");
  assert.deepEqual(s.calls, [{ action: "discard-draft", payload: { plan: bookingPlan, draftId: "dr-1", proposalId: "d1" } }]);
  for (const [answer, state] of [[{ deleted: false, absent: true }, "gone"], [{ deleted: false, reason: "Ashby didn't confirm the delete" }, "delete_failed"],
    [() => { throw Error("worker unreachable"); }, "delete_failed"]]) {
    const t = setup({ rows: [row("d1", { ashbyCheck: left })], booked: waiting, discard: answer, at: Date.parse("2099-10-14T14:00:00Z") });
    await t.check.sweep();
    assert.equal(t.store.data.d1.ashbyCheck.state, state);
  }
  // An unreadable schedule is left for the next sweep, never deleted blind.
  const u = setup({ rows: [row("d1", { ashbyCheck: left })], booked: () => { throw Error("Ashby down"); }, at: Date.parse("2099-10-14T14:00:00Z") });
  await u.check.sweep();
  assert.equal(u.store.data.d1.ashbyCheck.state, "composed");assert.equal(u.calls.length, 0);
});

test("after a restart, a check left running is uncertain, and one left queued never started", async () => {
  const s = setup({ rows: [row("d1", { ashbyCheck: { state: "running" } }), row("d2", { ashbyCheck: { state: "composed", draftId: "x", deleteBy: "2099-10-15T00:00:00Z" } }), row("d3", { ashbyCheck: { state: "queued" } })] });
  await s.check.recover();
  assert.equal(s.store.data.d1.ashbyCheck.state, "uncertain");assert.match(s.store.data.d1.ashbyCheck.reason, /restarted while the check was running/);
  assert.equal(s.store.data.d2.ashbyCheck.state, "composed");
  assert.equal(s.store.data.d3.ashbyCheck.state, "not_started");
});

test("the Slack message says what's true in every state, and never that something was sent when it wasn't", async () => {
  const calls = [];
  const slack = createSlack("x", async (url, o) => { calls.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ ok: true }) }; }, { displayTimeZone: "America/Los_Angeles", interactive: true });
  const at = "2099-10-14T22:00:00Z";
  const states = {
    queued: [/Waiting to be checked in Ashby/, /Nothing is booked or sent/],
    running: [/Checking in Ashby\* \(started Oct 14, 3:00 PM PDT\)/, /stopping before Send\. Nothing will be booked or sent/],
    composed: [/Composed and waiting in Ashby\* \(checked Oct 14, 3:00 PM PDT\): open TEST's First Round Interview Schedule in Ashby, go to its Drafts tab, open the draft and click Send\. The candidate's confirmation email will come from Anna Jones &lt;anna@luminai\.com&gt;\./, /Not sent yet\.\* If it isn't sent by Oct 15, 3:00 PM PDT, the draft is deleted and this needs booking by hand/],
    sent: [/Sent in Ashby\* \(seen Oct 14, 3:00 PM PDT\): what was booked matches this approval/],
    deleted: [/Draft deleted unsent\* at Oct 14, 3:00 PM PDT\. \*Not booked:\* this needs booking in Ashby by hand\./],
    gone: [/no longer in Ashby/, /Not booked:\* book this schedule in Ashby by hand/],
    delete_failed: [/couldn't be deleted/, /never "Delete Activity"/],
    superseded: [/Superseded\* at Oct 14, 3:00 PM PDT by a later approval/],
    refused: [/The Ashby check stopped\* at "compose session 1": The composer shows times in "MDT", not EDT\./, /The draft it made was deleted\./, /Not booked:\* book this schedule in Ashby by hand/],
    not_started: [/didn't start:\* Ashby is busy\./, /no draft was made/],
    uncertain: [/didn't finish\*/, /a draft may be left in Ashby/, /never "Delete Activity"/],
    too_close: [/\*Not booked:\* too close to the first interview — book this in Ashby by hand\./, /no invitations or candidate email have been sent/],
    skipped: [/Not booked yet\.\*/, /Not checked in Ashby: the check is only on for test candidates so far\./],
  };
  for (const [state, patterns] of Object.entries(states)) {
    const check = { state, at, startedAt: at, composedAt: at, deleteBy: "2099-10-15T22:00:00Z", sentSeenAt: at, deletedAt: at, goneSeenAt: at, failedAt: at, supersededAt: at,
      from: "Anna Jones <anna@luminai.com>", differences: [], step: "compose session 1", reason: state === "skipped" ? "Application x isn't one the booking robot may use." : state === "not_started" ? "Ashby is busy." : "The composer shows times in \"MDT\", not EDT.",
      draftId: "dr-1", cleanup: { deleted: true } };
    calls.length = 0;
    await slack.markApproved({ channel: "C1", ts: "1.2", row: { id: "d1", plan: { candidateName: "TEST", jobTitle: "TEST", bookingPlan, sessions: [], notes: "" }, slackApproval: { email: "anna@carrara.is", name: "Anna Jones", at }, ashbyCheck: check } });
    const text = calls[0].blocks.map(b => b.text?.text || "").join("\n");
    for (const p of patterns) assert.match(text, p, state);
    if (state !== "sent") assert.doesNotMatch(text + calls[0].text, /\bSent in Ashby\b|\b(has been|was|is now) booked\b|\binvitations? (have been|were) sent\b/i, state);
  }
});

test("a posted option carries the check's plan: the activity holding its interviews, in the candidate's zone", () => {
  const fullPlan = { jobId: "837cc1e9-15ed-4f07-8755-51ee29f4ea39", candidateId: "fc88f24e-d59b-4e58-aa51-f0e94b1a32da", applicationId: "8dfd8f14-83c4-41f8-aaf1-416b75cb0892", scheduleId: SCHED,
    candidateName: "TEST", candidateEmail: "HayleySamuels511@gmail.com", jobTitle: "TEST", stageTitle: "First Round",
    activities: [{ title: "First Round Interview Schedule", sessions: [{ interviewId: "8b357d3b-5bff-41a6-896f-94da41ddd08c" }] }, { title: "Other", sessions: [] }] };
  const option = { events: [{ title: "First Round", interviewId: "8b357d3b-5bff-41a6-896f-94da41ddd08c", start: "2099-10-15T19:00:00.000Z", end: "2099-10-15T19:30:00.000Z",
    interviewer: { userId: "c251f667-e04c-403a-8c70-4cbc8fc3f435", name: "Hayley Samuels", email: "hayley@luminai.com" } }] };
  const { plan } = bookingPlanForPost({ fullPlan, option, timezone: "America/Denver" });
  assert.equal(plan.activityTitle, "First Round Interview Schedule");assert.equal(plan.interviewScheduleId, SCHED);
  assert.equal(plan.timeZone, "America/Denver");assert.equal(plan.candidate.email, "hayleysamuels511@gmail.com");assert.equal(plan.stage.title, "First Round");
  // Never guessed: no single activity, or a missing field, means no plan.
  assert.match(bookingPlanForPost({ fullPlan: { ...fullPlan, activities: [] }, option, timezone: "America/Denver" }).reason, /No scheduling activity/);
  assert.match(bookingPlanForPost({ fullPlan: { ...fullPlan, candidateEmail: null }, option, timezone: "America/Denver" }).reason, /candidate email/);
});

test("a confirmation email that's off is recorded, and said first and plainly in Slack, never silently", async () => {
  const s = setup({ compose: { ...composed, wouldSend: { from: null }, confirmationEmail: "off",
    checks: [{ name: "candidate confirmation email is OFF for this schedule in Ashby: no confirmation email will be sent to the candidate" }] } });
  await s.check.start((await s.store.list())[0]);await s.check.idle();
  const c = s.store.data.d1.ashbyCheck;
  assert.equal(c.state, "composed");assert.equal(c.confirmationEmail, "off");assert.equal(c.from, null);
  assert.match(s.replies[0], /no confirmation email will be sent to the candidate/);
  // On by default, from an older worker that doesn't say.
  const on = setup({ compose: composed });await on.check.start((await on.store.list())[0]);await on.check.idle();
  assert.equal(on.store.data.d1.ashbyCheck.confirmationEmail, "on");
  const calls = [];
  const slack = createSlack("x", async (url, o) => { calls.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ ok: true }) }; }, { displayTimeZone: "America/Los_Angeles", interactive: true });
  const at = "2099-10-14T22:00:00Z", row = check => ({ id: "d1", plan: { candidateName: "TEST", jobTitle: "TEST", bookingPlan, sessions: [], notes: "" }, slackApproval: { email: "anna@carrara.is", name: "Anna Jones", at }, ashbyCheck: check });
  await slack.markApproved({ channel: "C1", ts: "1.2", row: row({ state: "composed", composedAt: at, deleteBy: "2099-10-15T22:00:00Z", from: null, confirmationEmail: "off" }) });
  const approval = calls[0].blocks.at(-1).text.text;
  assert.match(approval, /^\*Approved\* by .*\n⚠️ \*No candidate confirmation email will be sent:\* it's turned off for this schedule in Ashby\./);
  assert.doesNotMatch(approval, /confirmation email will come from/);
  assert.match(calls[0].text, /composed in Ashby, not sent yet; no candidate confirmation email will be sent\.$/);
  calls.length = 0;
  await slack.markApproved({ channel: "C1", ts: "1.2", row: row({ state: "composed", composedAt: at, deleteBy: "2099-10-15T22:00:00Z", from: "Anna Jones <anna@luminai.com>", confirmationEmail: "on" }) });
  assert.doesNotMatch(calls[0].blocks.at(-1).text.text + calls[0].text, /No candidate confirmation email/i);
});

// ---- the robot's Send -------------------------------------------------------

const sendingRow = (extra = {}) => row("d1", { plan: { candidateName: "TEST", jobTitle: "TEST", bookingPlan: { ...bookingPlan, send: true, sendAs: "Anna Jones Luminai" }, sessions: [] }, ...extra });
const bookedAsApproved = { status: "Scheduled", events: bookingPlan.sessions.map(s => ({ start: s.start, end: s.end, interviewers: s.interviewers.map(i => i.email) })) };
const sent = { status: "sent", draftId: "dr-1", confirmationEmail: "on", wouldSend: { from: "Anna Jones <anna@luminai.com>" }, cleanup: { deleted: false, kept: true, draftId: "dr-1" },
  send: { attempted: true, at: "2099-10-14T12:00:05.000Z", reply: { status: 200, accepted: true, errors: [] } }, invites: { state: "sent", evidence: ["Invites sent"] } };

test("a send is recorded as sent only when Ashby's API shows it Scheduled and its page shows the invitations sent", async () => {
  const s = setup({ rows: [sendingRow()], compose: sent, booked: bookedAsApproved });
  await s.check.start((await s.store.list())[0]);await s.check.idle();
  const c = s.store.data.d1.ashbyCheck;
  assert.equal(c.state, "sent");assert.equal(c.sentBy, "robot");assert.deepEqual(c.differences, []);assert.equal(c.attemptedAt, "2099-10-14T12:00:05.000Z");
  assert.deepEqual(s.shown, ["running", "sent"]);
  assert.deepEqual(c.invites, { state: "sent", evidence: ["Invites sent"] });
  assert.match(s.replies.at(-1), /^Sent by clicking Schedule once.*Scheduled and its invitations sent, matching this approval\.$/);
  assert.deepEqual(s.calls.map(c => c.action), ["compose"], "nothing deleted, nothing retried");
  // What Ashby booked, if it differs, is said.
  const d = setup({ rows: [sendingRow()], compose: sent, booked: { ...bookedAsApproved, events: bookedAsApproved.events.slice(1) } });
  await d.check.start((await d.store.list())[0]);await d.check.idle();
  assert.equal(d.store.data.d1.ashbyCheck.state, "sent");assert.match(d.store.data.d1.ashbyCheck.differences[0], /1 interview was booked, but 2 were approved/);
});

test("a send Ashby doesn't show as Scheduled is uncertain: read three times, never retried, never deleted; the sweep records it once it shows", async () => {
  let booked = { status: "CandidateAvailabilitySubmitted", events: [] };
  const s = setup({ rows: [sendingRow()], compose: { ...sent, status: "send_uncertain", send: { attempted: true, at: "2099-10-14T12:00:05.000Z", reply: null, blockedByGuard: false } }, booked: () => booked,
    inviteStatus: { status: "read", invites: { state: "sent", evidence: ["Invites sent"] } } });
  await s.check.start((await s.store.list())[0]);await s.check.idle();
  let c = s.store.data.d1.ashbyCheck;
  assert.equal(c.state, "send_uncertain");assert.match(c.reason, /no answer from Ashby/);
  assert.deepEqual(s.pauses, [10000, 10000], "three reads, ten seconds apart");
  assert.match(s.replies.at(-1), /may have gone.*nothing will be retried/);
  // The sweep never deletes it, however late; it records it once Ashby shows it.
  s.tick(30 * 24 * 3600 * 1000);await s.check.sweep();
  assert.equal(s.store.data.d1.ashbyCheck.state, "send_uncertain");
  booked = bookedAsApproved;await s.check.sweep();
  c = s.store.data.d1.ashbyCheck;
  assert.equal(c.state, "sent");assert.equal(c.sentBy, "robot");assert.deepEqual(c.differences, []);assert.equal(c.invites.state, "sent");
  assert.deepEqual(s.calls.map(c => c.action), ["compose", "invite-status"], "no delete and no second compose; the invites read from Ashby");
});

test("a worker failure on a post that could send is a possible send, never 'nothing was sent'", async () => {
  const s = setup({ rows: [sendingRow()], compose: () => { throw Object.assign(new Error("The scheduling worker didn't answer within 5 minutes"), { status: 503 }); } });
  await s.check.start((await s.store.list())[0]);await s.check.idle();
  assert.equal(s.store.data.d1.ashbyCheck.state, "send_uncertain");
  // A post that couldn't send keeps the old meaning.
  const o = setup({ compose: () => { throw Object.assign(new Error("no answer"), { status: 503 }); } });
  await o.check.start((await o.store.list())[0]);await o.check.idle();
  assert.equal(o.store.data.d1.ashbyCheck.state, "uncertain");
});

test("a composed check that was announced but didn't send says why", async () => {
  const s = setup({ rows: [sendingRow()], compose: { ...composed, sendSkipped: "Send is switched off on the scheduling worker (BOOKING_SEND)." } });
  await s.check.start((await s.store.list())[0]);await s.check.idle();
  assert.equal(s.store.data.d1.ashbyCheck.state, "composed");assert.match(s.store.data.d1.ashbyCheck.sendSkipped, /BOOKING_SEND/);
});

test("Slack, where Send is on: the button says approving sends, from Anna; each send state says plainly what happened", async () => {
  const calls = [];
  const slack = createSlack("x", async (url, o) => { calls.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ ok: true, ts: "1.2", channel: "C1" }) }; }, { displayTimeZone: "America/Los_Angeles", interactive: true, clientName: "Luminai" });
  const plan = { format: "calendar_checked", candidateId: "c", candidateName: "TEST", jobTitle: "TEST", timezone: "America/Los_Angeles", notes: "n", bookingPlan: { ...bookingPlan, send: true, sendAs: "Anna Jones Luminai" },
    sessions: [{ title: "First Round", start: "2099-10-15T19:00:00Z", end: "2099-10-15T19:30:00Z", location: "Room", people: [{ name: "Hayley Samuels" }] }] };
  await slack(plan, { channelId: "C1", proposalId: "d1", approver: "a", digest: "g" });
  const button = calls[0].blocks.at(-1).elements[0];
  assert.match(button.confirm.text.text, /^Approving \*sends this schedule now\*: Ashby's invitations to the candidate and interviewers, and the candidate's confirmation email if it's on, all from Anna Jones's account\. Nothing is retried\./);
  assert.ok(button.confirm.text.text.length <= 300);
  assert.match(calls[0].blocks[0].text.text, /or press Schedule, which \*sends it from Anna Jones's account\*\./);
  // Without Send, the old wording.
  calls.length = 0;
  await slack({ ...plan, bookingPlan }, { channelId: "C1", proposalId: "d1", approver: "a", digest: "g" });
  assert.match(calls[0].blocks.at(-1).elements[0].confirm.text.text, /Nothing is sent automatically/);
  const at = "2099-10-14T22:00:00Z", approved = check => ({ id: "d1", plan, slackApproval: { email: "h@carrara.is", name: "Hayley", at }, ashbyCheck: check });
  const text = async check => { calls.length = 0; await slack.markApproved({ channel: "C1", ts: "1.2", row: approved(check) }); return { body: calls[0].blocks.at(-1).text.text, note: calls[0].text }; };
  assert.match((await text({ state: "running", startedAt: at })).body, /Checking and sending in Ashby\* \(started .*\) from Anna Jones's account: once every check passes, Schedule is clicked once/);
  assert.match((await text({ state: "queued" })).body, /Waiting to be checked and sent in Ashby,\* .* from Anna Jones's account\. Nothing is sent yet\./);
  const ok = await text({ state: "sent", sentBy: "robot", attemptedAt: at, sentSeenAt: at, differences: [], confirmationEmail: "on", invites: { state: "sent", evidence: [] } });
  assert.match(ok.body, /\*Sent from Anna Jones's account\* at Oct 14, 3:00 PM PDT: Ashby shows it Scheduled, matching this approval, and its invitations sent\. The candidate's confirmation email was on for this schedule\./);
  assert.doesNotMatch(ok.body, /went out/, "the confirmation email is never claimed delivered");
  const pending = await text({ state: "booked_invites_pending", sentBy: "robot", attemptedAt: at, differences: [], invites: { state: "pending", evidence: ["Pending invites"] } });
  assert.match(pending.body, /⚠️ \*Booked, but the invitations were not sent\.\* .* with its invites \*pending\*\. Send them by hand from the schedule's page in Ashby \("Send to Candidate" and "Send to Interviewers"\)/);
  assert.match(pending.note, /booked, but invitations NOT sent; send them by hand\.$/);
  assert.match((await text({ state: "booked_invites_unknown", sentBy: "robot", differences: [] })).body, /⚠️ \*Booked; whether the invitations went out is unknown\.\*/);
  assert.match(ok.note, /sent in Ashby\.$/);
  const unsure = await text({ state: "send_uncertain", sentBy: "robot", attemptedAt: at, reason: "no answer from Ashby" });
  assert.match(unsure.body, /⚠️ \*The send may have gone:\* Schedule was clicked once at Oct 14, 3:00 PM PDT \(no answer from Ashby\).*if it isn't Scheduled, book it by hand\. Nothing will be retried\./);
  assert.match(unsure.note, /the send may have gone; check Ashby\.$/);
  assert.match((await text({ state: "composed", composedAt: at, deleteBy: at, sendSkipped: "Send is switched off on the scheduling worker (BOOKING_SEND)." })).body, /^\*Approved\*.*\n\*Not sent automatically:\* Send is switched off .* A person needs to send it\./s);
});

test("a booking Ashby shows with its invites pending is never called sent; unknown is said as unknown", async () => {
  for (const [invites, state, said] of [[{ state: "pending", evidence: ["Pending invites", "button: Send to Candidate"] }, "booked_invites_pending", /NOT sent: Ashby shows them pending/],
    [{ state: "unknown", evidence: [] }, "booked_invites_unknown", /whether the invitations went out is unknown/], [undefined, "booked_invites_unknown", /unknown/]]) {
    const s = setup({ rows: [sendingRow()], compose: { ...sent, invites }, booked: bookedAsApproved });
    await s.check.start((await s.store.list())[0]);await s.check.idle();
    assert.equal(s.store.data.d1.ashbyCheck.state, state);
    assert.match(s.replies.at(-1), said);
    assert.doesNotMatch(s.replies.join(" "), /its invitations sent|invitations and the confirmation email went out|^Sent by clicking/, "never a claim that they were sent");
  }
});

test("a robot send recorded as sent without invite evidence is re-read and corrected in Slack, once", async () => {
  // As 32cf646b was recorded on October 20, before invites needed evidence.
  const old = sendingRow({ ashbyCheck: { state: "sent", sentBy: "robot", attemptedAt: "2099-10-14T12:00:05.000Z", sentSeenAt: "2099-10-14T12:00:20.000Z", differences: [], confirmationEmail: "on", at: "2099-10-14T12:00:20.000Z" } });
  const s = setup({ rows: [old], inviteStatus: { status: "read", invites: { state: "pending", evidence: ["Pending invites"] } } });
  await s.check.sweep();
  const c = s.store.data.d1.ashbyCheck;
  assert.equal(c.state, "booked_invites_pending");assert.deepEqual(c.invites.evidence, ["Pending invites"]);
  assert.deepEqual(s.shown, ["booked_invites_pending"]);
  assert.match(s.replies[0], /^Correction: this message said the invitations and the confirmation email went out\. Booked in Ashby, but the invitations were NOT sent/);
  await s.check.sweep();
  assert.equal(s.calls.filter(c => c.action === "invite-status").length, 1, "read once");
  // If the worker can't say, it's left for the next sweep.
  const w = setup({ rows: [old], inviteStatus: () => { throw new Error("busy"); } });
  await w.check.sweep();
  assert.equal(w.store.data.d1.ashbyCheck.state, "sent");assert.deepEqual(w.replies, []);
});

test("once approved, the posting note no longer says nothing was booked; the status line says what happened", async () => {
  const calls = [];
  const slack = createSlack("x", async (url, o) => { calls.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ ok: true, ts: "1.2", channel: "C1" }) }; }, { displayTimeZone: "America/Los_Angeles", interactive: true, clientName: "Luminai" });
  const notes = "Full schedule option 4 from booking review, built from candidate-submitted availability. Checked against interviewers' primary Google calendars at 1:53 PM PDT. Nothing has been booked and no invitations have been sent.";
  const plan = { format: "calendar_checked", candidateId: "c", candidateName: "TEST", jobTitle: "TEST", timezone: "America/Los_Angeles", notes, bookingPlan: { ...bookingPlan, send: true, sendAs: "Anna Jones Luminai" },
    sessions: [{ title: "First Round", start: "2099-10-15T19:00:00Z", end: "2099-10-15T19:30:00Z", location: "Room", people: [{ name: "Hayley Samuels" }] }] };
  const small = () => calls.at(-1).blocks.find(b => b.type === "context").elements[0].text;
  await slack(plan, { channelId: "C1", proposalId: "d1", approver: "a", digest: "g" });
  assert.match(small(), /Nothing has been booked and no invitations have been sent\. Posted for discussion/, "before approval it's still true and said");
  const at = "2099-10-14T22:00:00Z";
  await slack.markApproved({ channel: "C1", ts: "1.2", row: { id: "d1", plan, slackApproval: { email: "h@carrara.is", name: "Hayley", at },
    ashbyCheck: { state: "booked_invites_pending", sentBy: "robot", attemptedAt: at, differences: [], invites: { state: "pending", evidence: [] } } } });
  assert.doesNotMatch(small(), /Nothing has been booked/);
  assert.match(small(), /at 1:53 PM PDT\. Posted for discussion by a coordinator\. Draft reference: d1$/);
  const status = calls.at(-1).blocks.at(-1).text.text;
  assert.match(status, /Ashby shows TEST's First Round Interview Schedule as Scheduled, matching this approval, with its invites \*pending\*/);
  assert.doesNotMatch(status, /in Ashby Scheduled/);
});
