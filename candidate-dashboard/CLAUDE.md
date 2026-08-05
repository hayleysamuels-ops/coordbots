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
than just freshly overdue. A third tab, Offers, tracks offers awaiting the
candidate's acceptance, offers stuck in internal approval (never sent to
the candidate yet), and offers signed in the last week. Full behaviour is in
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

**Multi-client env files.** `.env` is the full local dev config for whichever
client this checkout currently targets. `.env.<client>` files (`.env.january`,
`.env.luminai`, `.env.poetic`, `.env.profound`) each hold just that client's
`ASHBY_API_KEY`, prefixed with a `# Client: <Name> — Railway project
"dashboard-<name>"` comment so no file is ambiguous — see README § Running
locally against a different client. All covered by `.gitignore`'s `.env`/
`.env.*` (except `.env.example`). To point a local run at one of these
without touching `.env`, strip the comment before handing it to `env`'s
argument-list syntax (a bare `#` word otherwise gets executed as a command):
`env $(grep -v '^#' .env.profound) npm start`. Don't assume a filename's
client is correct without checking — it can be wrong (confirmed live: an
earlier `.env.client` was assumed to be Profound and was actually Luminai).
Verify via Ashby's `user.list` email domains and/or Railway's `CLIENT_NAME`
var for that project, not the filename alone.

## Architecture

Background poll (not webhooks — a dashboard just needs current state), one
refresh cycle: `issues.js` refreshes every `REFRESH_INTERVAL_MINUTES` by
calling `ashby.listIssues()`, `ashby.listRecentSourced()`,
`ashby.listInterviewerTraining()`, and `ashby.listOffers()` in parallel —
the twelve sections (Feedback Overdue, Needs Scheduling, Availability
Submitted, Stale Candidates, Interviewer Weekly Limits, Recently Sourced,
Onsite Interviews Today, Interviewer Training, Rescheduled Interviews,
Offers Not Yet Sent, Offers Awaiting Acceptance, Offers
Signed). Rescheduled Interviews is computed inside `ashby.listIssues()`
itself (it reuses that same `interviewSchedule.list` fetch), not a separate
top-level call.

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
  Logs the resolved `config.dataDir` on startup (`[server] Data directory:
  ...`) so it's visible in deploy logs without needing to shell into the
  host.
- `src/config.js` — env parsing. `dataDir` resolves
  `RAILWAY_VOLUME_MOUNT_PATH` (set automatically by Railway when a volume is
  attached) before `DATA_DIR`, before the `./data` fallback — a Railway
  deployment with a volume needs neither env var set manually. Don't reorder
  this without checking Railway still injects that var the same way.
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

- **The page is three tabs (Dashboard / Interviewer Info / Offers),
  implemented as plain DOM show/hide, not a router.** `index.html` has
  three sibling `.tab-panel` divs (`#tab-dashboard`, `#tab-interviewers`,
  `#tab-offers`) and three `.tab-btn` buttons with a `data-tab` attribute;
  `app.js`'s click handler is generic over the convention
  `id="tab-<data-tab value>"`, so a fourth tab needs only a matching
  button+panel pair, no JS changes. All three panels' content renders on
  **every** poll regardless of which is visible — the `hidden` attribute is
  purely cosmetic, so switching tabs is instant and never shows stale
  content. Interviewer Weekly Limits and Interviewer Training live on the
  Interviewer Info tab specifically because neither is tied to a
  candidate/department/job/recruiter/coordinator, so they were moved out of
  the candidate-facing Dashboard tab to reduce clutter there — don't move
  them back without re-checking whether that reasoning still holds.
  `.tab-panel` has NO conflicting `display` rule of its own — if you ever
  add one, remember `.tab-panel[hidden] { display: none; }` needs to win
  the cascade over it (author rules beat the browser's `[hidden]` default
  at equal specificity only if the `[hidden]` override is also an author
  rule — this exact class of bug has bitten this codebase before, on an
  unconditional `display: block` rule elsewhere).
