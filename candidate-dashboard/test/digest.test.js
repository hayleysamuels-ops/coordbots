"use strict";
// The weekday digest (src/scheduling/digest.js): what each section counts, the
// wording, "all clear" said only when every check was made and nothing waits,
// and the 8am weekday schedule (once a day, again after a failed post, never
// posted in log mode). The store, Slack, the worker and Ashby are stand-ins.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildDigest, renderDigest, createDigest, workingDaysUntil, chunks } = require("../src/scheduling/digest");

const Z = "America/Los_Angeles";
// Monday November 2, 2026, 8:01am PST.
const MON = Date.parse("2026-11-02T16:01:00Z");
const FDE = "aaaaaaaa-0000-4000-8000-000000000001", MKT = "aaaaaaaa-0000-4000-8000-000000000002", OTHER = "aaaaaaaa-0000-4000-8000-000000000003";
const jobs = { [FDE]: "all", [MKT]: ["hiring manager screen"] };
const ts = iso => String(Date.parse(iso) / 1000);
const post = (id, name, start, extra = {}) => ({ id, clientId: "luminai", state: "shared", plan: { candidateName: name, jobTitle: "Forward Deployed Engineer", sessions: [{ start, end: start }],
  bookingPlan: { interviewScheduleId: `s-${id}` } }, slack: { channel: "C1", ts: ts("2026-10-30T22:21:44Z") }, audit: [], ...extra });
const ready = (scheduleId, name, jobId, extra = {}) => ({ applicationId: `a-${scheduleId}`, scheduleId, candidateName: name, jobId, jobTitle: { [FDE]: "Forward Deployed Engineer", [MKT]: "Marketing Lead", [OTHER]: "Recruiter" }[jobId],
  currentStageId: `stage-${scheduleId}`, stageMatches: true, submittedAt: "2026-10-31T17:00:00.000Z", ...extra });
const snapshot = (visible, hidden = []) => ({ readyToSchedule: visible, readyToScheduleHidden: hidden, sectionStatus: { readyToSchedule: { lastUpdated: new Date(MON - 60000).toISOString(), lastError: null } } });
const quiet = { now: MON, since: MON - 3 * 86400000, sinceDigest: true, clientId: "luminai", rows: [], snapshot: snapshot([]), autoPost: { on: true, wide: true },
  settings: async () => ({ composeJobs: { jobs } }), stageTitle: async () => "Onsite" };

test("working days to the first session: Monday to Tuesday is 1, Thursday to Monday 2, the same day 0", () => {
  assert.equal(workingDaysUntil(MON, Date.parse("2026-11-03T18:00:00Z"), Z), 1);
  assert.equal(workingDaysUntil(Date.parse("2026-11-05T17:00:00Z"), Date.parse("2026-11-09T18:00:00Z"), Z), 2);
  assert.equal(workingDaysUntil(MON, Date.parse("2026-11-02T22:00:00Z"), Z), 0);
  // 7pm Pacific Monday is already Tuesday in UTC: still the same day here.
  assert.equal(workingDaysUntil(MON, Date.parse("2026-11-03T03:00:00Z"), Z), 0);
});

test("nothing waiting and every check made: all clear, every section named, and no thread", async () => {
  const { text, thread } = renderDigest(await buildDigest(quiet));
  assert.equal(text, [
    "Scheduling digest, Mon, Nov 2: all clear",
    "• Needs a person: none",
    "• Waiting for approval: none",
    "• Approved, draft not sent in Ashby: none",
    "• Eligible, not posted: none",
    "• Not on the compose list: none",
    "• Since Friday's digest: 0 posted, 0 booked through the bot, 0 drafts composed; auto-post failures: none"].join("\n"));
  assert.equal(thread, null);
});

