# CLAUDE.md — coordinator-metrics

Read [README.md](README.md) first. It covers what the dashboard measures,
the counting rules, and why the data gets here the way it does. This file
is the short list of things that look wrong and are not.

## Key design facts (don't "fix" these — they're intentional)

- **There is no `listApplications()` in `ashby.js`, and that is the point.**
  `application.list` returns every application an org ever received —
  242,611 on Forus, 236,896 on January — of which ~8,000 reached an
  interview. The bulk sweep cost 27 minutes per full sync and 254MB of
  storage, and grows forever. `syncApplications()` resolves only the ids
  that stored schedules actually reference, through `application.info` at
  concurrency 8. Pruning the rest changed no metric. Don't reintroduce a
  bulk sweep because "one call is cheaper than 8,000" — it isn't, after the
  first run. Measured against the real orgs: the first full backfill is
  about 21 minutes wall clock for five clients at concurrency 2 (Forus
  12 of them, resolving 7,483 applications), and every nightly run after
  that only refreshes applications still marked Active.

- **Applications are synced AFTER schedules, not before.** The set worth
  fetching is defined by which schedules exist, so the order is load-bearing,
  not stylistic.

- **A full sync refreshes Active applications but never re-reads archived
  ones.** Archived and Hired are terminal; re-reading them every night would
  triple the call count to learn nothing. The drop-off metric depends on
  catching the Active → Archived transition, which this does.

- **Two flags gate every roll-up: `engagement` and `status`.** A
  share-of-activity percentage is computed ONLY within one engagement
  type — Forus is client-scheduled, so most of its interviews were never
  ours and folding it into one figure describes nothing. An `ended`
  client never reaches a current-period number or the weekly trend.
  Volume totals DO include ended clients: that work happened. This means
  the overview's `totals` and `periods.full` legitimately differ once an
  ended client exists, unlike a client payload where they must be equal.

- **Profound is configured and `ended`, and that is deliberate.** It
  was removed on 26 October 2026 and put back the same day: the year of
  volume belongs in the totals. Its engagement really has finished, so
  it keeps `status=ended` and everything below about ended engagements
  applies to it — fixed window, one backfill, out of every
  current-period figure and the weekly trend.

  **Exclude Profound from pre/post-Carrara when that is built.** There
  is no meaningful "before": we built their Ashby, so the instance has
  no pre-Carrara history to compare against. A pre/post view would show
  an empty or near-empty baseline and read as a transformation.

- **An ended engagement reads its own fixed date range, not the rolling
  12 months.** A rolling window would silently erase finished work as it
  aged out — Profound's ends August 2026, so by September 2027 none of it
  would show, with nothing on screen to say why. It is also synced ONCE
  and never again (`ended_backfill_completed_at` in sync_meta): our last
  event there was months ago, while Profound's own team still runs ~1,300
  interviews a month that must never leak into the all-activity figures.

- **There are THREE scopes, defined once in `src/scopes.js`:
  `coordinated`, `notCoordinated` and `all`.** Client-level fields
  (name, timezone, today, roster, dataQuality) are hoisted above them.
  Coordinated counts schedules created by a rostered Carrara
  coordinator. It is a TOGGLE, not a replacement: "we coordinated
  10,689 of the 31,989 interviews that ran" is a stronger claim than
  10,689 alone, and a roster gap is then visible rather than looking
  like low output.

  `notCoordinated` is **not** `all` minus `coordinated`. It counts work
  booked by a NAMED person who is not on the roster. Schedules with no
  scheduler at all are in neither side — 3.7% of January's, 33% of
  Luminai's — because putting them on the client's side invents a
  finding and putting them on ours flatters one. Events are different:
  99.9%+ carry a scheduler, so the volume comparison is effectively
  complete while the cancellation one is not. The remainder is printed
  in the data-quality section, not left to a subtraction.

  The list lives in its own tiny file rather than in `metrics.js`
  because `payload-contract.js` reads it, and the contract is loaded by
  `scripts/smoke.js`, which runs in CI against a URL and must not open
  the database. It used to be a literal `["all", "coordinated"]` in
  five places; adding a third to some and not the others is exactly the
  drift that took the dashboard down over the period list.

