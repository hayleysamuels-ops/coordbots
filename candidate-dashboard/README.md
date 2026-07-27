# Candidate issues dashboard

A small dashboard for a recruiting coordinator: at a glance, which candidates
(and interviewers) need attention right now. Five sections:

| Section | What it flags | Source |
| --- | --- | --- |
| **Stale Candidates** | Pulled out of the two candidate columns below once feedback is overdue past `STALE_FEEDBACK_HOURS` (default 350h) or a schedule has been pending past `STALE_SCHEDULING_HOURS` (default 168h / 7 days) — these have likely fallen through the cracks, not just freshly overdue. | Same sources as the two rows below. |
| **Feedback Overdue** | An interview ended and the interviewer still hasn't submitted their scorecard, past `FEEDBACK_OVERDUE_HOURS` (default 24h). | Ashby `interviewSchedule.list` — `interviewEvents[].endTime` + `hasSubmittedFeedback`. |
| **Needs Scheduling** | An interview stage has no schedule built yet, past `NEEDS_SCHEDULING_ALERT_HOURS` (default 48h). | Ashby `interviewSchedule.list` — `status: "NeedsScheduling"`. |
| **Interviewer Weekly Limits** | An interviewer whose remaining weekly interview capacity has dropped to `INTERVIEWER_LIMIT_BUFFER` slots or fewer (default 1) — i.e. their Ashby-configured `weeklyLimit` minus interviews already on their calendar this week (Mon–Sun UTC). Interviewers with no `weeklyLimit` set never appear. | Ashby `user.interviewerSettings` (the limit) + `interviewSchedule.list` event data (the count). |
| **Recently Sourced** | Candidates whose application was **created** in the last `SOURCED_LOOKBACK_DAYS` (default 3) with a referral or agency source. All statuses shown (Active/Archived/Hired/Lead), labeled per card. | Ashby `application.list` (`createdAfter` + `source.sourceType`). |

A candidate that crosses a stale threshold appears **only** in Stale
Candidates, not also in its regular column, to avoid double-counting.

Two things were scoped out because Ashby has no data for them:

- **"Awaiting Reply"** (candidate emailed back but no one replied) — no
  email-activity endpoint; would need a Gmail integration.
- **"Declined meetings"** (declined by interviewer or candidate) —
  `interviewSchedule.status` only has `Complete` / `Cancelled` /
  `NeedsScheduling` / `SchedulingRequested`, no reason code. A real decline
  signal would live in Google Calendar's attendee RSVP status (each event
  carries an `interviewerCalendarEventId`), which would need a Calendar
  integration.

Both were dropped for now to keep this Ashby-only; revisit if either
integration becomes worth the added complexity.

## Scope

This dashboard does **not** scan every "Active" application in Ashby. In this
org, the vast majority of active applications (1,600+) sit untouched in
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

The one exception is **Recently Sourced**, which does query `application.list`
directly — but bounded to `createdAfter` = the last `SOURCED_LOOKBACK_DAYS`
(default 3), so it's ~100 records, not the whole org. It intentionally does
*not* apply the Active-only / past-Application-Review filter the other
sections do: a candidate referred or agency-submitted 3 days ago is normally
still in Application Review and may be any status.

## An important caveat on "Needs Scheduling"

This was originally scoped as "availability has been submitted," but Ashby's
API has no way to represent that. `interviewSchedule.status` only has three
values (`NeedsScheduling` / `Complete` / `Cancelled`), and `NeedsScheduling`
looks identical whether the candidate hasn't responded yet *or* they've
already sent times back and nobody's booked it. There's also no custom field
for this in the org (checked all of them). So this column is honestly a
**"nobody has scheduled this yet" flag**, not a claim about whether the
candidate replied. If you want the real signal, the fix is a custom field
your team updates when a candidate submits availability — ask if you want
that field created via the API.

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
| `ASHBY_API_KEY` | yes | Reads applications and interview schedules. |
| `ASHBY_APP_BASE_URL` | no | Only change for a custom Ashby domain. |
| `FEEDBACK_OVERDUE_HOURS` | no | Default `24`. |
| `NEEDS_SCHEDULING_ALERT_HOURS` | no | Default `48`. This is a dashboard-defined threshold, not an Ashby concept. |
| `STALE_FEEDBACK_HOURS` | no | Default `350`. Feedback-overdue candidates past this move to Stale Candidates instead. |
| `STALE_SCHEDULING_HOURS` | no | Default `168` (7 days). Needs-scheduling candidates past this move to Stale Candidates instead. |
| `INTERVIEWER_LIMIT_BUFFER` | no | Default `1`. An interviewer is flagged once remaining weekly capacity drops to this many slots or fewer. |
| `SOURCED_LOOKBACK_DAYS` | no | Default `3`. Recently Sourced shows referral/agency applications created within this many days. |
| `REFRESH_INTERVAL_MINUTES` | no | How often the server re-pulls Ashby in the background. Default `5`. The page itself polls the cached snapshot every 60s. |
| `DATA_DIR` | no | Where dismissals are persisted (`dismissals.json`). Defaults to `./data`. On a cloud host, point at a mounted volume so dismissals survive redeploys. |

## Run

```bash
npm start
```

Open `http://localhost:3000`. The background refresh loop runs immediately
on startup and then every `REFRESH_INTERVAL_MINUTES`; there's also a
"Refresh now" button on the page for an on-demand pull.

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
| `src/ashby.js` | Paginated Ashby client; computes Feedback Overdue, Needs Scheduling, Stale Candidates, Interviewer Weekly Limits, and Recently Sourced. |
| `src/concurrency.js` | `mapWithConcurrency` — bounds parallel `application.info` / `user.interviewerSettings` lookups. |
| `src/dismissals.js` | Persisted store of dismissed cards (`dismissals.json`); handles "today" expiry and "forever". |
| `src/issues.js` | Orchestrates Ashby into the five lists, filters out dismissed cards at serve time, holds the cached snapshot. |
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
