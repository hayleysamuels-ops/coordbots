# CLAUDE.md — Candidate issues dashboard

Context for Claude Code when working in this repo. Keep this file current when
the architecture or conventions change.

## What this is

A dashboard for a recruiting coordinator flagging overdue interview feedback,
interviews needing scheduling, interviewers nearing their weekly interview
limit, and candidates recently sourced via referral/agency, plus a "Stale
Candidates" section that pulls out whichever candidate-facing flags have gone
far enough past the normal thresholds to look abandoned rather than just
freshly overdue. Full behaviour and the "Needs Scheduling" caveat are in
`README.md`. Two flags were scoped out —
"Awaiting Reply" (needs Gmail) and "declined meetings" (needs Google
Calendar RSVP data, since Ashby has no reason code on cancelled schedules) —
both dropped to keep this Ashby-only. Don't re-add either without a fresh
product decision on the integration tradeoff.

## Run / dev

```bash
npm install
npm start              # node src/index.js
npm run dev             # same, with --watch
```

No build step, no test framework, no linter. Node 18+, CommonJS (`require`).

## Architecture

Background poll (not webhooks — a dashboard just needs current state):
`issues.js` refreshes every `REFRESH_INTERVAL_MINUTES` by calling
`ashby.listIssues()` and `ashby.listRecentSourced()` in parallel, caches the
combined snapshot, and `server.js` serves it at `GET /api/issues`. The
frontend (`public/app.js`) polls that endpoint every 60s — it never hits
Ashby directly.

`ashby.listIssues()` is **schedule-driven, not a full active-application
scan**: it paginates `interviewSchedule.list` for the last
`SCHEDULE_LOOKBACK_DAYS` (30) days, then calls `application.info` only for
the applications those schedules reference — not every Active application
org-wide. This was a deliberate fix after discovering the org has 1,600+
Active applications (almost all untouched in Application Review) and 700+
interview schedules just in a 60-day window; a full scan took minutes per
refresh. See `README.md` § Scope for the tradeoff this introduces.

`ashby.listRecentSourced()` is the one exception to schedule-driven — it hits
`application.list` directly, but bounded to `createdAfter` = the last
`SOURCED_LOOKBACK_DAYS` (3) days (~100 records, ~2 pages), and does NOT apply
the Active-only / past-Application-Review filter (a freshly sourced candidate
is normally still in Application Review and any status).

- `src/index.js` — entry point.
- `src/config.js` — env parsing.
- `src/concurrency.js` — `mapWithConcurrency`, bounds parallel
  `application.info` / `user.interviewerSettings` calls in `ashby.js`.
- `src/dismissals.js` — persisted (`<DATA_DIR>/dismissals.json`) store of
  dismissed cards keyed `candidate:<id>` / `interviewer:<id>`; "today" scope
  expires at next local midnight (pruned lazily on read), "forever" persists.
- `src/ashby.js` — paginated Ashby client (`fetchAllPages` walks
  `moreDataAvailable`/`nextCursor`) + flag computation for Feedback Overdue,
  Needs Scheduling, Stale Candidates, Interviewer Weekly Limits, and Recently
  Sourced. The Active-only / past-Application-Review filter applies to the
  first three only — Interviewer Weekly Limits counts interviews regardless
  of candidate status, and Recently Sourced shows all statuses.
- `src/issues.js` — orchestrator + cache; also applies dismissals at serve
  time (see below).
- `public/` — plain HTML/CSS/JS dashboard, no framework.

## Key design facts (don't "fix" these — they're intentional)

- **"Needs Scheduling" is not "availability submitted."** Ashby's API can't
  distinguish those two states — `interviewSchedule.status: "NeedsScheduling"`
  covers both "candidate hasn't responded" and "candidate responded, nobody's
  booked it yet." Don't relabel this column to imply otherwise without a real
  data source (e.g. a custom field) backing it.
- A failed refresh keeps serving the last good snapshot rather than clearing
  the dashboard; see `lastError` in `issues.js`.
- Interview-schedule lookback is a hardcoded 30 days
  (`SCHEDULE_LOOKBACK_DAYS` in `ashby.js`), not configurable via env — chosen
  for refresh-cycle speed on a large org, not because anything older is
  meaningless. Raise it if you need to catch very old stragglers and can
  tolerate a slower refresh.
- Application Review-stage applications are deliberately excluded from all
  three sections (see `isPreInterview` in `ashby.js`) — no interview activity
  is expected at that stage.
- **Stale Candidates is exclusive at the candidate (applicationId) level, not
  the entry level.** If ANY of a candidate's entries crosses
  `STALE_FEEDBACK_HOURS` / `STALE_SCHEDULING_HOURS`, that whole candidate is
  excluded from `feedbackOverdue`/`needsScheduling` — including their other,
  non-stale entries (e.g. a second interview event for the same candidate
  that's individually below the stale bar). See `staleApplicationIds` in
  `ashby.js`'s `listIssues()`. Don't narrow this back to per-entry filtering;
  that was the bug this fixed — a candidate showing up both in Stale
  Candidates and a regular column.
- **Interviewer Weekly Limits ignores application status entirely.** Load is
  computed straight from `interviewSchedule.list` events (`countInterviewsThisWeek`
  in `ashby.js`) without going through `fetchApplicationSummaries` — an
  interviewer's calendar load is real regardless of whether their candidate
  later gets archived or hired. Only interviewers with a non-null
  `weeklyLimit` from `user.interviewerSettings` are ever flagged; there's one
  API call per unique interviewer seen this week, bounded by
  `mapWithConcurrency`.
- The "current week" for Interviewer Weekly Limits is Monday 00:00 UTC
  through the following Monday (`startOfWeekUTC` in `ashby.js`) — not the
  server's local timezone, not Ashby's org timezone setting (unverified
  whether Ashby even has one exposed via the API).
- **Recently Sourced classifies by `source.sourceType.title` substring**
  (`classifySource` in `ashby.js`): "referr" → Referral, "agenc" → Agency.
  Substring (not exact/id) match so wording variants still resolve. The org's
  real source-type titles were confirmed via `source.list`: Referral,
  Agencies, Sourced, Inbound, Internal, Prospecting, Third-party boards — only
  the first two are surfaced. `application.list` already carries candidate,
  job, status, and source, so no per-application lookup is needed. All
  statuses are shown; only Active rows get a profile link (the URL's "active"
  segment is unverified for other statuses).

- **Dismissals are applied at serve time, not refresh time.** `issues.js`
  `getSnapshot()` runs `applyDismissals()` over the cached snapshot on every
  call, so a dismiss takes effect on the next 60s poll (and the dismiss
  endpoint returns the freshly filtered snapshot for an instant update) —
  the background refresh doesn't need to re-run. Don't move filtering into
  `refresh()`; that would delay dismissals by up to `REFRESH_INTERVAL_MINUTES`.
- **Dismiss keys are entity-scoped, not row-scoped.** `candidate:<id>` hides a
  person from all four candidate sections at once; `interviewer:<id>` hides an
  interviewer from the limits section. There's an `/api/undismiss` endpoint but
  no UI button for it yet (documented in README).

## Conventions

- Style: `"use strict"`, CommonJS modules, 2-space indent, double quotes.
- Log with a `[module]` prefix, e.g. `console.log("[issues] ...")`.
- Keep secrets in `.env` only. **Never commit `.env`** — it's gitignored.
- When adding config, add it to `src/config.js` *and* document it in
  `.env.example` and the README table.

## Guardrails

- Do not commit `.env`, `node_modules/`, or `*.log` (already in `.gitignore`).
