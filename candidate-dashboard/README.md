# Candidate issues dashboard

A small dashboard for a recruiting coordinator: at a glance, which candidates
(and interviewers) need attention right now. Nine sections:

| Section | What it flags | Source |
| --- | --- | --- |
| **Stale Candidates** | Pulled out of the two candidate columns below once feedback is overdue past `STALE_FEEDBACK_HOURS` (default 350h) or a schedule has been pending past `STALE_SCHEDULING_HOURS` (default 168h / 7 days) — these have likely fallen through the cracks, not just freshly overdue. | Same sources as the two rows below. |
| **Feedback Overdue** | An interview ended and the interviewer still hasn't submitted their scorecard, past `FEEDBACK_OVERDUE_HOURS` (default 24h). Debrief events are excluded — a debrief is an internal wrap-up meeting with no scorecard due back, so it can never be "overdue." | Ashby `interviewSchedule.list` — `interviewEvents[].endTime` + `hasSubmittedFeedback`, cross-referenced against `interview.list`'s `isDebrief` (a real structural field, not org-configured naming — safe for any client). |
| **Needs Scheduling** | Nothing has been sent to the candidate yet — no availability request, no self-schedule link — past `NEEDS_SCHEDULING_ALERT_HOURS` (default 48h). | Ashby `interviewSchedule.list` — `status: "NeedsScheduling"`. |
| **Availability Submitted** | The candidate replied with their availability; waiting on someone to book it. Shown regardless of age (not threshold-gated); `AVAILABILITY_SUBMITTED_ALERT_HOURS` (default 24h) only drives the amber/red color-coding. | Ashby `interviewSchedule.list` — `status: "CandidateAvailabilitySubmitted"`. |
| **Interviewer Weekly Limits** | An interviewer whose remaining weekly interview capacity has dropped to `INTERVIEWER_LIMIT_BUFFER` slots or fewer (default 1) — i.e. their Ashby-configured `weeklyLimit` minus interviews already on their calendar this week (Mon–Sun UTC). Interviewers with no `weeklyLimit` set never appear. | Ashby `user.interviewerSettings` (the limit) + `interviewSchedule.list` event data (the count). |
| **Recently Sourced** | Candidates whose application was **created** in the last `SOURCED_LOOKBACK_DAYS` (default 3) with a referral or agency source. All statuses shown (Active/Archived/Hired/Lead), labeled per card. | Ashby `application.list` (`createdAfter` + `source.sourceType`). |
| **Onsite Interviews Today** | Today's final-round and executive interview events, shown in a persistent right-margin column with a deliberately heavier border than the rest of the page. "Onsite" is **approximated**: Ashby has no per-interview location/format field anywhere in this org (checked interview events, interview definitions, interview stages, and all 38 org custom fields), so this matches on the interview stage title containing "final" or "exec" instead, per explicit product decision. "Today" is a UTC calendar day; display times render in the browser's local zone. | Ashby `interviewSchedule.list` (the same fetch `listIssues()` already does — no extra pagination call) + `interviewStage.info` per unique stage id involved. |
| **Interviewer Training** | Every interviewer currently enrolled in a pool's training path — real Ashby `Shadow`/`ReverseShadow` roles (not a naming-convention guess), with progress toward each stage's required interview count. Paused trainees are hidden by default behind a "Show N paused interview trainees" toggle, since a paused trainee isn't actionable the way an active one's progress is; toggling reveals them, sorted before active trainees. Not tied to any candidate/application. | Ashby `interviewerPool.list` + `interviewerPool.info` per pool with an enabled `trainingPath` (small, bounded — 22 pools on this org). |
| **Rescheduled Interviews** | Interview events whose reschedule count exceeds `RESCHEDULE_COUNT_THRESHOLD` (default 2, i.e. the 3rd reschedule onward). **Ashby has no reschedule history anywhere in its API** — checked schedule fields, event fields, `application.listHistory`, and `extraData` across a live sample of 131 events; only the event's *current* `startTime` exists. This app tracks it itself: each refresh, compares every event's `startTime` against what it last saw for that event id and increments a persisted counter when it changes. Counting starts at zero the first time a given event is ever seen — it can only catch reschedules from then on, not any that happened before. | Ashby `interviewSchedule.list` (the same fetch `listIssues()` already does) + this app's own persisted `<DATA_DIR>/reschedule-tracking.json`. |

