'use strict';
// Feedback leaderboard rules (src/feedback-leaderboard.js), agreed 2026-11-17:
// 90 days, minimum 8 completed interviews, top 10 only, ranked on share of
// feedback in, ties by median time to submit then volume, hosts and leavers
// excluded, "N others also at 100%" below the cut.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildLeaderboard, median } = require('../src/feedback-leaderboard');
const { createFeedbackSync } = require('../src/feedback-sync');

const NOW = Date.parse('2026-11-17T15:00:00Z');
const H = 36e5, D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const person = (id, isFeedbackRequired = true) => ({ id, firstName: id, lastName: '', isFeedbackRequired });

// `n` interviews for each listed person, ending `daysAgo` days ago; `inFor`
// lists who submitted on each (submitted `afterHours` after the end).
function interviews(prefix, n, people, { daysAgo = 5, inFor = people.map((p) => p.id), afterHours = 2, status = 'Complete', interviewId = 'iTech' } = {}) {
  const schedules = [], scorecards = [];
  for (let i = 0; i < n; i++) {
    const end = NOW - daysAgo * D - i * H;
    const id = `${prefix}${i}`;
    schedules.push({ status, interviewEvents: [{ id, interviewId, endTime: iso(end), interviewers: people }] });
    for (const u of inFor) scorecards.push({ eventId: id, userId: u, submittedAt: iso(end + afterHours * H) });
  }
  return { schedules, scorecards };
}

function board(parts, { enabled, minInterviews = 8, size = 10 } = {}) {
  const schedules = parts.flatMap((p) => p.schedules), scorecards = parts.flatMap((p) => p.scorecards);
  const ids = new Set(schedules.flatMap((s) => s.interviewEvents.flatMap((e) => e.interviewers.map((i) => i.id))));
  return buildLeaderboard({
    schedules, scorecards, enabledUserIds: enabled || ids,
    owersFor: (e) => (e.interviewId === 'iWelcome' ? [] : e.interviewers.filter((i) => i.isFeedbackRequired !== false)),
    now: NOW, days: 90, minInterviews, dueAfterHours: 24, size,
  });
}

test('share of feedback in outranks speed: a slower 100% beats a faster 90%', () => {
  const slowButComplete = interviews('a', 10, [person('ana')], { afterHours: 100 });
  const fastButMissing = interviews('b', 10, [person('ben')], { afterHours: 1 });
  fastButMissing.scorecards.pop(); // 9 of 10
  const b = board([slowButComplete, fastButMissing]);
  assert.deepEqual(b.top.map((p) => [p.name, p.submitted, p.completed]), [['ana', 10, 10], ['ben', 9, 10]]);
  assert.equal(b.top[0].medianHoursToSubmit, 100);
});

test('fewer than 8 completed interviews: not on the board; qualifying counts only those with 8+', () => {
  const b = board([interviews('a', 8, [person('ana')]), interviews('b', 7, [person('ben')])]);
  assert.deepEqual(b.top.map((p) => p.name), ['ana']);
  assert.equal(b.qualifying, 1);
});

test('only the top 10, even when more qualify; the 100% people below the cut are counted, not named', () => {
  // twelve people all at 100%, each one hour slower than the last
  const parts = Array.from({ length: 12 }, (_, i) => interviews(`p${i}-`, 8, [person(`u${String(i).padStart(2, '0')}`)], { afterHours: i + 1 }));
  parts.push(interviews('m', 10, [person('miss')], { inFor: [] })); // qualifies at 0%, below the cut
  const b = board(parts);
  assert.equal(b.top.length, 10);
  assert.equal(b.qualifying, 13);
  assert.deepEqual([b.top[0].name, b.top[9].name], ['u00', 'u09']);
  assert.equal(b.othersAtFull, 2, 'u10 and u11 are at 100% but outside the top 10; the 0% person is not counted');
});

test('ties on share go to the faster median first, interview count only after that', () => {
  const fewButPrompt = interviews('f', 8, [person('fay')], { afterHours: 1 });
  const manyButSlow = interviews('m', 40, [person('max')], { afterHours: 30 });
  const samePaceMore = interviews('s', 20, [person('sam')], { afterHours: 1 });
  const b = board([fewButPrompt, manyButSlow, samePaceMore]);
  assert.deepEqual(b.top.map((p) => p.name), ['sam', 'fay', 'max']);
  assert.equal(b.othersAtFull, 0);
});

test('hosts and interviews nobody owes feedback on never count, for or against', () => {
  const welcome = interviews('w', 20, [person('grace')], { interviewId: 'iWelcome', inFor: [] });
  const notRequired = interviews('n', 20, [person('ana'), person('tia', false)], { inFor: ['ana'] });
  const b = board([welcome, notRequired]);
  assert.deepEqual(b.top.map((p) => p.name), ['ana']);
});

test('people who have left are excluded entirely', () => {
  const b = board([interviews('a', 10, [person('ana')]), interviews('l', 10, [person('leaver')])], { enabled: new Set(['ana']) });
  assert.deepEqual(b.top.map((p) => p.name), ['ana']);
  assert.equal(b.qualifying, 1);
});

test('the window: not yet due (under 24h), older than 90 days, and cancelled schedules do not count', () => {
  const due = interviews('a', 8, [person('ana')]);
  const notDue = interviews('n', 5, [person('ana')], { daysAgo: 0.5, inFor: [] });
  const old = interviews('o', 5, [person('ana')], { daysAgo: 95, inFor: [] });
  const cancelled = interviews('c', 5, [person('ana')], { status: 'Cancelled', inFor: [] });
  const b = board([due, notDue, old, cancelled]);
  assert.deepEqual([b.top[0].submitted, b.top[0].completed], [8, 8]);
});