- **Action queue merges four sections into one table; DISABLED_SECTIONS
  hides a queue from it two different ways depending on whether that
  section still has its own static DOM.** Feedback Overdue/Needs
  Scheduling/Availability Submitted/Rescheduled Interviews used to each be
  their own `<section data-key="...">` — now `TRIAGE_QUEUES` (`app.js`)
  drives one merged, sortable table instead (see § Action queue below for
  the full design). None of those four keys has a section to
  `document.querySelector('[data-key="..."]')` and remove anymore, so
  disabling one is handled entirely inside `buildActionQueueRows()`/
  `renderQueueNav()`/`renderSignalChips()`, each looping `TRIAGE_QUEUES` and
  skipping `isSectionDisabled(queue.key)` — the same idea `render()`'s old
  per-column loop already used, just now inside the merge instead of at
  render()'s top level. `recentSourced`/`staleCandidates`/`onsiteToday`
  keep their own static sections, so `applyDisabledSections()` still
  removes their DOM node directly (`section.remove()`, not `hidden` —
  `.page-stack > * + *`'s divider is a structural CSS pseudo-class
  (adjacent-sibling `+`) that only recomputes correctly against the real
  remaining DOM; `display: none` would leave a stray divider at the top of
  the next section — verified this the hard way against the real cascade
  behavior, not just reasoned about it). Also collapses `.side-margin` to
  nothing if `onsiteToday` was its only remaining `.column`, rather than
  leaving an empty 300px gap. The backend (`issues.js`/`ashby.js`) still
  computes every section's data regardless of `DISABLED_SECTIONS` — this is
  purely a display-layer toggle, by design (see `config.js`'s
  `disabledSections` comment) — don't add server-side skip logic for it.
  `config.js`'s `SECTION_KEYS` array is the validated source of truth: it
  logs the full recognized list on startup and warns on any
  `DISABLED_SECTIONS` entry that doesn't match one, specifically so a typo
  (e.g. `interviewerWeeklyLimits` instead of `interviewerLimits`) is a loud
  deploy-log warning instead of a silently-ignored no-op.
- **Each refresh cycle's five Ashby fetch groups (`SECTION_GROUPS` in
  `issues.js`) commit independently AND immediately, not in one batch at
  the end.** `refreshOneGroup(group)` is `await`ed individually per group
  inside `Promise.all(SECTION_GROUPS.map(refreshOneGroup))` — each one
  writes its own `snapshot`/`sectionStatus` entries (and logs `"<label>
  committed (<key>=<count>, ...)"`) the instant ITS OWN `group.fetch()`
  settles, success or failure, with no dependency on its siblings. This
  replaced an earlier version that used `Promise.allSettled()` over all
  five fetches and only committed results in one `.forEach()` pass
  afterward — which reintroduced the exact all-or-nothing problem this
  design exists to fix: confirmed live against Profound, `listIssues`
  taking 523s while `listDepartments`/`listRecentSourced`/`listOffers` had
  all finished in under 90s meant `/api/issues` kept serving an all-empty,
  every-`lastUpdated`-null snapshot for that entire 523s despite deploy
  logs showing those faster groups long done — the batched commit was
  silently gated on the slowest group finishing too. Don't reintroduce a
  single `await Promise.allSettled(...)` (or `Promise.all`) over all the
  fetches followed by one shared commit step — that's precisely this bug.
  Also: `getSnapshot()` returns a **shallow copy** of `sectionStatus`
  (`{ ...sectionStatus }`), not the live object — `sectionStatus[key] = ...`
  mutates that object in place per-group as each settles, unlike
  `snapshot`'s own fields (`departments`, etc.), which `group.assign()`
  replaces wholesale (a fresh reference, never mutated), so an earlier
  `getSnapshot()` result's fields are naturally frozen against a later
  refresh — `sectionStatus` needed an explicit copy to get the same
  guarantee. No current `server.js` route has an `await` between calling
  `getSnapshot()` and serializing the response, so this isn't reachable
  today, but keep the copy — it's a one-line defense against the first
  route that does.
