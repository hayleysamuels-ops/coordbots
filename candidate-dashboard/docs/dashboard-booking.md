# Dashboard booking implementation checkpoint

The `/booking.html` review page is linked from Scheduling. Individual coordinator
credentials stay in memory and authenticate only the existing connection routes
and the new `/api/scheduling-booking` routes. Shared dashboard credentials cannot
approve. Discussion approvals remain separate.

Implemented:
- Read-only live details check binds the active application, current stage, exact
  interview, duration and enabled interviewer via documented Ashby APIs. Changes
  alter the source fingerprint; no calendar availability is inferred from these reads.
- Exact event and recipient review, candidate confirmation preview, separate final
  approval dialog, durable ledger with compare-and-swap transitions.
- Source freshness and permission rechecks; uncertain writes require reconciliation
  and block subsequent dispatch. No automatic retry after submission starts.
- A timezone-aware slot planner rejects stale/partial calendars, respects working
  hours, and excludes existing meetings. Nonexistent/ambiguous DST times are errors.
- Calendar and confirmation receipts must match the approved content before success.
- A signed, client-bound worker capability endpoint distinguishes saved login from
  verified calendar reading and verified dispatch.

## Not production-ready

A browser calendar observation reader is implemented. Complete free/busy verification and the automatic draft/booking executor remain unfinished.
`src/server.js` deliberately supplies no source or executor and readiness is false.
The planner is tested but not yet connected to live calendar input. A manual test in
Chrome is not evidence that unattended hosted-worker automation works. Do not flip
readiness or enable sends based on that test. The worker booking endpoint currently
supports status and draft inspection only; it cannot execute bookings. The read-only draft inspector and review page are deployed to Luminai. Live
inspection through the coordinator session has returned both calendar invitations
and structured confirmation fields: sender, candidate recipient, subject, body,
empty CC/BCC and attachments. Expanded CC/BCC are flagged as unverified. The invitation reader now isolates each rendered invitation card and separates
its title, displayed time, event details and recipients. It supports one candidate
card and one interviewer card; unknown layouts require direct review. Exact
machine-readable event times and conferencing organizer verification still need
work before a sending approval is possible. Sender loading is awaited separately
from message loading; an unresolved or ambiguous sender stays unverified.

Before rollout, implement and validate the adapter against an unsent test draft,
including exact account/application binding, complete calendar coverage and working
hours, no mutation of existing schedules, rejection of changed communications or
extra CC/attachments, durable intent before the final Schedule action, and readback
of actual events plus all three Ashby send-success signals. Then perform a separately
approved end-to-end dashboard booking. Never replay the already successful pilot.


The coordinator can now request a read-only inspection of an existing Ashby draft.
The dashboard refreshes the application and interviewer facts first; the worker
checks the saved account plus draft/candidate/application binding and reads the
calendar invitation and confirmation previews. This adapter has no scheduling or
sending actions. It does not verify working hours, complete calendar coverage, or
actual notification dispatch, and cannot enable the booking executor.

Interviewer limits are read from `user.interviewerSettings` and included in the
source fingerprint. The planner requires fresh, complete interview counts when a
limit applies; absent counts never mean zero. Weekly counts must include explicit
source-verified period boundaries instead of assuming which day starts the week.
This validation is tested locally, but a live count/calendar source is still missing.

## Submitted-availability queue
The dashboard's Needs scheduling section uses `readyToSchedule`, a distinct
schedule-level list of Active applications in CandidateAvailabilitySubmitted.
It is assembled before triage deduplication and is not hidden by alert thresholds
or candidate snoozes. Stage mismatches remain visible and block agenda loading.
The section applies the dashboard's entity filters and fetches published current
interview plans automatically (two concurrent reads, one-minute browser cache).
It shows an interview agenda, not a timed draft. Booking review imports actual
submitted availability; full calendar verification and automatic timed draft
generation remain unfinished.
Availability shared outside Ashby's submitted-availability state is not detected.
Booking dropdowns now default to this queue; direct application links still work.

