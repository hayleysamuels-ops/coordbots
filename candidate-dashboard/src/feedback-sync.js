"use strict";

// Every scorecard submitted in the last `keepDays`, org-wide, kept in memory
// for the feedback leaderboard. Same shape as interviewer-load.js's
// createScheduleSync: one full read, then only changes via Ashby's syncToken.
//
// applicationFeedback.list works without an applicationId: with createdAfter
// it pages through the whole org, and the last page returns a syncToken
// (confirmed live against January, 2026-11-17). That makes 90 days of
// scorecards one paged read (Forus: roughly 60 pages) instead of one call per
// application. Pages are read one at a time, never in parallel, because the
// key is shared with the live dashboard (see README § Running locally
// against a different client).
//
// A scorecard is kept as { eventId, userId, submittedAt }. userId is
// creditedToUser, falling back to submittedByUser only when there's no
// credit: someone sometimes submits on an interviewer's behalf, and the
// scorecard is that interviewer's (same rule as missingFeedbackOwers in
// ashby.js). Scorecards with no interview event can't be matched to an
// interview and are dropped.
//
// With a `store` (syncStateFile.js; ashby.js passes
// <DATA_DIR>/feedback-sync.json), the scorecards and sync token are kept on
// the volume, so a restart carries on from the saved token instead of
// reading 90 days again. The saved state is used only if its full read
// reached back far enough for today's window (`coveredFrom`), so raising
// FEEDBACK_LEADERBOARD_DAYS forces one full read. An expired token falls
// back to a full read exactly as it does in memory. Saved after a full read,
// then at most every `saveEveryMs`: an older saved token only means the
// next boot replays a few more minutes of changes.

const DAY = 24 * 60 * 60 * 1000;

const STATE_VERSION = 1;

function createFeedbackSync({ fetchPage, now = () => Date.now(), keepDays = 92, log = console, store = null, saveEveryMs = 10 * 60 * 1000 }) {
  const byId = new Map();
  let token = null;
  let inFlight = null;
  let coveredFrom = null; // createdAfter of the full read the current state came from
  let lastSaved = 0;

  function restore() {
    const state = store && store.load();
    if (!state) return;
    if (state.version !== STATE_VERSION || !state.token || !Array.isArray(state.scorecards) || !(state.coveredFrom <= now() - keepDays * DAY)) {
      log.warn("[feedback-sync] saved scorecards don't cover the current window; reading every scorecard again.");
      return;
    }
    for (const [id, eventId, userId, submittedAt] of state.scorecards) byId.set(id, { eventId, userId, submittedAt });
    token = state.token;
    coveredFrom = state.coveredFrom;
    lastSaved = now();
    log.log(`[feedback-sync] restored ${byId.size} scorecards saved ${Math.round((Date.now() - Date.parse(state.savedAt)) / 60000)}m ago; continuing from the sync token.`);
  }

  function save(force) {
    if (!store || !token || (!force && now() - lastSaved < saveEveryMs)) return;
    store.save({
      version: STATE_VERSION,
      savedAt: new Date().toISOString(),
      coveredFrom,
      token,
      scorecards: [...byId].map(([id, f]) => [id, f.eventId, f.userId, f.submittedAt]),
    });
    lastSaved = now();
  }

  async function readAll(body) {
    const results = [];
    let cursor = null;
    let last = null;
    for (;;) {
      last = await fetchPage(cursor ? { ...body, cursor } : body);
      results.push(...(last.results || []));
      if (!last.moreDataAvailable || !last.nextCursor) break;
      cursor = last.nextCursor;
    }
    return { results, syncToken: last.syncToken || null };
  }

  function keep(f) {
    const credited = (f.creditedToUser && f.creditedToUser.id) || (f.submittedByUser && f.submittedByUser.id);
    if (!f.id || !f.interviewEventId || !credited || !f.submittedAt) {
      byId.delete(f.id);
      return;
    }
    byId.set(f.id, { eventId: f.interviewEventId, userId: credited, submittedAt: f.submittedAt });
  }

  async function sync() {
    let read;
    if (token) {
      try {
        read = await readAll({ limit: 100, syncToken: token });
      } catch (err) {
        if (!/sync.?token/i.test(String(err.message))) throw err;
        log.warn("[feedback-sync] Ashby's sync token expired; reading every scorecard again.");
        byId.clear();
        token = null;
      }
    }
    let full = false;
    if (!read) {
      full = true;
      const createdAfter = now() - keepDays * DAY;
      read = await readAll({ limit: 100, createdAfter });
      coveredFrom = createdAfter;
    }
    for (const f of read.results) keep(f);
    if (read.syncToken) token = read.syncToken;
    const cutoff = now() - keepDays * DAY;
    for (const [id, f] of byId) if (Date.parse(f.submittedAt) < cutoff) byId.delete(id);
    save(full);
    return [...byId.values()];
  }

  restore();

  return {
    // Current scorecards; concurrent callers share one read.
    scorecards() {
      if (!inFlight) inFlight = sync().finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}

module.exports = { createFeedbackSync };
