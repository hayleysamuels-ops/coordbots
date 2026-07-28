# Candidate issues dashboard

A small dashboard for a recruiting coordinator: at a glance, which candidates
(and interviewers) need attention right now. Eight sections:

| Section | What it flags | Source |
| --- | --- | --- |
| **Stale Candidates** | Pulled out of the two candidate columns below once feedback is overdue past `STALE_FEEDBACK_HOURS` (default 350h) or a schedule has been pending past `STALE_SCHEDULING_HOURS` (default 168h / 7 days) — these have likely fallen through the cracks, not just freshly overdue. | Same sources as the two rows below. |
| **Feedback Overdue** | An interview ended and the interviewer still hasn't submitted their scorecard, past `FEEDBACK_OVERDUE_HOURS` (default 24h). | Ashby `interviewSchedule.list` — `interviewEvents[].endTime` + `hasSubmittedFeedback`. |
| **Needs Scheduling** | Nothing has been sent to the candidate yet — no availability request, no self-schedule link — past `NEEDS_SCHEDULING_ALERT_HOURS` (default 48h). | Ashby `interviewSchedule.list` — `status: "NeedsScheduling"`. |
| **Availability Submitted** | The candidate replied with their availability; waiting on someone to book it. Shown regardless of age (not threshold-gated); `AVAILABILITY_SUBMITTED_ALERT_HOURS` (default 24h) only drives the amber/red color-coding. | Ashby `interviewSchedule.list` — `status: "CandidateAvailabilitySubmitted"`. |
| **Interviewer Weekly Limits** | An interviewer whose remaining weekly interview capacity has dropped to `INTERVIEWER_LIMIT_BUFFER` slots or fewer (default 1) — i.e. their Ashby-configured `weeklyLimit` minus interviews already on their calendar this week (Mon–Sun UTC). Interviewers with no `weeklyLimit` set never appear. | Ashby `user.interviewerSettings` (the limit) + `interviewSchedule.list` event data (the count). |
| **Recently Sourced** | Candidates whose application was **created** in the last `SOURCED_LOOKBACK_DAYS` (default 3) with a referral or agency source. All statuses shown (Active/Archived/Hired/Lead), labeled per card. | Ashby `application.list` (`createdAfter` + `source.sourceType`). |
| **Active Referrals** | Every currently-Active referral candidate whose application was created within `REFERRAL_LOOKBACK_DAYS` (default 90), by current pipeline stage. Refreshes on its **own independent schedule** from the other seven sections — see § Active Referrals below. | Ashby `application.list` (`status: "Active"` + `createdAfter` on the one-time full scan; incremental afterwards via `syncToken`, unbounded by date), filtered client-side to `source.sourceType` = Referral. |
| **Onsite Interviews Today** | Today's panel/final-round interview events, shown in a persistent right-margin column with a deliberately heavier border than the rest of the page. "Onsite" is **approximated**: Ashby has no per-interview location/format field anywhere in this org (checked interview events, interview definitions, interview stages, and all 38 org custom fields), so this matches on the interview stage title containing "panel" or "final" instead, per explicit product decision. "Today" is a UTC calendar day; display times render in the browser's local zone. | Ashby `interviewSchedule.list` (the same fetch `listIssues()` already does — no extra pagination call) + `interviewStage.info` per unique stage id involved. |

A candidate that crosses a stale threshold appears **only** in Stale
Candidates, not also in its regular column, to avoid double-counting.

## Department / job filter

A multi-select menu at the top of the page filters every candidate-facing
section (Stale Candidates, Feedback Overdue, Needs Scheduling, Availability
Submitted, Recently Sourced, Active Referrals, Onsite Interviews Today). A
segmented **Department / Job** toggle picks which field it filters on — only
one is ever live at a time (switching doesn't AND the two together, it
replaces which one is active), and each remembers its own selection
independently, so switching back and forth doesn't lose either one.
**Interviewer Weekly Limits is not affected** by either mode — an
interviewer isn't tied to one department or job the way a candidate's
application is, so there's no natural mapping to filter by.

- **Department options** come from Ashby's `department.list` (12 total on
  this org, including 2 archived — fetched with `includeArchived: true` so a
  job whose department was later archived still resolves to a real name
  instead of a blank).
- **Job options** are derived client-side from whichever jobs are actually
  represented among the candidates currently shown across all sections —
  there's no separate org-wide job list call. This is deliberate: a full
  `job.list` would include every closed/archived job in the org (dozens to
  hundreds), making for a mostly-irrelevant dropdown; deriving from the
  candidates already on screen keeps every option meaningful.

