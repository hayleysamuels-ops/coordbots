'use strict';
// listIssues() end to end against a faked Ashby: per-person Feedback Overdue,
// NO_FEEDBACK_INTERVIEWS (by interview name, never by person), stale rows
// folded into Feedback Overdue, and Interviews today.
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'listissues-'));
process.env.ASHBY_API_KEY = 'test';
process.env.DISPLAY_TIMEZONE = 'UTC';
process.env.ONSITE_STAGE_KEYWORDS = '';
process.env.NO_FEEDBACK_INTERVIEWS = 'Welcome, lunch';
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;

const NOW = Date.parse('2026-11-17T15:00:00Z');
const H = 36e5;
const iso = (ms) => new Date(ms).toISOString();
const person = (id, isFeedbackRequired = true) => ({ id, firstName: id[0].toUpperCase() + id.slice(1), lastName: 'X', email: `${id}@x.test`, isFeedbackRequired });
const event = (id, interviewId, startMs, endMs, interviewers, hasSubmittedFeedback) => ({ id, interviewId, startTime: iso(startMs), endTime: iso(endMs), interviewers, hasSubmittedFeedback });
const schedule = (n, ev, status = 'WaitingOnFeedback') => ({ id: `s${n}`, applicationId: `a${n}`, interviewStageId: 'stage', status, createdAt: iso(NOW - 40 * 24 * H), updatedAt: iso(NOW - H), interviewEvents: [ev] });

const SCHEDULES = [
  // Panel: Ana's scorecard is in, Ben's isn't, but the event flag says "in".
  schedule(1, event('e1', 'iTech', NOW - 74 * H, NOW - 73 * H, [person('ana'), person('ben')], true)),
  // Ended 20 days ago, nobody in: overdue AND stale (past 350h).
  schedule(2, event('e2', 'iTech', NOW - 481 * H, NOW - 480 * H, [person('cy')], false)),
  // Welcome: Grace is marked feedback-required in Ashby but owes nothing.
  schedule(3, event('e3', 'iWelcome', NOW - 74 * H, NOW - 73 * H, [person('grace')], false)),
  // Today, ended: Ana in, Ben not, Tia not required (a host).
  schedule(4, event('e4', 'iTech', NOW - 2 * H, NOW - H, [person('ana'), person('ben'), person('tia', false)], true)),
  // Today, still running.
  schedule(5, event('e5', 'iTech', NOW - 0.5 * H, NOW + 0.5 * H, [person('dee')], false)),
  // Today, Lunch, ended: nobody owes, so no markers for anyone.
  schedule(6, event('e6', 'iLunch', NOW - 3 * H, NOW - 2 * H, [person('eve')], false)),
  // Today but cancelled: never shown.
  schedule(7, event('e7', 'iTech', NOW - 2 * H, NOW - H, [person('fay')], false), 'Cancelled'),
];
const TITLES = { iTech: 'Technical Interview', iWelcome: '  Welcome ', iLunch: 'LUNCH' };
const FEEDBACK = {
  a1: [{ interviewEventId: 'e1', submittedByUser: { id: 'ana' }, creditedToUser: { id: 'ana' } }],
  a4: [{ interviewEventId: 'e4', submittedByUser: { id: 'coordinator' }, creditedToUser: { id: 'ana' } }],
};
const application = (id) => ({
  id, status: 'Active', candidate: { id: `c-${id}`, name: `Cand ${id}` },
  job: { id: 'job', title: 'Engineer', departmentId: 'dep' },
  currentInterviewStage: { id: 'stage', type: 'Interview' },
  applicationHistory: [{ enteredStageAt: iso(NOW - 60 * 24 * H) }], hiringTeam: [],
});

function fakeAshby(endpoint, body) {
  switch (endpoint) {
    case 'interviewSchedule.list': return { results: SCHEDULES };
    case 'application.info': return { results: application(body.applicationId) };
    case 'interview.list': return { results: [] }; // like real orgs: job-plan interviews are missing
    case 'interview.info': return { results: { id: body.id, title: TITLES[body.id], isDebrief: false } };
    case 'applicationFeedback.list': return { results: FEEDBACK[body.applicationId] || [] };
    case 'user.interviewerSettings': return { results: { weeklyLimit: null } };
    default: return { results: [] };
  }
}

test('listIssues: per-person overdue, no-feedback names, stale folded in, interviews today', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  const calls = [];
  mock.method(global, 'fetch', async (url, opts) => {
    const endpoint = url.split('/').pop();
    calls.push(endpoint);
    const json = { success: true, moreDataAvailable: false, ...fakeAshby(endpoint, JSON.parse(opts.body)) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => json };
  });
  try {
    const ashby = require('../src/ashby');
    const r = await ashby.listIssues();

    const overdue = Object.fromEntries(r.feedbackOverdue.map((e) => [e.interviewEventId, e]));
    assert.deepEqual(Object.keys(overdue).sort(), ['e1', 'e2'], 'Welcome (e3) is never overdue');
    assert.deepEqual(overdue.e1.interviewers.map((i) => i.email), ['ben@x.test'], 'only the panelist still missing');
    assert.equal(overdue.e1.isStale, false);
    assert.equal(overdue.e2.isStale, true, 'stale rows stay in Feedback Overdue, marked');
    assert.equal(r.staleCandidates, undefined, 'no separate stale list any more');

    const today = Object.fromEntries(r.interviewsToday.map((e) => [e.interviewEventId, e]));
    assert.deepEqual(r.interviewsToday.map((e) => e.interviewEventId), ['e6', 'e4', 'e5'], 'started today, by start time; cancelled left out');
    const marks = (e) => Object.fromEntries(e.people.map((p) => [p.name, [p.owes, p.submitted]]));
    assert.deepEqual(marks(today.e4), { 'Ana X': [true, true], 'Ben X': [true, false], 'Tia X': [false, null] },
      'scorecard credited to Ana counts for Ana even though a coordinator submitted it');
    assert.equal(today.e5.inProgress, true);
    assert.deepEqual(marks(today.e5), { 'Dee X': [true, null] }, 'no markers while running');
    assert.deepEqual(marks(today.e6), { 'Eve X': [false, null] }, 'Lunch: matched by name, case and spaces ignored');
    assert.equal(today.e4.interviewTitle, 'Technical Interview');

    // One feedback lookup per application whose flag says "in" (a1, a4), none for flag-false ones.
    assert.equal(calls.filter((c) => c === 'applicationFeedback.list').length, 2);
  } finally {
    mock.reset();
    mock.timers.reset();
  }
});
