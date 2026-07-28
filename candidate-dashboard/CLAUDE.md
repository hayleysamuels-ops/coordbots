# CLAUDE.md — Candidate issues dashboard

Context for Claude Code when working in this repo. Keep this file current when
the architecture or conventions change.

## What this is

A dashboard for a recruiting coordinator flagging overdue interview feedback,
interviews needing scheduling, candidates who've submitted availability but
aren't booked yet, interviewers nearing their weekly interview limit,
candidates recently sourced via referral/agency, and every active referral
org-wide by pipeline stage, plus a "Stale Candidates" section that pulls out
whichever candidate-facing flags have gone far enough past the normal
thresholds to look abandoned rather than just freshly overdue. Full
behaviour is in `README.md`, including a correction to an earlier (wrong)
claim that Ashby couldn't represent "availability submitted" at all — see
§ Correction there before touching scheduling-status logic. Active Referrals
was originally a full active-application scan on every refresh (~12 minutes
measured on this org, 31,669 applications) — it's now `src/referralCache.js`:
a `REFERRAL_LOOKBACK_DAYS`-bounded full scan once (cuts 317 pages to 34),
then incremental via `syncToken`, persisted to disk, checkpointed per-page
so a restart mid-scan resumes instead of restarting, on its own independent
refresh timer. See README § Active Referrals before assuming any Ashby call
in this codebase is cheap, and before touching `referralCache.js`.
Two flags were scoped out —
"Awaiting Reply" (needs Gmail) and "declined meetings" (needs Google
Calendar RSVP data — a `Cancelled` schedule has no reason code) —
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

Background poll (not webhooks — a dashboard just needs current state), and
**two independent refresh cycles**, not one:

1. `issues.js` refreshes every `REFRESH_INTERVAL_MINUTES` by calling
   `ashby.listIssues()` and `ashby.listRecentSourced()` in parallel — the six
   "main" sections (Feedback Overdue, Needs Scheduling, Availability
   Submitted, Stale Candidates, Interviewer Weekly Limits, Recently Sourced).
2. `referralCache.js` refreshes independently on its own
   `ACTIVE_REFERRALS_REFRESH_INTERVAL_MINUTES` timer — Active Referrals only.

`issues.js`'s `getSnapshot()` merges both into one payload for
`GET /api/issues` (see `server.js`), with **separate timestamps**:
`lastUpdated`/`lastError` for the seven main sections, `activeReferralsUpdated`/
`activeReferralsError` for Active Referrals. The frontend (`public/app.js`)
polls that one endpoint every 60s and renders a per-section "Updated Xm ago"
using whichever timestamp applies to that section — it never hits Ashby
directly, and never needs to know these are two different refresh cycles
beyond reading the right timestamp field.

This split exists because Active Referrals' full scan (~12 minutes measured
on this org, unbounded) would otherwise have delayed the other seven sections
on every refresh — it used to run inside `issues.js`'s own `Promise.all`,
which meant nothing updated until the slowest call finished. See README
§ Active Referrals for the full history and design.

`ashby.listIssues()` is **schedule-driven, not a full active-application
scan**: it paginates `interviewSchedule.list` for the last
`SCHEDULE_LOOKBACK_DAYS` (30) days, then calls `application.info` only for
the applications those schedules reference — not every Active application
org-wide. This was a deliberate fix after discovering the org has 31,000+
Active applications (almost all untouched in Application Review, confirmed
via a full Active Referrals scan) and 700+ interview schedules just in a
60-day window; a full scan took minutes per refresh. See `README.md` § Scope
for the tradeoff this introduces.

`ashby.listRecentSourced()` is the other exception to schedule-driven — it
hits `application.list` directly, but bounded to `createdAfter` = the last
`SOURCED_LOOKBACK_DAYS` (3) days (~100 records, ~2 pages), and does NOT apply
the Active-only / past-Application-Review filter (a freshly sourced candidate
is normally still in Application Review and any status).

- `src/index.js` — entry point; starts both `issues.start()` (which itself
  calls `referralCache.start()` — see below) and the HTTP server.
- `src/config.js` — env parsing.
- `src/concurrency.js` — `mapWithConcurrency`, bounds parallel
  `application.info` / `user.interviewerSettings` calls in `ashby.js`.
- `src/dismissals.js` — persisted (`<DATA_DIR>/dismissals.json`) store of
  dismissed cards keyed `candidate:<id>` / `interviewer:<id>`; "today" scope
  expires at next local midnight (pruned lazily on read), "forever" persists.
