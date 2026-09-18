# Client-specific Ashby connection

This is a sign-in connection, not a booking executor. No route in this worker
approves a proposal, creates an interview, sends an invitation, or posts Slack.
The Scheduling tab links to `/ashby-connection.html`. Shared dashboard credentials
cannot operate it; an individual `SCHEDULING_APPROVERS_JSON` identity is required.

## Deployment

Deploy one separate worker per client, from `candidate-dashboard` with Dockerfile
`worker/Dockerfile`. Its dependency lockfile is separate from the dashboard.
Mount a persistent private volume at `/data`. Keep a single replica: browser
leases and replay protection are process-local. Do not expose the worker publicly
on Railway; name its service `scheduling-worker` in each client's project.
The worker defaults to Chromium's sandbox and drops root privileges before launch.
The previous Poetic Railway browser failed with this sandbox. Before live use,
either use hosting that supports sandboxed Chromium, or obtain explicit owner
approval for `ASHBY_BROWSER_ISOLATION=container`. That server-only setting removes
Chromium's additional sandbox; the unprivileged private container, signed requests,
coordinator access checks, and encrypted storage remain. It reduces defense if a
browser page is compromised. It is NOT configured or enabled by this change.
A dashboard request cannot select isolation mode.

Configure on BOTH dashboard and worker:
- `SCHEDULING_CLIENT_ID`: unique client identifier.
- `ASHBY_EXPECTED_IDENTITY`: exact observed account/organization button label.
- `ASHBY_WORKER_SECRET`: dedicated random secret of at least 32 characters.

Dashboard only: `ASHBY_WORKER_URL`, HTTPS or
`http://scheduling-worker.railway.internal:3001` on Railway's encrypted private network.
Worker only: `ASHBY_SESSION_FILE=/data/ashby/session.enc` and
`ASHBY_SESSION_KEY` (64 random hex characters). Never share keys/volumes between clients.
Do not put real credentials in source control or request logs.

For the Luminai pilot the account/organization button was observed in Anna's
signed-in browser. Configure its exact label privately. Her personal Chrome
cookies are not imported. The hosted browser needs its own interactive sign-in.

## Connection states

The connection page distinguishes unavailable setup, an open 15-minute sign-in
lease, and an encrypted saved session. Saving checks the configured Ashby identity
and binds the encrypted record to this client. An account/organization mismatch
cannot be saved. Other coordinators cannot control the lease. Changing the client
or expected identity makes the previous saved session ineligible.

`sessionSaved` means a record exists, not that its cookies are still valid.
`sessionVerified` and `bookingEnabled` remain false. A future executor must verify
identity, current availability, exact-revision approval, and invitation results
before booking can be enabled. Discussion approvals never grant booking authority.

## Verification and remaining work

Connection HTTP/authentication and browser lifecycle tests use fictional accounts.
They verify cross-client rejection, owner spoofing, replay, expiry, wrong identity,
wrong encryption key, popup handling, and disabled booking. They do not establish
live browser launch or invitation delivery. No live session has been stored by this
implementation. Hosted launch, coordinator account provisioning, interactive login,
availability provider, and verified booking/reconciliation executor remain pending.