- **Action queue (`app.js`): `TRIAGE_QUEUES` is a 4-entry table
  (feedbackOverdue/needsScheduling/availabilitySubmitted/
  rescheduledInterviews) that `buildActionQueueRows()` merges into one
  array, sorted by each entry's own `waitingHours(item)` descending — no
  new Ashby data, purely a client-side reshaping of the same four arrays
  `data.feedbackOverdue`/etc. already were.** `filterByEntity()` still
  applies per-source before merging, same as always. `activeSignal`
  ("all" or one of `TRIAGE_QUEUES[].key`) narrows which rows show; two
  surfaces write it — the sidebar's Triage queues group
  (`#triage-queue-nav`) and the chip row above the table
  (`#signal-chip-row`) — via one delegated `[data-signal]` click handler,
  so they can never drift out of sync with each other. Sidebar/chip counts
  are computed BEFORE `activeSignal` narrows anything, so every option's
  true size stays visible regardless of which one is currently picked.
  `queue.signalClass` (the Signal tag's fixed color) is deliberately NOT
  Carrara's `good`/`warning`/`serious`/`critical` severity ramp applied
  1:1 — `warning`/`serious`/`critical` are the same ember hue at different
  darkness (a ramp for grading one thing's escalating severity), which
  reads as near-identical tags once real data was actually on screen
  (confirmed live). The four signal classes instead span `critical`/
  `warning`/`good`/a custom `neutral` (gray, for Rescheduled, which
  doesn't fit the good/bad severity framing at all) for real hue
  separation. `.aq-waiting`'s color is a SEPARATE, ratio-to-threshold
  `severity()` call (same function `renderColumn()` used to feed a card's
  left border) — how urgent THIS row is within its own category, not
  which category it is. Rescheduled Interviews has no native "waiting
  since X" field (only `rescheduleCount` + the current `startTime` — see
  `listIssues()` in `ashby.js`); its `waitingHours` is derived from
  `startTime` instead (hours since the already-rescheduled slot was
  supposed to happen; a future `startTime` reads "Upcoming", not a
  negative duration) — an existing field used differently, not a new
  data source. The "Stage" half of the Stage & Role column reuses each
  row's own `queue.label` (there's no interview-stage-title field on
  these four record shapes without an additional `interviewStage.info`
  call per schedule, which would be new data-fetching — out of scope when
  this was built) — it's honestly redundant with the Signal tag next to
  it; don't be surprised the two columns say the same thing per row, and
  don't try to "fix" that without first deciding whether a real stage
  lookup (new API calls) is worth adding.
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
  trainees complete interviews. `isPaused` is a plain Ashby boolean, no
  self-tracking involved — an earlier version also tracked and displayed
  how long each trainee had been paused (`src/pauseTracking.js`), since
  removed; see git history if it's ever worth reviving.
- **Paused trainees are hidden by default, behind a "Show N paused
  interview trainees" toggle in `app.js` (`showPausedTrainees`, same
  render-from-cached-`lastData` pattern as the department/job/recruiter/
  coordinator filter — no network round-trip on toggle).** A paused
  trainee isn't actionable the way an active one's progress-toward-next-
  stage is, so they're opt-in to view rather than cluttering the default
  list. Toggling re-renders with the same backend-sorted order (paused
  entries still come first among themselves once revealed).
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
  "Today" is a calendar day in `config.displayTimeZone` (`isToday`/
  `calendarDateInTimeZone`, replacing the old `isTodayUTC`) — NOT the server
  container's UTC day, and NOT `countInterviewsThisWeek`'s
  Monday-Sunday UTC week boundary above (same class of issue, out of scope,
  untouched). The old UTC boundary rolled over at 8pm Eastern during EDT (UTC
  midnight), so an evening onsite interview could silently drop off this
  section hours before the day actually changed for anyone in the org —
  confirmed the exact failure live: a 9:30pm-America/New_York event
  (`2026-08-04T01:30:00.000Z`) resolves to calendar day `2026-08-04` in UTC
  but correctly `2026-08-03` in `America/New_York`.
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
- **Client-specific display config (`CLIENT_NAME`/`DASHBOARD_TITLE`/
  `CLIENT_ACCENT_COLOR`) is injected client-side via `/api/issues`'s
  `appConfig` field, not server-side templating.** `public/index.html` is a
  static file served by `express.static` — there's no templating step to
  bake env values into it at request time. `issues.js` sets a static
  `appConfig` object once at module load (see near `thresholds`); `app.js`'s
  `applyAppConfig()` sets `document.title` / `#dashboard-title` text and the
  `--header-accent` CSS custom property on every render (idempotent, so no
  special-casing "only on first load" is needed). If you add another
  client-specific display value, follow the same path — don't reach for
  server-side HTML templating for a single value.
