# coordinator-metrics

A cross-client dashboard showing the volume of coordination work behind each
client's hiring: how many interviews were scheduled, for which roles, over
what period, and how much of that work was re-done because something moved.

One tab per client, plus an all-clients overview. Internal-facing: a single
shared login sees every tab.

Unlike `candidate-dashboard/`, which is a live work queue deployed once per
client, this is one deployment holding every client's Ashby key and twelve
months of history in a local SQLite file.

## What it measures

Per client, over a rolling twelve months:

| Metric | Where it comes from |
|---|---|
| Interviews coordinated | One per interview event, candidate-facing and debriefs |
| Interview hours | Sum of each event's `endTime - startTime` |
| Candidates scheduled | Distinct candidates behind those events |
| Roles supported | Distinct jobs with interview activity |
| Interviewer seats filled | Every interviewer on every event — a five-person panel is five |
| Average panel size | Seats ÷ events |
| Reschedules | Derived, plus directly observed — see § Reschedules |
| Cancellations | Cancelled schedules that were never re-booked |
| Candidate drop-offs | Applications archived *after* reaching a scheduled interview |
| Short-notice bookings | Booked under `SHORT_NOTICE_HOURS` before the slot starts |
| Out-of-hours interviews | Starting outside local business hours |
| Median booking turnaround | Schedule created → its first event booked, see § Turnaround |
| Busiest day | The single heaviest day in the window |

Broken down by role, by interview stage, by day/week/month, and by
day-of-week × hour. Every comparison is period-over-period — this period
against the one before it. There are no targets, by design: nobody has to
own a number somebody invented.

## Counting rules

**Counted:** candidate-facing interview events, and debriefs.
**Excluded:** holds, logistics and internal blocks.

Debriefs are identified by Ashby's own structured `isDebrief` flag on the
interview definition, so they need no per-client configuration.

Holds are not structured anywhere in Ashby, so they are matched on interview
*title* keywords, which differ per org. This is not hypothetical: Forus's
live `interview.list` contains "External Hold", "[Forus] Arrival + Set Up",
"[Forus] Account Strategy Work Time" and "Dinner with Forus" sitting
alongside genuine interviews. Defaults are in `src/config.js`
(`DEFAULT_EXCLUDED_TITLE_KEYWORDS`); override per client with
`EXCLUDED_TITLE_KEYWORDS_<ID>`.

**Run `npm run check-client -- --client=<id>` against a new client before
trusting the defaults.** It prints every interview title, which ones the
current keywords would exclude, whether the org uses `isDebrief` at all, and
what twelve months of their data will cost to pull.

## Reschedules

**Ashby stores no reschedule history.** This was checked across schedule
fields, event fields, `application.listHistory` and `extraData` against a
live sample — only an event's *current* `startTime` exists, never a log of
what it used to be. There is also no cancellation reason: a `Cancelled`
schedule carries no field distinguishing a decline from a reschedule from a
candidate dropping out.

So this app reports two different numbers, and labels both on the page:

- **Derived** (covers the full twelve months). A cancelled schedule whose
  application and interview stage got a *new* schedule afterwards is counted
  as a reschedule; one that was never re-booked is counted as a
  cancellation. This is an inference, not something Ashby reports, but it is
  the only way to see the period before this app existed.
- **Observed** (exact, but only forward). Each sync compares every event's
  `startTime` against the last value stored and records a row when it
  changes. Necessarily starts at zero the first time a given event is seen.

The observed figure overtakes the derived one in usefulness as history
accumulates. Until then the derived number is what the headline shows.

**Interviewer RSVP declines are not available at all.** Ashby exposes no
attendance or RSVP field on an event's interviewers. A real decline signal
lives in Google Calendar attendee status — which `scheduling-worker/` does
for Poetic, at the cost of per-client OAuth. Out of scope here on purpose.

## Turnaround

`Median booking turnaround` measures a schedule being created to its first
event being booked, and deliberately excludes gaps under a minute.

When a coordinator books directly, Ashby creates the schedule and the event
in the same instant, so the gap is zero. Those dominate the sample:
including them put Forus's median at 0h against a 90th percentile of 23.4h,
a number that described nothing. The tile shows how many schedules genuinely
waited and how many were booked outright, so the split is visible rather
than averaged away.

## How the data gets here

Two sync passes, both read-only against Ashby:

- **Full**, nightly at `FULL_SYNC_HOUR`. Twelve months of
  `interviewSchedule.list`, the reference tables, and a refresh of every
  application that is still Active.
