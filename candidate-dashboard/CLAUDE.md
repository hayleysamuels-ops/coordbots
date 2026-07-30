# CLAUDE.md — Candidate issues dashboard

Context for Claude Code when working in this repo. Keep this file current when
the architecture or conventions change.

## What this is

A dashboard for a recruiting coordinator flagging overdue interview feedback,
interviews needing scheduling, candidates who've submitted availability but
aren't booked yet, interviewers nearing their weekly interview limit (and
their training progress — shadow/reverse-shadow), candidates recently
sourced via referral/agency, today's onsite (final-round/executive)
interviews, and interviews rescheduled more than a couple times, plus a
"Stale Candidates" section that pulls out whichever candidate-facing flags
have gone far enough past the normal thresholds to look abandoned rather
than just freshly overdue. A button
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
calling `ashby.listIssues()`, `ashby.listRecentSourced()`, and
`ashby.listInterviewerTraining()` in parallel — the nine sections
(Feedback Overdue, Needs Scheduling, Availability Submitted, Stale
Candidates, Interviewer Weekly Limits, Recently Sourced, Onsite Interviews
Today, Interviewer Training, Rescheduled Interviews). Rescheduled
Interviews is computed inside `ashby.listIssues()` itself (it reuses that
same `interviewSchedule.list` fetch), not a separate top-level call.

`issues.js`'s `getSnapshot()` serves this as one payload for
`GET /api/issues` (see `server.js`), with `lastUpdated`/`lastError`. The
frontend (`public/app.js`) polls that one endpoint every 60s and renders a
per-section "Updated Xm ago" from that timestamp — it never hits Ashby
directly.

