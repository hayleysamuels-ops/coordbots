# Approved work-trial scheduling

> Scheduling project checkpoint: [start here](scheduling-project/README.md).
> Development paused September 22, 2026. This index covers both repositories,
> current branches, Luminai status, private rollout history and portable setup.

Status: implementation in progress, 18 September 2026. No booking worker enabled.
Execution must run unattended on Railway, including when Hayley's computer is off.

## Confirmed scope

Hayley requested both new work-trial schedules and replacements for declined
interviewers/rooms. The tracker proposes; a coordinator approves the concrete
schedule; execution takes place through Ashby. Use both the configured Ashby
interview plans and Hima's Work Trial Playbook.

## Coordinator workflow

1. Open a candidate and choose **Suggest schedule**, or open an upcoming decline
   and choose **Suggest replacement**.
2. For a new schedule, select the candidate-confirmed date range and location.
   Read the role's current Ashby interview activity, steps, pools, durations,
   feedback settings and communications. Do not infer a template from a previous
   candidate's one-off itinerary.
3. Present a draft with every session, date, local time/timezone, interviewer,
   room, conferencing choice and intended notification recipients. For a
   replacement, show the exact before/after change and preserve other sessions.
4. Show missing information and unavailable resources explicitly. Calendar read
   failures cannot mean free. Exclude paused/ineligible interviewers, account for
   working hours and existing load, and apply the playbook's confirmed rules.
5. The coordinator can edit, reject, regenerate, or approve the displayed
   revision. Only an active user with `canApprove` may approve. Edits invalidate
   previous approval. Approval records identity, time and the exact payload.
6. Before execution, reload the source schedule, candidate status, resource
   availability and approval. Changed facts return the draft for review rather
   than silently changing an approved assignment.
7. Claim execution atomically. Record each external operation and its result.
   An uncertain submission requires reconciliation with Ashby before retrying;
   a second click or restarted worker must not create duplicate invitations.
8. Mark scheduled only after reading the resulting Ashby schedule and checking
   the approved sessions, resources and invite state. Distinguish partial
   completion from success. Do not mark a decline handled just because a draft
   exists.

## Sources inspected

- Hima's Work Trial Playbook, compiled 28 August 2026, in the existing shared
  Claude artifact. It summarizes Slack instructions and includes both standing
  rules and historical exceptions; conflicts need review before enforcement.
- Poetic Ashby, signed-in Tess Chrome profile: Vivian's FDS schedule exposes
  Current, Drafts, Candidate Availability and Manual Reschedule. Its current
  screen distinguishes scheduled events from pending interviewer invitations.
  No schedule was changed during discovery.
- Official API reference:
  https://developers.ashbyhq.com/reference/interviewschedulecreate
  https://developers.ashbyhq.com/reference/interviewscheduleupdate

The public update endpoint only updates schedules created with the same API key.
It therefore does not establish an API execution path for existing schedules
made by coordinators in Ashby's UI. The create schema documents application,
interview events, times and interviewers; it does not establish the required room,
Zoom or candidate invitation workflow. Do not label a successful API record
creation as a fully booked work trial without verifying those effects.

## Playbook scheduling constraints to reconcile with Ashby

- Maximum two trials per day. Hayley clarified on 17 September: at most one of
  each role per day unless absolutely unavoidable. A same-role exception requires
  a coordinator's explicit override and reason on the exact draft; the bot cannot
  decide unavoidability. FDS trials should normally be offset.
- Use qualified session pools, not the main-partner pool for every session.
  Agent-shadow rotation should consider history, not just the first free person.
- Agent shadowing lasts 45 minutes. Verify its position in the current activity
  and that the recording is available before the following morning's trial.
- Work-trial events use Zoom under Tess's account. Presentations and debriefs
  require rooms; Invariant is the stated FDE presentation preference, subject
  to current availability.
- FDS debrief belongs on day two in the evening. The deployments overview needs
  an actual FDS; Neel may welcome but cannot be the full DRI for that segment.
- Include the case-study interviewer in the FDS final presentation. If the
  source cannot identify that interviewer, ask for the missing fact.
- Autumn owns meals; do not invent a substitute when she is unavailable.
- Keep event titles clean. Use existing communication templates, the candidate's
  supplied LinkedIn in descriptions, and the documented business-discovery
  exception. Do not derive immigration-sensitive wording from candidate data;
  obtain coordinator-approved wording where required.
- FDS Ashby limits and the Sales agenda contain historical exceptions. Surface
  them for review instead of automatically bypassing Ashby constraints.
- Platform laptop reservations need confirmation against current inventory;
  the August playbook and the September inventory use different labels.

## Existing integration boundaries

`lib/ashby.js` remains read-only. `lib/calendar.js` currently reads the shared
interview calendar; it does not establish full interviewer/room availability.
The tracker already exposes the active user's `canApprove` flag, but scheduling
must enforce it server-side. Store proposals and execution records separately
from the last-write-wins candidate checklist.

No background execution is authorized by an old proposal or a Slack alert.
The approved revision is the only booking instruction. Creating a new proposal
does not post Slack messages, modify the sheet, or send candidate invitations.

## Remaining implementation decisions