The button opens a checkbox dropdown (mirroring the existing per-card
dismiss-menu's fixed-position/anchor-to-button pattern); any number of
options can be checked at once, and a candidate is shown if their
department/job is any of the checked ones (an OR, not an AND). No selection
means no filter ("All departments"/"All jobs"). The button label reflects
the current selection: "All departments", a single option's name, or "N
departments"/"N jobs".

The filter is purely client-side: department options, each candidate's
`departmentId` and `jobId` (both from the underlying Ashby application's
`job` object), are already part of the normal `/api/issues` payload, so
checking/unchecking an option or switching modes re-renders instantly from
the already-fetched snapshot — no additional network request, and it works
even while Active Referrals is mid-scan.

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
org, the vast majority of active applications (31,000+, confirmed via a full
Active Referrals scan — see below) sit untouched in
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

**Active Referrals used to be a full active-application scan on every
refresh; it no longer is.** See § Active Referrals below for the current
design (`src/referralCache.js`) — it's now a lookback-bounded full scan
only once, then incremental. It also runs on its own timer
(`ACTIVE_REFERRALS_REFRESH_INTERVAL_MINUTES`), independently of the other six
sections' `REFRESH_INTERVAL_MINUTES`, so its cost (whatever it is on a given
run) never delays them.

## Active Referrals: lookback bound, incremental sync, and resumable scans

The full active-application scan (`status: "Active"`, every page — Ashby's
API has no server-side source filter, so there's no cheaper way to find
"every active referral") is expensive. Instrumented breakdown from a real
**unbounded** run on this org, before `REFERRAL_LOOKBACK_DAYS` existed:

```
317 pages, 740.0s pagination/network, 39ms filter+classify
(31,669 applications scanned, 372 referrals found)
```

Virtually all of it (740s) is pagination/network wait; client-side
filtering is negligible (39ms) because source classification just reads a
field already present in each `application.list` result — there is no
separate per-application lookup to instrument, because there is no separate
lookup. A separate full run measured 718s end-to-end for comparison — both
numbers agree it's roughly 12 minutes. `listIssues()` (the normal
schedule-driven path the other six sections use) took ~113-128s in the same
testing. Ashby's API was also visibly rate-limited/slow during testing, so
treat ~12 minutes as a realistic worst case, not a one-off fluke.

`src/referralCache.js` addresses this three ways:

1. **`REFERRAL_LOOKBACK_DAYS` bounds the full scan** to applications created
   within that many days (default 90) via `createdAfter` — the same
   full-scan-avoidance idea `SCHEDULE_LOOKBACK_DAYS` and
   `SOURCED_LOOKBACK_DAYS` use elsewhere, applied here to Active Referrals.
   Measured on this org, the 90-day-bounded scan: **34 pages, 80.7s
   network, 3,328 applications scanned** — a reduction of **283 pages
   (~89%)** and roughly **10x faster** than the unbounded 317-page/740s
   scan. Tradeoff, stated plainly: a referral candidate whose application
   is older than the lookback window and hasn't otherwise triggered a page
   fetch won't appear, even if still Active. This only affects the
   **initial full scan** — incremental syncs afterwards (below) are
   unbounded by date, since a changed application shows up in the diff
   regardless of its age.
2. **Full scan once, incremental after that.** On first run (no persisted
   cache yet), or as a fallback if an incremental sync's token gets
   rejected, it does the (now lookback-bounded) full scan and captures the
   `syncToken` Ashby returns on the final page. Every refresh after that
   calls `application.list` with just `{ syncToken, limit }` — no `status`
   or `createdAfter` — returning only applications that changed since the
   last sync. **Deliberately no `status: "Active"` filter is sent on this
   call**: Ashby's syncToken filtering semantics aren't documented, and
   applying status server-side risks silently hiding exactly the transition
   that matters most — an application leaving Active status needs to still
   appear in the diff so it can be evicted from the cache. All
   qualification filtering happens client-side, on the fresh data, for
   every changed record.
