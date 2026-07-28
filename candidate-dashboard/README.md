# Candidate issues dashboard

A small dashboard for a recruiting coordinator: at a glance, which candidates
(and interviewers) need attention right now. Seven sections, plus a link out
to Ashby's own Active Referrals report (see below):

| Section | What it flags | Source |
| --- | --- | --- |
| **Stale Candidates** | Pulled out of the two candidate columns below once feedback is overdue past `STALE_FEEDBACK_HOURS` (default 350h) or a schedule has been pending past `STALE_SCHEDULING_HOURS` (default 168h / 7 days) — these have likely fallen through the cracks, not just freshly overdue. | Same sources as the two rows below. |
| **Feedback Overdue** | An interview ended and the interviewer still hasn't submitted their scorecard, past `FEEDBACK_OVERDUE_HOURS` (default 24h). | Ashby `interviewSchedule.list` — `interviewEvents[].endTime` + `hasSubmittedFeedback`. |
| **Needs Scheduling** | Nothing has been sent to the candidate yet — no availability request, no self-schedule link — past `NEEDS_SCHEDULING_ALERT_HOURS` (default 48h). | Ashby `interviewSchedule.list` — `status: "NeedsScheduling"`. |
| **Availability Submitted** | The candidate replied with their availability; waiting on someone to book it. Shown regardless of age (not threshold-gated); `AVAILABILITY_SUBMITTED_ALERT_HOURS` (default 24h) only drives the amber/red color-coding. | Ashby `interviewSchedule.list` — `status: "CandidateAvailabilitySubmitted"`. |
| **Interviewer Weekly Limits** | An interviewer whose remaining weekly interview capacity has dropped to `INTERVIEWER_LIMIT_BUFFER` slots or fewer (default 1) — i.e. their Ashby-configured `weeklyLimit` minus interviews already on their calendar this week (Mon–Sun UTC). Interviewers with no `weeklyLimit` set never appear. | Ashby `user.interviewerSettings` (the limit) + `interviewSchedule.list` event data (the count). |
| **Recently Sourced** | Candidates whose application was **created** in the last `SOURCED_LOOKBACK_DAYS` (default 3) with a referral or agency source. All statuses shown (Active/Archived/Hired/Lead), labeled per card. | Ashby `application.list` (`createdAfter` + `source.sourceType`). |
| **Onsite Interviews Today** | Today's panel/final-round interview events, shown in a persistent right-margin column with a deliberately heavier border than the rest of the page. "Onsite" is **approximated**: Ashby has no per-interview location/format field anywhere in this org (checked interview events, interview definitions, interview stages, and all 38 org custom fields), so this matches on the interview stage title containing "panel" or "final" instead, per explicit product decision. "Today" is a UTC calendar day; display times render in the browser's local zone. | Ashby `interviewSchedule.list` (the same fetch `listIssues()` already does — no extra pagination call) + `interviewStage.info` per unique stage id involved. |

**Active Referrals** used to be computed in-app (a bounded full
`application.list` scan + incremental `syncToken` sync — see git history if
you need the old approach back). It's now just a link, below the Onsite
Interviews Today card, out to Ashby's own Active Referrals report — no
reason to re-derive in this app what Ashby already reports on natively.

Every candidate appears in **at most one** of the five sections above
(Feedback Overdue, Needs Scheduling, Availability Submitted, Onsite
Interviews Today, Stale Candidates) — never several at once. If a candidate
has activity across more than one (say, an old interview whose feedback is
still outstanding, and a newer round scheduled for today), only their single
most recent event is kept; the rest are dropped rather than shown twice or
moved to Stale Candidates.

## Department / job filter

A multi-select menu at the top of the page filters every candidate-facing
section (Stale Candidates, Feedback Overdue, Needs Scheduling, Availability
Submitted, Recently Sourced, Onsite Interviews Today). A
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
the already-fetched snapshot — no additional network request.

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

(This dashboard used to also run a bounded-then-incremental full
active-application scan for an in-app **Active Referrals** section — see git
history for that design if it's ever worth reviving. It's now just a link to
Ashby's own Active Referrals report instead.)

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
| `REFRESH_INTERVAL_MINUTES` | no | How often the server re-pulls Ashby for the seven sections. Default `5`. The page itself polls the cached snapshot every 60s regardless. |
| `DATA_DIR` | no | Where dismissals (`dismissals.json`) are persisted. Defaults to `./data`. On a cloud host, point at a mounted volume so dismissals aren't lost on redeploy. |

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
| `src/config.js` | Reads and validates env vars. |
| `src/server.js` | Express app: serves the static dashboard, `GET /api/issues`, `POST /api/refresh`, `POST /api/dismiss`, `POST /api/undismiss`. |
| `src/ashby.js` | Paginated Ashby client; computes Feedback Overdue, Needs Scheduling, Availability Submitted, Stale Candidates, Interviewer Weekly Limits, Recently Sourced, and Onsite Interviews Today. |
| `src/concurrency.js` | `mapWithConcurrency` — bounds parallel `application.info` / `user.interviewerSettings` lookups. |
| `src/dismissals.js` | Persisted store of dismissed cards (`dismissals.json`); handles "today" expiry and "forever". |
| `src/issues.js` | Orchestrates the seven schedule-driven lists, guards against overlapping refreshes, filters out dismissed cards at serve time, holds the cached snapshot. |
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