- `src/ashby.js` — paginated Ashby client (`fetchAllPages` walks
  `moreDataAvailable`/`nextCursor`, and captures `syncToken` off the final
  page into an optional `stats` object) + flag computation for Feedback
  Overdue, Needs Scheduling, Availability Submitted, Stale Candidates,
  Interviewer Weekly Limits, and Recently Sourced, plus `listDepartments()`
  for the department filter dropdown. The Active-only /
  past-Application-Review filter applies to Feedback Overdue / Needs
  Scheduling / Availability Submitted only — Interviewer Weekly Limits counts
  interviews regardless of candidate status, and Recently Sourced shows all
  statuses. Exports `fetchAllPages`/`classifySource`/`profileUrl` for
  `referralCache.js` to reuse — don't duplicate these there.
- `src/referralCache.js` — Active Referrals' `REFERRAL_LOOKBACK_DAYS`-bounded
  full-scan-once / incremental-after logic, persisted cache
  (`<DATA_DIR>/referral-cache.json`), per-page scan checkpointing
  (`<DATA_DIR>/referral-scan-checkpoint.json`), and independent refresh
  timer. `start()` is called from `issues.js`'s `start()`, not `index.js`
  directly, so `issues.start()` remains the single entry point for "start
  all background refresh loops."
- `src/issues.js` — orchestrator + cache for the seven main sections; merges in
  Active Referrals from `referralCache.js` at serve time; also applies
  dismissals at serve time (see below).
- `public/` — plain HTML/CSS/JS dashboard, no framework.

## Key design facts (don't "fix" these — they're intentional)

- **"Onsite" in Onsite Interviews Today is a naming-convention approximation,
  not a real Ashby signal.** Checked interviewEvents, interview.info,
  interviewStage.info, and all 38 org custom fields — none carry a
  location/format field anywhere. `listOnsiteToday()` in `src/ashby.js`
  instead matches on the interview STAGE title containing "panel" or "final"
  (case-insensitive, `ONSITE_STAGE_TITLE_PATTERN`), per explicit product
  decision (confirmed live: this org really does have a "Panel Round" stage).
  If a future org's stage names don't follow this convention, this section
  will silently show nothing rather than error — check the stage titles via
  `interviewStage.info` before assuming the pattern is broken. "Today" is a
  UTC calendar day (`isTodayUTC`), the same tradeoff `countInterviewsThisWeek`
  already makes for weekly limits — display times still render in the
  browser's local zone client-side.
- **`interviewSchedule.status` is a real, granular state machine — treat it
  that way, not as a coarse 3-value enum.** Confirmed values in this org:
  `NeedsScheduling` → `WaitingOnCandidateAvailability` /
  `WaitingOnCandidateBooking` → `CandidateAvailabilitySubmitted` →
  `Scheduled` → `WaitingOnFeedback` → `Complete` (or `Cancelled` at any
  point). "Needs Scheduling" (`NeedsScheduling`) and "Availability Submitted"
  (`CandidateAvailabilitySubmitted`) are genuinely distinct, mutually
  exclusive states — a candidate is in exactly one at a time, never both. An
  earlier version of this file (and the README) claimed the opposite based on
  too small a sample; if you're about to add scheduling-status logic, pull a
  large enough live sample first (100+ schedules across a few weeks) rather
  than trusting a small one — see README § Correction for what that mistake
  looked like.
- A failed refresh keeps serving the last good snapshot rather than clearing
  the dashboard; see `lastError` in `issues.js`.
- Interview-schedule lookback is a hardcoded 30 days
  (`SCHEDULE_LOOKBACK_DAYS` in `ashby.js`), not configurable via env — chosen
  for refresh-cycle speed on a large org, not because anything older is
  meaningless. Raise it if you need to catch very old stragglers and can
  tolerate a slower refresh.
- Application Review-stage applications are deliberately excluded from
  Feedback Overdue / Needs Scheduling / Availability Submitted (see
  `isPreInterview` in `ashby.js`) — no interview activity is expected at
  that stage.
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
- **Availability Submitted is not threshold-gated on the server** — unlike
  Feedback Overdue/Needs Scheduling (which only include entries past their
  `_HOURS` threshold), every `CandidateAvailabilitySubmitted` schedule is
  included regardless of age. `AVAILABILITY_SUBMITTED_ALERT_HOURS` only
  affects the frontend's severity color via the shared `severity()` ratio
  function in `app.js` — it is not a filter. `submittedAt` is the schedule's
  `updatedAt`, not `createdAt`, since `updatedAt` is when the status last
  transitioned (i.e. when the submission landed), while `createdAt` is when
  scheduling was first initiated.
