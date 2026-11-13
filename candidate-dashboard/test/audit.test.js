"use strict";
// The scheduling audit (src/scheduling/audit.js) and its weekly run
// (audit-watch.js): drift in the worker's job lists and the rules file,
// onboarding blockers, the notes, renames against the last snapshot, and when
// the weekly run posts. Ashby, Slack and the worker are stand-ins; the rules
// are parsed by rules.js and the lists by the worker's own jobList. Fictional
// jobs and people throughout.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { audit, renderDrift, renderReport, snapshotOf, nearDuplicate } = require("../src/scheduling/audit");
const { createAuditWatch, weekOf } = require("../src/scheduling/audit-watch");
const { parseRules } = require("../src/scheduling/rules");
const { jobList } = require("../worker/job-lists");

const ENG = "aaaaaaaa-0000-4000-8000-000000000001", OPS = "aaaaaaaa-0000-4000-8000-000000000002", SHUT = "aaaaaaaa-0000-4000-8000-000000000003";
const iv = (interviewId, title, extra = {}) => ({ id: `p-${interviewId}`, interviewId, title, interviewDurationMinutes: 45, isSchedulable: true, ...extra });
const person = (n, extra = {}) => ({ id: `u-${n}`, firstName: n, lastName: "Example", email: `${n.toLowerCase()}@example-client.com`, isEnabled: true, ...extra });
function fixture() {
  const plans = {
    [ENG]: { stages: [
      { id: "s-new", title: "New Lead", activities: [] },
      { id: "s-screen", title: "Initial Screen", activities: [{ id: "a-screen", title: "Initial Screen", interviews: [iv("i-screen", "Initial Screen ")] }] },
      { id: "s-onsite", title: "Onsite Interview", activities: [{ id: "a-onsite", title: "Onsite", interviews: [iv("i-welcome", "Welcome"), iv("i-roomba", "Coding - Roomba"), iv("i-url", "Coding - URL Shortner"), iv("i-panel", "Panel")] },
        { id: "a-onsite2", title: "Onsite", interviews: [iv("i-debrief", "Debrief")] }] },
    ] },
    [OPS]: { stages: [{ id: "s-ops", title: "Agency Recruiter Screen", activities: [{ id: "a-ops", title: "Screen", interviews: [iv("i-ops", "URL Shortener")] }] }] },
  };
  const ev = (interviewId, people) => ({ interviewId, interviewers: people });
  const sched = (applicationId, stage, events) => ({ id: `sc-${applicationId}-${events.map(e => e.interviewId).join("")}`, status: "Complete", applicationId, interviewStageId: stage, interviewEvents: events });
  const host = (n, isFeedbackRequired) => ({ ...person(n), isFeedbackRequired });
  const schedules = [
    // Two candidates took one coding exercise each (one of them over two days).
    sched("app-1", "s-onsite", [ev("i-welcome", [host("Gina", false), host("Gus", false)]), ev("i-roomba", [host("Ari", true)])]),
    sched("app-2", "s-onsite", [ev("i-welcome", [host("Gina", false), host("Gus", false)])]),
    sched("app-2", "s-onsite", [ev("i-url", [host("Ari", true)])]),
    // A four-person panel, every time.
    sched("app-1", "s-onsite", [ev("i-panel", ["Ari", "Bo", "Cy", "Di"].map(n => host(n, true)))]),
    sched("app-3", "s-onsite", [ev("i-panel", ["Ari", "Bo", "Cy", "Di"].map(n => host(n, true)))]),
    sched("app-5", "s-onsite", [ev("i-panel", ["Ari", "Bo", "Cy", "Di"].map(n => host(n, true)))]),
    // Three people once: too little to call it a panel.
    sched("app-5", "s-screen", [ev("i-screen", ["Ari", "Bo", "Cy"].map(n => host(n, true)))]),
    { ...sched("app-4", "s-onsite", [ev("i-roomba", [host("Ari", true)]), ev("i-url", [host("Ari", true)])]), status: "Cancelled" },
  ];
  return {
    jobs: [{ id: ENG, title: "Engineer " }, { id: OPS, title: "Operations" }],
    plans, schedules, lookbackDays: 90, readAt: Date.parse("2026-11-16T17:00:00Z"),
    interviews: [{ id: "i-debrief", isDebrief: true }],
    users: [person("Gina"), person("Gus"), person("Ari"), person("Old", { isEnabled: false }), person("Pat"), person("Pat", { id: "u-pat2", email: "pat2@example-client.com" })],
    jobInfo: async id => id === SHUT ? { id, title: "Closed Role ", status: "Closed" } : null,
  };
}
const rulesDoc = (sessions = {}, extra = {}) => parseRules({ schemaVersion: 2, clientId: "example", rulesRevision: 1, agenda: { singleDay: true, minBreakMinutes: 15, maxGapMinutes: 30 },
  meetingHours: { default: { timezone: "America/Los_Angeles", days: ["mon"], start: "09:00", end: "17:00" }, overrides: { "old@example-client.com": { timezone: "America/Los_Angeles", days: ["mon"], start: "09:00", end: "17:00" } } },
  attendance: { default: "in_person", overrides: { "gone@example-client.com": "video" } }, limits: { ashbyInterviewerLimits: "zero_only" }, busy: { source: "none", calendars: [] },
  sessions, ...extra }, "example");
