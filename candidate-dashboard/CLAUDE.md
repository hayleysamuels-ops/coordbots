# CLAUDE.md — Candidate issues dashboard

Context for Claude Code when working in this repo. Keep this file current when
the architecture or conventions change.

## What this is

A dashboard for a recruiting coordinator flagging overdue interview feedback,
interviews needing scheduling, candidates who've submitted availability but
aren't booked yet, interviewers nearing their weekly interview limit,
candidates recently sourced via referral/agency, and today's onsite (panel/
final-round) interviews, plus a "Stale Candidates" section that pulls out
whichever candidate-facing flags have gone far enough past the normal
thresholds to look abandoned rather than just freshly overdue. A button
below the Onsite Interviews Today section links out to Ashby's own Active
Referrals report — that used to be computed in-app (a bounded full-scan-once
+ incremental-sync design in `src/referralCache.js`, since removed; see git
history if it's ever worth reviving), but there's no reason to re-derive in
this app what Ashby already reports on natively. Full behaviour is in
`README.md`, including a correction to an earlier (wrong) claim that Ashby
couldn't represent "availability submitted" at all — see § Correction there
before touching scheduling-status logic. Two flags were scoped out —
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

Background poll (not webhooks — a dashboard just needs current state), one
refresh cycle: `issues.js` refreshes every `REFRESH_INTERVAL_MINUTES` by
calling `ashby.listIssues()` and `ashby.listRecentSourced()` in parallel —
the seven sections (Feedback Overdue, Needs Scheduling, Availability
Submitted, Stale Candidates, Interviewer Weekly Limits, Recently Sourced,
Onsite Interviews Today).

`issues.js`'s `getSnapshot()` serves this as one payload for
`GET /api/issues` (see `server.js`), with `lastUpdated`/`lastError`. The
frontend (`public/app.js`) polls that one endpoint every 60s and renders a
per-section "Updated Xm ago" from that timestamp — it never hits Ashby
directly.

`ashby.listIssues()` is **schedule-driven, not a full active-application
scan**: it paginates `interviewSchedule.list` for the last
`SCHEDULE_LOOKBACK_DAYS` (30) days, then calls `application.info` only for
the applications those schedules reference — not every Active application
org-wide. This was a deliberate fix after discovering the org has 31,000+
Active applications (almost all untouched in Application Review) and 700+
interview schedules just in a 60-day window; a full scan took minutes per
refresh. See `README.md` § Scope for the tradeoff this introduces.

`ashby.listRecentSourced()` is the other exception to schedule-driven — it
hits `application.list` directly, but bounded to `createdAfter` = the last
`SOURCED_LOOKBACK_DAYS` (3) days (~100 records, ~2 pages), and does NOT apply
the Active-only / past-Application-Review filter (a freshly sourced candidate
is normally still in Application Review and any status).

- `src/index.js` — entry point; starts `issues.start()` and the HTTP server.
- `src/config.js` — env parsing.
- `src/concurrency.js` — `mapWithConcurrency`, bounds parallel
  `application.info` / `user.interviewerSettings` calls in `ashby.js`.
- `src/dismissals.js` — persisted (`<DATA_DIR>/dismissals.json`) store of
  dismissed cards keyed `candidate:<id>` / `interviewer:<id>`; "today" scope
  expires at next local midnight (pruned lazily on read), "forever" persists.
- `src/ashby.js` — paginated Ashby client (`fetchAllPages` walks
  `moreDataAvailable`/`nextCursor`) + flag computation for Feedback Overdue,
  Needs Scheduling, Availability Submitted, Stale Candidates, Interviewer
  Weekly Limits, Recently Sourced, and Onsite Interviews Today, plus
  `listDepartments()` for the department filter. The Active-only /
  past-Application-Review filter applies to Feedback Overdue / Needs
  Scheduling / Availability Submitted only — Interviewer Weekly Limits counts
  interviews regardless of candidate status, and Recently Sourced shows all
  statuses.
- `src/issues.js` — orchestrator + cache for the seven sections; applies
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
- **A candidate appears in at most ONE of feedbackOverdue/needsScheduling/
  availabilitySubmitted/onsiteToday/staleCandidates, globally, never
  several at once.** `keepMostRecentPerCandidate()` in `ashby.js`'s
  `listIssues()` pools every candidate-linked entry across all four
  event-driven lists (tagged with a comparable `eventTime` — `endTime` for
  feedback, `createdAt` for scheduling, `submittedAt` for availability,
  `startTime` for onsite — plus a `__section` marker) and keeps only the
  single most recent one per `candidateId`; everything else for that
  candidate is dropped entirely this refresh, not just hidden from one
  section. This runs BEFORE the stale-exclusion step below, so a stale old
  entry that's no longer a candidate's most recent event won't appear in
  Stale Candidates either — it's genuinely superseded, not just relocated.
  Real example this fixed: a candidate with an old unsubmitted-feedback
  interview AND a newer onsite round scheduled today showed up in both
  Feedback Overdue and Onsite Interviews Today; now only the onsite entry
  survives. If you add a new event-driven candidate section, tag its
  entries with `eventTime`/`__section` and fold them into the `winners`
  pool too, or it won't participate in this dedup.
- **Stale Candidates is exclusive at the candidate (applicationId) level, not
  the entry level.** If ANY of a candidate's (post-dedup) entries crosses
  `STALE_FEEDBACK_HOURS` / `STALE_SCHEDULING_HOURS`, that whole candidate is
  excluded from `feedbackOverdue`/`needsScheduling`. See `staleApplicationIds`
  in `ashby.js`'s `listIssues()`. Don't narrow this back to per-entry
  filtering; that was the bug this fixed — a candidate showing up both in
  Stale Candidates and a regular column.
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
- **`issues.js` guards against overlapping refreshes** via its own
  `refreshPromise` — a refresh triggered while one is already in flight
  (interval tick, or the manual "Refresh now" button) just attaches to the
  in-flight promise instead of starting a new one. Don't remove this guard.
- **The department/job filter (`public/app.js`) is multi-select, mode-
  switchable, and purely client-side, filtering the already-fetched
  snapshot in memory — not a new API call.** `filterMode` is `"department"`
  or `"job"`; only ONE mode's Set actually filters at a time —
  `selectedDepartmentIds`/`selectedJobIds` are two independent Sets (empty =
  no filter), each remembering its own selection across mode switches.
  `activeSelection()` returns `{ ids, key }` for whichever mode is live;
  `filterByEntity()` does `items.filter(i => ids.has(i[key]))`, an OR across
  selections. `lastData` caches the last render's payload; checking/
  unchecking a checkbox in `#entity-filter-menu`, or clicking a
  `.filter-mode-btn`, just calls `render(lastData)` again. The menu mirrors
  the existing per-card dismiss-menu's fixed-position/anchor-to-button
  pattern, but deliberately does NOT close on selection (unlike
  dismiss-menu) since picking several options requires staying open — it
  closes only on the reset button, outside-click, or scroll.
  **Department options come from the server** (`data.departments`, Ashby's
  `department.list`). **Job options are derived client-side** via
  `collectJobs()` from whichever jobs are actually represented across
  `CANDIDATE_SECTION_KEYS`' items in `lastData` — deliberately NOT a
  separate `job.list` call, since that would include every closed/archived
  job org-wide (dozens to hundreds) rather than just the ones with
  candidates currently on screen. `filterByEntity()` is applied to the six
  candidate sections' arrays before each is rendered (`renderColumn`/
  `renderStale`/`renderRecentSourced`/`renderOnsiteToday`) — Interviewer
  Weekly Limits deliberately skips it, since an interviewer isn't tied to one
  department/job. If you add a new candidate-facing section, wrap its render
  call with `filterByEntity(...)` too, add its key to `CANDIDATE_SECTION_KEYS`
  (so it's included when deriving job options), and make sure `ashby.js`
  actually populates `departmentId`/`jobId` on its records (from
  `app.job.departmentId`/`app.job.id`) — neither is automatic.

- **Dismissals are applied at serve time, not refresh time.** `issues.js`
  `getSnapshot()` runs `applyDismissals()` over the cached snapshot on every
  call, so a dismiss takes effect on the next 60s poll (and the dismiss
  endpoint returns the freshly filtered snapshot for an instant update) —
  the background refresh doesn't need to re-run. Don't move filtering into
  `refresh()`; that would delay dismissals by up to `REFRESH_INTERVAL_MINUTES`.
- **Dismiss keys are entity-scoped, not row-scoped.** `candidate:<id>` hides a
  person from all six candidate sections at once;
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