## Calendar inspection
The coordinator-only `inspect-calendar` route re-reads Ashby candidate and user
identities, then asks the signed worker to inspect the existing unsent draft's
calendar. It navigates only to that bound draft and reads the displayed date,
interviewer timezone and occupied blocks. It never edits a date, changes an
interviewer or sends anything. The UI presents observations, not free slots.
The reader still marks coverage/availability unverified: additional days,
complete loading/coverage checks, authoritative working hours, draft-overlay
identity and complete interview counts must be resolved before slot generation.
A coordinator can supply explicit dated working windows with an IANA timezone.
Overrides are attributed to the authenticated coordinator, not a client-supplied
name. They do not authorize sending, clear conflicts or bypass interview limits.
Currently overrides are returned with the inspection; they are not persisted as
an approval or used to turn on automatic suggestions.


## Multi-day calendar observations and tentative suggestions
The calendar inspector now accepts server-validated candidate windows and reads up
to five dates in the draft's displayed month. Ashby's single-day date controls move
interviews, so the worker enables multi-day view before navigating, verifies the
saved interview dates after every read, and restores the original view before
restoring single-day mode. An unreadable day fails the request rather than treating
it as free. Observations still do not prove complete calendar coverage.

Coordinators can enter multiple dated working-hour windows. The response attributes
these to the authenticated coordinator and calculates tentative options that fit
candidate windows, these working hours and observed busy blocks. Suggestions are
explicitly marked needs_review and never enter the booking engine, create an Ashby
draft, send messages, or authorize booking. Counts, complete coverage and a final
calendar recheck remain outstanding. Overrides are response-only, not persisted.

Live Luminai validation (September 21): the two-day reader returned September 22's
six existing meetings plus the unsent test overlay, and September 23's six meetings,
matching the manually inspected calendar. The worker's unchanged-interview-date
checks passed. Real tentative options await coordinator-provided working hours;
full availability and interview-load verification remain incomplete. 104 tests pass.


## Candidate-submitted availability
Opening booking review from Needs scheduling now carries both application and
schedule IDs. After coordinator sign-in, the page loads current pending requests
and automatically imports the selected request's submitted windows and timezone.
If an application has multiple requests, it preserves the linked request or asks
the coordinator to select one. Coordinator-entered availability is an explicit
source option for times shared outside Ashby.

The public interviewSchedule.list response provides status and request binding,
not the actual windows. The worker reads the request-specific Candidate Availability
grid using the saved Ashby session, without editing its selected cells or enabling
Show All Availability. It scans six displayed weeks and returns that scope alongside
the windows. A complete 7-day, 96-quarter-hour grid is required for every week;
malformed grids fail rather than implying availability. Availability notes are not
yet imported. Dates outside the reported scope are not inspected.

Server-side reads check the current active application/stage, pending request status,
and request revision before and after reading. The calendar/details routes refresh
submitted windows again and ignore client-supplied window values in Ashby mode.
Elapsed windows are omitted; stale, missing or withdrawn requests stop the lookup.
No calendar availability verification, booking approval, or sending is implied.

Live validation: Andrew Lee's exact pending request imported September 28 and 29,
2026, 09:00–17:00 America/New_York, matching the manually inspected grid. The local
browser fixture also verified automatic prefill and switching to coordinator entry.

## Full onsite agendas
The booking page loads all interviews from the active stage, then reads the selected
pending schedule's linked template through the signed worker. It shows each duration,
fixed interviewer, and explicit eligible employee list. The reader supports one required
interviewer slot per interview, including explicit employee-identity matchers; unsupported
rules or mismatched counts fail closed. It never unlinks or edits the template.

Full-agenda proposals preserve the published order and fit the complete duration inside
one candidate availability window. They distribute eligible choices within the agenda,
keeping fixed interviewers fixed. They are advisory agenda sketches, not calendar-checked
slots: interviewer calendars, working hours, interview limits, rooms, and break preferences
remain unverified. They cannot enter approval/dispatch, create an Ashby draft, or send
invitations. Submitted availability and template bindings are re-read server-side; caller-
supplied interviewer lists are ignored. The existing single-interview diagnostic tools
remain available in a collapsed advanced section.