- **Recently Sourced classifies by `source.sourceType.title` substring**
  (`classifySource` in `ashby.js`): "referr" → Referral, "agenc" → Agency.
  Substring (not exact/id) match so wording variants still resolve. The org's
  real source-type titles were confirmed via `source.list`: Referral,
  Agencies, Sourced, Inbound, Internal, Prospecting, Third-party boards — only
  the first two are surfaced. `application.list` already carries candidate,
  job, status, and source, so no per-application lookup is needed. All
  statuses are shown; only Active rows get a profile link (the URL's "active"
  segment is unverified for other statuses).
- **Active Referrals (`referralCache.js`) is full-scan-once, then
  incremental, never a full scan on every refresh.** The original
  implementation (`listActiveReferrals` in `ashby.js`, since removed) really
  was a full scan every time — status: "Active", no `createdAfter` bound,
  every page — the exact cost `listIssues()`'s schedule-driven design was
  built to avoid, reintroduced here as an explicit product decision (user
  chose it over the bounded/cheap alternative — see git history). Measured
  cost of that unbounded full scan, instrumented: 317 pages, 740.0s network,
  39ms client-side filtering, 31,669 applications scanned, 372 referrals
  found — essentially all the cost is pagination/network, none of it is
  per-application processing. `referralCache.js` now does that scan only
  once (or again if an incremental sync's token gets rejected), capturing
  Ashby's `syncToken` from the final page, and uses it for every subsequent
  refresh instead. Includes Application-Review-stage candidates on purpose
  (unlike the other sections) since showing every stage, including the
  first one, is the point.
- **`REFERRAL_LOOKBACK_DAYS` bounds only the full scan, via `createdAfter`
  — never the incremental sync.** Measured on this org: 90 days cuts 317
  pages to 34 (~89% fewer, ~10x faster: 80.7s vs 740s network). A referral
  whose application predates the window and never otherwise triggers a page
  fetch won't appear — that's the accepted tradeoff, not a bug. Don't add
  this bound to `incrementalSync()`'s request: a changed application must
  show up in the diff regardless of age, or an old-but-newly-Active referral
  would never get added to the cache.
- **Full scans are resumable, checkpointed per-page to
  `<DATA_DIR>/referral-scan-checkpoint.json`** (separate file from the main
  `referral-cache.json` — the main cache only ever holds a complete,
  servable result, never a partial one). `loadCheckpoint()` compares against
  `config.referralLookbackDays` (the stable *days* number), not a freshly
  recomputed `createdAfter` timestamp — the timestamp is "now minus N days"
  computed fresh at scan start, so it differs on every run even when the
  config hasn't changed; comparing timestamps directly would make every
  checkpoint look stale and never resume (this was caught before shipping,
  not after). When resuming, the checkpoint's own stored `createdAfter` is
  reused verbatim (not recomputed) so pagination continues under the exact
  filter its cursor was issued for. Verified live: an interrupted scan
  (killed at 24/34 pages) resumed and finished the remaining 10 pages in
  19.4s rather than repeating all 34; a checkpoint saved under a 90-day
  window was correctly discarded (not resumed) when restarted with
  `REFERRAL_LOOKBACK_DAYS=30`.
- **Incremental sync sends no `status` filter, on purpose.** `referralCache.js`'s
  `incrementalSync()` calls `application.list` with just `{ syncToken, limit
  }` — Ashby's syncToken filtering semantics aren't documented, and applying
  `status: "Active"` server-side on an incremental call risks silently
  hiding exactly the transition that matters: an application leaving Active
  status. All qualification filtering (`qualifies()` in `referralCache.js`)
  happens client-side on every changed record instead, so a record that no
  longer qualifies gets evicted from the persisted cache rather than
  silently never appearing in a filtered response. Don't add a `status`
  filter to the incremental call without re-verifying this against live data
  first.
- **The persisted cache (`referral-cache.json`) IS the Active Referrals
  result set**, not an intermediate structure — `getSnapshot()` in
  `referralCache.js` just reads it directly (sorted by `stageOrder`). An
  incremental sync's merge step adds/updates a record when its application
  now qualifies, and deletes the record when it no longer does. There's no
  separate "cache of sources" and "list of results" to keep in sync with
  each other.
- **`toRecord()`'s output shape changing requires bumping
  `RECORD_SCHEMA_VERSION`, or existing cached records silently keep their old
  shape forever.** This actually happened: adding `departmentId` to
  `toRecord()` didn't backfill any of the 12 already-cached records — an
  incremental sync only touches applications that *changed*, so records that
  hadn't changed since before the edit were missing the key entirely (not
  even `null`), confirmed live via the real `/api/issues` response before the
  fix. `load()` now compares the cache file's `schemaVersion` against
  `RECORD_SCHEMA_VERSION` and discards + rebuilds on any mismatch, and
  `save()` always writes the current version. When you next change
  `toRecord()`'s shape, bump the constant — don't rely on incremental sync to
  eventually catch every record.