1. Unattended Railway execution is required. A Playwright/Chromium browser worker
   and its dependency were approved by Hayley on 17 September 2026.
   It needs a dedicated Poetic Ashby session before live booking can be enabled.
2. Login expiry and unexpected Ashby UI changes pause affected jobs. No hidden
   internal Ashby endpoints or copied personal browser cookies are an integration.
3. Read the actual FDE, FDS and Sales interview-plan activity settings and verify
   the complete booking/rescheduling steps before implementing the executor.
4. Worker identity: tess.wicks@poetic.com. Test candidate: Test Tess
   (tess@carrara.is), confirmed by Hayley. Internal interviewer/room recipients
   and the exact test schedule still need confirmation before invitations.
   Read-only Ashby search on 17 September found Test Tess with five archived
   applications (FDE, FDS and Recruiting); choose a test application explicitly.
   Candidate ID: 4dbc5d4c-6753-401f-b709-29b2ea1adff9.

## Implementation status

Implemented: approval records, revision checks, capacity checks, durable execution
intent, server approval/rejection APIs, candidate schedule-review page, and a
separate encrypted-session sign-in worker. The template-based planner checks
working hours, conflicts, rooms, Zoom, capacity and daylight-saving ambiguity.
These are tested with synthetic contracts, not live Ashby bookings.

The live source provider and booking executor remain unconnected. Suggestion and
approval routes fail closed until a verified provider exists. The sign-in page
cannot enable booking. No live invitations have been sent.

### Test booking requested

Hayley selected FDE with Jenna Caminiti on Monday, 21 September 2026, at 10:00.
Timezone confirmed: America/New_York (10:00 EDT / 14:00 UTC). Ashby's active employee directory in the Poetic
account identifies Jenna as jenna@carrara.is (America/New_York). This is a test
recipient selection, not evidence of availability or a completed booking.

The active FDE test application inspected is 79cda04f-7211-4481-bd65-4d571d29a8a9.
Its pending Work Trial Interview Schedule currently contains Agent Shadowing
(45 minutes), not a complete onsite agenda. Verify the intended test session
and full role templates separately; this activity must not seed a full agenda.

Ashby Manual Schedule opened draft a1b19929-4dcd-4181-a8f5-e40d9dfc3b33
for the selected test application. The page remained in loading state during
inspection. Date, interviewer, conferencing and invitations are not configured.
No booking was submitted.

## Connection deployment

The separate `scheduling-worker` service uses `worker/Dockerfile`, a private
Railway hostname and a `/data` volume. The tracker forwards signed, replay-checked
requests over Railway's encrypted private network. No public worker domain is
required. Only active coordinators with approval permission may initiate a
15-minute browser lease; frames and input are bound to that coordinator.

Worker configuration: `ASHBY_WORKER_SECRET`, `ASHBY_SESSION_KEY` (64 hex
characters), `ASHBY_SESSION_FILE=/data/ashby/session.enc`. Tracker configuration:
`ASHBY_WORKER_SECRET` (same shared value),
`ASHBY_WORKER_URL=http://scheduling-worker.railway.internal:3001`.
Keys must remain in Railway variables and the ignored local `.auth` folder.

`worker/bootstrap.js` initializes volume ownership then drops to UID/GID 1000.
Chromium's sandbox stays enabled. If Railway cannot support that sandbox, the
sign-in browser must remain unavailable pending an appropriate hosting solution.
No plaintext browser state or personal browser cookies are imported.

The coordinator opens `/ashby-connection.html`, signs into Tess's Poetic account,
and saves the session. A saved session is not a booking-ready indicator; it must
be checked again by the future executor. Login expiry and UI mismatches stop work.

## Verified implementation checkpoint, 18 September

- Production tracker still loads candidates, calendar and existing bot data.
- The candidate link opens the live schedule-review page and reads proposal
  storage successfully. No proposal has been approved or booked.
- The first worker builds accidentally started the legacy preflight script.
  Docker startup now points to `worker/bootstrap.js`, with a regression test
  verifying that the connection server starts only after dropping privileges.
- Both planning paths have synthetic contract tests. Replacement plans retain
  the prior event for review and specify removed recipients explicitly.
- Execution is serialized across candidates. An uncertain external write blocks
  further execution until reconciliation; no automatic retry is provided.
- Source provider, verified full role templates, live availability acquisition,
  and Ashby booking/reconciliation adapter remain required before enabling work.

The worker has no public domain. An attempted public-domain creation was refused
by automatic approval review; the implementation uses Railway private networking.
A broad environment-variable read was also refused; private hostname metadata
was obtained with `railway private-network status` instead. No existing secrets
were exported. New worker secrets were generated and configured via stdin.

## Current runtime blocker

The corrected worker is reachable privately and returns its saved-session status.
A live launch through the tracker failed with Chromium's sandbox enabled on
Railway. No Ashby login has been saved. A server-only isolation setting is ready:
`ASHBY_BROWSER_ISOLATION=sandbox` (default) or `container`. The latter removes
Chromium's extra sandbox while preserving the unprivileged private container,
coordinator access checks, request signing and encrypted session storage. It has
not been configured on Railway and requires explicit owner approval. Keeping the
browser sandbox requires a compatible runtime/hosting arrangement before sign-in.
