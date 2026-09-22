# Historical scheduling rollout log

Archived from the original workstation on September 22, 2026. This file belongs
in this PRIVATE repository: it contains operational candidate/test references.
Entries are chronological snapshots, not current instructions. Later checkpoints
supersede earlier blockers, test counts, branch names and deployment status.
Browser tab IDs, local preview addresses and `.local` helpers are historical only;
they are not prerequisites for resuming. Start with [the project index](README.md).
No passwords, OAuth secrets, session cookies or raw calendar exports are included.

# Current pause checkpoint — September 22, 2026

Work paused at Hayley’s request. Luminai is primarily San Francisco-based and
candidates will likely travel to the West Coast for onsites. This context is
recorded, not a deployed timezone rewrite; preserve submitted availability and
confirm travel/location constraints before scheduling.

Canonical portable handoff: [Luminai handoff](https://github.com/hayleysamuels-ops/coordbots/blob/feature/client-ashby-connection/candidate-dashboard/docs/scheduling-handoff.md).
GitHub branch: https://github.com/hayleysamuels-ops/coordbots/tree/feature/client-ashby-connection
Read the handoff before the historical log below. Anna’s Google OAuth is connected;
the user’s screenshot confirms the account-level free/busy test passed. All-plan
interviewer verification and full-calendar solver integration are still pending.
No new scheduling work, messages, invitations or calendar reads during this pause.

---

# Candidate tracker scheduling rollout

18 September 2026. The user approved production deployment of the review layer.
Live automatic booking remains disconnected and disabled. See deployment status
at the end of this document for the latest rollout results.

## Confirmed decisions

- Cover all client deployments of `coordbots/candidate-dashboard` and the separate
  Poetic work-trial tracker.
- Luminai is the first live pilot.
- Anna's Luminai Ashby account is the scheduling identity. Her local Chrome sign-in is verified; a hosted worker session is still needed.
- No interview may be scheduled without approval of the exact schedule.
- Sending an onsite draft to Slack requires a separate approval for discussion.
- Default to the candidate's specific Slack channel; allow a shared channel for
  clients that prefer one. Show the destination before approving.

## Saved implementation

- `coordbots`, branch `feature/scheduling-approvals`, commit `b0c225c`.
- `work-trial-tracker`, branch `feature/scheduling-discussion-approvals`, commit
  `8074cf0`.
- Both checkouts are inside this workspace. The original project directories
  were not edited.

The shared dashboard has a Scheduling tab, active Ashby interview-plan lookup,
coordinator-authored drafts, personal approver identities, candidate/client
channel routing, and durable approval/delivery state. Poetic uses the same review
flow with its existing Google identity, imports existing shell proposals into
separate discussion drafts, and persists them separately in Postgres.

Automatic generation of a fully verified schedule is not implemented. The UI
can load titles/durations from an Ashby plan; the coordinator supplies times,
interviewers and rooms. The booking control and endpoint remain disabled. Slack
posting is implemented but no live Slack token or candidate mapping was configured.
No real invitation or Slack message was sent.

## Verified

- Luminai's existing local API connection can read jobs and published plans.
- A read-only `apiKey.info` check shows interview read and write scopes.
- The Software Engineer, Product published onsite activities are readable.
- Anna’s Chrome window was verified signed in to Luminai as Anna Jones on 18 September.
- Railway includes the `dashboard-luminai` project and `coordbots` service.
- 14 shared-dashboard tests passed; 660 Poetic tests passed; Poetic's 20-offset
  clock sweep passed. Syntax and diff checks passed.
- A fictional local browser test verified approval changes a draft to shared
  discussion state and leaves booking disabled. Slack was mocked.

## Remaining work

1. Local Anna sign-in is complete. Resolve hosted browser isolation and configure a dedicated worker login.
2. Inspect the actual scheduling interface, availability, interviewer eligibility,
   room/conferencing setup, and invitation delivery.
3. Implement and verify the Luminai source provider and booking/reconciliation
   adapter using the existing shell's exact-revision approval and durable intent
   model. A successful API schedule record is not proof of invitation delivery.
4. Configure per-client coordinator accounts and Slack app/channel mappings in
   secure deployment settings. Candidate-channel discovery/creation is not wired;
   the separate Ashby-to-Slack channel project remains its own scaffold.
5. Obtain explicit approval for a concrete test schedule and recipients before
   any invitation; verify the resulting schedule and delivery.
6. Deploy Luminai first, then configure and verify each client; Poetic retains its
   own existing runtime/access constraints.

See each repository's new guide for detailed configuration and recovery limits.

## Production rollout authorized 18 September 2026

User request: “push that change to the dashboards.”

- Shared dashboard PR #1 merged into main at
  `f8f6d39d1513956c058532b026fedc5e7c9f47de`. All six client services started
  GitHub deployments of that exact commit.
- Poetic PR #4 was first narrowed to base `codex/approved-scheduling`, matching
  its previously deployed implementation. It then merged at
  `04283aa5ee63a0d386ed44e5d3167852541cefe6`. This avoids merging earlier unrelated
  scheduling work into main as part of this request.
- The separate Poetic tracker deployed source commit `8074cf0` directly as
  Railway deployment `96400af1-6db7-4cf3-bae2-5a421241c6bf`, status SUCCESS.
- Signed-in browser verification of the live Poetic tracker showed Scheduling,
  the existing shell proposal list, and “No invitations can be sent.” No draft
  was created and no sending/booking approval was clicked.
- No new credentials, permissions, Slack configuration, domains, or booking
  connections were created. Existing authentication remains required.

Individual coordinator approval accounts and client identities are not configured
for the shared dashboards yet. Their Scheduling tab is visible, but drafting and
approvals remain unavailable with the existing shared dashboard login. Poetic
uses its already-configured Google identity and approval permissions.

Final rollout result: all seven deployments succeeded. All six shared dashboards
run commit `f8f6d39d1513956c058532b026fedc5e7c9f47de`. Public HTTP checks
returned the expected 401 authentication challenge on each shared dashboard;
sign-in protection remains in place. The separate Poetic tracker was verified
in the signed-in browser, including its new tab and proposal list.

| Dashboard | URL | Deployment |
| --- | --- | --- |
| dashboard-forus | https://coordbots-production-48d8.up.railway.app/ | f8f58103-787a-4534-9567-a73e642cc1e8 |
| dashboard-runlayer | https://coordbots-production-74a0.up.railway.app/ | 2a0e1302-b7a7-4e0e-b7b8-821500c0f0e9 |
| dashboard-profound | https://coordbots-production-7542.up.railway.app/ | 55c190aa-21ca-4c0c-8f30-24c19c0dbee1 |
| dashboard-poetic | https://coordbots-production-6ad4.up.railway.app/ | d91ebbfc-b09c-473f-95ee-3aec7465dc4b |
| dashboard-luminai | https://coordbots-production-f093.up.railway.app/ | cfe572c3-29f5-4081-84f8-d3fb4f39ccd8 |
| dashboard-january | https://coordbots-production.up.railway.app/ | c2fdca62-5750-4395-a5b4-bc4e6c9c9777 |
| Poetic work-trial tracker | https://work-trial-tracker-production.up.railway.app/ | 96400af1-6db7-4cf3-bae2-5a421241c6bf |

## Client connection build, later 18 September

Built in `coordbots`, branch `feature/client-ashby-connection`: shared dashboard
connection page; individually authorized, signed gateway; separate per-client
worker; encrypted client-bound session storage; exact configured account/org
check. Shared dashboard login cannot manage it. Booking remains disconnected.
No personal Chrome cookies were copied. Poetic code and deployment untouched.

The earlier Railway Chromium sandbox failure is a hosting issue, independent of
Luminai Ashby API permissions. The new worker defaults to the browser sandbox.
Container-only isolation is implemented as an explicit deployment option but has
NOT been enabled or approved. Choosing compatible hosting or approving that
isolation change is required before provisioning a live connection. Coordinator
credentials, hosted sign-in, source provider, executor, and invitation verification
remain pending. No interviews or messages were sent.

Draft PR for the connection build: https://github.com/hayleysamuels-ops/coordbots/pull/2
29 tests passed. Worker dependency audit: zero known vulnerabilities. Browser
preview at http://127.0.0.1:4320/ashby-connection.html verified unavailable setup
and disabled sign-in. No deployment occurred. Hosting-isolation decision was
requested from the user; no answer has been received at this checkpoint.

## Option 1 approved and Luminai deployed

User explicitly chose option 1: Railway container isolation without Chromium's
additional sandbox. Dedicated Luminai worker `cf4631de-ea00-48d2-ba83-be126ddd9e9e`
uses `ASHBY_BROWSER_ISOLATION=container`, private hostname
`scheduling-worker.railway.internal`, volume `d6e9fa6d-353d-481a-ab4b-51a561ae0eb0`.
No public worker domain. Worker deployment `7bc0d644-1331-4ba7-a4bc-cbf5c3bbb18f`
logged “browser launch verified; isolation=container; booking disabled”. This
proves process launch, not Ashby sign-in or invitation delivery. Code commit
`3f7b54f`, 30 tests passed, PR #2 updated.

Luminai dashboard connection deployment `ee0c8829-c5e4-4913-9b57-2204a9d3d18a`
succeeded and the page was inspected in Chrome. Shared dashboard credentials
correctly could not manage the connection. User then authorized an individual
coordinator account named `Luminai Scheduler`. It was added while preserving
existing approvers (there were zero); password is in a mode-0600 local file
`.local/private-luminai/Coordinator login.txt`, not source control or chat.
Initial automatic approval review had rejected account creation; explicit user
approval with the requested name resolved that restriction. Dashboard deployment
`4b650060-c60d-4065-a787-13f8d6e35cfa` activates this account; verification pending.

Worker keys are private local files and Railway variables, never in GitHub.
Hosted Anna sign-in is still required; local Chrome cookies were not copied.
No bookings or Slack messages sent; live executor remains unimplemented.

Final authenticated verification succeeded: connection page HTTP 200; worker status
returned `clientId=luminai`, `expectedIdentity=Anna Jones Luminai`,
`sessionSaved=false`, `signInOpen=false`, `bookingEnabled=false`. Scheduling status
returned `canApprove=true`, `bookingReady=false`. Dashboard image creation
2026-09-18T22:57:18Z. Ready for user's hosted sign-in.

Important: PR #2 remains open; Luminai was deployed directly from its feature
branch source. The dashboard still tracks GitHub main for future automatic
builds. Merge reviewed connection changes before a later main push to avoid
reverting the connection UI. Other clients and Poetic were not redeployed here.

## Coordinator login usability fix

User screenshot showed shared Basic Auth cached on the connection page. Added a
page-local coordinator form so Incognito is no longer required. Explicit credentials
are held only in page memory and sent via a dedicated header scoped server-side to
POST `/api/ashby-connection/*`. Bad explicit credentials cannot fall back to a
cached account; this header cannot elevate schedule approval routes. Removed the
misleading “Not configured” identity label before authentication. Local browser
verification confirmed the shared-login state switches to the expected account
and enabled sign-in button with fictional credentials. 34 tests passed.
Commit `f6f169e`, deployment `a2493553-91ff-4035-a54b-7970f106586e` pending verification.
Deployment a2493553 succeeded. Production Chrome verification shows the coordinator
username/password form under the cached shared dashboard login, with the worker
sign-in button disabled until coordinator authentication. User can refresh the
existing page and enter Luminai Scheduler using the private login file.

## September 21: Luminai test preparation

Anna saved the hosted session. Added live saved-session identity verification and
reuse of the encrypted session when reopening sign-in (coordbots commit 60c3417).
Worker b7f4b4ca-f5d2-4c94-b0ff-74c242d84a29 and dashboard
d15e38b8-427f-45d4-bbc7-512eb90395ff both verified SUCCESS. This confirms deployment,
not current session validity or invitation delivery. Booking remains disabled.

User selected TEST petrino (petrinom@gmail.com), Mary Petrino
(mary@luminai.com), and explicitly confirmed just the 15-minute Welcome interview.
User opened Manual Schedule draft a8350d52-4055-4779-adb2-aafca66de6e4.
It currently still contains all seven onsite sessions, including Vamsi in HM Check-In;
do NOT send it. Mary calendar added for read-only availability inspection.
Mary timezone is America/New_York; overall draft timezone America/Los_Angeles.
Candidate lane shows unavailable all day on September 21; no usable candidate
availability confirmed. Asked user for a date/time window and time zone, pending.
No invitations, schedule confirmations, or Slack messages sent.

New local booking-engine.js / booking-store.js are development scaffolding only,
not routed or deployed. They require a verified source and executor that do not yet
exist. Include distinct approval, source freshness checks, persistent operation
intent, CAS concurrency, and reconciliation after uncertain writes. Receipt checks
require delivery evidence for every event/recipient pair. Eight new tests passed;
full suite 43/43 passed with temporary localhost-server permission. npm ci reported
three moderate dependency findings; no dependency changes made in this step.

Remaining: candidate window, single-session draft configuration, communication
preview and exact approval, grounded availability/booking adapter and verification,
then integration with the dashboard. Do not describe this as completed automation.

Candidate availability confirmed by user: September 22/23, 2026, 10:00–16:00
America/Los_Angeles. Inspected September 22 in the live Ashby draft; changing
Interview Date also autosaved all current draft events onto September 22.
Mary calendar loaded: busy 10:00–13:00, 14:45–15:00, 16:00–16:30,
17:00–17:20, 18:00–18:30 America/New_York. Proposed first open slot
September 22 10:00–10:15 PDT / 13:00–13:15 EDT, not yet approved.
Candidate availability popup explicitly said no availability submitted this month;
use the user's supplied window, not the gray candidate lane as a calendar conflict.
Attempted removal of unused Applied AI session via visible trash icon, but no
change confirmed; Chrome switched to Profound profile before verification.
Stopped UI actions and asked user to bring Anna/Luminai back and keep it active.
Still must verify draft, remove six unused draft sessions, select Mary, configure
10:00–10:15, review actual communication recipients/content, and obtain approval.

## September 21: exact live test draft ready for approval

Verified Anna Jones / Luminai profile. Removed the six unused draft sessions;
only Welcome remains, September 22, 2026 10:00–10:15 PDT (13:00–13:15 EDT),
Mary Petrino mary@luminai.com sole interviewer. Saved draft and communications
preview verified. Candidate recipient petrinom@gmail.com. Candidate calendar title
Interview with Luminai; interviewer title Welcome - TEST petrino - Applied AI Engineer.
Luminai Scheduling Calendar selected, Google Meet unique shared link configured,
no room. Candidate description replaced inherited onsite address with explicit
scheduling-test wording and no office visit. Draft-only candidate email reminder
and interviewer Slack reminder removed; Interview Reminders Off verified.
Separate Candidate Confirmation Email, Slack Channel, AI Notetaker all Off.
Both Send Candidate Invite and Send Interviewer Invite On, but final Schedule
button NOT clicked. Await explicit approval of exact event before final action.
Current UI is /communication/calendar-invites of draft a8350d52-4055-4779-adb2-aafca66de6e4.
This is a manual pilot draft; automated booking adapter remains unimplemented.

## September 21: approved live pilot booked successfully

User explicitly approved the exact Welcome test and additionally requested candidate
confirmation email. Enabled confirmation, removed inherited CC recipients Gabrielle
and Grace, removed Applied AI setup PDF, and replaced onsite/travel/NDA body with
virtual scheduling test confirmation. Sender Anna Jones anna@luminai.com. Candidate
confirmation subject Confirmed: Interviews with Luminai - Tue, Sep 22, 2026.
Clicked Schedule ONCE in Anna/Luminai UI. Ashby showed, in sequence:
Scheduling -> Scheduled; Send all invites -> Sent all invites;
Sending candidate confirmation email -> Sent candidate confirmation email.
Final success AX and screenshot verified all three green checks.
Schedule URL https://app.ashbyhq.com/schedules/0dd841b6-ff5f-45c2-b0a4-dd21b2a52b22
Welcome September 22 10:00–10:15 PDT; Mary mary@luminai.com;
candidate petrinom@gmail.com. Google Meet; Luminai Scheduling Calendar.
No other sessions, reminders, or Slack messages. Do not retry booking.
This proves the manual UI pilot path, not the dashboard automatic executor.

## September 21: dashboard booking foundation and second unsent test

User approved preparing a second unsent TEST petrino / Mary draft using Sept22/23
10–16 PT, avoiding the original booking. Created separate interview shell
433e73b3-e5e0-4598-a4e6-c3727f497826 and draft
739778b9-bb86-491e-9647-00eefe2d60f2. Removed six template sessions; Welcome only,
event 7c0e5b95-33a5-48a7-ab46-f78bf37d228a, September22 10:15–10:30 PDT,
Mary sole interviewer. Verified Mary calendar with original test 13–13:15 EDT
and no overlap in the new 13:15–13:30 EDT slot. Saved; no invitations sent.
New draft communications have NOT yet been reviewed; inherited template defaults
must be checked before any future approval. Existing reschedule draft
00545fc4-98a7-441c-bdeb-352ff46b144c was not modified. Do not replay original booking.

Commit6108265 on feature/client-ashby-connection adds booking review page, durable
approval ledger, timezone-aware slot planner and signed readiness endpoint. Tests
58/58 pass. Fictional local preview http://127.0.0.1:61281/booking.html verified
review modal and Keep as draft; no real sends. Live source/executor are still null
and automatic booking deliberately disabled. No production deployment this turn.
See candidate-dashboard/docs/dashboard-booking.md for remaining adapter work.
Native Chrome later changed to Hayley Samuels / Luminai profile, candidate Home,
with Scribe screen capture sidebar; no additional Ashby mutations performed.

## September 21: live metadata validation detects changed pilot stage

Commit2034964 pushed to existing feature branch adds booking-facts.js: documented
read-only application.info -> jobInterviewPlan.info -> user.search. Validates active
application, current-stage interview identity, duration, active unique interviewer,
future IANA-zone availability windows. Candidate/plan changes alter fingerprints.
Coordinator-only POST /api/scheduling-booking/details and Check interview details
button expose this verification without claiming calendar availability. Sign-out
suppresses pending details results. 64/64 tests pass; syntax and diff checks pass.
Not deployed; live calendar adapter and dispatch remain unavailable.

Live read verified Mary user4a8a726c-adce-4653-8874-3828c8f4e4a2, enabled. Reading
TEST petrino now shows Offer stage5a6bb0f8-0ce5-4f7b-b50c-edde683f6a40 with no
activities, so the earlier Welcome selection is correctly refused. Candidate and
existing draft were not modified. Asked user whether they will move TEST petrino
back to Onsite or provide another test candidate. Also requested Anna's Chrome
window at front for adapter inspection. Both replies pending at this checkpoint.
.local/private-luminai/test-plan.json was refreshed and now reflects Offer.

## September 21: Onsite restored; hosted read-only draft inspector

User moved TEST petrino back to Onsite. Live booking-facts check now passes for
Welcome15m and enabled Mary. Native Anna Chrome verified draft739778b9-bb86-491e-9647-00eefe2d60f2,
September22 10:15–10:30 PDT; original booked test unchanged. Edited ONLY draft:
removed inherited candidate Email4h reminder and interviewer Slack15min reminder;
Interview Reminders Off verified. Confirmation On, sender Anna, removed Gabrielle
and Grace CCs and Applied AI PDF attachment. Confirmation body saved and read back
as virtual scheduling test, exact time, Mary, use Google Meet, no office/travel/setup.
Candidate invite preview likewise saved/read back with virtual test wording.
IMPORTANT CUA native paste inserted unrelated clipboard text initially; corrected
both unsent bodies using typeText, then separate readback after autosave. No send.
Avoid native paste for this workflow; verify saved content after asynchronous save.

Commits11f394e and4a9b00f pushed. New worker/draft-reader.js reads only fixed draft
calendar-invite and confirmation pages, checks Anna + client + candidate/application,
no click/input/send operations. Dashboard POST inspect-draft refreshes facts first.
68 tests passed, plus identity-route regression separately passed (69 total).
Worker deployment e3ef498c-1ad6-4e9f-976e-7233e47d168e SUCCESS. Dashboard initial
wrong-layout upload7a99092b failed; corrected repo-root upload
b9a92bb0-5d00-481a-8026-57ff8d5c00ee SUCCESS, actual booking.html page verified.

User signed in as Luminai Scheduler in Chrome tab403663501. UI test exposed picker
only containing candidates with dashboard issues (TEST absent). Commitf33a30a adds
Load candidate from Ashby link with read-only application lookup/current-stage plan.
One additional source test passes. Dashboard redeploy in progress at this checkpoint.
Live hosted draft inspection still NOT validated; calendar availability and executor
remain absent/disabled. Do not claim automatic booking works. No invitations sent.

Candidate-link fix f33a30a deployment ab02ec00-dc7e-4fc3-8685-bdad76d051f7 SUCCESS.
Full suite70/70 passed. Refresh cleared coordinator credentials (page-memory only).
Asked user to sign in again; Chrome tab403663501 remains at booking.html login,
marked handoff. CUA bindings bookingChrome=agent.browsers.get('2'),
bookingLive=bookingChrome.tabs.get('403663501') support Playwright; liveBookingTab
is CUA wrapper. After login: expand Prepare an interview, paste observed application
URL (draft/right-side/candidates/.../applications/dd7978c2-4b5e-4e62-ac56-670bbd688162),
Load candidate from Ashby link; select Welcome; Mary email; Tue/Wed 10–16PT;
paste draft URL739778b9-bb86-491e-9647-00eefe2d60f2 and Read saved Ashby draft.
Do NOT click any Schedule or send action. Worker reader still needs live verification.

## September 21: hosted read-only draft path verified

User said go; coordinator session active in Chrome403663501. CUA direct Playwright
loaded TEST via application link, selected Welcome15m, Mary, both Sept22/23 10–16PT,
and exact draft739778b9... URL. Check interview details succeeded live.
First inspection failed candidate binding due early header render; commit efd44a2
waits for candidate link. Worker64a17d15-7405-403e-9b29-f4eb98b79bc2 SUCCESS and
read both correct invite previews. Email initially 'Loading template builder'.
Commit7282803 used textbox ARIA label but real editor did not expose that label;
reader failed closed. Commit a5218ce waits for visible contenteditable and hidden
loading text. Worker470eaee8-488a-4b2e-9e7e-7f130677fbc2 SUCCESS; final CUA read
verified BOTH invitation previews and saved confirmation body through dashboard.
No Ashby writes this turn, no sends. Full suite71/71 passed.

Observed hosted preview times17:15–17:30UTC equal10:15–10:30PDT. Candidate recipient
petrinom@gmail.com and interviewer mary@luminai.com visible, virtual wording matches.
Confirmation body contains exact test time/Mary/GoogleMeet/no office travel setup.
All three send toggles On in draft; this is NOT permission to click Schedule.
Current excerpt also includes Ashby help banner at end; sender dropdown value is
not included in body.innerText. Must implement structured sender/recipient and
message extraction before using readback for exact approval or delivery receipts.
Live reader does not read calendar availability, create drafts, or send. Engine
source/executor remain null; automatic booking disabled. Do not claim end-to-end
scheduling complete. Dashboard tab marked deliverable, stays signed in until reload.

## September 21: structured invitation cards and interviewer capacity checks

User said go. Structured confirmation reader 9a62ee6 previously verified live.
Added documented user.interviewerSettings lookup to source fingerprint; Mary has
2/day, no weekly limit. Planner requires fresh complete counts for configured
limits; weekly periods must be explicit source-provided intervals (no assumed
Monday boundary). Still no live availability source or booking executor.
Commit b53e840 pushed; dashboard012953d4-2ddd-4ae5-bf7e-ad725ff4d403 SUCCESS.
Worker305ed10a-7d97-4796-94dd-ffe9d1cf7d22 SUCCESS. Live CUA click on Read saved
Ashby draft verified clean candidate/interviewer cards, no help banners. Exact
candidate/interviewer recipients and time17:15–17:30UTC retained. No sends.
Full suite84/84 passed; live API facts check passed.
Native Anna UI still shows original booked10:00PT and separate unsent10:15PT.
Native reading of interviewer selection exposed alternate people, not authoritative
count or working-hours coverage. Nothing selected or changed.
A live read intermittently returned missing confirmation sender; UI correctly
flagged unverified. Added separate rendered sender wait8b9c3fd, tests6/6 including
loading success/timeout. Worker a850c5a2-ffde-48ca-9176-731a9d82473d deploying,
pending final verification. Native confirmation view shows Anna sender and same
unsent body. Dashboard Chrome403663501 remains signed in; do not reload. No
automatic booking or approval enabled. Docs checkpoint b326b50 pushed.
Final worker a850c5a2-ffde-48ca-9176-731a9d82473d SUCCESS. Before final readback,
Chrome suspended/replaced dashboard403663501 with403663515 at The Marvellous
Suspender chrome-extension page. CUA tabs.get succeeded but domSnapshot blocked
by browser URL security policy; no alternate surface/workaround attempted.
Asked user asynchronously to restore tab and sign in if required. Final sender
wait verification pending this user action. bookingLive now points403663515.

## September 21: final sender-loading fix verified live
User restored dashboard and said go ahead. Claimed restored Chrome403663515 at
booking.html, already signed in as Luminai Scheduler. Restored TEST application,
Welcome15m, Mary, Sept22/23 10–16PT, and exact unsent draft739778b9... through UI.
Read saved Ashby draft succeeded on worker a850c5a2: clean invitation cards,
TEST and Mary recipients, Sept22 17:15–17:30UTC (10:15–10:30PT), confirmation
FROM anna@luminai.com TO petrinom@gmail.com, CC/BCC/attachments none, exact
saved subject/body. No sends or Ashby edits. Final sender wait is now live verified.
Chrome403663515 marked deliverable. Booking source/executor remain null.

## September 21: Needs scheduling section deployed
User asked for a dedicated section populated by candidates with submitted
availability, with automatic drafts based on Ashby plans. Implemented queue/UI
foundation (NOT timed auto-drafts) in bc56281 pushed. Dashboard deployment
7d3ec0d0-8b65-447a-94e3-55edc9cae699 SUCCESS. 89/89 tests pass.
readyToSchedule is schedule-level, Active + CandidateAvailabilitySubmitted,
assembled before cross-alert dedup, unaffected by triage snoozes or thresholds.
Stage mismatch remains visible but blocks agenda loading. Main dashboard filters
apply. Auto loads current stage plan (2 concurrent reads/1min cache). Booking
picker defaults to ready queue; application deep links select after sign-in.
Live Chrome403663531 verified Justin Hui and Andrew Lee, both Onsite plans loaded.
Justin plan has multiple separate activities (main onsite, breakfast, dinner,
pre-onsite chat); future draft source must bind pending schedule to exact activity.
No actual availability windows imported, no suggested times, no background timed
drafts, no sends. Those remain missing and UI explicitly says suggested times
pending. User expects eventual timed drafts, not just the agenda shown now.
Main live tab403663531 and existing booking403663515 marked deliverable.
Fictional preview process44369 at127.0.0.1:50265 can be stopped; only local data.

## September 21: calendar reader first implementation, live verification pending
User: let's do calendar piece. Native Anna window found via Window > Ashby.
Read TEST unsent root calendar and Justin schedule overview. Justin shows Manual
Schedule, no Auto Schedule option. His candidate-availability page has week grid,
Week Of Sep20 and no AX time blocks; did not change availability or any schedule.
Added calendar inspection to existing worker draftReader, same candidate/app/vault
binding and mutual-exclusion lock. calendar-reader.js reads displayed date,
interviewer h3/calendar-column geometry, zone from header parent, rendered event
buttons. parseCalendar timezone-normalizes intervals. Keeps all blocks including
unsent draft overlays; returns coverageVerified:false, workingHoursVerified:false,
availabilityVerified:false, bookingEnabled:false. NOT live verified yet. No
calendar navigation/mutations or slot suggestions implemented.
Commit f72fd28 pushed, worker0c8f4119-f091-4e23-8799-4ed3629e8a38 SUCCESS.
Dashboard first calendar deployment e6c3920a-3392-42dd-8a97-382e1396126f.
Reloaded bookingChrome403663515 for new Read interviewer calendar button, cleared
in-memory login; asked user to sign in as Luminai Scheduler, still pending.
User authorized coordinator-entered working-hours override when Ashby hours absent.
Implemented optional timezone/start/end fields + authenticated attribution and
validation, response-only not persisted/not used for automatic slots.9ebb06a pushed.
95 tests pass. Override dashboard c7fb7719-c871-4b78-9a80-ffff194fae45 building.
Docs13885f0 pushed. Browser403663515 marked handoff; main403663531 deliverable.
Need finish deployment check and live calendar test after login. Existing page
loaded before override deploy; calendar button exists after sign in but override
fields may require later reload. Do not reload signed-in session unnecessarily.
Native Anna currently at Justin schedule candidate-availability read-only view.
Override dashboard c7fb7719-c871-4b78-9a80-ffff194fae45 confirmed SUCCESS.
Live calendar test remains blocked on coordinator sign-in, not on deployment.

Calendar live test after user 'done': booking403663515 signed in. Restored TEST
application, Welcome15m, Mary, Tue/Wed10–16PT, exact unsentdraft. Read interviewer
calendar returned 'Close the sign-in window before checking an Ashby draft.'
Read-only connection status confirms sessionSaved:true and signInOpen:true.
Existing native Window menu no longer shows worker-sign-in window; newly opened
connectionCheck Chrome403663543 is shared-login only and cannot cancel lease.
No bypass attempted: cancel requires owner and lease ID. Asked user to use original
Connect Ashby viewer's Save signed-in session or Close without saving. Corrected
initial button wording in commentary. Waiting on lease close, then retry existing
Read interviewer calendar button. Booking remains signed in and marked deliverable.

## Calendar retry: stuck sign-in cleared; reader fixes in progress
User try again. booking403663515 had navigated to Connect Ashby; state said open
session but no viewer controls. Railway restart of dedicated worker cleared orphan
lease, saved encrypted login retained (sessionSavedtrue/signInOpenfalse). Back to
booking cleared login. To avoid repeated user sign-in, created private
.local/check-luminai-calendar.cjs integration test using saved coordinator file
without logging credentials; calls only app-owned read-only inspect-calendar.
First read503. Native root draft navigation redirects to last Communications page.
8098b8a improved errors/date placeholder;29994b4 explicitly uses Schedule link
from calendar-invites;1997136 normalizes 'America/New York' display label.
Default calendarReader import exposed missing booking-planner.js in workerDocker.
c66954bb deploy crashed; fixed Docker8d5a26c + package smoke test; af9a7347 SUCCESS.
Next API read409 'calendar empty or not loaded'.9e3f2d6 adds [role=button] controls,
waits rendered event controls, distinguishes missing timezone from empty calendar.
Worker c5425a57-c0d8-4931-bbc0-89b251feb0e5 BUILDING, needs final live API retry.
Native Anna now on TEST root calendar. Verified Mary EDT busy10–13, original
Welcome13–13:15, unsentdraft13:15–13:30, busy14:45–15,16–16:30,17–17:20,18–18:30.
No changes to schedules/no sends. Calendar still NOT live verified; no auto slots.

## September 21 calendar retry succeeded for existing meetings on one day
21a6447 pushed; worker11111572-160f-4918-b688-27e9422f22d2 SUCCESS.
Loading guard now waits for a block independent of the unsent draft overlay.
Private read-only integration test returned HTTP200 for exact TEST application,
Mary mary@luminai.com, Sep22, America/New_York. Six observed meetings match native
calendar: EDT10–13,13–13:15,14:45–15,16–16:30,17–17:20,18–18:30.
IMPORTANT returned draftOverlayCount0 and no unsent13:15–13:30 overlay this time;
do not assume overlays are always present or calendar coverage complete.
coverageVerified, workingHoursVerified, availabilityVerified, bookingEnabled all
remain false. One-day existing-meetings observation is live verified; multi-day
coverage, working hours/override application, stable overlay identity and timed
suggestions remain unfinished. No sends, schedule changes or invitations made.

## September 21 multi-day calendar work in progress
User continue. Native TEST draft single-day date arrows moved saved draft date to
Sep23; immediately restored Sep22 10:15–10:30 PT, Saved verified. No sends.
Enabled Multi-Day Schedule on unsent test: date arrows then only change calendar
view, while right-hand interview remains Tue Sep22. Wednesday native Mary busy
EDT11:30–12,12–13,13–13:30,14:30–15,15:30–16,17:30–18. Restored view Tue then modeOff.
Built worker/calendar-range.js: checks saved interview date inputs unchanged after
each day, restores original view before original mode, max5 dates/currentmonth.
Routes pass server-validated windows. UI supports multiple working-hours windows;
calendar-suggestions.js advisory options exclude observed meetings and entered
hours, bookingEnabledfalse; incomplete coverage and counts explicit review items.
User asked async for Mary's working hours Sep22/23, no answer yet. Do not invent.
6c73f1b pushed.104 tests pass. Dashboard fe376f0f-6e4e-4253-933d-df6834c39747 pending;
worker47b80e24-dc1d-42dc-8fbd-d53ed721d7ed building. Prior live attempts failed closed:
first before draft dates loaded (added wait), second invalid view zone America/Los
(display has spaces, normalized now). Need final live test .local/check-luminai-calendar.cjs.
No live tentative slots until real coordinator working hours supplied. Full verified
availability and automatic booking still unavailable.
Final live read SUCCESS HTTP200 on worker47b80e24 and dashboardfe376f0f.
Returns Sep22 seven blocks (six existing meetings + unsentdraft17:15–17:30UTC),
Sep23 six blocks exactly matching native Wednesday inspection. Correct viewPT/userET.
Worker verifies unchanged saved interview dates, restores originalview/mode before
return. No errors/no sends. Suggestions return needs_review/no slots because real
Mary working hours not supplied. Async hours question remains pending.104/104 tests.
6c73f1b pushed. All full verification/booking flags still false; not an automatic
end-to-end scheduling implementation. User can enter hours on livebooking page.

User authorized assuming Mary's hours 9–5 Eastern on Sep22 and23. Updated private
calendar integration test with those dated coordinator overrides. Live HTTP200;
override attributed Luminai Scheduler. Suggestions produced six 15m options:
Sep22 and23 17:30–17:45,17:35–17:50,17:40–17:55UTC (10:30,10:35,10:40PT starts;
13:30,13:35,13:40ET). All advisory needs_review, bookingEnabledfalse; coverage,
interview counts and final recheck outstanding. No Ashby draft changed or sends.
Override is per-request only, not a persisted interviewer setting. Earliest option
each day10:30–10:45PT /13:30–13:45ET. Existing unsent10:15–10:30PT blocked asoccupied.

## September 21 candidate-submitted availability import
User requested adding actual submitted windows. Public interviewSchedule.list
provides pending status/IDs but no windows. Native Anna brought Ashby forward after
auto-review rejected Window menu while Superhuman inbox was foreground; resolved
by user done. No inbox interaction continued.
Andrew schedule4a9ef7e9-48a7-4594-90f0-6f82e9cc8ded/app0222fc17-2d9f-4eae-80b8-db3a85ce5ad9,
candidate d1403b95-a668-4216-aa24-6b560bf9fc5c. Candidate Availability page is editable
weekly quarter-hour grid. Read only; NEVER click/drag cells. Week navigation only.
Native verified nextweek Sep28+29 9–17 ET. ShowAllAvailability toggled for inspection
then restored false. Native left Andrew nextweek availability visible, pickerclosed.
Built availability-source.js server API binding (active app/currentstage/pending
schedule, pagination, updatedAt recheck before/after). Worker availability-reader.js
reads exact /schedules/{id}/candidate-availability; requires ShowAllfalse; parses
7x96 rendered _slice_ cells/_selected_ class grouped by day/timezone. Scans6 weeks,
returns scope; skips elapsed windows, dedups. Unknown/malformed grid fails closed.
No candidate notes imported yet; no data outside reported six-week range inspected.
Server /availability-requests + /availability; details/calendar re-fetch submission
and ignore client windows when availabilitySourceashby. Stable fingerprint includes
schedule+submission revision. Source read does not enable calendar verification.
Main links now carry scheduleId; booking default Ashby submission auto-imports after
sign-in/loadplan. Multiple pending requests require correct selection; manual source
explicitly toggles editable fields. UI tested via fictional localhost fixture:
auto-populated2windows, ET; manual toggles controls correctly. Fixturetabclosed,
previewserverstopped.113/113 tests pass. gitclean b1f0921 pushedfeaturebranch PR2.
Worker292d21d2-9a5c-4b82-ade7-a00ea576154c live verified. Dashboard6805fc5a-7475-4f74-ba02-4c5ca0a8884f
live import verified; final c1fd47f7-8187-4f70-b153-7512cf4d8468 building (minorlogoutcleanup,
sourcefingerprintfix/docs). Need final statuscheck before finish.
Private .local/check-luminai-availability.cjs defaultAndrew (--justin optional),
credentials in-process only. AndrewliveHTTP200 Sep28/29 13–21UTC=9–17ET, source
ashby_submission, scopeSep20–Oct31, proper schedule/app/stage bindings. Justinlive
HTTP200 windowsempty for same6weeks; don't assume all future availability absent.
Justin schedule43a3ee5e-2425-44f3-8995-3d3a2fbeca56 app5631520e-5448-454a-bd21-9e1d2791db3d
candidate8ff6f0ef-b2f7-4595-ac9f-aa6697b778a8 stagec9ffd2fd-9413-4247-8444-73fb58c90945.
No schedule creation/sends/availability edits. Timedauto-draft/completecalendarcounts
still incomplete; import is delivered, not a fully automatic scheduling system.
Final dashboard c1fd47f7-8187-4f70-b153-7512cf4d8468 confirmed SUCCESS. Import feature
fully deployed for Luminai; live validated on Andrew/Justin as above. No remaining
blocker for this availability-import task. Broader automatic booking still pending.

## Dark-mode contrast fix
User asked to fix hard-to-see buttons. Found main controls paired white backgrounds
with dark-theme light text (tabs/refresh/filter/menu/dismiss/popovers), plus standalone
booking/connection pages with fixed light styles. Shared style.css now uses semantic
surfaces, stronger dark borders, bright selected states, visible dismiss controls,
and keyboard focus outlines. Scheduling-review controls now explicit themed colors.
New scheduler-theme.css covers booking + connection pages, inputs/selects/links,
messages/dialogs, hover and readable dashed disabled states; follows system theme.
No behavior/permissions/scheduling changes. CSS-only; no new tests or broad test rerun.
Forced-dark/light local fixture verified in CUA, including autoimported read-only
fields, booking controls, main tabs/filter nav, scheduling form, connection page.
Measured text contrast: booking8.05, disabled5.96, inactive dashboardtab7.72,
selectedtab11.84. Fixture tabs9/10 closed, previewserverstopped. Browserviewport/
systemtheme unchanged (preview server transformed CSS media queries only).
9450c5b pushedfeaturebranch. Luminai dashboard deployment
c9392fa5-6a3a-4b8e-ac9e-5192c9ad3a4c pending final status. Shared source updated; other
client services and Poetic tracker not deployed/changed during this task.
Dark-mode deployment c9392fa5 confirmed SUCCESS. Authenticated live static checks
verified new style.css, scheduler-theme.css and stylesheet links on both booking
and connection pages. Task complete for Luminai/shared source.

## 2026-09-21 all-client theme rollout completed

User explicitly requested light/dark fix on every client. All seven web services report SUCCESS. No workers, credentials, booking flags, or candidate data changed.

Shared theme-only release 7cfdf6d on fix/all-client-theme, isolated worktree `.local/coordbots-theme-rollout`, based on each nonpilot client's existing f8f6d39. Draft PR https://github.com/hayleysamuels-ops/coordbots/pull/3 . Not merged: inspect GitHub deploy source for Luminai before merging main so the pilot cannot be replaced. Original feature branch remains 9450c5b.

- Forus df18f889-2c9a-4876-889f-2cdcbba0ab7b
- Runlayer 0a67da3d-ab31-4f55-a2bd-70e3c5463b64
- Profound 41ff9049-87dd-4e93-a94c-e6813c041c34
- Poetic dashboard 1925b970-20c2-4ab3-a1a7-d7f79e372866
- January 87e73f59-275f-4236-8406-6188c388db65
- Luminai existing c9392fa5-6a3a-4b8e-ac9e-5192c9ad3a4c

All six shared dashboards' protected style.css and scheduling-review.css verified live using existing dashboard credentials (never printed). Script `.local/check-client-themes.cjs` accepts optional client arguments and retrieves Railway credentials in memory.

Separate Poetic tracker: d5980e6 pushed feature/scheduling-discussion-approvals; deployment e1a32dae-7e25-4ce4-8f4d-ef8a0806d13b SUCCESS. Fixed conflicting old theme overrides, themed surfaces and fields, readable selected/disabled controls and New candidate text; role ground colors unchanged. All 660 tests pass after installing existing locked dependencies. Local fictional control preview visually checked light/dark. Build descriptor decoded: image sha256:97de1da8847d2aeb9409a18e285af2ecc3883fefcce8b2e92601bbd79ed63cf3 created 2026-09-22T02:31:36Z, after deployment submission 02:30:43Z. Live login returns 200; authenticated tracker UI not inspected. Temporary preview tab closed and server stopped.

## 2026-09-21 full onsite agenda implementation

User asked to prioritize pulling plan interviewers and suggesting the entire schedule on booking.html. Luminai pilot only; per-client configuration/release separation remains next (recommend config instead of permanent divergent branches accepted).

Commits 0359485 and 33a4d9b pushed feature/client-ashby-connection. Full regression suite 120 passed; final name-token edge case has an additional passing targeted test (7 full-schedule tests). Added worker/plan-reader.js: visits existing /schedules/:id/template/events, validates expected account and candidate/application link, waits for ALL eligible-match calculations to finish, binds each visible event to its duration, parses exactly one required interviewer slot. Supports explicit Specific Employees and advanced employee identity lists with exact eligible-count match. Rejects unmatched/extra interviews, unsupported pool rules, multiple slots or incomplete matches. No template editing/unlinking, no Ashby draft creation, no sends. Earlier diagnostic iterations removed; normal generic errors restored.

New coordinator endpoints /full-plan and /suggest-full-schedule re-read published plan and current pending request, authenticate scope, compare before/after plan and request bindings, ignore client-supplied interviewer lists. Full agenda sketch fits all sessions sequentially in one future candidate availability window, chooses eligible names with within-agenda distribution, fixed names remain fixed. All results needs_review, availabilityVerified:false, bookingEnabled:false. Candidate submission re-imported server-side. These are NOT calendar-checked proposals: working hours, calendars, limits, rooms and break preferences remain outstanding. Suggested interviewer names currently no email/user IDs; complete calendar matching remains a future step.

UI: expanded full-schedule section, all interview durations/eligible names, total duration, Suggest entire schedule button. Existing single-interview email/draft/calendar tools collapsed under Advanced. Changes/sign-out clear stale proposals; rendering escapes names. Local fictional browser validation verified all eight events and complete timeline; preview server stopped/tab closed.

Live /full-plan verified Andrew Lee application 0222fc17-2d9f-4eae-80b8-db3a85ce5ad9, pending schedule 4a9ef7e9-48a7-4594-90f0-6f82e9cc8ded. Exact 8 interviews / 345 min:
- Welcome 15m: Gabrielle Struckell, Grace Buckingham
- Coding Roomba 60m and Coding URL Shortner 60m: Jonathan Chen, Yun Feng, Keshav Malhotra, Collin Buchan, Ariel Perez Chavez
- Solution Decomp 60m: Anisha Tandon, Maya Shoham
- Experience 30m: Shawn Greenspan (fixed)
- Lunch 30m: Mack Lu, Kathryn Wicks, Upasna Madhok, Fee Christoph, Yun Feng, Keshav Malhotra, Collin Buchan, Jonathan Chen, Ariel Perez Chavez
- Pipeline System Design 60m: Fee Christoph, Upasna Madhok
- HM 30m: Sanjay Saraf (fixed)

Live /suggest-full-schedule returned two UNSENT advisory agendas Sep28/Sep29 09:00–14:45 America/New_York (candidate-submitted timezone), all eight interviews, names from eligible lists. These times have NOT been checked against onsite PT working hours/calendars; don't approve/send or describe them as available. Names chosen: Gabrielle, Jonathan, Yun, Anisha, Shawn, Mack, Fee, Sanjay. Full endpoint response in .local/luminai-full-plan-result.json (private); read-only validation script .local/check-full-plan.cjs [--suggest]. Anna's native Chrome left on linked schedule template (read-only; no changes).

Final web rollout 24c3e8d2-764a-4675-ac2f-6650774d5d5d (0359485) was BUILDING at last check. Worker 21feb990-bd37-4b5b-9ea5-1db4d497ef58 SUCCESS and live verified. Tiny name-boundary follow-up 33a4d9b worker deployment 6d6d7acf-1914-43ba-8bdd-84e5d470925f pending; confirm success before reporting final deployment complete.

Final confirmation: web 24c3e8d2 and worker 6d6d7acf both SUCCESS. Authenticated live booking.html and booking.js markers verified. Final user should be told full agenda and interviewer import are live, with calendar/working-hours validation still pending and no sends.

## September 21 calendar continuation

- Full-calendar search core added in `coordbots/candidate-dashboard/src/scheduling/full-calendar-schedule.js` with tests. It requires complete fresh server-side free/busy, per-session working-hour windows, resolved Ashby user IDs, and verified limits/counts; backtracks assignments to reserve capacity for fixed interviewers. Not connected to a live verified provider yet.
- Read-only full-draft conflict inspector deployed to Luminai worker and web. New coordinator endpoint `/api/scheduling-booking/inspect-full-calendar`; UI under Advanced. Explicit absence of conflict text remains unknown; never flips booking readiness.
- Live inspection succeeded for all 8 interviews / 27 eligible-interviewer entries on Andrew Lee unsent draft `183bb8bb-ff6a-4d33-a7bf-a533ba631462`. This draft was created through native Anna Chrome's Manual Schedule during calendar inspection; it is UNSENT. No existing schedules moved and no invitations/confirmation sent.
- Current draft Sept28 9AM–2:45PM Eastern has explicit conflicts in 7 interview blocks. Welcome both outside Ashby Meeting Hours; coding early slots outside hours; Solution Decomp has OOO/meetings; Shawn has meeting-hour + existing weekly meeting conflict; Lunch and Pipeline conflicts. HM Sanjay has no explicit conflict text, remains unknown rather than available.
- UI debugging fixes: wait for interview-date inputs, then asynchronously loaded eligible-match links; normalize links using DOM `a.href`, not raw relative attribute; fixed interviewer panels show `No interviewers to select from.` rather than a filter field. Reader returns to original draft and verifies dates/start/end/link snapshot unchanged.
- Worker release `474f7867-56a0-4f7a-a066-92e5c4e8e3ce` includes the loading waits; earlier `9fdfff90-0a83-442b-bad6-1eeffa00ffbf` included resolved links. Successful live read saved privately in `.local/luminai-full-calendar-result.json` via `.local/check-full-calendars.cjs`.
- Web final release `92460a8c-62b5-4ae4-a892-30bd73ce2854` moves diagnostic under Advanced and renames main button `Preview agenda (calendars unverified)`.
- Asked user to choose reliable read-only Google Calendar availability connection (requires Luminai authorization/setup) vs continuing entirely through saved Ashby browser reader. This is a source architecture preference, not authorization to grant OAuth scopes yet. Await response; do not install a Calendar plugin or grant access without explicit authorization. Google freeBusy query docs verified: `https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query`; freebusy-only scope exists, max50 calendar IDs, handle per-calendar errors; freebusy does not replace Ashby meeting-hour/limit/secondary-calendar rules.
- Full calendar-aware auto suggestions NOT finished. No verified positive complete-coverage provider, automatic unsent draft search, or booking executor. Do not report generic calendars connected/suggestions available; deployed feature is conflict inspection only.

### Google Calendar decision and implementation

User chose read-only Google Calendar availability and said **“I'll create one”** for the Google Cloud OAuth app. Do not ask the architecture choice again. They were given the exact web-app redirect URI `https://coordbots-production-f093.up.railway.app/api/google-calendar/callback` and scopes `openid`, `email`, `https://www.googleapis.com/auth/calendar.events.freebusy`.

- Committed/pushed `99da1b4` (full draft conflict inspection) and `1b9a60c` (Google OAuth/freebusy) to `feature/client-ashby-connection`; main untouched.
- Google implementation in candidate-dashboard: `google-calendar-connection.js`, `calendar-token-store.js`, `google-freebusy.js`, `google-calendar-routes.js`; UI `/google-calendar.html` and booking-page link/primary-calendar read button. Official `google-auth-library` installed. OAuth PKCE/state/HttpOnly browser binding, expected `anna@luminai.com` verified ID token/nonce/audience, exact read-only scope checks, encrypted offline tokens, disconnect/revocation, fixed freeBusy endpoint with complete per-calendar response checks.
- Coordinator header authentication now covers `/api/google-calendar/*`. OAuth callback remains behind existing dashboard Basic Auth and additionally validates the single-use browser-bound state and active initiating coordinator.
- Google calendar query resolves exact active Ashby user identities via paginated `user.list`, imports fresh candidate availability, queries each primary calendar, and checks the application/plan/request did not change. Inaccessible calendar errors do not mean free time. Extra blocking calendars, Ashby working hours and limits still needed before full agenda verification/auto-search.
- Live Ashby identity resolution succeeded for **15 unique interviewers** across 8 sessions (not 13). Private result `.local/luminai-calendar-identities.json`. No Google data has been read yet; OAuth app absent at setup check.
- Configured Luminai WEB service only via Railway stdin: `GOOGLE_CALENDAR_REDIRECT_URI`, `GOOGLE_CALENDAR_EXPECTED_EMAIL=anna@luminai.com`, generated dedicated `GOOGLE_CALENDAR_ENCRYPTION_KEY` (never printed). Preserved any existing vars. User still needs `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET`, saved directly into Railway variables, not chat/GitHub.
- All **146 tests passed**. Compatible existing Express/body-parser/qs updates via npm audit fix leave **0 reported vulnerabilities**.
- Setup guide: `coordbots/candidate-dashboard/docs/google-calendar-setup.md`. `.local/check-google-calendar-setup.cjs` checks authenticated deployed status without credentials output. Google deployment just dispatched; finish validating deployment/status before final handoff.
- Google web deployment `a366c1dd-1abe-462b-aa95-390f1df818ca` verified **SUCCESS**. Authenticated `/api/google-calendar/status` returned `configured:false`, `connected:false`, missing **only** `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET`, expected `anna@luminai.com`, exact callback as provided. No live Google access yet. Connection page queued to open in Codex for user setup (open_in_codex returned queued). User must supply OAuth client variables privately in Railway and approve Google consent; no invitations sent.

### Sep 22 — Restore calendar page after OAuth credential redeployment
- Saving Google credentials redeployed Railway web from main f8f6d39, removing the scheduling feature pages (HTTP404).
- Corrected only Luminai WEB service source to hayleysamuels-ops/coordbots branch feature/client-ashby-connection via railway service source connect. Future source deployments should retain features; main and other clients untouched.
- Redeployed clean 1b9a60c as be4bc4ed-6b95-4ebc-8246-c947011c1e99. Live authenticated Google status now configured:true, connected:false, expected Anna and exact callback. User credentials are present; Anna OAuth consent is next. No invitations sent.
