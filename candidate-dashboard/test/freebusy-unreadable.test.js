"use strict";
// An interviewer calendar Google won't read refuses the whole calendar check:
// never counted as free or busy, never silently dropped. The refusal names
// every unreadable calendar, by interviewer, with what a coordinator can do:
// fix the address or sharing (notFound, which Google uses for both and doesn't
// distinguish), retry (temporary Google errors), or reconnect (authorization).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createGoogleFreeBusy, parseFreeBusy } = require("../src/scheduling/google-freebusy");
const { buildCalendarInputs } = require("../src/scheduling/calendar-inputs");
const { parseRules } = require("../src/scheduling/rules");

const start = Date.parse("2099-01-05T17:00:00Z"), end = Date.parse("2099-01-06T01:00:00Z");
const query = { calendarIds: ["a@x.test", "b@x.test", "c@x.test", "d@x.test", "e@x.test"], start, end, checkedAt: 0 };
const reply = calendars => ({ kind: "calendar#freeBusy", timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), calendars });

test("each calendar is classified by Google's reason, and readable ones still parse", () => {
  const { rows, unreadable } = parseFreeBusy(reply({
    "a@x.test": { busy: [] },
    "b@x.test": { errors: [{ domain: "global", reason: "notFound" }], busy: [] },
    "c@x.test": { errors: [{ domain: "global", reason: "internalError" }], busy: [] },
    "d@x.test": { errors: [{ domain: "global", reason: "somethingNew" }], busy: [] },
  }), query);
  assert.deepEqual(rows.map(r => r.calendarId), ["a@x.test"]);
  assert.deepEqual(unreadable, [
    { calendarId: "b@x.test", kind: "not_found_or_not_shared", reason: "notFound" },
    { calendarId: "c@x.test", kind: "google_error", reason: "internalError" },
    { calendarId: "d@x.test", kind: "unrecognised", reason: "somethingNew" },
    { calendarId: "e@x.test", kind: "incomplete", reason: "missing from the reply" },
  ]);
});

function service(replies, account = "anna@luminai.test") {
  const sent = [];
  const freeBusy = createGoogleFreeBusy({
    now: () => start - 60000,
    connection: { access: async () => ({ token: "t", connectionId: "id" }), isCurrent: () => true, status: () => ({ account }) },
    request: async (url, options) => { const body = JSON.parse(options.body); sent.push(body.items.map(i => i.id)); return replies(body.items.map(i => i.id)); },
  });
  return { freeBusy, sent };
}
const ok = calendars => ({ ok: true, json: async () => reply(calendars) });
const args = ids => ({ calendarIds: ids, timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString() });

test("one refusal names every unreadable calendar, across batches; nothing is returned", async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `p${i}@x.test`);
  const { freeBusy, sent } = service(batch => ok(Object.fromEntries(batch.map(id =>
    [id, id === "p3@x.test" || id === "p55@x.test" ? { errors: [{ reason: "notFound" }] } : { busy: [] }]))));
  const err = await freeBusy.read(args(ids)).then(() => null, e => e);
  assert.equal(sent.length, 2, "both batches were asked before refusing");
  assert.equal(err.status, 409);
  assert.deepEqual(err.unreadable.map(u => u.calendarId), ["p3@x.test", "p55@x.test"]);
  assert.match(err.message, /^Couldn't read 2 of 60 interviewer calendars, so no times were proposed\. No one was treated as free or busy\./);
  assert.match(err.message, /p3@x\.test: Google found no calendar it will show to anna@luminai\.test\. Either it isn't shared with that account, or the address isn't a Google calendar\. Google's reply doesn't say which\./);
  assert.equal(err.message.split("\n").length, 3);
});

test("only temporary problems are a 503 (retry); any calendar to fix makes it a 409", async () => {
  const temporary = service(() => ok({ "a@x.test": { errors: [{ reason: "backendError" }] }, "b@x.test": { busy: [] } }));
  const t = await temporary.freeBusy.read(args(["a@x.test", "b@x.test"])).then(() => null, e => e);
  assert.equal(t.status, 503);
  assert.match(t.message, /a@x\.test: temporary Google error \(backendError\)\. Try again in a few minutes\./);
  const mixed = service(() => ok({ "a@x.test": { errors: [{ reason: "backendError" }] }, "b@x.test": { errors: [{ reason: "notFound" }] } }));
  assert.equal((await mixed.freeBusy.read(args(["a@x.test", "b@x.test"])).then(() => null, e => e)).status, 409);
});

test("request-level failures say whether to reconnect or retry", async () => {
  const fails = (status, body) => service(() => ({ ok: false, status, json: async () => body })).freeBusy.read(args(["a@x.test"])).then(() => null, e => e);
  const expired = await fails(401, {});
  assert.equal(expired.status, 409); assert.match(expired.message, /anna@luminai\.test has expired or was revoked\. Reconnect/);
  const limited = await fails(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } });
  assert.equal(limited.status, 503); assert.match(limited.message, /limiting how fast/);
  const refused = await fails(403, { error: { errors: [{ reason: "forbidden" }] } });
  assert.equal(refused.status, 409); assert.match(refused.message, /refused calendar access for anna@luminai\.test \(forbidden\)/);
  const down = await fails(500, null);
  assert.equal(down.status, 503); assert.match(down.message, /temporarily unavailable \(HTTP 500\)\. Try again/);
});

test("the calendar check names interviewers, and doesn't drop or free anyone", async () => {
  const ANA = { userId: "u1", name: "Ana Silva", email: "ana@luminai.com" }, TOM = { userId: "u2", name: "Tom Reyes", email: "tom@luminai.com" };
  const plan = { sessions: [{ sessionId: "s1", interviewId: "i1", title: "Panel", durationMinutes: 60, assignmentVerified: true, requiredCount: 1, eligibleInterviewers: [{ name: "Ana Silva" }, { name: "Tom Reyes" }] }] };
  const facts = {
    resolveInterviewers: async sessions => ({ sessions: sessions.map(s => ({ ...s, eligibleInterviewers: [ANA, TOM] })), interviewers: [ANA, TOM] }),
    interviewerLimits: async ids => new Map(ids.map(id => [id, { dailyLimit: null, weeklyLimit: 5 }])),
  };
  const { freeBusy } = service(() => ok({ "ana@luminai.com": { busy: [] }, "tom@luminai.com": { errors: [{ reason: "notFound" }] } }));
  const rules = parseRules(JSON.parse(JSON.stringify(require("../scheduling-rules/luminai.json"))), "luminai");
  const err = await buildCalendarInputs({ plan, windows: [{ start: "2099-01-05T09:00", end: "2099-01-05T17:00" }], timezone: "America/Los_Angeles", rules, facts, freeBusy, now: start - 3600000 }).then(() => null, e => e);
  assert.equal(err.status, 409);
  assert.match(err.message, /^Couldn't read 1 of 2 interviewer calendars/);
  assert.match(err.message, /• Tom Reyes \(tom@luminai\.com\): Google found no calendar it will show to anna@luminai\.test/);
  assert.doesNotMatch(err.message, /Ana Silva/);
});