test("a check that couldn't be made is said, and the header never reads all clear", async () => {
  let d = renderDigest(await buildDigest({ ...quiet, settings: async () => { throw new Error("The scheduling worker is busy."); } }));
  assert.match(d.text, /^Scheduling digest, Mon, Nov 2: some checks couldn't be made, see below$/m);
  assert.match(d.text, /^• Eligible, not posted: couldn't check$/m);
  assert.match(d.text, /^• Not on the compose list: couldn't check$/m);
  assert.match(d.text, /^Couldn't check: the worker's compose list \(The scheduling worker is busy\)\.$/m);
  d = renderDigest(await buildDigest({ ...quiet, snapshot: { sectionStatus: { readyToSchedule: { lastUpdated: null, lastError: "Ashby answered 502" } } } }));
  assert.match(d.text, /some checks couldn't be made/);
  assert.match(d.text, /Couldn't check: the Ready to schedule list \(the dashboard hasn't read Ashby's schedules since it started: Ashby answered 502\)\./);
  // An old list is used, and said to be old.
  d = renderDigest(await buildDigest({ ...quiet, snapshot: { ...snapshot([]), sectionStatus: { readyToSchedule: { lastUpdated: "2026-11-02T13:00:00Z", lastError: "HTTP 502" } } } }));
  assert.match(d.text, /^The Ready to schedule list is from Mon, Nov 2, 5:00 AM PST \(the latest refresh failed: HTTP 502\)\.$/m);
});

test("Monday's digest: this weekend's cases, each in its section", async () => {
  const state = {
    // Kshitiz: given up on before needs-a-person existed; his refusal is one.
    "s-k": { updatedAt: "2026-10-31T17:00:00.000Z", failedRounds: 3, candidateName: "Kshitiz Parashar", at: "2026-10-30T16:01:00.000Z",
      lastError: "Both coding interviews are in the template (\"Coding - Roomba\" and \"Coding - URL Shortner\"), and only one should run." },
    "s-sam": { updatedAt: "2026-10-31T17:00:00.000Z", failedRounds: 3, lastError: "Ashby didn't answer properly (HTTP 502, a web page titled \"502 Bad Gateway\") after 3 tries." },
  };
  const rows = [
    post("rachel", "Rachel Lo", "2026-11-03T18:00:00Z"),
    post("qiqi", "Qiqi Liang", "2026-11-05T18:00:00Z"),
    post("dana", "Dana Ng", "2026-11-04T18:00:00Z", { state: "discussion_approved", ashbyCheck: { state: "composed", at: "2026-11-02T00:00:00Z", draftUrl: "https://app.ashbyhq.com/schedules/x/drafts" },
      audit: [{ action: "ashby_check_composed", at: "2026-11-02T00:00:00Z" }] }),
    post("lee", "Lee Park", "2026-11-09T18:00:00Z", { state: "discussion_approved", ashbyCheck: { state: "sent" }, slack: { channel: "C1", ts: ts("2026-10-31T18:00:00Z") },
      audit: [{ action: "ashby_check_composed", at: "2026-10-31T19:00:00Z" }, { action: "ashby_check_sent", at: "2026-10-31T19:05:00Z" }] }),
    post("old", "Old Post", "2026-11-09T18:00:00Z", { state: "rejected", slack: { channel: "C1", ts: ts("2026-10-20T18:00:00Z") } }),
    { ...post("other", "Other Client", "2026-11-03T18:00:00Z"), clientId: "someone-else" },
  ];
  const titles = { "a-k": "Onsite", "a-emma": "Onsite Interview", "a-pat": "Recruiter Screen", "a-sam": "Onsite", "a-s-rachel": "Onsite" };
  const events = [
    { at: "2026-10-31T10:00:00Z", kind: "retry", scheduleId: "s-sam", name: "Sam Wu", status: 502, why: "couldn't read the candidate's availability: Ashby didn't answer properly" },
    { at: "2026-10-31T10:05:00Z", kind: "retry", scheduleId: "s-sam", name: "Sam Wu", status: null, why: "couldn't build an option: The scheduling worker is busy" },
    { at: "2026-10-31T10:10:00Z", kind: "gave_up", scheduleId: "s-sam", name: "Sam Wu", status: 502, why: "couldn't read the candidate's availability: Ashby didn't answer properly" },
    { at: "2026-11-01T04:00:00Z", kind: "round", scheduleId: null, name: null, status: null, why: "the worker didn't say which jobs it may compose for" },
    { at: "2026-11-01T04:00:00Z", kind: "needs_person", scheduleId: "s-k", name: "Kshitiz Parashar", status: null, why: "x" },
  ];
  const d = await buildDigest({ ...quiet, rows, autoPostState: state, events,
    snapshot: snapshot([ready("s-k", "Kshitiz Parashar", FDE, { applicationId: "a-k" }), ready("s-emma", "Emma Smith", MKT, { applicationId: "a-emma" }),
      ready("s-pat", "Pat Doe", OTHER, { applicationId: "a-pat" }), ready("s-sam", "Sam Wu", FDE, { applicationId: "a-sam" }),
      ready("s-rachel", "Rachel Lo", FDE), ready("s-gone", "Moved On", FDE, { stageMatches: false })]),
    stageTitle: async id => titles[id] });
  const { text, thread } = renderDigest(d);
  assert.equal(text, [
    "Scheduling digest, Mon, Nov 2: 7 waiting on someone",
    "• Needs a person: 1: Kshitiz Parashar (3 days)",
    "• Waiting for approval: 2: ⚠️ Rachel Lo (Tue, Nov 3, 1 working day), Qiqi Liang (Thu, Nov 5, 3 working days)",
    "• Approved, draft not sent in Ashby: 1: ⚠️ Dana Ng (Wed, Nov 4, 2 working days)",
    "• Eligible, not posted: 1: Sam Wu (1 older submission for a stage the candidate has left not counted)",
    "• Not on the compose list: 2: Emma Smith (Marketing Lead / Onsite Interview), Pat Doe (Recruiter / Recruiter Screen)",
    "• Since Friday's digest: 4 posted, 1 booked through the bot, 2 drafts composed; auto-post failures: 3 for 1 candidate (HTTP 502); 1 whole round"].join("\n"));
  assert.match(thread, /^• Kshitiz Parashar \(Forward Deployed Engineer\), waiting 3 days: Both coding interviews are in the template .*only one should run\. Fix it in Ashby .* Auto-post won't try this one again until the schedule changes in Ashby/m);
  assert.match(thread, /^• ⚠️ Rachel Lo · Forward Deployed Engineer: first session Tue, Nov 3, 10:00 AM PST \(1 working day\); posted 3 days ago\.$/m);
  assert.match(thread, /^• ⚠️ Dana Ng · .*composed 16 hours ago\. Send it from Drafts in the left sidebar under SCHEDULES: https:\/\/app\.ashbyhq\.com\/schedules\/x\/drafts\.$/m);
  assert.match(thread, /^• Sam Wu · Forward Deployed Engineer \/ Onsite: auto-post gave up \(Ashby didn't answer properly \(HTTP 502, a web page titled "502 Bad Gateway"\) after 3 tries\)\.$/m);
  assert.match(thread, /^• Emma Smith · Marketing Lead \/ Onsite Interview: the job is, but this stage isn't; submitted 2 days ago\.$/m);
  assert.match(thread, /^• Pat Doe · Recruiter \/ Recruiter Screen: the job isn't on the compose list; submitted 2 days ago\.$/m);
  assert.match(thread, /^• Sam Wu: 3 failed tries \(HTTP 502\), gave up\. Last: couldn't read/m);
  assert.match(thread, /^• Whole rounds that failed: 1 \(the worker didn't say which jobs it may compose for\)\.$/m);
});

test("a needs-a-person wait counts from `since`, and leaves the digest once the submission leaves the Ready list", async () => {
  const state = { "s-k": { updatedAt: "x", failedRounds: 0, needsPerson: { at: "2026-11-02T15:00:00Z", since: "2026-10-31T16:00:00Z", why: "Onsite Interview is a panel: two interviewers." } } };
  let d = renderDigest(await buildDigest({ ...quiet, autoPostState: state, snapshot: snapshot([], [ready("s-k", "Kshitiz Parashar", FDE)]) }));
  assert.match(d.text, /^• Needs a person: 1: Kshitiz Parashar \(2 days\)$/m);
  assert.match(d.thread, /auto-post checks again within the hour/);
  d = renderDigest(await buildDigest({ ...quiet, autoPostState: state }));
  assert.match(d.text, /^• Needs a person: none$/m);
});

test("what an eligible, unposted submission is waiting on", async () => {
  const one = async (extra, state = {}, rows = []) => (await buildDigest({ ...quiet, ...extra, rows, autoPostState: state, snapshot: snapshot([ready("s-1", "Ana", FDE, extra.row)]) })).unposted[0]?.why;
  assert.equal(await one({ autoPost: { on: true, wide: false } }), "auto-post isn't on for compose-list jobs, so this waits on a post from booking review");
  assert.equal(await one({}, { "s-1": { updatedAt: "2026-10-31T17:00:00.000Z", done: true, outcome: "no_clean_option" } }), "auto-post found no option it could post and said why in the channel");
  assert.equal(await one({}, { "s-1": { updatedAt: "2026-10-31T17:00:00.000Z", failedRounds: 1, lastError: "The scheduling worker is busy." } }), "auto-post is retrying (The scheduling worker is busy)");
  assert.equal(await one({}, { _reads: { "s-1": { rounds: 6, gaveUp: true, submittedAt: "2026-10-31T17:00:00.000Z", why: "couldn't list their submissions: Ashby answered with a web page instead of data" } } }),
    "auto-post gave up (couldn't list their submissions: Ashby answered with a web page instead of data)");
  assert.equal(await one({}, {}, [post("1", "Ana", "2026-11-09T18:00:00Z", { state: "rejected" })]), "its last post was rejected");
  assert.equal(await one({}), "submitted 2 days ago and auto-post hasn't picked it up");
  assert.equal(await one({ row: { submittedAt: new Date(MON - 5 * 60000).toISOString() } }), "submitted 5 minutes ago; auto-post hasn't reached it yet");
  // A post in play (open, or approved and booked) means it was posted.
  assert.equal(await one({}, {}, [post("1", "Ana", "2026-11-09T18:00:00Z")]), undefined);
  assert.equal(await one({}, {}, [post("1", "Ana", "2026-11-09T18:00:00Z", { state: "discussion_approved", ashbyCheck: { state: "sent" } })]), undefined);
});

test("a long thread is split by line, under Slack's limit", () => {
  const parts = chunks(Array.from({ length: 100 }, (_, i) => `• line ${i} ${"x".repeat(60)}`).join("\n"), 1000);
  assert.ok(parts.length > 1 && parts.every(p => p.length <= 1000));
  assert.equal(parts.join("\n").split("\n").length, 100);
});

function scheduler(t, { mode = "on", failNotice = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-digest-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { t: MON }, notices = [], replies = [], logs = [];
  let fails = failNotice;
  const slackApi = { notice: async x => { if (fails-- > 0) throw new Error("Slack refused the post: ratelimited"); notices.push(x); return { ts: "9.1", channel: "C1" }; },
    threadReply: async x => replies.push(x) };
  let snap = snapshot([ready("s-emma", "Emma Smith", MKT)]);
  const digest = createDigest({ mode, dataDir: dir, clientId: "luminai", channelId: "C1", slackApi, store: { list: async () => [] }, snapshot: () => snap,
    settings: async () => ({ composeJobs: { jobs } }), stageTitle: async () => "Onsite Interview", autoPost: { on: true, wide: true }, now: () => clock.t, log: { warn: m => logs.push(m) } });
  return { digest, clock, notices, replies, logs, dir, setSnapshot: s => { snap = s; } };
}

test("posted once each weekday from 8am Pacific, with its detail in the thread, and never on a weekend", async t => {
  const s = scheduler(t);
  s.clock.t = Date.parse("2026-11-01T17:00:00Z"); // Sunday 9am
  await s.digest.tick();
  s.clock.t = Date.parse("2026-11-02T15:59:00Z"); // Monday 7:59am
  await s.digest.tick();
  assert.equal(s.notices.length, 0);
  s.clock.t = MON;
  await s.digest.tick(); await s.digest.tick();
  assert.equal(s.notices.length, 1);
  assert.match(s.notices[0].text, /^Scheduling digest, Mon, Nov 2: 1 waiting on someone\n/);
  assert.match(s.notices[0].text, /• Since Fri, Oct 30, 8:00 AM PDT: 0 posted/, "the first digest reaches back to Friday");
  assert.equal(s.replies.length, 1);
  assert.equal(s.replies[0].threadTs, "9.1");
  assert.match(s.replies[0].text, /^Not on the compose list/);
  // Tuesday: from Monday's digest.
  s.clock.t = Date.parse("2026-11-03T16:30:00Z");
  await s.digest.tick();
  assert.equal(s.notices.length, 2);
  assert.match(s.notices[1].text, /• Since Monday's digest: /);
});

test("a failed post is tried again the next minute, and not after noon", async t => {
  let s = scheduler(t, { failNotice: 1 });
  await s.digest.tick();
  assert.equal(s.notices.length, 0);
  assert.match(s.logs.at(-1), /Couldn't post today's digest \(tries again in a minute\): Slack refused the post: ratelimited/);
  s.clock.t += 60000;
  await s.digest.tick();
  assert.equal(s.notices.length, 1);
  s = scheduler(t);
  s.clock.t = Date.parse("2026-11-02T20:00:00Z"); // noon
  await s.digest.tick(); await s.digest.tick();
  assert.equal(s.notices.length, 0);
  assert.equal(s.logs.filter(l => /wasn't posted by 12:00/.test(l)).length, 1);
});

test("log mode: built and logged after startup and at 8am, never posted, and a later switch to on still posts that day", async t => {
  const s = scheduler(t, { mode: "log" });
  s.setSnapshot({ sectionStatus: { readyToSchedule: { lastUpdated: null } } });
  s.clock.t = Date.parse("2026-11-01T17:00:00Z"); // Sunday: the dashboard hasn't read Ashby yet
  await s.digest.tick();
  assert.equal(s.logs.length, 0);
  s.setSnapshot(snapshot([]));
  await s.digest.tick();
  assert.equal(s.logs.length, 1);
  assert.match(s.logs[0], /^\[digest\] Built after startup; not posted \(SCHEDULING_DIGEST is "log"\):\nScheduling digest, Sun, Nov 1: all clear/);
  s.clock.t = MON;
  await s.digest.tick(); await s.digest.tick();
  assert.equal(s.logs.length, 2);
  assert.match(s.logs[1], /^\[digest\] Today's digest; not posted/);
  assert.equal(s.notices.length, 0);
  const on = createDigest({ mode: "on", dataDir: s.dir, clientId: "luminai", channelId: "C1", slackApi: { notice: async x => { s.notices.push(x); return { ts: "1" }; }, threadReply: async () => {} },
    store: { list: async () => [] }, snapshot: () => snapshot([]), settings: async () => ({ composeJobs: { jobs } }), stageTitle: async () => "x", autoPost: { on: true, wide: true }, now: () => MON, log: { warn() {} } });
  await on.tick();
  assert.equal(s.notices.length, 1);
});

test("the startup line says which mode", () => {
  const lines = [];
  for (const mode of ["off", "log", "on"]) createDigest({ mode, dataDir: "/nonexistent", log: { warn: m => lines.push(m) } }).start()();
  assert.deepEqual(lines, ['[digest] off (SCHEDULING_DIGEST isn\'t "on" or "log")',
    "[digest] log only: built at 8:00 Pacific every weekday and once after startup, never posted", "[digest] on: posts at 8:00 Pacific every weekday"]);
});
