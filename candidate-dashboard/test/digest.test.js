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
    "• Expired, never approved: none",
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
      lastError: "None of the coding interviews (\"Coding - Roomba\", \"Coding - URL Shortner\") is in the template, and one should run. Add the one this candidate is taking to the schedule's template in Ashby, then load the plan again." },
    "s-sam": { updatedAt: "2026-10-31T17:00:00.000Z", failedRounds: 3, lastError: "Ashby didn't answer properly (HTTP 502, a web page titled \"502 Bad Gateway\") after 3 tries." },
  };
  const rows = [
    post("rachel", "Rachel Lo", "2026-11-03T18:00:00Z"),
    // Closed by the expiry sweep this morning; one closed before the last digest isn't listed again.
    post("amara", "Amara Jordan", "2026-11-02T15:30:00Z", { state: "rejected", expired: { at: "2026-11-02T15:35:00Z", firstStart: "2026-11-02T15:30:00Z", presses: "Nobody pressed Schedule or Suggest on it." }, slack: { channel: "C1", ts: ts("2026-10-29T18:00:00Z") } }),
    post("earlier", "Earlier Expiry", "2026-10-28T16:30:00Z", { state: "rejected", expired: { at: "2026-10-28T16:35:00Z", firstStart: "2026-10-28T16:30:00Z", presses: "Nobody pressed Schedule or Suggest on it." }, slack: { channel: "C1", ts: ts("2026-10-20T18:00:00Z") } }),
    // Expired: its first session passed, never approved. Its job title ends in a tab, as some of Ashby's do.
    post("samuel", "Samuel Zhao", "2026-10-05T16:15:00Z", { slack: { channel: "C1", ts: ts("2026-09-29T18:00:00Z") }, plan: { candidateName: "Samuel Zhao", jobTitle: "Applied AI Engineer\t", sessions: [{ start: "2026-10-05T16:15:00Z" }] } }),
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
    "Scheduling digest, Mon, Nov 2: 7 waiting on someone, and 2 expired posts",
    "• Needs a person: 1: Kshitiz Parashar (given up on Fri)",
    "• Waiting for approval: 2: ⚠️ Rachel Lo (Tue, Nov 3, 1 working day), Qiqi Liang (Thu, Nov 5, 3 working days)",
    "• Expired, never approved: 2: Samuel Zhao (Mon, Oct 5; still open), Amara Jordan (Mon, Nov 2; nothing pressed)",
    "• Approved, draft not sent in Ashby: 1: ⚠️ Dana Ng (Wed, Nov 4, 2 working days)",
    "• Eligible, not posted: 1: Sam Wu (1 older submission for a stage the candidate has left not counted)",
    "• Not on the compose list: 2: Emma Smith (Marketing Lead / Onsite Interview), Pat Doe (Recruiter / Recruiter Screen)",
    "• Since Friday's digest: 4 posted, 1 booked through the bot, 2 drafts composed; auto-post failures: 3 for 1 candidate (HTTP 502); 1 whole round"].join("\n"));
  // Cut back to the last whole sentence; no generic fix line, since the refusal names Ashby... once it's whole.
  assert.match(thread, /^• Kshitiz Parashar \(Forward Deployed Engineer\), given up on Fri, Oct 30: None of the coding interviews \("Coding - Roomba", "Coding - URL Shortner"\) is in the template, and one should run\. Add the one this candidate is taking to the schedule's template in Ashby, then load the plan again\. Auto-post won't try this one again until the schedule changes in Ashby; once it's fixed, post from booking review\.$/m);
  assert.match(thread, /^• Samuel Zhao · Applied AI Engineer: first session Mon, Oct 5, 9:15 AM PDT passed; posted 34 days ago; the post is still open\.$/m);
  assert.match(thread, /^• Amara Jordan · Forward Deployed Engineer: first session Mon, Nov 2, 7:30 AM PST passed; posted 4 days ago\. Nobody pressed Schedule or Suggest on it\.$/m);
  assert.doesNotMatch(text, /Earlier Expiry/);
  assert.doesNotMatch(thread, /reject/i, "nothing in Slack can clear an expired post, so the digest doesn't say to");
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
  assert.match(d.thread, /two interviewers\. Fix it in Ashby \(the schedule's template or the job's interview plan\)\. Auto-post checks again within the hour/);
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

test("a refusal that already says what to change in Ashby gets no generic fix line", async () => {
  const state = { "s-k": { updatedAt: "x", needsPerson: { at: "2026-11-02T15:00:00Z", since: "2026-11-02T15:00:00Z", why: "Welcome must come first. Move it to the top of the schedule's template in Ashby." } } };
  const d = renderDigest(await buildDigest({ ...quiet, autoPostState: state, snapshot: snapshot([ready("s-k", "Kshitiz Parashar", FDE)]) }));
  assert.match(d.thread, /: Welcome must come first\. Move it to the top of the schedule's template in Ashby\. Auto-post checks again within the hour/);
  assert.doesNotMatch(d.thread, /Fix it in Ashby/);
});

// Approved, composed, nobody sent it, the sweep deleted it: a lapse. Auto-post
// never re-posts it by itself, so the digest carries it under Needs a person
// until a fresh option is posted or the schedule leaves the Ready list.
const lapsedRow = (id, name, extra = {}) => post(id, name, "2026-11-03T18:00:00Z", { state: "discussion_approved",
  slackApproval: { name: "Anna Jones", email: "anna@example.com", at: "2026-10-30T22:30:00Z" },
  ashbyCheck: { state: "deleted", composedAt: "2026-10-30T22:35:00Z", deleteBy: "2026-10-31T22:35:00Z", deletedAt: "2026-10-31T22:36:00Z" }, ...extra });

test("a lapsed approval is under Needs a person: who, which role, when it was approved, and that nobody sent it", async () => {
  const d = await buildDigest({ ...quiet, rows: [lapsedRow("ella", "Ella Smith")], snapshot: snapshot([ready("s-ella", "Ella Smith", FDE)]) });
  const { text, thread } = renderDigest(d);
  assert.match(text, /^Scheduling digest, Mon, Nov 2: 1 waiting on someone$/m);
  assert.match(text, /^• Needs a person: 1: Ella Smith \(approved Fri, Oct 30, never sent\)$/m);
  // Not also listed as eligible and unposted.
  assert.match(text, /^• Eligible, not posted: none/m);
  assert.match(thread, /^Needs a person$/m);
  assert.match(thread, /^• Ella Smith \(Forward Deployed Engineer\): approved by Anna Jones Fri, Oct 30, 3:30 PM PDT, but nobody sent the draft in Ashby, so it was deleted Sat, Oct 31 \(the approved first session was Tue, Nov 3, 10:00 AM PST\)\. Nothing is booked and auto-post won't post this schedule again by itself: post a fresh option from booking review, or book it by hand in Ashby\.$/m);
});

test("a lapse is carried forward, day after day, while the schedule waits and nothing new is posted", async () => {
  const later = { ...quiet, now: MON + 3 * 86400000, rows: [lapsedRow("ella", "Ella Smith")], snapshot: { ...snapshot([ready("s-ella", "Ella Smith", FDE)]), sectionStatus: { readyToSchedule: { lastUpdated: new Date(MON + 3 * 86400000 - 60000).toISOString(), lastError: null } } } };
  assert.match(renderDigest(await buildDigest(later)).text, /^• Needs a person: 1: Ella Smith \(approved Fri, Oct 30, never sent\)$/m);
});

test("a lapse drops off once a fresh option is posted for the schedule, or the schedule leaves the Ready list", async () => {
  const fresh = post("ella2", "Ella Smith", "2026-11-05T18:00:00Z", { slack: { channel: "C1", ts: ts("2026-11-02T15:00:00Z") }, plan: { candidateName: "Ella Smith", jobTitle: "Forward Deployed Engineer",
    sessions: [{ start: "2026-11-05T18:00:00Z" }], bookingPlan: { interviewScheduleId: "s-ella" } } });
  let d = await buildDigest({ ...quiet, rows: [lapsedRow("ella", "Ella Smith"), fresh], snapshot: snapshot([ready("s-ella", "Ella Smith", FDE)]) });
  assert.equal(d.person.length, 0);
  assert.equal(d.open.length, 1, "the fresh post is what's waiting now");
  // Booked by hand in Ashby (or the candidate moved on): no longer on the Ready list.
  d = await buildDigest({ ...quiet, rows: [lapsedRow("ella", "Ella Smith")], snapshot: snapshot([]) });
  assert.equal(d.person.length, 0);
});

test("a lapse stays listed when the Ready list can't be read, and a hidden row still counts as waiting", async () => {
  let d = await buildDigest({ ...quiet, rows: [lapsedRow("ella", "Ella Smith")], snapshot: { sectionStatus: { readyToSchedule: { lastUpdated: null, lastError: "HTTP 502" } } } });
  assert.deepEqual(d.person.map(p => p.name), ["Ella Smith"]);
  d = await buildDigest({ ...quiet, rows: [lapsedRow("ella", "Ella Smith")], snapshot: snapshot([], [ready("s-ella", "Ella Smith", FDE)]) });
  assert.deepEqual(d.person.map(p => p.name), ["Ella Smith"]);
});

test("only the latest lapse per schedule; a draft that left Ashby unsent is a lapse too; a release, a send or a live draft isn't", async () => {
  const older = lapsedRow("ella0", "Ella Smith", { slack: { channel: "C1", ts: ts("2026-10-28T18:00:00Z") } });
  const gone = lapsedRow("ella", "Ella Smith", { ashbyCheck: { state: "gone", deleteBy: "2026-10-31T22:35:00Z", goneSeenAt: "2026-10-31T09:00:00Z" } });
  let d = await buildDigest({ ...quiet, rows: [older, gone], snapshot: snapshot([ready("s-ella", "Ella Smith", FDE)]) });
  assert.equal(d.person.length, 1);
  assert.match(renderDigest(d).thread, /so it left Ashby unsent Sat, Oct 31/);
  for (const state of ["released", "sent", "composed"]) {
    d = await buildDigest({ ...quiet, rows: [lapsedRow("ella", "Ella Smith", { ashbyCheck: { state, draftId: "d1" } })], snapshot: snapshot([ready("s-ella", "Ella Smith", FDE)]) });
    assert.equal(d.person.filter(p => p.lapsed).length, 0, state);
  }
});

test("a draft the sweep couldn't delete is under Needs a person as blocked, until it's released", async () => {
  const failed = lapsedRow("ella", "Ella Smith", { ashbyCheck: { state: "delete_failed", draftId: "d-123", deleteBy: "2026-10-31T22:35:00Z", failedAt: "2026-10-31T22:36:00Z",
    reason: "Ashby's Drafts page didn't load. The draft wasn't deleted." } });
  const sheet = snapshot([ready("s-ella", "Ella Smith", FDE)]);
  let d = await buildDigest({ ...quiet, rows: [failed], snapshot: sheet });
  const { text, thread } = renderDigest(d);
  assert.match(text, /^• Needs a person: 1: Ella Smith \(draft couldn't be deleted, blocked 2 days\)$/m);
  assert.match(text, /^• Eligible, not posted: none/m);
  assert.match(thread, /^• Ella Smith \(Forward Deployed Engineer\): approved by Anna Jones Fri, Oct 30, 3:30 PM PDT and never sent; the unsent draft couldn't be deleted Sat, Oct 31 \(Ashby's Drafts page didn't load\. The draft wasn't deleted\), so it may still be in Ashby \(https:\/\/app\.ashbyhq\.com\/schedules\/drafts\/d-123\)\. This schedule takes no new post until someone presses Release this schedule on the post in the dashboard's Scheduling tab, which deletes the draft\. Then post a fresh option, or book it by hand in Ashby\.$/m);
  // Released: off the list (and a release isn't a lapse either).
  d = await buildDigest({ ...quiet, rows: [lapsedRow("ella", "Ella Smith", { ashbyCheck: { state: "released", previous: { state: "delete_failed" } } })], snapshot: sheet });
  assert.equal(d.person.length, 0);
  // Gone from the Ready list: off it too; listed when the list can't be read.
  assert.equal((await buildDigest({ ...quiet, rows: [failed], snapshot: snapshot([]) })).person.length, 0);
  assert.equal((await buildDigest({ ...quiet, rows: [failed], snapshot: { sectionStatus: { readyToSchedule: { lastUpdated: null, lastError: "HTTP 502" } } } })).person.length, 1);
});

test("an approval the Ashby check refused is under Needs a person, with the reason, on the same rules as a lapse", async () => {
  const refused = (extra = {}) => lapsedRow("ella", "Ella Smith", { ashbyCheck: { state: "refused", step: "agenda", at: "2026-10-30T22:36:00Z",
    reason: "The agenda in Ashby doesn't match the approved times. Nothing was sent.", draftId: null, cleanup: null, ...extra } });
  const sheet = snapshot([ready("s-ella", "Ella Smith", FDE)]);
  let d = await buildDigest({ ...quiet, rows: [refused()], snapshot: sheet });
  let { text, thread } = renderDigest(d);
  assert.match(text, /^• Needs a person: 1: Ella Smith \(approved Fri, Oct 30, refused in Ashby\)$/m);
  assert.match(text, /^• Eligible, not posted: none/m);
  assert.match(thread, /^• Ella Smith \(Forward Deployed Engineer\): approved by Anna Jones Fri, Oct 30, 3:30 PM PDT, but the Ashby check refused it Fri, Oct 30: The agenda in Ashby doesn't match the approved times\. Nothing was sent\. Nothing was booked \(the approved first session was Tue, Nov 3, 10:00 AM PST\), and auto-post won't post this schedule again by itself\. Post a fresh option from booking review once the cause is fixed, or book it by hand in Ashby\.$/m);
  // Its draft not confirmed deleted: the schedule is blocked, so release comes first.
  d = await buildDigest({ ...quiet, rows: [refused({ draftId: "d-9", cleanup: { deleted: false } })], snapshot: sheet });
  assert.match(renderDigest(d).thread, /The draft it started wasn't confirmed deleted \(https:\/\/app\.ashbyhq\.com\/schedules\/drafts\/d-9\), so the schedule takes no new post until someone presses Release this schedule on the post in the dashboard's Scheduling tab\. Then post a fresh option/);
  // Same drop-off: a fresh post, or off the Ready list (booked by hand).
  const fresh = post("ella2", "Ella Smith", "2026-11-05T18:00:00Z", { slack: { channel: "C1", ts: ts("2026-11-02T15:00:00Z") }, plan: { candidateName: "Ella Smith", jobTitle: "Forward Deployed Engineer",
    sessions: [{ start: "2026-11-05T18:00:00Z" }], bookingPlan: { interviewScheduleId: "s-ella" } } });
  assert.equal((await buildDigest({ ...quiet, rows: [refused(), fresh], snapshot: sheet })).person.length, 0);
  assert.equal((await buildDigest({ ...quiet, rows: [refused()], snapshot: snapshot([]) })).person.length, 0);
});
