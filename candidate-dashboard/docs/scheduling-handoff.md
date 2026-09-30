# Luminai scheduling handoff

This is the current checkpoint; older dated validation notes in other docs are historical.
No automatic work or interview sends are authorized by this document.

## Product intent and client rules

The dashboard should automatically propose complete schedules that fit the client's
rules, not recreate Ashby's internal scheduling UI. Ready to schedule should include
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
Branch: `main`. The pilot was developed on `feature/client-ashby-connection`
([PR #2](https://github.com/hayleysamuels-ops/coordbots/pull/2), merged September 28,
2026; the branch is deleted).

```sh
git clone https://github.com/hayleysamuels-ops/coordbots.git
cd coordbots/candidate-dashboard
npm ci
npm test
```

Read this document, then [booking implementation](dashboard-booking.md),
[Google setup](google-calendar-setup.md), [Ashby connection](ashby-connection.md),
and [discussion pilot](scheduling-pilot.md). Main has these features, but they are
off unless `SCHEDULING_CLIENT_ID` is set, and only Luminai sets it.
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
Both Luminai services have built from `main` since step 2 of the post-merge sequence
below. A push to main may auto-deploy every dashboard; other clients must not receive
this pilot, which `SCHEDULING_CLIENT_ID` guarantees.
Latest known worker deployment: `474f7867-56a0-4f7a-a066-92e5c4e8e3ce`.

## Post-merge sequence (feature/client-ashby-connection → main, September 28, 2026)

Main now contains the pilot, off unless `SCHEDULING_CLIENT_ID` is set. All six
dashboards and Luminai's `scheduling-worker` build from main. All four steps are
done and verified, in this order:

1. **Done.** Verify the five main-built dashboards: each loads with three tabs (no Scheduling
   tab, no ready-to-schedule section), the queue reads "Needs scheduling", and
   `/booking.html` returns 404.
2. **Done.** Point Luminai's `coordbots` and `scheduling-worker` services at `main`, keeping
   their root directory, Dockerfile and watch paths. Confirm the Scheduling tab,
   booking review and Google page still load.
3. **Done.** Set Luminai's `DISABLED_SECTIONS=interviewerLimits,availabilitySubmitted`. Keep
   `interviewerLimits` in the value: setting `availabilitySubmitted` alone would
   un-hide Interviewer Weekly Limits. Ready-to-schedule replaces Availability
   Submitted on Luminai because it lists every submitted schedule, not just the
   one-section-per-candidate winners.
4. **Done.** Retire `feature/client-ashby-connection`, and update the branch references in
   § Resume from any computer and the root README to `main`.

## Known gaps

- **Hidden Ready to schedule rows have no un-hide page.** Rows now have Snooze and
  Hide, keyed per submission as `schedule:<scheduleId>:<submittedAt>` rather than
  per candidate, so candidate snoozes elsewhere still don't touch this section.
  Past the 12-second Undo, a hidden row returns only when its schedule changes in
  Ashby (any change, by design) or when its entry is removed from `dismissals.json`.
  The status line shows how many are hidden.
- **Ready to schedule Snooze/Hide is unverified in a browser.** Luminai had zero rows
  in the section when it shipped (September 28, 2026), so the buttons have only been
  covered by unit tests and a syntax check. Once a real submission appears, click
  Snooze, Undo, then Hide, Undo on it, and confirm the "N hidden" count follows.
- **Post to Slack for discussion (phase one of [the Slack schedule button](slack-schedule-button.md))
  is built but not configured or tested live.** It needs `SCHEDULING_SLACK_ROUTING=client`,
  `SCHEDULING_SLACK_CHANNEL_ID`, `SCHEDULING_SLACK_CHANNEL_NAME` and
  `SCHEDULING_SLACK_BOT_TOKEN` on Luminai, with the bot invited to that channel.
- **Calendar-checked options.** "Preview calendar-checked agenda" runs
  `full-calendar-schedule.js` against each interviewer's primary Google calendar.
  It uses meeting hours assumed from `scheduling-rules/luminai.json` (reported as
  assumed, never verified). Under `zero_only`, anyone with an Ashby limit of 0 is
  excluded and listed, and every other limit is ignored. Not checked: other
  calendars, bookable-over holds and non-zero limits.
  - **Breaks are now set for Luminai (rules revision 5).** They were previously
    recorded here as not agreed with Luminai, with the gaps held at 0/0. This
    sets them: at most two breaks per agenda (`maxGapCount: 2`), each 15–30
    minutes (`minBreakMinutes: 15`, `maxGapMinutes: 30`); every other gap is 0.
    The search tries back to back first, so a compact agenda still wins when one
    fits. `maxGapCount` defaults to 0, and `test/full-calendar-schedule-v1.test.js`
    still holds that default to the original solver's exact output.
  - **A no-fit comes with a report:** the furthest reach, then at most two changes
    that would produce a fit, then one line per interviewer at the blocking
    session. Placeholder (client-default) hours are labelled as a data gap, never
    as a conflict.
  - **Lunch has a start window.** `sessions.placementWindows` (rules revision 4)
    requires any session whose Ashby interview name contains "Lunch" to start
    between 12:00 and 13:30 America/Los_Angeles. The calendar-checked search
    prunes by it as it places each session. With no breaks, the only way to move
    lunch is to move the whole agenda's start; Luminai's two 15–30-minute breaks
    give it some slack. When the window still binds, the no-fit report says so and
    names the smallest break allowance that would fit, fewest breaks first ("one
    break of up to 60 minutes"), up to three breaks of 120 minutes.
    Both previews apply start windows. "Preview agenda without calendar checks"
    applies start windows only, and its result lists what it doesn't check:
    calendars, meeting hours, limits and breaks.
  - **Options are distinct.** Each option differs from every other by day, by at
    least an hour, or by at least one interviewer (`option-variety.js`). For a
    given start time the search keeps its first valid assignment and doesn't
    look for an alternative panel, so interviewer variety appears only when
    calendars force it; otherwise options are an hour or more apart. The 0/0
    regression test runs with variety off, and also checks that variety never
    changes the first option.
  - **Busy-time evidence for bookable-over.** Each no-fit logs
    `[calendar-check] no fit: ... rejected busy=N hours-default=N ...` (counts only,
    no names). Grep Luminai's logs for it to see how often busy time, rather than
    hours or limits, is what binds.
- **Most video interviewers inherit the wrong meeting hours.** Ten interviewers are set
  to `attendance: "video"` in `scheduling-rules/luminai.json`. Two of them, Aggelos
  Arvanitakis and Alex Mavrogiannis, have meeting-hours overrides (revision 3). The
  other eight have none yet, so they inherit the 09:00–17:00 Pacific default, which
  is wrong for them: Ali Feldman, Anisha Tandon, Dmitriy Mekh, Harry Kirschner,
  Jennifer Badash, Jordan Silvergleid, Sean O'Brien and Shawn Greenspan. The
  calendar-checked preview will propose slots outside their real hours until their
  time zones and hours are filled in. Mary Petrino's 09:00–17:00 Eastern override
  (`mary@luminai.com`) is in.
- **The Athens pair's short window means frequent "no fit". That's correct, not a
  bug.** Aggelos and Alex are available 19:00–22:00 Europe/Athens, Monday–Friday.
  That's three hours a day, usually 09:00–12:00 Pacific; in the week each year when
  Europe has left daylight saving and the US hasn't, it's 10:00–13:00. Any session
  where one of them is the only eligible interviewer has to land inside that
  window. The agenda must also stay back-to-back on one day, so the whole agenda
  must be built around it. Expect `no_calendar_fit` for many candidate windows. Until
  the binding-constraint report exists, a "no fit" involving either of them is most
  likely their meeting hours. Four more people named as video interviewers (Amelia, Chris Gonzalez, Daniel
  Noguchi, Michael Carignan) have no active Luminai Ashby account, so they have no
  override. If they do interview, Ashby's plan will name them and the post will stop
  with "could not be uniquely matched".
- **Calendar-checked Slack posts name interviewers as plain text, by design.** The
  format is a hyperlinked Ashby Link, then "Interview Schedule", the date, and one
  bullet per session with a "Candidate time" line when the candidate's zone
  differs, a "(video link required)" label, and small print saying nothing is
  booked. Interviewer names are plain text. The channel (#luminai-rc-team) and the
  bot are in Carrara's Slack workspace, while the interviewers are in Luminai's, so
  `users.lookupByEmail` can never resolve them, and profile links and mentions
  aren't available regardless of scopes. That's a property of the
  one-app-in-Carrara's-workspace design, not a missing permission; don't add
  `users:read.email` for it. The bot token has `chat:write` only (checked
  2026-09-29), which is all posting needs. Other discussion posts keep the
  plain-text format.
- **Step 2 plan reads now tell read failures from mismatches** (`worker/plan-reader.js`,
  `worker/draft-reader.js`). A read failure names its cause (session expired,
  Ashby unreachable or erroring, wrong account, page or matches never loaded). A
  mismatch lists every difference from the published plan: missing, repeated,
  wrong duration, out of order, wrong count. Two matching fixes came with it.
  Only the innermost event block counts, so a stage heading with the same name as
  its only session (Bilal Munawar's "HM Screen") isn't read as a second event.
  Repeated titles (the Applied AI Engineer onsite's two "One on One" sessions)
  pair up in page order. Both were reproduced on a simulated page, not Ashby's
  real one; the next live Step 2 read confirms or names the real difference.
- **The Slack "Schedule" button (phase two, stage 1) is built but not configured.**
  - **What it does:** on calendar-checked posts, a Schedule button with Slack's
    own confirmation dialog records an approval of that exact option (state
    `discussion_approved`, with who, when and the draft's digest). It then updates
    the message to show who approved it and that nothing is booked, because
    booking in Ashby is still blocked on IT permissions. It is never booking
    approval, and stages 2–4 (Ashby booking, calendar invites, candidate email)
    aren't built.
  - **The endpoint:** `POST /api/slack/interactions` is the only route outside
    Basic Auth. Until configured it's a 404 on every dashboard.
  - **To turn it on:**
    - In the Slack app: enable Interactivity with the Request URL
      `https://coordbots-production-f093.up.railway.app/api/slack/interactions`.
      Add `users:read` and `users:read.email`, then reinstall; the `xoxb` token
      doesn't change.
    - On Luminai's `coordbots` service, set `SCHEDULING_SLACK_SIGNING_SECRET`,
      `SCHEDULING_SLACK_TEAM_ID`, `SCHEDULING_SLACK_APP_ID` and
      `SCHEDULING_SLACK_APPROVERS` (a JSON list of lowercase emails).
  - **Why `users:read.email` is right here and wasn't for interviewers:** the
    approvers click from Carrara's workspace, where the bot is, so Slack can
    report their email. Interviewers are in Luminai's workspace, where it can't.
    A Slack Connect guest from another workspace usually has no readable email,
    so they're refused.
  - **One app, one Request URL:** Slack sends every click from the app to one
    URL, and today that's Luminai's dashboard. A second client using the same
    app would need a router or its own app (see `slack-schedule-button.md` §2).
- **An uncertain Slack post has no reconcile button.** A `discussion_uncertain` draft
  blocks that candidate's next post, and the dashboard can only reject drafts in the
  `draft` state, so clearing one means editing `scheduling.json` on the volume.

Google Cloud project was being configured in Carrara with External audience and Anna
as test user. Verify its current publishing state on resume. If still Testing,
Google refresh authorization expires after seven days; reauthorization may be needed.
Resolve production OAuth setup before relying on unattended long-term reads.

## Next work, in order

1. Verify Google connection and read the complete plan's actual interviewer calendars
   from booking review. Confirm missing/inaccessible calendars stop the lookup.
2. Add explicit Luminai onsite location/Pacific display and travel-aware coordinator
   inputs; preserve candidate availability timezone/instants. Confirm working hours,
   buffers, session order, room needs and candidate travel constraints before enforcing.
   Breaks between sessions are set (rules revision 5: at most two, 15–30 minutes).
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

## Whole-project GitHub index

For both codebases and the historical rollout record, use the
[private scheduling project index](https://github.com/hayleysamuels-ops/work-trial-tracker/blob/feature/scheduling-discussion-approvals/docs/scheduling-project/README.md).
Poetic's source is on `feature/scheduling-discussion-approvals` in that repository.
No original-workstation helper or session is required to check out the code.