Every candidate appears in **at most one** of the five sections above
(Feedback Overdue, Needs Scheduling, Availability Submitted, Onsite
Interviews Today, Stale Candidates) — never several at once. If a candidate
has activity across more than one (say, an old interview whose feedback is
still outstanding, and a newer round scheduled for today), only their single
most recent event is kept; the rest are dropped rather than shown twice or
moved to Stale Candidates.

## Pages

The page is split into two tabs (`.tab-btn`/`.tab-panel` in `index.html` and
`app.js` — plain DOM show/hide via the `hidden` attribute, no router):

- **Dashboard** (default) — every candidate-facing section above plus
  Rescheduled Interviews and the department/job/recruiter/coordinator filter.
- **Interviewer Info** — Interviewer Weekly Limits and Interviewer
  Training, which aren't tied to a candidate and aren't affected by the
  filter, so they live on their own tab out of the way of the
  candidate-facing sections.

Both tabs' data refreshes on the same cycle and renders on every poll
regardless of which tab is currently visible — switching tabs is instant
and never shows stale content, since it's just toggling which already-
rendered panel is hidden.

## Section keys

Every section has a stable key, used as its `<section data-key="...">`
attribute in `index.html`, its field name in the `/api/issues` snapshot
(`issues.js`/`ashby.js`), and its `DISABLED_SECTIONS` entry (see below):

| Key | Section |
| --- | --- |
| `feedbackOverdue` | Feedback Overdue |
| `needsScheduling` | Needs Scheduling |
| `availabilitySubmitted` | Availability Submitted |
| `staleCandidates` | Stale Candidates |
| `interviewerLimits` | Interviewer Weekly Limits |
| `recentSourced` | Recently Sourced |
| `onsiteToday` | Onsite Interviews Today |
| `rescheduledInterviews` | Rescheduled Interviews |
| `interviewerTraining` | Interviewer Training |

`config.js`'s `SECTION_KEYS` array is the single source of truth for this
list — keep it, this table, and each section's `data-key` in sync if a
section is ever added, renamed, or removed.

### Disabling a section per client

Set `DISABLED_SECTIONS` (comma-separated keys from the table above) to hide
sections a client has no use for — e.g. a client that doesn't configure
Ashby `weeklyLimit`s has no reason to show an always-empty Interviewer
Weekly Limits. The frontend (`applyDisabledSections()` in `app.js`) removes
the section's `<section>` element and its nav link entirely (not just
`hidden`), and collapses the wrapper around it (`.row-pair`, `.side-margin`)
if that was its only remaining child — so a disabled section never leaves a
gap or an unbalanced column. The backend still computes every section's
data regardless of `DISABLED_SECTIONS` (it's a display-only toggle); only
rendering is skipped.

Two safeguards against a silent typo: on startup, `config.js` logs the full
list of recognized keys (`[config] Recognized section keys: ...`), and
warns on any `DISABLED_SECTIONS` entry that doesn't match one of them
(`[config] Warning: DISABLED_SECTIONS entry "..." doesn't match any known
section key`) — both visible in deploy logs, so a typo (e.g.
`interviewerWeeklyLimits` instead of `interviewerLimits`) is loud rather
than just quietly leaving the section visible.

## Department / Job / Recruiter / Coordinator filter

A multi-select menu at the top of the page filters every candidate-facing
section (Stale Candidates, Feedback Overdue, Needs Scheduling, Availability
Submitted, Recently Sourced, Onsite Interviews Today). A segmented
**Department / Job / Recruiter / Coordinator** toggle picks which field it
filters on — only one is ever live at a time (switching doesn't AND
multiple fields together, it replaces which one is active), and each
remembers its own selection independently, so switching back and forth
doesn't lose any of them. **Interviewer Weekly Limits is not affected** by
any mode — an interviewer isn't tied to one department/job/recruiter/
coordinator the way a candidate's application is, so there's no natural
mapping to filter by.

- **Department options** come from Ashby's `department.list` (12 total on
  this org, including 2 archived — fetched with `includeArchived: true` so a
  job whose department was later archived still resolves to a real name
  instead of a blank).