- **`CLIENT_NAME` is the single source of truth for the title/header text;
  `DASHBOARD_TITLE` is a full-override escape hatch, not a separate
  concept.** `config.dashboardTitle` resolves `DASHBOARD_TITLE` first, then
  falls back to `` `${CLIENT_NAME} Coordination Dashboard` `` (client name
  first), then the plain generic `"Candidate Dashboard"` default if neither
  is set — computed once in `config.js`, not duplicated client-side.
  `DASHBOARD_TITLE` isn't in `.env.example` (most deployments won't need
  it) but is still fully supported in code for a title that doesn't fit the
  `"<name> Coordination Dashboard"` shape. This org's `.env` sets
  `CLIENT_NAME=January`, which derives exactly "January Coordination
  Dashboard" — no `DASHBOARD_TITLE` override needed here anymore.
  `CLIENT_ACCENT_COLOR` is independent of both — it only touches
  `--header-accent` (topbar border + title color), defined once in
  `style.css`'s `:root` token block, default `var(--ember)`.
- **`DISPLAY_TIMEZONE` (`config.displayTimeZone`, default `America/New_York`)
  reaches two genuinely different places, not one** — this is worth
  understanding before touching either: (1) `public/app.js` formats every
  ABSOLUTE time in the UI (`formatEventTime`, `formatEventDateTime`, the
  "Updated"/"Last loaded" timestamps) in this zone client-side, via
  `appConfig.displayTimeZone` (same threading path as `clientAccentColor`
  above) — set once in `applyAppConfig()` into a module-level
  `displayTimeZone` variable; (2) `src/ashby.js` reads `config.displayTimeZone`
  directly (no threading needed, it's already server-side) for the Onsite
  Interviews Today day boundary (`isToday`, see above). Deliberately NOT
  applied to `formatAge`/`formatAgo`/`formatUpdatedAgo` (pure elapsed
  durations — "3h ago" doesn't change meaning by time zone) or to
  `formatDateOnly` (Offers' plain `YYYY-MM-DD` start date, which has no
  time-of-day component to convert at all — stays pinned to `"UTC"` since
  that's what its `Date.UTC(...)` construction actually is; passing
  `displayTimeZone` there would shift it to the previous day). **Must be a
  real IANA name, not a fixed abbreviation** — confirmed live:
  `Intl.DateTimeFormat` does NOT reject `"EST"`, it silently resolves to the
  fixed `America/Panama` zone (no daylight saving), which reads identically
  to real US Eastern time in January (`7:00 AM EST` either way) but is an
  hour off in July (`America/New_York` correctly shows `8:00 AM EDT`; `EST`
  still shows `7:00 AM EST`) — wrong for roughly eight months of the year,
  not an edge case. `validateTimeZone()` in `config.js` warns (doesn't
  silently rewrite) on this specific trap via a `"/"`-in-the-name heuristic
  (the one legitimate exception is bare `"UTC"`), and separately falls back
  to the default with a warning for a genuinely invalid zone name (one
  `Intl.DateTimeFormat` actually throws constructing).
- **The Offers tab (`offersNotYetSent`/`offersAwaitingAcceptance`/
  `offersSigned`, all computed in `listOffers()` in `ashby.js`) is a third
  `.tab-panel`, sharing the same generic tab mechanism as Dashboard/
  Interviewer Info — no JS changes needed for the tab switch itself, per the
  first bullet above. It deliberately has NO department/job/recruiter/
  coordinator filter bar** (unlike the Dashboard tab's candidate sections) —
  that filter is a single instance keyed by page-wide DOM ids
  (`#entity-filter-btn`/`#entity-filter-menu`), and giving Offers its own
  would mean either a second instance or reworking it to be filter-bar-aware
  of which tab is active; out of scope for this addition, so `offerColumns`
  in `app.js` render straight from the snapshot, not through
  `filterByEntity()`, and the three keys are deliberately NOT in
  `CANDIDATE_SECTION_KEYS`. Per-card dismiss still works normally (`cardHtml`
  already keys every card on `candidate:<id>` regardless of section), and
  all three keys are in `applyDismissals()`'s `keepCandidate` list.
  **Ashby has no distinct "signed" concept** — `offerStatus` transitions
  `WaitingOnApproval*` (created, candidate has never seen it) →
  `WaitingOnCandidateResponse` (offer extended, waiting on the candidate) →
  `CandidateAccepted`/`CandidateRejected`/`OfferCancelled`. "Signed" is
  `CandidateAccepted` with `decidedAt` (the real field marking when that
  decision landed) within `OFFERS_SIGNED_LOOKBACK_DAYS` (default 7) — there's
  no separate e-signature timestamp; `latestVersion.fileHandles` is where a
  signed PDF would appear, but it carries no date.
  **No field on the Offer object marks a "sent"/"extended" event either** —
  walked the full `offer.info` schema (Offer, OfferVersion, `versions[]`,
  `formDefinition`) against a real live offer and confirmed via Ashby's own
  API reference: no `sentAt`/`extendedAt`/`deliveredAt`/`notifiedAt` field
  anywhere. So Offers Not Yet Sent (`OFFER_NOT_YET_SENT_STATUSES` =
  `WaitingOnApprovalStart`/`WaitingOnOfferApproval`/
  `WaitingOnApprovalDefinition`) is inferred purely from `offerStatus`, kept
  as its own section rather than folded into Offers Awaiting Acceptance —
  explicit product decision, since an offer the candidate has never seen
  isn't something they could be "awaiting acceptance" on. Confirmed no other
  `offerStatus` value can leak into this bucket: `WaitingOnCandidateResponse`/
  `CandidateAccepted`/`CandidateRejected` all mean the candidate has been
  sent something; `OfferCancelled` is genuinely ambiguous (could be pre- or
  post-send) but isn't included in this bucket at all, so it can't leak in
  either way. Also checked the revision-loop edge case live: an offer
  observed mid-build going `WaitingOnApprovalDefinition` →
  `WaitingOnOfferApproval` across a new version kept `acceptanceStatus:
  "Created"` throughout (never `"Pending"`, which is what Ashby uses once a
  candidate is actually awaiting a decision) — consistent with these three
  states being strictly pre-send even across a revision, though Ashby's docs
  don't explicitly rule a revert out. All of this is a real, structural
  `offerProcessStatus` enum (confirmed via Ashby's API docs), not
  org-configured naming — unlike source/onsite keywords, no per-client
  keyword tuning is needed, only whether the client uses Ashby's Offers
  feature (and has an approval chain configured) at all. **Ashby has no
  org-wide "approvals enabled" setting to query** — the only real signal is
  `latestVersion.approvalStatus` on an individual offer, null "when no
  approval process has been configured for the offer version" (confirmed via
  API docs) versus a real value (`Approved`/`WaitingOnApprovals`/`Declined`)
  once one has. Verified live on this org: `approvalStatus` is null even on
  its one real `WaitingOnApprovalDefinition` offer, and 0 of 288 offers ever
  had a non-null value — January has never used this Ashby feature, so
  Offers Not Yet Sent reading empty here is correct, not broken.
  `scripts/check-ashby-compatibility.js`'s Offers section reports this count
  so a new client's onboarding can tell the two cases apart.
  **`offer.list` has no `createdAfter` filter**, so every refresh walks every
  offer the org has ever created — verified live on this org: 287 total
  offers (3 pages), 21 currently `WaitingOnCandidateResponse`, 0 currently in
  a `WaitingOnApproval*` state, 1 `CandidateAccepted` with `decidedAt` in the
  trailing 7 days as of 2026-07-31. This is safe unlike the equivalent full
  scan would be for `application.list` (see § Scope below) — `offer.list`
  itself is cheap (no per-item lookup), and the expensive part (one
  `application.info` call per `applicationId`, via `fetchOfferApplications`)
  only runs for the applicationIds in one of the three current buckets, not
  every historical offer. `offer.list` DOES support a `syncToken` for
  incremental sync (do a full paginated sync once, the last page returns a
  token, then pass it back to fetch only offers changed since) — deliberately
  NOT adopted here: the full scan is only 3 pages at this org's actual
  volume, the expensive part is the per-bucket `application.info` calls
  which `syncToken` wouldn't reduce, and adopting it would mean maintaining
  a persisted local mirror of every offer (to merge in incremental deltas)
  plus token-expiry/`incremental_sync_too_large`-overflow fallback logic.
  Revisit only if a client's offer history grows large enough that the full
  scan itself becomes slow. `fetchOfferApplications` mirrors
  `fetchApplicationSummaries` but keeps every application status (a signed
  offer's candidate is usually already `Hired`, not `Active` — the
  Active-only filter would wrongly hide them); both now share
  `buildApplicationRecord()`/`fetchApplicationsById()` rather than
  duplicating the candidate/job/hiring-team shape-building logic.
  Age on the two pending sections ("Sent"/"Created" respectively) uses a
  field named `versionCreatedAt` (deliberately not `sentAt` — see above,
  there's no such thing), which is `latestVersion.createdAt` (when that
  offer version was authored). For Offers Awaiting Acceptance this is a
  reasonable proxy for "roughly when it went out" (a version is normally
  created right before being sent, but this is not a literal delivery
  event); for Offers Not Yet Sent it's honestly just "created," which is the
  whole point of that section. Cards show a start date
  (`latestVersion.startDate`, a plain `YYYY-MM-DD` with no time/timezone —
  `formatDateOnly()` in `app.js` parses it as UTC calendar-date parts, not
  `new Date(str)`, to avoid a local-zone off-by-one near midnight) —
  deliberately no salary shown, per product decision to keep compensation
  off the shared dashboard for now.
  **Offers Awaiting Acceptance excludes candidates already `Hired` or
  `Archived`** — `offerStatus` can lag the application's real outcome
  (candidate hired/pulled out through some other update without the offer
  object itself transitioning off `WaitingOnCandidateResponse`); confirmed
  live both statuses actually showed up in this section before the
  exclusion was added (dropped a real sample from 22 entries to 3). Neither
  status is genuinely "awaiting" anything at that point. Applied only to
  Offers Awaiting Acceptance, not Offers Not Yet Sent or Offers Signed —
  not asked for there, and less obviously wrong for those (an offer stuck
  pre-send or one already accepted isn't the same "stale state" shape).
  **Offer candidate names link via `candidateProfileUrl()`, not `profileUrl()`**
  — `fetchOfferApplications` overrides `buildApplicationRecord()`'s
  `ashbyProfileUrl` with it. `profileUrl()` is pipeline-view-scoped
  (`/candidates/pipeline/active/right-side/.../applications/<id>/feed`) and
  explicitly verified Active-only; Offers candidates are frequently already
  `Hired` or `Archived` by the time an offer shows up here, so that link
  would silently come back `undefined` for most of them (confirmed: before
  this fix, 0 of a live sample's Hired/Archived offer cards had a link).
  `candidateProfileUrl()` instead uses `candidate.info`'s own real
  `profileUrl` field — confirmed via live `candidate.info` calls against
  both an Active and an Archived candidate that it resolves to the same
  `/candidate-searches/new/right-side/candidates/<candidateId>` shape either
  way (`"new"` is a literal path segment, not a per-search value) — so it's
  constructed directly with no extra API call, and needs no `applicationId`.
  This is a better, verified link for Offers specifically; the five
  Active-only candidate sections still use `profileUrl()` unchanged (correct
  for them, since they're already Active-filtered) — not touched here, out
  of scope for this fix.
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
- **Debrief events are excluded from Feedback Overdue** (and therefore from
  Stale Candidates' feedback-overdue reason too, since that list is derived
  from `feedbackEntries`) **— a debrief is an internal wrap-up meeting with
  no scorecard due back.** `fetchDebriefInterviewIds()` in `ashby.js` fetches
  `interview.list` once per refresh and keeps the `id`s where `isDebrief` is
  true, cross-referenced against each event's `interviewId` (a real
  structural Ashby field on the interview *definition*, not an org-naming
  convention — safe for any client, unlike Onsite Interviews Today's
  keyword matching below). Only affects Feedback Overdue — Rescheduled
  Interviews still tracks debrief events like any other, since a debrief
  can legitimately get rescheduled too. Degrades to "exclude nothing" (the
  pre-existing behavior) with a console warning if `interview.list` fails
  for any reason (e.g. an API key without `interviews:read`), rather than
  taking down the rest of `listIssues()`'s `Promise.all`.
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
  `.filter-mode-btn`, just calls `render(lastData)` again. The menu is fixed,
  not absolute, positioned from JS via the button's real viewport rect (same
  `.card-details`/`#entity-filter-menu` anchoring pattern used elsewhere) so
  it's never clipped by a scrollable ancestor; deliberately does NOT close on
  selection, since picking several options requires staying open — it closes
  only on the reset button, outside-click, or scroll.
  **Department/job/recruiter/coordinator options are all derived
  client-side**, from whichever ones are actually represented across
  `CANDIDATE_SECTION_KEYS`' items in `lastData` — deliberately NOT a
  separate org-wide list call for any of them, since e.g. `job.list` (or
  `department.list` without this filtering) would include every
  closed/archived job or department org-wide (dozens to hundreds) rather
  than just the ones with candidates currently on screen. Job/recruiter/
  coordinator use the shared `collectDistinct(data, idKey, nameKey)`, which
  reads the name straight off each item. Department is `collectDistinctDepartments(data)`
  instead, because candidate items only carry `departmentId`, not a name:
  it collects the same way, then resolves each id's name/`isArchived`/
  `createdAt` via the `lastDepartments` lookup (still populated from the
  server's `data.departments`, Ashby's `department.list` with
  `includeArchived: true` — see `ashby.listDepartments()`), then runs
  `disambiguateDepartmentNames()` before the final alphabetical sort.
  Some orgs have two departments sharing a `name` (most commonly an
  archived one and its active replacement, occasionally two distinct
  active ones); rather than merge them into one dropdown row — which
  would make checking it silently filter by only one of the two department
  IDs — collisions are labeled: an archived member of a colliding pair gets
  `" (archived)"` appended, and if a collision remains after that (two
  active departments, same name) each gets `" (1)"`/`" (2)"`/etc., numbered
  oldest-created-first so the numbering doesn't reshuffle across refreshes.
  `filterByEntity()` is applied to the seven candidate sections' arrays
  before each is used — `renderStale`/`renderRecentSourced`/
  `renderOnsiteToday` directly, and `buildActionQueueRows()` per-queue for
  the four TRIAGE_QUEUES sections it merges into the Action queue table
  (see § Action queue below). Interviewer Weekly Limits and Interviewer
  Training deliberately skip it, since an interviewer isn't tied to one
  department/job/recruiter/coordinator. If you add a new candidate-facing
  section, run it through `filterByEntity(...)` too, add its key to
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
  `interviewer:<id>` hides an interviewer from the limits section. `/api/undismiss`
  is called by the Undo toast's button (`.dismiss-toast-undo` in app.js),
  shown for 12 seconds after every dismiss — there's no other UI for
  bringing a card back early. If you add a new candidate-facing section, add
  it to the `keepCandidate` filter list in `issues.js`'s `applyDismissals()`
  — it's not automatic.
- **The dismiss control is two always-visible buttons, not a "×" that opens a
  menu — deliberately, after a live report of dismiss silently not working.**
  Root cause: a browser extension's own `position: fixed` overlay sat above
  the old popup menu and swallowed its second click (confirmed by
  reproducing in a normal profile, gone in incognito) — nothing wrong with
  `dismissals.json` or `applyDismissals()`, both of which already covered
  every section correctly. See README § Correction for the full story.
  `dismissHtml()` (app.js) now renders both actions inline in the card's
  normal layout instead of a dynamically-positioned floating menu — nothing
  for an overlay to cover that isn't also covering the whole card. Both
  fire on `pointerdown` as well as `click` (`activateDismissControl()`,
  same file) as further defense against click-swallowing; a module-level
  `lastPointerActivation` (element reference + timestamp) stops the
  following `click` from re-firing the same action, without breaking
  keyboard activation (Enter/Space produces a `click` with no preceding
  `pointerdown`, so it's still handled there). No confirmation step in front
  of a dismiss anymore — the old menu's second click doubled as one — so the
  Undo toast (`showUndoToast()`/`#dismiss-toast`) is the replacement safety
  net, shown after every dismiss regardless of scope.

## Conventions

- Style: `"use strict"`, CommonJS modules, 2-space indent, double quotes.
- Log with a `[module]` prefix, e.g. `console.log("[issues] ...")`.
- Keep secrets in `.env` only. **Never commit `.env`** — it's gitignored.
- When adding config, add it to `src/config.js` *and* document it in
  `.env.example` and the README table.
- When adding a new dashboard section, add a corresponding check to
  `scripts/check-ashby-compatibility.js` in the same change, and note in
  that check (and the commit) whether the section depends on structural
  Ashby fields (real enum/schema values — safe for any client, e.g.
  `interviewSchedule.status`, `interviewerRole` Shadow/ReverseShadow) or
  org-configured naming (free-text titles a client sets themselves — e.g.
  source names, stage titles, hiring-team role names — which needs
  client-specific env-var tuning and verification via the compatibility
  script before onboarding).
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
