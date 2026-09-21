# Dashboard booking implementation checkpoint

The `/booking.html` review page is linked from Scheduling. Individual coordinator
credentials stay in memory and authenticate only the existing connection routes
and the new `/api/scheduling-booking` routes. Shared dashboard credentials cannot
approve. Discussion approvals remain separate.

Implemented:
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
supports status only; it cannot execute bookings. No new production deployment was
performed for this checkpoint.

Before rollout, implement and validate the adapter against an unsent test draft,
including exact account/application binding, complete calendar coverage and working
hours, no mutation of existing schedules, rejection of changed communications or
extra CC/attachments, durable intent before the final Schedule action, and readback
of actual events plus all three Ashby send-success signals. Then perform a separately
approved end-to-end dashboard booking. Never replay the already successful pilot.