- **Job/Recruiter/Coordinator options** are all derived client-side from
  whichever ones are actually represented among the candidates currently
  shown across all sections — there's no separate org-wide list call for
  any of them. This is deliberate: a full `job.list` would include every
  closed/archived job in the org (dozens to hundreds), making for a
  mostly-irrelevant dropdown; deriving from the candidates already on
  screen keeps every option meaningful. Recruiter/Coordinator come from
  each application's `hiringTeam[]` (already present on every
  `application.list`/`application.info` result — no extra lookup),
  matched by exact role name (`RECRUITER_ROLE_NAME`/`COORDINATOR_ROLE_NAME`,
  defaults `Recruiter`/`Recruiting Coordinator` — **this org's actual
  `hiringTeamRole.list` values, not an Ashby-wide standard**; verify with
  `scripts/check-ashby-compatibility.js` before onboarding a new client).

The button opens a checkbox dropdown (mirroring the existing per-card
dismiss-menu's fixed-position/anchor-to-button pattern); any number of
options can be checked at once, and a candidate is shown if their
department/job/recruiter/coordinator is any of the checked ones (an OR, not
an AND). No selection means no filter ("All departments", etc). The button
label reflects the current selection: "All departments", a single option's
name, or "N departments"/"N jobs"/etc.

The filter is purely client-side: department options and each candidate's
`departmentId`/`jobId`/`recruiterId`/`coordinatorId` are already part of the
normal `/api/issues` payload, so checking/unchecking an option or switching
modes re-renders instantly from the already-fetched snapshot — no
additional network request.

Two things were scoped out because Ashby has no data for them:

- **"Awaiting Reply"** (candidate emailed back but no one replied) — no
  email-activity endpoint; would need a Gmail integration.
- **"Declined meetings"** (declined by interviewer or candidate) — a
  `Cancelled` schedule carries no reason code (checked a real example: no
  cancellation-reason field at all), and none of Ashby's other statuses
  distinguish a decline from a reschedule or any other cancellation. A real
  decline signal would live in Google Calendar's attendee RSVP status (each
  event carries an `interviewerCalendarEventId`), which would need a Calendar
  integration.

Both were dropped for now to keep this Ashby-only; revisit if either
integration becomes worth the added complexity.

## Scope

This dashboard does **not** scan every "Active" application in Ashby. In this
org, the vast majority of active applications sit untouched in
**Application Review** — no interview activity, nothing to flag. Instead:

1. It pulls interview schedules created in the **last 30 days**
   (`SCHEDULE_LOOKBACK_DAYS` in `src/ashby.js`) — this is the bounded, fast
   call.
2. It looks up full details only for the applications those schedules
   reference (not the whole org), and drops anything no longer Active or
   still sitting in Application Review.

Tradeoff: an interview stuck in `NeedsScheduling` for more than 30 days
without any update would age out of this window and stop being flagged.
That's an intentional bound to keep each refresh cycle fast rather than
paginating thousands of records; increase `SCHEDULE_LOOKBACK_DAYS` if you'd
rather trade speed for catching very old stragglers.

**Recently Sourced** queries `application.list` directly too, but bounded to
`createdAfter` = the last `SOURCED_LOOKBACK_DAYS` (default 3), so it's ~100
records, not the whole org. It intentionally does *not* apply the
Active-only / past-Application-Review filter the other sections do: a
candidate referred or agency-submitted 3 days ago is normally still in
Application Review and may be any status.