test('late feedback still counts as in', () => {
  const b = board([interviews('a', 8, [person('ana')], { afterHours: 24 * 30 })]);
  assert.equal(b.top[0].share, 1);
});

test('nobody qualifies: an empty top list, not placeholder rows', () => {
  const b = board([interviews('a', 3, [person('ana')])]);
  assert.deepEqual(b.top, []);
  assert.equal(b.qualifying, 0);
});

test('median', () => {
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('scorecard sync: one full read by date, then the sync token; credit beats submitter', async () => {
  const calls = [];
  const pages = [
    { results: [
      { id: 'f1', interviewEventId: 'e1', submittedByUser: { id: 'coord' }, creditedToUser: { id: 'ana' }, submittedAt: iso(NOW - D) },
      { id: 'f2', interviewEventId: null, submittedByUser: { id: 'ben' }, submittedAt: iso(NOW - D) },
    ], moreDataAvailable: true, nextCursor: 'c1' },
    { results: [{ id: 'f3', interviewEventId: 'e2', submittedByUser: { id: 'ben' }, submittedAt: iso(NOW - 2 * D) }], moreDataAvailable: false, syncToken: 't1' },
    { results: [{ id: 'f4', interviewEventId: 'e3', creditedToUser: { id: 'cy' }, submittedAt: iso(NOW - H) }], moreDataAvailable: false, syncToken: 't2' },
  ];
  const sync = createFeedbackSync({ fetchPage: async (body) => { calls.push(body); return pages[calls.length - 1]; }, now: () => NOW, keepDays: 92 });
  const first = await sync.scorecards();
  assert.deepEqual(first.map((s) => [s.eventId, s.userId]), [['e1', 'ana'], ['e2', 'ben']]);
  assert.equal(calls[0].createdAfter, NOW - 92 * D);
  assert.equal(calls[1].cursor, 'c1');
  const second = await sync.scorecards();
  assert.equal(calls[2].syncToken, 't1');
  assert.equal(second.length, 3);
});

// Kept on the volume (feedback-sync.json) so a redeploy carries on from the
// saved sync token instead of reading 90 days of scorecards again.
function memoryStore(initial = null) {
  let saved = initial, saves = 0;
  return { load: () => (saved ? JSON.parse(JSON.stringify(saved)) : null), save: (s) => { saved = s; saves += 1; }, get saved() { return saved; }, get saves() { return saves; } };
}
const quiet = { warn() {}, log() {} };

test('scorecard sync on the volume: a restart continues from the saved token, no full read', async () => {
  const store = memoryStore();
  let clock = NOW;
  const first = createFeedbackSync({ fetchPage: async () => ({ results: [{ id: 'f1', interviewEventId: 'e1', creditedToUser: { id: 'ana' }, submittedAt: iso(NOW - D) }], moreDataAvailable: false, syncToken: 't1' }), now: () => clock, keepDays: 92, store, log: quiet });
  await first.scorecards();
  assert.equal(store.saves, 1, 'saved straight after the full read');
  assert.equal(store.saved.token, 't1');

  clock = NOW + 2 * H; // the redeploy
  const calls = [];
  const second = createFeedbackSync({ fetchPage: async (body) => { calls.push(body); return { results: [{ id: 'f2', interviewEventId: 'e2', creditedToUser: { id: 'ben' }, submittedAt: iso(clock - H) }], moreDataAvailable: false, syncToken: 't2' }; }, now: () => clock, keepDays: 92, store, log: quiet });
  const after = await second.scorecards();
  assert.deepEqual(calls, [{ limit: 100, syncToken: 't1' }]);
  assert.deepEqual(after.map((s) => s.userId).sort(), ['ana', 'ben']);
});

test('scorecard sync on the volume: saves are throttled, and a longer window or unreadable state reads everything', async () => {
  const store = memoryStore();
  let clock = NOW, n = 0;
  const page = async (body) => ({ results: [], moreDataAvailable: false, syncToken: `t${++n}`, body });
  const sync = createFeedbackSync({ fetchPage: page, now: () => clock, keepDays: 92, store, log: quiet, saveEveryMs: 10 * 60 * 1000 });
  await sync.scorecards();
  clock += 60 * 1000; await sync.scorecards();
  assert.equal(store.saves, 1, 'not again a minute later');
  clock += 10 * 60 * 1000; await sync.scorecards();
  assert.equal(store.saves, 2);

  // FEEDBACK_LEADERBOARD_DAYS raised: the saved read doesn't reach back far enough.
  const calls = [];
  const longer = createFeedbackSync({ fetchPage: async (body) => { calls.push(body); return { results: [], moreDataAvailable: false, syncToken: 'x' }; }, now: () => clock, keepDays: 182, store, log: quiet });
  await longer.scorecards();
  assert.ok(calls[0].createdAfter, 'full read by date');

  const junk = createFeedbackSync({ fetchPage: async (body) => { calls.push(body); return { results: [], moreDataAvailable: false, syncToken: 'y' }; }, now: () => clock, keepDays: 92, store: memoryStore({ version: 99 }), log: quiet });
  await junk.scorecards();
  assert.ok(calls.at(-1).createdAfter);
});