const lists = (compose, send) => ({ compose: jobList({ X: JSON.stringify(compose) }, "X"), send: jobList({ X: JSON.stringify(send) }, "X") });
const kinds = list => list.map(f => f.kind);

test("drift in the job lists: a stage the plan no longer has, a closed job, and a send list wider than compose, judged as the worker judges them", async () => {
  const r = await audit({ data: fixture(), lists: lists({ [ENG]: ["initial screen", "Agency Recruiter Screen", " ONSITE INTERVIEW "], [SHUT]: "all" }, { [ENG]: ["Initial Screen", "Technical Interview"], [OPS]: "all" }) });
  assert.deepEqual(kinds(r.drift).sort(), ["list_job_not_open", "list_stage_missing", "list_stage_missing", "send_beyond_compose", "send_beyond_compose"]);
  assert.match(r.drift.find(f => f.kind === "list_stage_missing").text, /^BOOKING_COMPOSE_JOBS names stage "agency recruiter screen", which isn't in the plan, so nothing is composed for it\. .*Stages with interviews: "Initial Screen", "Onsite Interview"\.$/);
  assert.match(r.drift.find(f => f.kind === "list_job_not_open").text, /"Closed Role" \(aaaaaaaa\), which is closed/);
  assert.ok(r.drift.some(f => /BOOKING_SEND_JOBS names stage "technical interview"/.test(f.text)));
  assert.ok(r.drift.some(f => /opts in the whole job beyond BOOKING_COMPOSE_JOBS/.test(f.text)), "Operations is on send only");
  assert.ok(r.notices.some(f => f.kind === "not_listed" && f.job === "Operations"));
  const bad = await audit({ data: fixture(), lists: { compose: jobList({ X: "{not json" }, "X"), send: { jobs: {} } } });
  assert.match(bad.drift[0].text, /^BOOKING_COMPOSE_JOBS can't be read \(X isn't valid JSON\.\), so the worker opens nothing on it\.$/);
});