- **The roster matches on NAME, exactly, and never on substring.**
  `user.list` is incomplete so ids can't be the key, but the name is on
  every schedule. Substring matching is actively wrong here: "Anna Jones"
  as a substring also hits "Giovanna Borgiotti" and "Hanna Rocks", both
  real people in the live data. Two silent failure modes are therefore
  reported on the page rather than swallowed — a rostered name matching
  zero events, and one name resolving to two Ashby user ids (two people
  merged). A mid-window rename (one id, two names) is reported too.

- **Candidate drop-offs are identical in both scopes** and cannot be
  otherwise: they are a property of the application, not of whoever booked
  a slot on it.

- **Period keys and scope keys must never share a word.** Periods are
  `week`/`month`/`quarter`/**`full`**; scopes are `all`/`coordinated`.
  `all` previously meant both "the full 12-month window" and "every
  scheduler", and that collision took the dashboard down twice —
  `payload.periods[state.period]` resolved to undefined and every stat
  tile threw. A test asserts the two vocabularies stay disjoint.

- **Period options are defined ONCE, in `PERIODS` in metrics.js, and
  served to the browser via /api/config.** They used to be written out in
  three places — the per-client loop, the overview loop, and the button
  list in app.js — and the three drifted: adding "12 months" to the UI
  while two backends still produced only week/month/quarter is precisely
  what broke. `public/app.js` builds its control and takes its default
  from the server, so the UI cannot select a period the server does not
  produce. Don't hardcode a period list anywhere.

- **The payload contract checks DYNAMIC lookups, not just static paths.**
  app.js does `payload.periods[state.period]`; a static path list happily
  certified `periods.week` while the page was actually set to a key that
  did not exist. `dynamicClientPaths`/`dynamicOverviewPaths` enumerate
  every scope x period the UI can reach, and both the offline test and
  the smoke test additionally assert the exact DEFAULT state renders.

- **`byRole`, `byStage` and `heatmap` are keyed by PERIOD, not flat
  arrays.** `payload.byRole.all`, `.quarter`, `.month`, `.week`. They used
  to be single arrays over the whole window, which meant the 7/30/90
  toggle moved the stat tiles and the client-tab chart and silently drove
  nothing else — on the Overview it didn't even move the chart directly
  beneath it. All four variants ship in one payload so switching is an
  object lookup with no refetch; a per-role daily matrix for the client to
  re-aggregate would be ~18,000 sparse entries on Forus, more than all four
  variants together. A "12 months" option was added to the control at the
  same time, because wiring the toggle without it would have quietly cut
  every breakdown from 12 months to 90 days.

- **Breakdowns stop at today; the time series does not.** Interviews
  booked ahead stay in `series.daily`/`series.weekly` (drawn faded) but are
  excluded from every breakdown, so "by role, last 90 days" never mixes
  work done with work pending.

- **Roles group by job id, never by title, and nothing is auto-merged.**
  Luminai has three "Forward Deployed Engineer" reqs at three levels and
  two "Deployment Strategist" reqs sharing a title exactly. Merging on a
  title prefix would overstate a single req; merging exact duplicates would
  be right in the Deployment Strategist case and wrong in others, and
  nothing in the data tells them apart. So exact duplicates get "(1)"/"(2)"
  (oldest req first) and related titles stay separate. Don't "fix" the
  duplicate-looking rows by merging them.

- **Ashby `.list` endpoints are not complete, as a rule. Always gap-fill
  by id.** Three found so far, each discovered only after it had silently
  corrupted a number:
  - `interview.list` omits definitions that are not even archived — 88% of
    Forus's events had no title, so the hold rule never ran on them.
  - `user.list` omits accounts behind 1,789 of January's scheduled events.
  - `job.list` omits **Draft** jobs even with `includeArchived: true`,
    so their events render as "Unknown role".

  The fix in every case is the same: find the ids referenced by stored
  rows that have no matching record, and resolve exactly those through the
  matching `.info` endpoint at concurrency 8. Assume the next `.list` you
  add has the same problem and check before trusting it.

- **`interview.list` is NOT a complete list of an org's interview
  definitions, and no flag makes it one.** Confirmed live: it returns 83
  for Luminai while its events reference 118 more, `includeArchived`
  changes nothing, and the omitted ones are not even archived — the
  most-used missing one resolves via `interview.info` with
  `isArchived: false`. Before `syncInterviewDefinitions()` existed this hit
  88% of Forus's events, and the failure was silent in one direction: an
  event with no title can't be tested against the hold keywords, so holds
  counted as interviews and debriefs were undercounted. Don't "simplify"
  this back to a single `interview.list` call. The page reports both the
  last resolution time and any still-unresolvable events, because new ones
  appear over time.

- **Meals are COUNTED, not excluded, and the same rule applies to every
  client.** Forus's 469 meal events are all attached to a named candidate's
  application, 463 sit in an Onsite stage, and the median has two
  interviewers — coordinated candidate time, identical in kind to Poetic's
  work-trial meals. Excluding them dropped 706 real events. They're also
  surfaced as a named sub-count on each tab, so the composition of a total
  is on the page. Don't add a per-client meal toggle: divergent definitions
  would make the combined overview row meaningless.

- **Hold matching is WHOLE-WORD, and must stay that way.** As a plain
  `includes()` it silently excluded 297 real interviews: "hold" inside
  "Stakeholder Conversation" (241 events), "lunch" inside "Lunchtime Chat"
  (44), "break" inside "Breakfast with Kesava" (12). Nothing on the page
  showed it — the interviews were simply absent — which is why the
  excluded titles are now listed in the UI, not just counted. Don't
  "simplify" the regex back to a substring test.

- **Job exclusion is an EXACT title match, unlike the interview-title
  rule right above it.** A substring rule on "test" would silently delete a
  genuine "Test Engineer" role and the page would just show a smaller
  number. `test/metrics.test.js` pins both halves: a "TEST PIPELINE" req is
  dropped from every total, and a "Test Engineer" req survives.

- **Reschedules are reported two ways on purpose, and both are labelled on
  the page.** Ashby has no reschedule history and no cancellation reason
  (verified across schedule fields, event fields, `application.listHistory`
  and `extraData`). The derived figure infers one from cancelled-then-
  re-booked schedules and covers the full window; the observed figure is
  exact but only counts forward from first sync. Don't collapse them into
  one number — the honesty is the feature, and `renderDataQuality()` exists
  to say so in the UI.

- **`sumWindow()` has an exclusive upper bound, and removing it silently
  inflates every period.** Interviews are booked ahead, so the daily series
  legitimately contains future dates. The original "last 7 days" sum had no
  upper bound and swept in everything on the calendar for next month,
  reporting it as volume delivered this week. `test/metrics.test.js` pins
  this.

- **Charts fade from `fadeFrom` onward: tomorrow for daily bars, the
  current Monday for weekly ones.** The in-progress week is only partly
  elapsed. Drawn solid, every chart ends in a cliff that reads as a
  collapse in volume rather than a Tuesday.

- **Median booking turnaround excludes gaps under a minute.** A direct
  booking creates the schedule and the event in the same instant, so its gap
  is zero and those dominate the sample — with them in, Forus's median was
  0h against a p90 of 23.4h. The tile shows the waited/booked-outright split
  rather than hiding the bimodality.

- **Day and week bucketing happens in JS, not SQL.** SQLite has no IANA time
  zone support, and each client's tab buckets in its own zone. `localBuckets()`
  also builds week keys from the *local* calendar date, so a Sunday-evening
  US interview doesn't land in the following week — `test/buckets.test.js`
  pins both that and the DST behaviour.

- **Metrics are computed once per sync and cached, never per request.**
  `syncAll()` calls `metrics.rebuild()` itself when it finishes, so callers
  don't have to remember — one of them (the scheduler) originally didn't.

- **`scheduledBy` is a user object, not a string.** node:sqlite refuses to
  bind an object rather than coercing it, which is how this surfaced. Stored
  split into `scheduled_by_id`/`scheduled_by_name`; it names who actually
  booked each slot, which is per-coordinator attribution data if that is ever
  wanted.

- **Coordinator and recruiter are stored on every application but not shown
  anywhere.** The agreed attribution is per client, not per coordinator
  within a client. The columns exist so a breakdown is a query away rather
  than a re-sync.

- **`node:sqlite`, not `better-sqlite3`.** No native build means a deploy
  can't fail on node-gyp or a blocked install script — which it did locally
  on the first attempt. It has no `db.transaction()` helper, hence the
  `transaction()` wrapper in `db.js`.

- **Every table is keyed on `(client_id, id)`.** Ashby ids are per-org UUIDs
  with no cross-org uniqueness guarantee and this process holds five orgs in
  one file.

- **One shared Basic Auth credential, checked in `src/auth.js` only.** The
  agreed posture is internal-first: everyone who can log in sees every tab.
  A client-facing per-client view needs real per-user auth, and keeping the
  decision in one file is what makes that a contained change.

- **Watch patterns live in `railway.json`, NOT the Railway dashboard.**
  Config-as-code overrides the dashboard for any field it sets, so editing
  watch paths in the UI will appear to work and then be silently ignored on
  the next deploy — change `railway.json` instead. Two things to know about
  the patterns: they are **repo-root-relative even though the service has a
  root directory** (hence the `/coordinator-metrics/` prefix on every one),
  and a `!` negation only takes effect if an earlier rule included the files
  it excludes, so the broad include has to come first. The root directory
  itself is the one setting that cannot go in this file and still lives in
  the dashboard.

- **Doc-only changes deliberately do not redeploy.** A redeploy restarts the
  container mid-sync, and the nightly full sync takes about 21 minutes.

- **CI waits for the deployed commit, not for a 200.** `/api/config`
  reports `commit` (from `RAILWAY_GIT_COMMIT_SHA`), and the workflow
  polls until it equals the SHA under test. `/healthz` deliberately does
  NOT carry it — that endpoint is unauthenticated. A health-only wait
  cannot distinguish the new deployment from the old one still serving,
  and when a Railway webhook was dropped, a committed fix sat undeployed
  overnight with every check green. If that happens again the fix is
  `railway redeploy --from-source`.

- **Booking turnaround measures from `application_stages.entered_at`,
  not from the schedule's own `createdAt`.** Ashby records no timestamp
  for a schedule entering `NeedsScheduling` — a schedule carries only
  createdAt/updatedAt and a current status. Measuring from createdAt gave
  a median of 0.2 hours, because a direct booking creates the schedule
  and its first event in the same instant; it was measuring nothing. The
  anchor is the application entering that schedule's interview stage,
  from `application.info`'s embedded `applicationHistory[]` — verified to
  match on 100% of sampled schedules across all six clients. It is
  reported in BUSINESS hours: a Friday-evening request booked Monday
  morning is 64 clock hours and about 2 business hours.

- **Time between stages is anchored on interviews, not on history
  entries.** Measured from `applicationHistory` transitions the median is
  ~0 days, because a bulk stage advance moves an application through
  several stages in milliseconds. The metric instead orders each
  application's interviewed stages by their own first interview and
  measures the end of one to the start of the next, so stages passed
  through without an interview are correctly absent.

- **Reschedule rate is per ROUND (application + stage), not per
  schedule.** A round that was cancelled and re-booked appears as two
  schedules; counting schedules would record the same round twice and
  call one of them untouched.

- **The areas-to-work-on panel uses the SAME attribution fallback as the
  cancellation rate.** Filtering it on `scheduled_by_name` alone dropped
  the 92% of Luminai's cancelled schedules Ashby leaves unattributed and
  collapsed the panel from 315 cancellations to 1.

- **Ashby has no URL for a filtered list view.** The only link shapes
  that work are a candidate's application feed, a candidate profile, and
  `/schedules/{id}`. A group row therefore cannot link to "cancelled,
  role = X"; rows expand to the individual records instead.

- **Results metrics are NOT comparable between clients, and the page is
  built to prevent that reading.** Each reflects that client's own
  interview mix, stage design and volume. They appear on client tabs
  only, measured against that client's own prior period; the Overview
  shows a RANGE with no client named; nothing ranks clients on them.
  Luminai at 10 business hours against Runlayer at 6 looks like a gap,
  but Luminai has a fifth of the volume and a 40% longer tail. Don't add
  a Results column to the by-client table or sort anything by them.

- **They are not individual performance measures either.** Several
  coordinators work a client, work moves between them, and Ashby records
  only who CREATED a booking — not who chased it, re-planned it, or
  picked it up. The Results group says so on the page.

- **A client tab is a left rail plus one open page, not an accordion.**
  The accordion hid every number behind a click, so a tab told you
  nothing at a glance and comparing two sections meant opening one and
  closing the other. The rail is both the contents list and the summary
  — it carries each section's key figure — and the sections below stay
  open. `trackRail()` highlights whichever section is in view. Don't
  reintroduce collapsing for the main sections; the two genuinely
  secondary ones (data quality, method) stay collapsed at the foot.

- **The Overview's period toggle lives on the chart, not in the page
  head.** The overview's `periods` carry only `events` and `hours`, so
  the four tiles, the Results ranges and the by-client table are all
  12-month figures and cannot follow it. At the top of the page it read
  as driving all of them, and the by-client heading dutifully relabelled
  itself "last 30 days" over numbers that had not moved. The window the
  rest of the page covers is stated once, in the head. If the toggle
  should ever drive the tiles, `computeOverview` has to produce
  candidates/roles/interviewerSlots per period first.

- **The Carrara-vs-client panel gates every row on ITS OWN sample, not
  on the panel's event count.** The two are very different numbers:
  Luminai's client-side reschedule rate rests on 105 rounds against 128
  interviews, and over 7 days both collapse to single figures while the
  event count still clears the panel floor. One late booking out of
  four is a 25-point swing wearing the clothes of a finding. Below
  `COMPARE_MIN_SAMPLE` a row prints "too few to compare" with the
  count, and no row gets a better/worse verdict it cannot carry.

- **The Carrara-vs-client panel holds THREE rows — interviews, short
  notice, cancelled-never-rebooked — and marks neither side better.**
  Booking turnaround and reschedule rate were removed on 27 October
  2026 and must not come back. Two separate findings put them out:

  *Colour first.* The original panel coloured the winner of each row.
  Live, it said the client's own team books faster at four of five
  clients and reschedules less at all five — a verdict the data cannot
  support, and the same mistake as ranking clients on Results.

  *Then the rows themselves.* The direct-booking hypothesis was tested
  properly: schedule and first event created in the same instant,
  excluded from BOTH sides, recomputed per client. The exclusion cut
  13–41% of the client-side turnaround sample against under 9% of
  ours — and the gaps held. Turnaround moved by at most an hour in
  either direction; Runlayer's reschedule gap WIDENED by 6.5 points.
  So the gap is not booking style, it is selection: a coordinator gets
  the panels, the onsites and the rounds that already went wrong, and a
  round picked up BECAUSE it was rescheduled counts that reschedule
  against whoever picked it up. No exclusion fixes a different
  population of work.

  Forus is the clearest case and the reason the numbers are kept:
  Carrara touched 371 of its ~17,000 interviews and moved 35.8% of
  those rounds against the client's own 8.4%. As a comparison it says
  we are worse. As escalation load it says Forus sends us its hardest
  rounds, which is true and useful.

- **Those two live in "Escalation load", beside areas-to-work-on, with
  a sample gate.** Both sides shown, neither marked, sample printed
  next to every figure, and anything under `ESCALATION_MIN_SAMPLE`
  greyed and labelled. Luminai's client side is 73 turnaround
  observations against our 959; a median on 73 must not sit at full
  weight beside one on 959. Don't move these back into the comparison
  panel and don't drop the sample labels.

- **The roster panel is a MATCH CHECK, collapsed and alphabetical.** It
  confirms each rostered name resolves to real scheduled work — that is
  how a misspelled name, a renamed account or a coordinator assigned to
  the wrong client gets caught (it found Meredith Faria and Sadiqeh
  Agah). It is not a workload or performance measure, and the page says
  so rather than leaving it implied. Sorted by event count it reads as a
  leaderboard whatever the heading says, so it is ordered by NAME; don't
  "improve" it by sorting on volume, and don't expand it by default.

- **Access: internal to Carrara leadership.** The client tabs name roles
  and stages where work went wrong and link to individual candidate
  records. One shared password, holder list deliberately short. The
  decision is unchanged, but the on-page "Carrara leadership only"
  marking was removed on request — don't add it back. Not for clients
  or coordinators.

- **The SQLite file is backed up nightly, and `VACUUM INTO` is the only
  correct way to do it.** The database is WAL-mode and written to
  continuously; `cp metrics.sqlite` under load yields a file that may
  open cleanly and be missing committed rows, and you find out when you
  restore. `src/backup.js` takes a read-locked consistent snapshot,
  opens it, runs `PRAGMA integrity_check`, refuses any snapshot with
  zero events or schedules (a wiped volume must not roll a good backup
  out of retention), gzips it, and chains off the nightly full sync so
  it always captures a completed sync. Retention is 30 dailies plus the
  first snapshot of each of 12 months — monthlies matter because the
  failure is often "a table was corrupted three weeks ago", which 30
  dailies do not cover.

  **Without `BACKUP_S3_*` set, the snapshot sits on the SAME volume as
  the database and a volume incident loses both.** That is logged as a
  warning every run and reported as `offsite: false` in
  `/api/config`.`backup`. The dumps contain `candidate_name` and
  `scheduled_by_email` for every client, so the destination must be
  private — and note it is a wider audience than the dashboard
  password, whose holder list is deliberately short.

  SigV4 is hand-rolled in `src/backup-sinks.js` rather than pulling in
  the AWS SDK for one PUT. `test/sigv4`-style coverage in
  `test/backup.test.js` pins it to the worked example published in the
  AWS documentation, so it is tested rather than trusted.

## Conventions

- No build step and no frontend framework, matching the sibling dashboards.
  Charts are hand-built inline SVG.
- Design tokens at the top of `public/style.css` are copied verbatim from
  `candidate-dashboard/public/style.css`. Keep them in sync by copying, not
  by linking — neither app has a build step to resolve an import.
- Per-client settings are suffixed environment variables
  (`ASHBY_API_KEY_FORUS`), not one JSON blob, so each key stays a discrete
  Railway variable.

## Guardrails

- **Read-only against Ashby.** Every endpoint used is a `.list` or `.info`.
  Nothing here writes to a client's ATS, and nothing should start.
- **Secrets never go in the repo.** `.env` is gitignored; real keys live in
  Railway variables.
- **The SQLite file must be on a Railway volume.** The backfill is
  re-derivable at the cost of a long sync; the observed-reschedule history
  is not re-derivable at all.