3. **Resumable full scans.** The full scan checkpoints its cursor and
   partial results to `<DATA_DIR>/referral-scan-checkpoint.json` after
   *every page*, so a server restart mid-scan resumes from the last
   completed page instead of starting over at page 1. Verified live: an
   interrupted scan (killed at 24/34 pages, 8 referrals found so far) was
   restarted and correctly resumed, finishing the remaining 10 pages in
   19.4s instead of redoing the full ~81s scan — a real saving, not just a
   theoretical one. The checkpoint stores which `REFERRAL_LOOKBACK_DAYS`
   value it was fetched under; if that config changes between restarts, the
   stale checkpoint is discarded and a fresh scan starts instead of
   resuming under a mismatched filter (also verified live: a checkpoint
   saved under a 90-day window was correctly discarded, not resumed, when
   restarted with a 30-day window). The one accepted gap: a crash in the
   narrow window after the last page arrives but before the scan finalizes
   (writes the real cache + clears the checkpoint) would resume from
   scratch rather than replaying that already-complete result — rare, and
   self-correcting, not incorrect.

The persisted cache lives at `<DATA_DIR>/referral-cache.json` —
`{ syncToken, applications: { [applicationId]: record } }`. This *is* the
Active Referrals result set (not an intermediate structure): an incremental
sync adds/updates a record when its application now qualifies, and removes
it when it no longer does. Restarting the server doesn't lose the cache or
force a re-scan.

**Own refresh timer.** `ACTIVE_REFERRALS_REFRESH_INTERVAL_MINUTES` (default
`5`, independent of `REFRESH_INTERVAL_MINUTES`) controls how often this
runs, with the same overlapping-refresh guard as `issues.js` — a full-scan
fallback taking longer than the interval won't cause pileup.

Net effect: the one-time cost dropped from ~12 minutes to ~80 seconds with
the default 90-day lookback, every refresh after that is incremental (fast),
a restart mid-scan doesn't waste the progress already made, and because it's
on its own timer, the other six sections were never blocked by any of this
in the first place.

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
| `REFRESH_INTERVAL_MINUTES` | no | How often the server re-pulls Ashby for the seven main sections. Default `5`. The page itself polls the cached snapshot every 60s regardless. |
| `ACTIVE_REFERRALS_REFRESH_INTERVAL_MINUTES` | no | Default `5`. Separate timer for Active Referrals only — see § Active Referrals. Independent of `REFRESH_INTERVAL_MINUTES` on purpose. |
| `REFERRAL_LOOKBACK_DAYS` | no | Default `90`. Bounds Active Referrals' one-time full scan to applications created within this many days (measured: cuts 317 pages to 34). Does not affect incremental syncs after that. |
| `DATA_DIR` | no | Where dismissals (`dismissals.json`), the Active Referrals cache (`referral-cache.json`), and its in-progress scan checkpoint (`referral-scan-checkpoint.json`) are persisted. Defaults to `./data`. On a cloud host, point at a mounted volume so none of these are lost on redeploy. |

## Run

```bash
npm start
```

Open `http://localhost:3000`. Both background refresh loops (seven main
sections, and Active Referrals separately) start immediately on startup and
then run on their own intervals; there's also a "Refresh now" button on the
page for an on-demand pull of the **seven main sections only** — it
deliberately doesn't force Active Referrals to refresh too, since that could
mean waiting for a scan instead of the instant response the button implies.

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
| `src/config.js` | Reads and validates env vars. |
| `src/server.js` | Express app: serves the static dashboard, `GET /api/issues`, `POST /api/refresh`, `POST /api/dismiss`, `POST /api/undismiss`. |
| `src/ashby.js` | Paginated Ashby client; computes Feedback Overdue, Needs Scheduling, Availability Submitted, Stale Candidates, Interviewer Weekly Limits, and Recently Sourced. Also exports `fetchAllPages`/`classifySource`/`profileUrl` for `referralCache.js` to reuse. |
| `src/referralCache.js` | Active Referrals' own persisted cache + incremental sync + resumable full-scan checkpointing, and independent refresh timer — see § Active Referrals. |
| `src/concurrency.js` | `mapWithConcurrency` — bounds parallel `application.info` / `user.interviewerSettings` lookups. |
| `src/dismissals.js` | Persisted store of dismissed cards (`dismissals.json`); handles "today" expiry and "forever". |
| `src/issues.js` | Orchestrates the seven schedule-driven lists, merges in Active Referrals from `referralCache.js`, guards against overlapping refreshes, filters out dismissed cards at serve time, holds the cached snapshot. |
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
  duplicate trigger` in the server log. This matters in practice because
  Active Referrals' full scan can take longer than the refresh interval
  itself (see § Active Referrals); without this guard, overlapping scans
  would each compete for the same Ashby API and slow each other down further.
- Active Referrals' full-scan-in-progress state lives in a separate
  checkpoint file, not the main cache — see § Active Referrals for why, and
  what happens if `REFERRAL_LOOKBACK_DAYS` changes while a scan is
  interrupted.
