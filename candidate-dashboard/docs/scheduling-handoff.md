# Luminai scheduling handoff — paused September 22, 2026

Work is paused at the user's request. Resume only when requested. This is the
current checkpoint; older dated validation notes in other docs are historical.
No automatic work or interview sends are authorized by this document.

## Product intent and client rules

The dashboard should automatically propose complete schedules that fit the client's
rules, not recreate Ashby's internal scheduling UI. Needs scheduling should include
candidates with submitted availability, load their current published interview plan,
and assign eligible interviewers using real availability. Coordinator approval is
required before booking; booking must include calendar invitations AND candidate
confirmation. Approval to post an onsite draft to Slack is separate and does not
approve booking. Candidate-specific Slack channels are the default, with explicit
client-level alternatives.

**New client context:** Luminai is primarily based in San Francisco. Candidates will
likely travel to the West Coast for onsites. Use San Francisco / America/Los_Angeles
as the intended onsite location/time reference when implementing client rules.
This is recorded intent, not a deployed timezone or availability change. Confirm
onsite location, candidate travel dates and any arrival/departure buffers before
assuming they are available locally. Do not reinterpret submitted timestamps as
Pacific or assume all interviewers work Pacific hours. Preserve original timezone
and instants, display a clearly labeled Pacific conversion, and resolve ambiguity
with the coordinator. No travel buffers or universal office hours have been agreed.
The explicit 09:00–17:00 America/New_York working-hours assumption applies only to
Mary Petrino; coordinator overrides are allowed, not yet a complete rule system.

## Current implementation and evidence

- Luminai has the deployed booking review, Ashby connection, submitted-availability
  import, complete interview plan/eligible interviewer reader, and Google connection.
- Google OAuth is configured for anna@luminai.com. User's September 22 screenshot
  confirms the saved account and a successful read-only connection test. This proves
  access for the connected account, NOT yet all 15 plan interviewers. User says Anna
  has access to all calendars; the per-interviewer API read still needs verification.
- The chosen approach is Anna OAuth, not a service account. Google credentials are
  stored in Railway, not source. OAuth requests identity plus calendar.events.freebusy
  only; no event titles, calendar edits or sends through this connection.
- The hosted Ashby session has been saved and used for live read-only inspections.
  Session existence is not proof of current validity; verify it again when resuming.
- Full onsite agenda previews include eight interviews, durations, eligible pools
  and fixed people. They are NOT calendar-certified suggestions.
- Google primary-calendar free/busy read is wired to booking review. The full-agenda
  solver is tested but not connected to complete verified inputs (working hours,
  extra blocking calendars, limits and counts). Missing data must not mean free.
- Automatic draft preparation and dashboard booking execution remain unfinished and
  disabled. A prior explicitly approved manual test sent invitations/confirmation;
  it does not establish automated hosted-worker dispatch. Never replay that test.
- Last implementation validation: 146 tests passed and npm audit reported zero
  vulnerabilities at code commit 1b9a60c. No code changes made during this pause.
- Light/dark fixes were previously rolled out across clients. Experimental Luminai
  scheduling remains separate from other deployments. Dedicated client branches/rule
  isolation across all dashboards and Poetic remain outstanding.

## Resume from any computer

Repository: https://github.com/hayleysamuels-ops/coordbots
Branch: `feature/client-ashby-connection`
Draft PR: https://github.com/hayleysamuels-ops/coordbots/pull/2
Last implementation commit: `1b9a60c` (documentation commits may follow).

```sh
git clone --branch feature/client-ashby-connection https://github.com/hayleysamuels-ops/coordbots.git
cd coordbots/candidate-dashboard
npm ci
npm test
```

Read this document, then [booking implementation](dashboard-booking.md),
[Google setup](google-calendar-setup.md), [Ashby connection](ashby-connection.md),
and [discussion pilot](scheduling-pilot.md). Do not assume main has these features.
GitHub and Railway access are needed. Live credentials and encrypted session data
remain in Railway; cloning the repo does not bring them to a new machine. Use the
existing coordinator account through the deployed UI or an approved secret store;
do not depend on the original computer's private `.local` helper files.

## Deployment and persistence

Railway project: `dashboard-luminai`, production.
Project ID: `f012b051-d769-491a-999a-90b6489e73f4`.
Web service `coordbots`: `5226f544-b069-4889-919c-955d81cf9d2d`.
Worker service `scheduling-worker`: `cf4631de-ea00-48d2-ba83-be126ddd9e9e`.
Environment ID: `6f709ad7-fa08-498f-814c-b17e4790cc8d`.
Web root directory: `/candidate-dashboard`; persistent volume `/data`.
Worker: separate private service, `worker/Dockerfile`, private persistent `/data`.
Preserve encryption keys, volumes, approval records and tokens. Do not copy secrets
into GitHub, logs, screenshots or chat. Do not share state across clients.