## Correction: "Needs Scheduling" vs. "Availability Submitted"

An earlier version of this README claimed Ashby's `interviewSchedule.status`
only had three values (`NeedsScheduling` / `Complete` / `Cancelled`) and that
"has the candidate submitted availability" wasn't representable at all. That
was wrong — it was based on too small a sample of live data. The real status
enum, confirmed against this org, is much more granular:

```
NeedsScheduling → WaitingOnCandidateAvailability / WaitingOnCandidateBooking
                → CandidateAvailabilitySubmitted → Scheduled → WaitingOnFeedback → Complete
                                                                          (or Cancelled at any point)
```

- `NeedsScheduling` — nothing sent yet. This is the **Needs Scheduling** section.
- `WaitingOnCandidateAvailability` / `WaitingOnCandidateBooking` — an
  availability-request email or a self-schedule link *was* sent; waiting on
  the candidate. Not currently surfaced as its own section.
- `CandidateAvailabilitySubmitted` — the candidate replied with their times;
  waiting on someone to book. This is the **Availability Submitted** section.

So "Needs Scheduling" and "Availability Submitted" are genuinely distinct and
mutually exclusive states, not an ambiguous single flag — no custom field was
ever needed for this.

## Prerequisites

- Node.js 18+
- An Ashby API key (Admin → Integrations → API Keys)

## Setup

```bash
cp .env.example .env
npm install
```