- **Both `issues.js` and `referralCache.js` guard against overlapping
  refreshes** via their own `refreshPromise` — this was a real bug found in
  production testing before the split existed: Active Referrals' full scan
  took longer than `REFRESH_INTERVAL_MINUTES`, so without a guard the
  interval timer kicked off a second concurrent refresh before the first
  finished, then a third, etc., each pileup competing for the same
  rate-limited Ashby API and making every one of them slower. A refresh
  triggered while one is already in flight (interval tick, or the manual
  "Refresh now" button, which only triggers `issues.js`'s refresh, not
  `referralCache.js`'s) just attaches to the in-flight promise instead of
  starting a new one. Don't remove either guard.
- **Per-section timestamps reveal the two-cycle split, don't hide it.**
  `public/app.js`'s `SECTION_TIMESTAMP_KEYS` lists the seven sections that
  share `data.lastUpdated`/`lastError`; Active Referrals is rendered
  separately using `data.activeReferralsUpdated`/`activeReferralsError`. If
  you add a new main-cycle section, add its key to
  `SECTION_TIMESTAMP_KEYS` — it's not automatic.
- **The department filter (`public/app.js`) is multi-select and purely
  client-side, filtering the already-fetched snapshot in memory — not a new
  API call.** Selection state is `selectedDepartmentIds` (a `Set` of
  department IDs; empty = no filter/"All departments"), not a single string
  — `filterByDepartment()` does `items.filter(i =>
  selectedDepartmentIds.has(i.departmentId))`, an OR across selections.
  `lastData` caches the last render's payload; checking/unchecking a
  checkbox in `#department-filter-menu` just calls `render(lastData)` again
  (see the delegated `change` listener). The menu itself mirrors the
  existing per-card dismiss-menu's fixed-position/anchor-to-button pattern,
  but deliberately does NOT close on selection (unlike dismiss-menu) since
  picking several departments requires staying open — it closes only on the
  reset button, outside-click, or scroll. `filterByDepartment()` is applied
  to the seven candidate sections' arrays before each is rendered
  (`renderColumn`/`renderStale`/`renderRecentSourced`/`renderActiveReferrals`/
  `renderOnsiteToday`)
  — Interviewer Weekly Limits deliberately skips it, since an interviewer
  isn't tied to one department. If you add a new candidate-facing section,
  wrap its render call with `filterByDepartment(...)` too, and make sure
  `ashby.js`/`referralCache.js` actually populate `departmentId` on its
  records (from `app.job.departmentId`) — it's not automatic either.

- **Dismissals are applied at serve time, not refresh time.** `issues.js`
  `getSnapshot()` runs `applyDismissals()` over the cached snapshot on every
  call, so a dismiss takes effect on the next 60s poll (and the dismiss
  endpoint returns the freshly filtered snapshot for an instant update) —
  the background refresh doesn't need to re-run. Don't move filtering into
  `refresh()`; that would delay dismissals by up to `REFRESH_INTERVAL_MINUTES`.
- **Dismiss keys are entity-scoped, not row-scoped.** `candidate:<id>` hides a
  person from all seven candidate sections at once (including Active
  Referrals, even though it refreshes independently — `applyDismissals()`
  filters it too, after `getSnapshot()` merges it in from `referralCache.js`);
  `interviewer:<id>` hides an interviewer from the limits section. There's an
  `/api/undismiss` endpoint but no UI button for it yet (documented in
  README). If you add a new candidate-facing section, add it to the
  `keepCandidate` filter list in `issues.js`'s `applyDismissals()` — it's not
  automatic.

## Conventions

- Style: `"use strict"`, CommonJS modules, 2-space indent, double quotes.
- Log with a `[module]` prefix, e.g. `console.log("[issues] ...")`.
- Keep secrets in `.env` only. **Never commit `.env`** — it's gitignored.
- When adding config, add it to `src/config.js` *and* document it in
  `.env.example` and the README table.
- **`public/style.css` ports design tokens from the "Carrara Design
  System"** (colors, PT Serif/Manrope type, spacing/radii/shadows) —
  copied in as plain CSS custom properties rather than linked, since
  there's no build step to fetch an external stylesheet at request time.
  Severity colors (`--good`/`--warning`/`--serious`/`--critical`) are a
  derived mapping onto that palette (moss → lemon → ember →
  ember-press), not official Carrara semantic tokens — the source system
  only defines brand/text/surface roles, not alert-severity ones. If the
  design system changes, re-pull the relevant `tokens/*.css` files rather
  than hand-tweaking colors here.

## Guardrails

- Do not commit `.env`, `node_modules/`, or `*.log` (already in `.gitignore`).
