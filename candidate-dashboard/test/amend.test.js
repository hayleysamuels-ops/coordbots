"use strict";
// amend.js: what a request means, settled in code. The model's reading is an
// input here; every field is matched against the post and Ashby, and anything
// unclear is asked, never guessed.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveChange, eligibleFor, names, sessionLabels } = require("../src/scheduling/amend");

const P = (userId, name) => ({ userId, name, email: `${name.split(" ")[0].toLowerCase()}@luminai.com` });
const gabrielle = P("u-g", "Gabrielle Struckell"), joe = P("u-j", "Joe Penn"), mary = P("u-m", "Mary Petrino"), anna = P("u-a", "Anna Jones"),
  vamsi = P("u-v", "Vamsi Chitters"), joan = P("u-jo", "Joan Park"), maryk = P("u-mk", "Mary Kim");
// TEST's onsite shape: two "Onsite" sessions, Joe on both.
const sessions = [
  { title: "Welcome", interviewId: "i0", start: "2026-11-03T17:30:00.000Z", end: "2026-11-03T17:45:00.000Z", interviewers: [gabrielle] },
  { title: "Onsite", interviewId: "i1", start: "2026-11-03T18:00:00.000Z", end: "2026-11-03T18:30:00.000Z", interviewers: [joe] },
  { title: "Onsite", interviewId: "i2", start: "2026-11-03T20:30:00.000Z", end: "2026-11-03T21:00:00.000Z", interviewers: [joe] },
];
const eligible = [[gabrielle], [joe, mary, anna], [joe, mary, maryk]];
const directory = [gabrielle, joe, mary, anna, vamsi, joan, maryk];
const findPeople = async () => directory;
const resolve = (o, extra = {}) => resolveChange({ kind: "replace_interviewer", session: null, replace: null, with: null, ...o }, { sessions, eligible, findPeople, timeZone: "America/Los_Angeles", ...extra });

test("names: every typed word starts a different word of the name, in order", () => {
  assert.ok(names("Vamsi", "Vamsi Chitters")); assert.ok(names("vamsi c", "Vamsi Chitters")); assert.ok(names("@V Chitters", "Vamsi Chitters"));
  assert.ok(names("José", "Jose Ruiz")); assert.ok(!names("Chitters Vamsi", "Vamsi Chitters")); assert.ok(!names("V", "Vamsi Chitters")); assert.ok(!names("Vamsi X", "Vamsi Chitters"));
  assert.deepEqual(sessionLabels(sessions), ["Welcome", "Onsite 1", "Onsite 2"]);
});

test("a clear swap with an eligible person is restated in full", async () => {
  const r = await resolve({ session: 2, replace: "Joe", with: "Mary" });
  assert.equal(r.restatement, "Replace Joe Penn with Mary Petrino on Onsite 1 (Tue, Nov 3, 10:00 AM–10:30 AM PST)?");
  assert.deepEqual(r.change, { kind: "replace_interviewer", session: 1, label: "Onsite 1", when: "Tue, Nov 3, 10:00 AM–10:30 AM PST", start: sessions[1].start, end: sessions[1].end,
    out: { userId: "u-j", name: "Joe Penn" }, in: mary });
});

test("a person on two sessions with none named is asked about, whatever the model said", async () => {
  const r = await resolve({ replace: "Joe", with: "Mary" });
  assert.equal(r.ask, "Joe Penn is on 2 sessions. Which one do you mean: Onsite 1 (Tue, Nov 3, 10:00 AM–10:30 AM PST, Joe Penn) or Onsite 2 (Tue, Nov 3, 12:30 PM–1:00 PM PST, Joe Penn)?");
  assert.equal(r.change, undefined);
});

test("no session and nobody named to replace: it asks which session", async () => {
  assert.match((await resolve({ with: "Mary" })).ask, /^Which session should Mary take: Welcome \(.*\), Onsite 1 \(.*\) or Onsite 2 \(.*\)\?$/);
});

test("the person named as coming off must be the one on that session", async () => {
  assert.match((await resolve({ session: 1, replace: "Joe", with: "Mary" })).ask, /^Welcome has Gabrielle Struckell, not Joe\. Which session do you mean: Onsite 1 .* or Onsite 2 /);
  assert.match((await resolve({ replace: "Anna", with: "Mary" })).ask, /^Anna isn't an interviewer on this post\./);
});

test("a name that fits two eligible people is asked about", async () => {
  assert.equal((await resolve({ session: 3, with: "Mary" })).ask, `"Mary" could be Mary Petrino or Mary Kim. Which one should take Onsite 2?`);
});

test("off-plan: restated, then declined with the drafted message; nobody unknown is invented", async () => {
  const r = await resolve({ session: 2, replace: "Joe", with: "Vamsi" });
  assert.equal(r.decline, "You asked to replace Joe Penn with Vamsi Chitters on Onsite 1 (Tue, Nov 3, 10:00 AM–10:30 AM PST). Vamsi Chitters isn't eligible for Onsite 1 in Ashby; off-plan interviewers aren't supported yet. Nothing was changed.");
  assert.equal(r.change, undefined);
  assert.equal((await resolve({ session: 2, with: "Zed" })).ask, "I couldn't find anyone active in Ashby called Zed. Who do you mean?");
  assert.match((await resolve({ session: 2, with: "Jo" }, { findPeople: async () => directory })).ask, /^"Jo" could be /);
});

test("swapping someone for themselves changes nothing", async () => {
  assert.equal((await resolve({ session: 2, with: "Joe" })).decline, "Joe Penn is already on Onsite 1. Nothing was changed.");
});

test("unclear and unsupported readings pass through as a question and a decline", async () => {
  assert.deepEqual(await resolveChange({ kind: "unclear", question: "Which day?" }, { sessions, eligible, findPeople, timeZone: "America/Los_Angeles" }), { ask: "Which day?" });
  assert.match((await resolveChange({ kind: "unsupported", reason: "another day" }, { sessions, eligible, findPeople, timeZone: "America/Los_Angeles" })).decline, /^I can only swap one interviewer for another on a session, so I can't do that \(another day\)/);
});

test("eligible lists come from the current plan, and a plan that no longer matches the post refuses", async () => {
  const plan = { sessions: [{ interviewId: "i0", eligibleInterviewers: [{ name: "Gabrielle Struckell" }] }, { interviewId: "d", isDebrief: true, eligibleInterviewers: [] },
    { interviewId: "i1", eligibleInterviewers: [{ name: "Joe Penn" }] }, { interviewId: "i2", eligibleInterviewers: [{ name: "Mary Petrino" }] }] };
  const byName = new Map(directory.map(p => [p.name, p]));
  const resolveInterviewers = async list => ({ sessions: list.map(s => ({ ...s, eligibleInterviewers: s.eligibleInterviewers.map(p => byName.get(p.name)) })) });
  assert.deepEqual(await eligibleFor(sessions, plan, resolveInterviewers), [[gabrielle], [joe], [mary]]);
  await assert.rejects(eligibleFor(sessions, { sessions: plan.sessions.slice(0, 3) }, resolveInterviewers), e => e.status === 409 && /has changed since this was posted/.test(e.message));
});