`ashby.listIssues()` is **schedule-driven, not a full active-application
scan**: it paginates `interviewSchedule.list` for the last
`config.scheduleLookbackDays` (`SCHEDULE_LOOKBACK_DAYS`, default 30) days,
then calls `application.info` only for
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
  Weekly Limits, Recently Sourced, Onsite Interviews Today, Interviewer
  Training, and Rescheduled Interviews, plus `listDepartments()` for the
  department filter. The Active-only / past-Application-Review filter
  applies to Feedback Overdue / Needs Scheduling / Availability Submitted
  only — Interviewer Weekly Limits and Interviewer Training count
  regardless of candidate status (they aren't candidate-driven at all), and
  Recently Sourced shows all statuses.
- `src/rescheduleTracking.js` — persisted (`<DATA_DIR>/reschedule-
  tracking.json`) reschedule counter per interview event id; see the key
  design fact below.
- `src/issues.js` — orchestrator + cache for the nine sections; applies
  dismissals at serve time (see below).
- `public/` — plain HTML/CSS/JS dashboard, no framework.
- `scripts/check-ashby-compatibility.js` — standalone, read-only pre-
  onboarding diagnostic for a new client's Ashby org (see § client-specific
  assumptions below and the script's own header comment). Zero dependency
  on `src/` — duplicates the minimal fetch/pagination/concurrency helpers
  it needs so it stays runnable before a client even has a `.env` set up.

## Key design facts (don't "fix" these — they're intentional)

- **The page is two tabs (Dashboard / Interviewer Info), implemented as
  plain DOM show/hide, not a router.** `index.html` has two sibling
  `.tab-panel` divs (`#tab-dashboard`, `#tab-interviewers`) and two
  `.tab-btn` buttons with a `data-tab` attribute; `app.js`'s click handler
  is generic over the convention `id="tab-<data-tab value>"`, so a third
  tab needs only a matching button+panel pair, no JS changes. Both panels'
  cards render on **every** poll regardless of which is visible — the
  `hidden` attribute is purely cosmetic, so switching tabs is instant and
  never shows stale content. Interviewer Weekly Limits and Interviewer
  Training live on the Interviewer Info tab specifically because neither is
  tied to a candidate/department/job/recruiter/coordinator, so they were
  moved out of the candidate-facing Dashboard tab to reduce clutter there —
  don't move them back without re-checking whether that reasoning still
  holds. `.tab-panel` has NO conflicting `display` rule of its own — if you
  ever add one, remember `.tab-panel[hidden] { display: none; }` needs to
  win the cascade over it (author rules beat the browser's `[hidden]`
  default at equal specificity only if the `[hidden]` override is also an
  author rule — this exact class of bug already happened once with
  `.ashby-report-link`, see below).
- **Interviewer Training (`listInterviewerTraining()` in `ashby.js`) uses
  real, structured Ashby fields (`Shadow`/`ReverseShadow` via
  `interviewerPool.list`'s `trainingPath.trainingStages[].interviewerRole`)
  — unlike Onsite Interviews Today below, this is NOT a naming-convention
  guess.** One call to `interviewerPool.list` (paginated but small — 22
  pools on this org), then one `interviewerPool.info` call per pool with
  `trainingPath.enabled === true` (bounded, concurrency-limited via
  `mapWithConcurrency`, same shape as `listInterviewerLimits`'s per-user
  calls) — each response's `trainees[]` already carries
  `currentProgress.trainingPathStageId`, resolved against that SAME
  response's `trainingPath.trainingStages` (no extra lookup). Not tied to
  any candidate/application — entries are interviewer-centric like
  Interviewer Weekly Limits, so `filterByEntity()` (department/job/
  recruiter/coordinator) deliberately skips this section too, and it
  reuses the same `interviewer:<userId>` dismiss keyspace as Interviewer
  Weekly Limits (dismissing an interviewer hides them from both). Sorted
  paused-first (blocked, needs a nudge), then alphabetical — not by
  progress-remaining, so the list doesn't reshuffle every refresh as
  trainees complete interviews.
- **Rescheduled Interviews requires this app to track its own history —
  Ashby's API genuinely has none.** Checked `interviewSchedule`/
  `interviewEvent` fields, `application.listHistory` (stage transitions
  only), and `extraData` across a live sample of 131 events: nothing
  records a previous `startTime` or a reschedule count anywhere.
  `src/rescheduleTracking.js` persists `{ lastKnownStartTime,
  rescheduleCount }` per interview event id to `<DATA_DIR>/reschedule-
  tracking.json`, incrementing the counter when `startTime` differs from
  what was last seen; `trackAndGetCounts()` is called once per
  `listIssues()` refresh with every event in the lookback window
  (regardless of candidate status — reschedule count is a property of the
  event, not the candidate), and events no longer seen are pruned so the
  file doesn't grow forever. **Counting starts at zero the first time a
  given event is ever observed** — it can only catch reschedules from then
  on, never ones that happened before this feature existed; don't present
  a "3 reschedules" flag as if it were the interview's whole history.
  `config.rescheduleCountThreshold` (`RESCHEDULE_COUNT_THRESHOLD`, default
  2) is the count that must be *exceeded* to flag, i.e. default flags the
  3rd reschedule onward, matching "more than 2 times." **A real bug caught
  in testing**: the first version only set the `save()`-triggering
  `changed` flag when an *existing* event's time changed, not when a
  *new* event was first added to the store — meaning the tracking file
  was never created on a fresh install (verified live: ran a full refresh,
  confirmed the file genuinely didn't exist afterward). Fixed by also
  setting `changed = true` on first-seen events; don't regress this, or a
  server restarted before any reschedule occurs loses its whole baseline
  and starts over. Deliberately NOT part of `keepMostRecentPerCandidate()`'s
  dedup pool (see above) — it's an orthogonal fact about an event's history,
  not a mutually-exclusive candidate state, so a candidate can appear here
  AND in one of the four deduped sections at the same time.
- **"Onsite" in Onsite Interviews Today is a naming-convention approximation,
  not a real Ashby signal — this is CLIENT-SPECIFIC, not universal.** Checked
  interviewEvents, interview.info, interviewStage.info, and all 38 org
  custom fields — none carry a location/format field anywhere, in any Ashby
  org, structurally. `listOnsiteToday()` in `src/ashby.js` instead matches
  on the interview STAGE title against `config.onsiteStageKeywords`
  (`ONSITE_STAGE_KEYWORDS` env var, default `final,exec` — January's
  convention, confirmed live via real "Final Round"/"Final Round (series)"
  and "Executive Interview" stages, NOT an Ashby default; previously also
  matched "panel"/"Panel Round" until narrowed to final-round and
  executive interviews only, per product decision). An empty keyword list
  disables the section outright rather than silently matching nothing.
  Before onboarding a new client, run
  `scripts/check-ashby-compatibility.js` against their org — it lists their
  actual stage titles so you can pick real keywords instead of guessing.
  "Today" is a UTC calendar day (`isTodayUTC`), the same tradeoff
  `countInterviewsThisWeek` already makes for weekly limits — display times
  still render in the browser's local zone client-side.
- **Source classification (Recently Sourced) is also client-specific
  keyword matching, not a fixed Ashby taxonomy.** `classifySource()` in
  `ashby.js` matches `source.sourceType.title` against
  `config.sourceReferralKeywords`/`sourceAgencyKeywords`
  (`SOURCE_REFERRAL_KEYWORDS`/`SOURCE_AGENCY_KEYWORDS`, defaults
  `referr`/`agenc`) — every Ashby org names its source types differently
  (this org: "Referral", "Agencies", "Sourced", "Inbound", "Internal",
  "Prospecting", "Third-party boards"). Same compatibility-script guidance
  as onsite keywords above.
- **Recruiter/Coordinator filter is an EXACT role-name match, not a
  substring/keyword list like source/onsite above** —
  `hiringTeamMember()` in `ashby.js` finds the `hiringTeam[]` entry whose
  `role === config.recruiterRoleName` (`RECRUITER_ROLE_NAME`/
  `COORDINATOR_ROLE_NAME`, defaults `Recruiter`/`Recruiting Coordinator`).
  `hiringTeam[]` is already present on every `application.list`/
  `application.info` result, no extra lookup. Ashby's `hiringTeamRole.list`
  is a small controlled per-org list (this org: "Hiring Manager",
  "Recruiter", "Recruiting Coordinator", "Sourcer"), but it's still
  org-specific naming — verify with `scripts/check-ashby-compatibility.js`
  before onboarding a new client, same as the keyword-matched config above.
  `recruiterId`/`recruiterName`/`coordinatorId`/`coordinatorName` are set on
  every candidate record built in `fetchApplicationSummaries()` and
  `listRecentSourced()`; `listOnsiteToday()` inherits them for free since
  its entries spread `...app` from `fetchApplicationSummaries`'s output.
- **Client-specific display config (`DASHBOARD_TITLE`,
  `ACTIVE_REFERRALS_REPORT_URL`) is injected client-side via `/api/issues`'s
  `appConfig` field, not server-side templating.** `public/index.html` is a
  static file served by `express.static` — there's no templating step to
  bake env values into it at request time. `issues.js` sets a static
  `appConfig` object once at module load (see near `thresholds`);
  `app.js`'s `applyAppConfig()` sets `document.title` / `#dashboard-title`
  text and the report-link's `href`/`hidden` on every render (idempotent,
  so no special-casing "only on first load" is needed). If you add another
  client-specific display value, follow the same path — don't reach for
  server-side HTML templating for a single value.
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
- Interview-schedule lookback is `config.scheduleLookbackDays`
  (`SCHEDULE_LOOKBACK_DAYS` env var, default 30) — chosen for refresh-cycle
  speed on a large org, not because anything older is meaningless. A
  different client's interview volume/velocity may want a different value;
  raise it if you need to catch very old stragglers and can tolerate a
  slower refresh.
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
- **The department/job/recruiter/coordinator filter (`public/app.js`) is
  multi-select, mode-switchable, table-driven, and purely client-side,
  filtering the already-fetched snapshot in memory — not a new API call.**
  `FILTER_MODES` is a `{ department, job, recruiter, coordinator }` table,
  each entry giving its `key` (the item field to match), `noun`/`pluralNoun`
  (for labels), and an `options()` function. `filterMode` names which one
  is live; `selectedIdsByMode` holds one independent `Set` per mode (built
  from `Object.keys(FILTER_MODES)`, so adding a mode doesn't require a new
  variable), each remembering its own selection across mode switches. Only
  ONE mode's Set actually filters at a time — switching modes doesn't
  combine two fields, it replaces which one is active. `activeSelection()`
  returns `{ ids, key, noun, pluralNoun }` for whichever mode is live;
  `filterByEntity()` does `items.filter(i => ids.has(i[key]))`, an OR across
  selections. `lastData` caches the last render's payload; checking/
  unchecking a checkbox in `#entity-filter-menu`, or clicking a
  `.filter-mode-btn`, just calls `render(lastData)` again. The menu mirrors
  the existing per-card dismiss-menu's fixed-position/anchor-to-button
  pattern, but deliberately does NOT close on selection (unlike
  dismiss-menu) since picking several options requires staying open — it
  closes only on the reset button, outside-click, or scroll.
  **Department options come from the server** (`data.departments`, Ashby's
  `department.list`). **Job/recruiter/coordinator options are all derived
  client-side** via the shared `collectDistinct(data, idKey, nameKey)` from
  whichever ones are actually represented across `CANDIDATE_SECTION_KEYS`'
  items in `lastData` — deliberately NOT a separate `job.list`/etc. call,
  since e.g. `job.list` would include every closed/archived job org-wide
  (dozens to hundreds) rather than just the ones with candidates currently
  on screen. `filterByEntity()` is applied to the seven candidate sections'
  arrays before each is rendered (`renderColumn`/`renderStale`/
  `renderRecentSourced`/`renderOnsiteToday`/`renderRescheduledInterviews`) —
  Interviewer Weekly Limits and Interviewer Training deliberately skip it,
  since an interviewer isn't tied to one department/job/recruiter/
  coordinator. If you add a new candidate-facing section,
  wrap its render call with `filterByEntity(...)` too, add its key to
  `CANDIDATE_SECTION_KEYS` (so it's included when deriving job/recruiter/
  coordinator options), and make sure `ashby.js` actually populates
  `departmentId`/`jobId`/`recruiterId`/`coordinatorId` on its records —
  none of it is automatic. To add a fifth filterable field, add one entry
  to `FILTER_MODES` and one `.filter-mode-btn` in `index.html`; everything
  else (Set management, menu population, button label, filtering) is
  already generic over the table.

- **Dismissals are applied at serve time, not refresh time.** `issues.js`
  `getSnapshot()` runs `applyDismissals()` over the cached snapshot on every
  call, so a dismiss takes effect on the next 60s poll (and the dismiss
  endpoint returns the freshly filtered snapshot for an instant update) —
  the background refresh doesn't need to re-run. Don't move filtering into
  `refresh()`; that would delay dismissals by up to `REFRESH_INTERVAL_MINUTES`.
- **Dismiss keys are entity-scoped, not row-scoped.** `candidate:<id>` hides a
  person from all seven candidate sections at once;
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