test("drift in the rules: alternatives and preferences naming interviews that are gone, people deactivated or missing, and rules matching nothing", async () => {
  const rules = rulesDoc({
    alternatives: [{ jobId: ENG.toLowerCase(), label: "coding interviews", interviews: ["Coding - Roomba", "Coding - URL Shortener"], reason: "r" }],
    preferredInterviewers: [{ match: "exact", value: "Welcome", emails: ["gina@example-client.com", "old@example-client.com"] }, { match: "exact", value: "Greeting", jobId: ENG.toLowerCase(), emails: ["gina@example-client.com"] },
      { match: "contains", value: "welcome", emails: ["pat@example-client.com"] }],
    placementWindows: [{ match: "contains", value: "Lunch", timezone: "America/Los_Angeles", earliestStart: "12:00", latestStart: "13:00" }],
  }, { interviewerIdentities: { overrides: { "Pat Example": { email: "pat@example-client.com", reason: "two accounts" }, "Gina Example": { email: "gina@example-client.com", reason: "was two" } } } });
  const r = await audit({ data: fixture(), rules });
  const text = r.drift.map(f => f.text).join("\n");
  assert.match(text, /The coding interviews alternatives name "Coding - URL Shortener", which isn't an interview on this job any more, so the pair is never recognised\. Closest: "Coding - URL Shortner"\./);
  assert.match(text, /The preferred interviewers for "Welcome" include Old Example, who is deactivated in Ashby\./);
  assert.match(text, /The preferred interviewers for "Greeting" on "Engineer" match no interview any more/);
  assert.match(text, /The start window for sessions containing "Lunch" matches no interview on any open job\./);
  assert.match(text, /The meeting-hours override for Old Example is for someone who is deactivated in Ashby\./);
  assert.match(text, /The attendance override for gone@example-client\.com is for someone who has no Ashby account\./);
  assert.ok(!/Pat Example/.test(text), "Pat still has two active accounts");
  assert.ok(r.notices.some(f => /Gina Example now has one active account, so the account override may no longer be needed/.test(f.text)));
  assert.ok(r.notices.some(f => /preferred interviewers for sessions containing "welcome" include Pat Example, who hasn't taken one in 90 days/.test(f.text)));
  assert.ok(!r.notices.some(f => f.kind === "likely_alternatives" && /Roomba/.test(f.text)), "a declared pair isn't suggested again, even half-matched");
});

test("onboarding blockers and notes: duplicate activity names, larger panels, likely alternatives per candidate, hosts, spellings, stray spaces, churny names", async () => {
  const r = await audit({ data: fixture() });
  assert.deepEqual(kinds(r.blocking).sort(), ["duplicate_activity", "panel_large"]);
  assert.match(r.blocking.find(f => f.kind === "duplicate_activity").text, /^2 activities are named "Onsite"\. The worker finds the card by its name/);
  assert.match(r.blocking.find(f => f.kind === "panel_large").text, /^"Panel" usually has 4 people per event \(observed over 3 events in 90 days; slots themselves aren't readable from the API\)\. Panels above 2/);
  const notes = r.notices.map(f => f.text).join("\n");
  assert.match(notes, /"Coding - Roomba" and "Coding - URL Shortner" look like alternatives: candidates here had one \(1\) or the other \(1\), never both/, "app-2's two schedules count as one candidate; the cancelled one not at all");
  assert.ok(!/Debrief/.test(notes), "debriefs are never suggested as alternatives");
  assert.match(notes, /On at least half the events without giving feedback \(hosting\): "Welcome": Gina Example \(2 of 2 events\), Gus Example \(2 of 2 events\)\./);
  assert.match(notes, /Usually two people per event .*: "Welcome"\./);
  assert.match(notes, /"Initial Screen" had 3 people on its only event in 90 days: too few to tell a larger panel from shadows\. Check the template's slots\./);
  assert.match(notes, /Stray spaces or tabs in job title "Engineer ", interview "Initial Screen "\./);
  assert.match(notes, /Stage "Agency Recruiter Screen" has the kind of name that gets changed \(Agency\)/);
  assert.ok(!/New Lead/.test(notes), "an empty default stage isn't flagged");
  assert.equal(r.drift.length, 0);
  assert.match(renderReport(r), /DRIFTED SINCE CONFIGURED \(0\)\n• Nothing configured was given/);
});

test("near-duplicate names: one spelled two ways, never numbered siblings or short words", () => {
  assert.equal(nearDuplicate("URL Shortner", "URL Shortener"), true);
  assert.equal(nearDuplicate("Case Study Presentation", "Case-Study Presentation"), true);
  assert.equal(nearDuplicate("Round 1 Interview", "Round 2 Interview"), false);
  assert.equal(nearDuplicate("Lunch", "Brunch"), false);
  assert.equal(nearDuplicate("Onsite Main Loop", "Oniste Main Loop"), true);
});

test("renames since the last audit: drift on a configured job, a note elsewhere", async () => {
  const before = snapshotOf(fixture());
  const data = fixture();
  data.plans[ENG].stages[1].title = "Recruiter Screen";
  data.plans[ENG].stages[2].activities[0].interviews[1].title = "Coding - Roomba v2";
  data.plans[OPS].stages[0].title = "Ops Screen";
  const r = await audit({ data, lists: lists({ [ENG]: "all" }, {}), previous: before });
  assert.ok(r.drift.some(f => f.kind === "stage_renamed" && /Stage "Initial Screen" was renamed "Recruiter Screen" since 2026-11-16\./.test(f.text)));
  assert.ok(r.drift.some(f => f.kind === "interview_renamed" && /"Coding - Roomba" was renamed "Coding - Roomba v2"/.test(f.text)));
  assert.ok(r.notices.some(f => f.kind === "stage_renamed" && f.job === "Operations"), "Operations isn't configured");
});

test("the channel text: drift only, null without it, and last week's lines marked as still open", async () => {
  assert.equal(renderDrift(await audit({ data: fixture() })), null);
  const r = await audit({ data: fixture(), lists: lists({ [ENG]: ["Agency Recruiter Screen"] }, {}) });
  const first = renderDrift(r);
  assert.match(first, /^Weekly scheduling audit: 1 thing the bot is configured for no longer matches Ashby\./);
  assert.doesNotMatch(first, /still/);
  assert.match(renderDrift(r, { seen: new Set(first.split("\n").slice(1)) }), /\(still, from last week\)$/);
});

function watch(t, { worker = async () => ({ composeJobs: { jobs: { [ENG.toLowerCase()]: ["agency recruiter screen"] } }, sendJobs: { jobs: {} } }), read = async () => fixture(), mode = "on" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-watch-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const posted = [], logs = [], clock = { t: Date.parse("2026-11-16T17:30:00Z") }; // Monday 9:30am Pacific
  const w = createAuditWatch({ mode, apiKey: "fictional", rules: { get: () => null }, worker, dataDir: dir, channelId: "C1", slackApi: { notice: async x => { posted.push(x); return { ts: "1.1" }; } },
    now: () => clock.t, log: { warn: m => logs.push(m), log() {} }, read });
  return { w, posted, logs, clock, dir };
}

test("weekly: Monday from 9am Pacific, once a week; posts only when something drifted", async t => {
  const f = watch(t);
  f.clock.t = Date.parse("2026-11-16T16:30:00Z"); await f.w.tick(); assert.equal(f.posted.length, 0, "8:30am is too early");
  f.clock.t = Date.parse("2026-11-16T17:30:00Z"); await f.w.tick();
  assert.equal(f.posted.length, 1); assert.match(f.posted[0].text, /BOOKING_COMPOSE_JOBS names stage "agency recruiter screen"/);
  await f.w.tick(); assert.equal(f.posted.length, 1, "once a week");
  f.clock.t = Date.parse("2026-11-23T17:30:00Z"); await f.w.tick();
  assert.equal(f.posted.length, 2); assert.match(f.posted[1].text, /\(still, from last week\)/);
  assert.equal(weekOf(Date.parse("2026-11-22T20:00:00Z"), "America/Los_Angeles"), "2026-11-16", "Sunday belongs to the week before");

  const clean = watch(t, { worker: async () => ({ composeJobs: { jobs: { [ENG.toLowerCase()]: "all" } }, sendJobs: { jobs: {} } }) });
  await clean.w.tick();
  assert.equal(clean.posted.length, 0); assert.ok(clean.logs.some(l => /nothing drifted/.test(l)));
  const logged = watch(t, { mode: "log" });
  await logged.w.tick();
  assert.equal(logged.posted.length, 0); assert.ok(logged.logs.some(l => /DRIFTED SINCE CONFIGURED \(1\)/.test(l)));
});

test("weekly: lists the worker can't give are posted as unchecked; Ashby failing three times is said once", async t => {
  const f = watch(t, { worker: async () => { throw new Error("The scheduling worker didn't answer"); } });
  await f.w.tick();
  assert.match(f.posted[0].text, /The worker's job lists couldn't be read \(The scheduling worker didn't answer\), so BOOKING_COMPOSE_JOBS and BOOKING_SEND_JOBS weren't checked this week\./);

  const g = watch(t, { read: async () => { throw new Error("Ashby didn't answer"); } });
  for (let i = 0; i < 4; i++) { g.clock.t += 3600000; await g.w.tick(); }
  assert.equal(g.posted.length, 1);
  assert.match(g.posted[0].text, /^The weekly scheduling audit couldn't read Ashby \(Ashby didn't answer\) after 3 tries, so nothing was checked this week\./);
});
