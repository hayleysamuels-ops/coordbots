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

The browser calendar reader and automatic draft/booking executor are NOT implemented.
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
It shows an interview agenda, not a timed draft: importing actual availability,
calendar verification and automatic timed draft generation remain unimplemented.
Availability shared outside Ashby's submitted-availability state is not detected.
Booking dropdowns now default to this queue; direct application links still work.