- **Incremental**, every `INCREMENTAL_MINUTES`. Only schedules created
  inside `INCREMENTAL_DAYS`.

`interviewSchedule.list` filters on `createdAfter` and has **no
`updatedAfter`**. A schedule created four months ago that gets cancelled
today still has an old `createdAt`, so the incremental pass cannot see it —
only the nightly full sync will. `INCREMENTAL_DAYS` is the dial for how much
of that lag you are willing to accept.

### Why applications are fetched one at a time

`application.list` returns every application an org has ever received:
242,611 on Forus and 236,896 on January at first backfill, of which roughly
8,000 each ever reached a scheduled interview. Sweeping it took 27 minutes
of the first full sync and stored 254MB nobody queries — and it gets worse
every year the client keeps hiring.

So applications are resolved *after* schedules and *from* them: the ids
referenced by stored schedules, fetched individually through
`application.info` at concurrency 8 (the limit `candidate-dashboard` already
runs that endpoint at without being rate-limited). On a first run that is
~8,000 calls; afterwards it is the handful of genuinely new candidates.
Pruning the unreferenced rows took the database from 254MB to 37MB and
changed no metric.

Measured on the production backfill of 15 October 2026: 21 minutes wall
clock for all five clients at `CLIENT_CONCURRENCY=2` — Forus 734s (21,366
schedules, 18,268 events, 7,483 applications), January 250s, Poetic 157s,
Runlayer 65s, Luminai 45s.

Anything referenced by a schedule but missing from the database renders as
"Unknown role", so this step is not optional: before it existed, 132 of
Runlayer's 730 events — 18% of the dashboard — sat under Unknown role.

## Run locally

```bash
cp .env.example .env     # then fill in DASHBOARD_* and one ASHBY_API_KEY_<ID>
npm install
npm run sync -- --kind=full --client=<id>
npm start
```

Quote hex accent colours in `.env` (`CLIENT_ACCENT_COLOR_X="#1d3efc"`) —
dotenv reads an unquoted `#` as a comment and the tab silently loses its
colour. Railway variables are not parsed by dotenv, so no quotes there.

## Adding a client

1. `npm run check-client -- --client=<id>` (or with `ASHBY_API_KEY` set, for
   one not configured yet). Read the interview titles it prints.
2. Add `<id>` to `CLIENTS` and set `ASHBY_API_KEY_<ID>`, `CLIENT_NAME_<ID>`,
   `CLIENT_TIMEZONE_<ID>` and optionally `CLIENT_ACCENT_COLOR_<ID>` and
   `EXCLUDED_TITLE_KEYWORDS_<ID>`.
3. Redeploy, then `POST /api/sync?kind=full` to backfill the new tab.

Clients with a Railway dashboard project today: January, Forus, Luminai,
Poetic, Runlayer (and Profound, whose dashboard is switched off but whose
key still works). Polymarket, OpenAI Foundation, Source Foundry and Modal
have no key provisioned yet.

## Time zones

Each client tab buckets days, weeks and the heatmap in that client's own
`CLIENT_TIMEZONE_<ID>`, so "interviews on Tuesday" matches the Tuesday their
coordinator actually worked. The overview tab re-buckets in
`OVERVIEW_TIMEZONE`.

Use an IANA name, never a fixed abbreviation. Node silently resolves "EST"
to `America/Panama`, which never observes daylight saving, so it reads an
hour out for roughly eight months a year instead of failing.

## Charts

The current day and the in-progress week are drawn faded, as is anything
already booked ahead. Those columns are incomplete, not low — at full
strength every chart ends in a cliff that looks like a collapse in volume.

## Storage

Everything lives in one SQLite file (`metrics.sqlite`) via Node's built-in
`node:sqlite`, so there is no native build step and nothing for a deploy to
compile.

**It must sit on a Railway volume.** Without one, a redeploy throws away the
twelve-month backfill — recoverable, at the cost of a long re-sync — *and*
the observed-reschedule history, which is not recoverable from Ashby at all.

## Routes

| Route | What |
|---|---|
| `GET /healthz` | Liveness, unauthenticated, reveals nothing |
| `GET /api/config` | Client list and display settings; never the API keys |
| `GET /api/overview` | Cross-client roll-up |
| `GET /api/client/:id` | One client's full payload |
| `GET /api/status` | Last sync per client, and whether one is running |
| `POST /api/sync` | Manual top-up; `?kind=full` re-reads twelve months |

Everything except `/healthz` sits behind one shared Basic Auth credential.
A per-client, client-facing view would need real per-user auth; `src/auth.js`
is deliberately the only place that decides access so that change lands in
one file.