Fill in `.env`:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DASHBOARD_USER` | yes | HTTP Basic Auth username, required in front of every route (including `/api/*`). One shared set of credentials, not per-user. |
| `DASHBOARD_PASSWORD` | yes | HTTP Basic Auth password. Compared with `crypto.timingSafeEqual`, not `===`. |
| `ASHBY_API_KEY` | yes | Reads applications and interview schedules. |
| `ASHBY_APP_BASE_URL` | no | Only change for a custom Ashby domain. |
| `FEEDBACK_OVERDUE_HOURS` | no | Default `24`. |
| `NEEDS_SCHEDULING_ALERT_HOURS` | no | Default `48`. This is a dashboard-defined threshold, not an Ashby concept. |
| `STALE_FEEDBACK_HOURS` | no | Default `350`. Feedback-overdue candidates past this move to Stale Candidates instead. |
| `STALE_SCHEDULING_HOURS` | no | Default `168` (7 days). Needs-scheduling candidates past this move to Stale Candidates instead. |
| `INTERVIEWER_LIMIT_BUFFER` | no | Default `1`. An interviewer is flagged once remaining weekly capacity drops to this many slots or fewer. |
| `SOURCED_LOOKBACK_DAYS` | no | Default `3`. Recently Sourced shows referral/agency applications created within this many days. |
| `AVAILABILITY_SUBMITTED_ALERT_HOURS` | no | Default `24`. Color-coding threshold only — every submitted-and-unbooked candidate is shown regardless of age. |
| `REFRESH_INTERVAL_MINUTES` | no | How often the server re-pulls Ashby for the nine sections. Default `5`. The page itself polls the cached snapshot every 60s regardless. |
| `RESCHEDULE_COUNT_THRESHOLD` | no | Default `2`. Flags an interview event once its (self-tracked) reschedule count exceeds this. See § Rescheduled Interviews above. |
| `DATA_DIR` | no | Where dismissals (`dismissals.json`) and self-tracked history (`reschedule-tracking.json`) are persisted. Resolution order: `RAILWAY_VOLUME_MOUNT_PATH` (set automatically by Railway when a volume is attached — no manual config needed there) → `DATA_DIR` → `./data`. On any other cloud host, set `DATA_DIR` to a mounted volume so this state survives redeploys; on Railway, just attach a volume and both env vars can be left unset. The resolved path is logged on startup (`[server] Data directory: ...`). |
| `SCHEDULE_LOOKBACK_DAYS` | no | Default `30`. How far back `interviewSchedule.list` is pulled for the schedule-driven sections. Tune per client's interview volume — see § Scope. |
| `SOURCE_REFERRAL_KEYWORDS` / `SOURCE_AGENCY_KEYWORDS` | no | Defaults `referr` / `agenc`. Comma-separated, case-insensitive substrings matched against `source.sourceType.title` to classify Recently Sourced. **Every Ashby org names these differently** — run `scripts/check-ashby-compatibility.js` against a new client before trusting the defaults. Set to an empty value to disable a category. |
| `ONSITE_STAGE_KEYWORDS` | no | Default `final,exec`. Comma-separated, case-insensitive substrings matched against interview stage titles to approximate "onsite" (Ashby has no real location signal — see § Onsite Interviews Today). **January's convention, not an Ashby default** — verify with `scripts/check-ashby-compatibility.js` before onboarding a new client. Empty value disables the section. |
| `CLIENT_NAME` | no | Single source of truth for the client this deployment is for. Drives the browser tab title and page header: `"<CLIENT_NAME> Coordination Dashboard"`. Unset means a plain, unbranded `Candidate Dashboard`. |
| `DASHBOARD_TITLE` | no | Full override for the title/header text above — wins outright over the `CLIENT_NAME`-derived title if set. Only needed when the title doesn't fit the `"<name> Coordination Dashboard"` shape; not part of `.env.example` since most deployments won't need it. |
| `CLIENT_ACCENT_COLOR` | no | Overrides the header accent color (topbar border + title text, default Carrara ember) so each client deployment is visually distinguishable at a glance. Any valid CSS color. |
| `RECRUITER_ROLE_NAME` / `COORDINATOR_ROLE_NAME` | no | Defaults `Recruiter` / `Recruiting Coordinator`. Exact `hiringTeamRole.list` values (not a substring match) used for the Recruiter/Coordinator filter. **This org's actual role names, not an Ashby standard** — verify with `scripts/check-ashby-compatibility.js` before onboarding a new client. |
| `DISABLED_SECTIONS` | no | Comma-separated section keys (see § Section keys) to hide from this client's dashboard entirely. Empty by default (nothing hidden). An unrecognized key logs a startup warning rather than silently doing nothing. |

## Onboarding a new client

This was originally built against one specific Ashby org (January) and some
behavior is a best-effort approximation rather than something Ashby's API
actually guarantees for every org:

- **Source classification** (`SOURCE_REFERRAL_KEYWORDS`/`SOURCE_AGENCY_KEYWORDS`)
  keyword-matches `source.sourceType.title` — every org names its source
  types differently.
- **Onsite Interviews Today** (`ONSITE_STAGE_KEYWORDS`) keyword-matches
  interview stage titles, because Ashby has no structured onsite/location
  field anywhere. "final"/"exec" is January's naming convention, not
  anything Ashby-standard.
- **Interviewer Weekly Limits** only shows anything if the client actually
  uses Ashby's `weeklyLimit` interviewer-settings feature — some orgs never
  configure it, in which case this section is correctly empty, not broken.
- **Recruiter/Coordinator filter** (`RECRUITER_ROLE_NAME`/
  `COORDINATOR_ROLE_NAME`) matches an exact `hiringTeamRole.list` value —
  this org's roles happen to be "Recruiter"/"Recruiting Coordinator", but
  that's this org's naming, not an Ashby default.
- **Interviewer Training** only shows anything if the client actually uses
  Ashby's interviewer-pool training-path feature — some orgs never
  configure it, in which case this section is correctly empty, not broken.
  Unlike the naming-convention items above, this one uses real Ashby
  `Shadow`/`ReverseShadow` enum values, so there's no keyword to tune —
  it's purely a "does this org use this Ashby feature" question.

Before turning this on for a new client, run:

```bash
node scripts/check-ashby-compatibility.js --api-key=<their Ashby API key>
```

It queries their Ashby org read-only (never creates/updates/deletes
anything) and reports, section by section, whether it'll work out of the
box, needs one of the keyword env vars above tuned to their naming, or will
be empty because of an Ashby-side configuration choice outside this app's
control — printing the actual source-type and stage titles it found so you
can pick the right keywords rather than guessing. See the script's own
header comment for all CLI options.

## Run

```bash
npm start
```

Open `http://localhost:3000`. The background refresh loop for all seven
sections starts immediately on startup and then runs on its own interval;
there's also a "Refresh now" button on the page for an on-demand pull.

## Dismissing cards

Every card has a **×** in its top-right corner. Clicking it offers two options:

- **Hide until tomorrow** — the card reappears at the next local midnight.
- **Hide indefinitely** — the card stays hidden until manually un-dismissed.

Dismissals are per-candidate (they hide that person from *all* candidate
sections at once) or per-interviewer (for the Interviewer Weekly Limits
section), and are persisted to `<DATA_DIR>/dismissals.json` so "indefinitely"
survives restarts. There's no un-dismiss button in the UI yet; to bring a
card back, either wait for its "until tomorrow" window to lapse, `POST
/api/undismiss` with `{ "key": "candidate:<id>" }`, or delete the relevant
entry from `dismissals.json`.

## Files

| File | What it does |
| --- | --- |
| `src/index.js` | Entry point — starts the server + background refresh loop. |
| `src/config.js` | Reads and validates env vars. Also owns `SECTION_KEYS` (see § Section keys) and warns on startup about any unrecognized `DISABLED_SECTIONS` entry. |
| `src/server.js` | Express app: serves the static dashboard, `GET /api/issues`, `POST /api/refresh`, `POST /api/dismiss`, `POST /api/undismiss`. |
| `src/ashby.js` | Paginated Ashby client; computes Feedback Overdue, Needs Scheduling, Availability Submitted, Stale Candidates, Interviewer Weekly Limits, Recently Sourced, and Onsite Interviews Today. |
| `src/concurrency.js` | `mapWithConcurrency` — bounds parallel `application.info` / `user.interviewerSettings` lookups. |
| `src/dismissals.js` | Persisted store of dismissed cards (`dismissals.json`); handles "today" expiry and "forever". |
| `src/issues.js` | Orchestrates the nine sections (schedule/application-driven, plus interviewer training pool data), guards against overlapping refreshes, filters out dismissed cards at serve time, holds the cached snapshot. |
| `src/rescheduleTracking.js` | Persisted (`<DATA_DIR>/reschedule-tracking.json`) reschedule counter per interview event id, since Ashby has none of its own — see § Rescheduled Interviews above. |
| `public/` | The dashboard itself — plain HTML/CSS/JS, polls `/api/issues` every 60s. |

## Notes & limitations

- Only **Active** Ashby applications are considered (not Hired/Archived/Lead),
  and only those past Application Review (see Scope above) — **except**
  Recently Sourced, which shows all statuses. In that section, only Active
  candidates get a clickable Ashby link; others show as plain text because
  the profile URL hardcodes the "active" pipeline segment (see below).
- The Ashby profile link uses the `.../pipeline/active/...` URL pattern, which
  is only verified for Active applications. Recently Sourced therefore links
  Active candidates only; a non-Active candidate's row is intentionally
  unlinked rather than pointing at a URL that may 404.
- Interview-schedule lookback is 30 days — anything older and still
  unresolved wouldn't surface (see Scope above for the tradeoff). This also
  bounds Interviewer Weekly Limits: an interview booked more than 30 days ago
  for a slot this week wouldn't be counted toward that interviewer's load.
- Interviewer Weekly Limits counts interviews for the current calendar week
  (Monday 00:00 UTC through Sunday), regardless of timezone settings in Ashby
  itself. Cancelled schedules don't count toward load.
- If an Ashby refresh fails outright, the dashboard keeps serving the last
  good snapshot rather than going blank, and shows the error next to the
  "Updated" timestamp.
- If a refresh is still running when the next one would normally start
  (interval tick, or clicking "Refresh now"), the new one is skipped rather
  than run concurrently — you'll see `refresh already in progress, skipping
  duplicate trigger` in the server log.