- Dashboard: https://coordbots-production-f093.up.railway.app/
- Booking: https://coordbots-production-f093.up.railway.app/booking.html
- Google: https://coordbots-production-f093.up.railway.app/google-calendar.html
- Ashby: https://coordbots-production-f093.up.railway.app/ashby-connection.html
- Google callback: https://coordbots-production-f093.up.railway.app/api/google-calendar/callback

On September 22 a variable deployment rebuilt old main (`f8f6d39`) and removed the
Google page. The WEB service source was corrected to `feature/client-ashby-connection`.
Restoration deployment: `be4bc4ed-6b95-4ebc-8246-c947011c1e99`; page HTTP200 and
Google configured:true were verified. Subsequent user screenshot confirms connection.
Keep this branch source on Luminai; do not switch to main until the features are
merged deliberately. A branch push may auto-deploy the web service. Other clients
must not receive this pilot merely because documentation or shared code changes.
Latest known worker deployment: `474f7867-56a0-4f7a-a066-92e5c4e8e3ce`.

Google Cloud project was being configured in Carrara with External audience and Anna
as test user. Verify its current publishing state on resume. If still Testing,
Google refresh authorization expires after seven days; reauthorization may be needed.
Resolve production OAuth setup before relying on unattended long-term reads.

## Next work, in order when resumed

1. Verify Google connection and read the complete plan's actual interviewer calendars
   from booking review. Confirm missing/inaccessible calendars stop the lookup.
2. Add explicit Luminai onsite location/Pacific display and travel-aware coordinator
   inputs; preserve candidate availability timezone/instants. Confirm working hours,
   buffers, breaks/order, room needs and candidate travel constraints before enforcing.
3. Connect full-calendar-schedule.js to fresh verified primary/additional calendars,
   per-session working hours and Ashby interview limits with complete daily/weekly
   counts and verified week boundaries. Produce calendar-checked full agendas; keep
   unknown coverage visibly blocked. Recheck all facts before approval/dispatch.
4. Finish durable unsent draft preparation, exact communications review, approved
   execution and readback reconciliation. No automatic retries after uncertain sends.
   Obtain approval for any specific live test; general development permission does
   not approve interview invitations or candidate confirmation.
5. Finish per-client branches/configuration and independently validate other client
   dashboards plus the Poetic work-trial tracker. Verify Slack workspace/channel
   mappings before any approved discussion post.

## Existing draft/test records — do not replay or alter on resume

Andrew Lee (real candidate), Forward Deployed Engineer:
- application `0222fc17-2d9f-4eae-80b8-db3a85ce5ad9`
- candidate `d1403b95-a668-4216-aa24-6b560bf9fc5c`
- pending availability request `4a9ef7e9-48a7-4594-90f0-6f82e9cc8ded`
- existing UNSENT draft `183bb8bb-ff6a-4d33-a7bf-a533ba631462`
- last observed submitted windows September 28/29, 2026, 09:00–17:00
  America/New_York (=06:00–14:00 Pacific). Re-read on resume; these were not Pacific
  submissions. Eight sessions total 345 minutes; 15 unique eligible interviewers.
- Ashby draft conflict inspection reported conflicts in seven interview blocks;
  the remaining block had no explicit conflict text and stayed unknown, not free.

TEST petrino with Mary:
- prior approved September 22, 10:00–10:15 Pacific test was already SENT; never replay.
- separate UNSENT draft `739778b9-bb86-491e-9647-00eefe2d60f2`, last observed September
  22, 10:15–10:30 Pacific. Old test availability expires; get fresh approval and dates
  before a new test. Do not book a real candidate as an implicit test.

## Pause boundary

Documentation and GitHub handoff only at this checkpoint. No new calendar reads,
bookings, draft edits, Slack posts, or scheduling-rule deployments as part of pause.
Existing hosted dashboards remain running; pausing development does not disable them.

## Whole-project GitHub index

For both codebases and the historical rollout record, use the
[private scheduling project index](https://github.com/hayleysamuels-ops/work-trial-tracker/blob/feature/scheduling-discussion-approvals/docs/scheduling-project/README.md).
Poetic's source is on `feature/scheduling-discussion-approvals` in that repository.
No original-workstation helper or session is required to check out the code.
