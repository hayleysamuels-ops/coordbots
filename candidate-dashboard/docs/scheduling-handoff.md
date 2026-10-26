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
  - **An unreadable calendar refuses the whole check, naming whose** (October 12, 2026).
    It's never counted as free or busy, and the interviewer isn't dropped. The refusal
    lists every unreadable calendar by interviewer, with Google's reason and what to do:
    `notFound` means not found *or* not shared with the connected account (Google's
    free/busy reply doesn't distinguish them, and finding out would need a broader
    scope); `internalError`/`backendError`, or a calendar missing from the reply, means
    retry; 401, or a 403 that isn't rate limiting, means reconnect. All-temporary
    failures are a 503, anything a coordinator must fix is a 409.
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
- **Step 2 counts event rows, not interviewer slots** (September 30, 2026).
  - **What went wrong:** Tarishi Singh's Agency Recruiter Screen template has one
    event, "Recruiter Screen" (30 min). The reader counted "Add Interviewer Slot"
    buttons as events and found none, so it reported a 0-interview mismatch.
  - **Counting:** an event row is now the smallest block holding the title and
    one duration field. The event count is the number of visible duration
    fields, and the reader waits up to 30 seconds for them, as it did before
    September 29.
  - **Empty pages:** a page with no rows at all is a read failure (503), not a
    mismatch.
- **Correction (October 1, 2026): those events weren't missing interviewers.**
  - **What the September 30 note got wrong:** it said Tarishi's event had no
    interviewers configured, and the reader told coordinators to add some. Both
    were wrong. "Configure: Interviewers | Room" is the collapsed control that
    expands an event, and the interviewer slots aren't on the page until it's
    opened.
  - **Same cause elsewhere:** an Applied AI Engineer onsite read the same way,
    "no interviewer slot could be found" on all seven sessions. Ashby's summary
    view showed eligible interviewers on every one: Welcome 2, Applied AI
    Interview 2, System Design 2, Lunch 3, HM Check-In 1, and 5 on each One on
    One. Tarishi's "unsupported interviewer-slot rule" was most likely the same
    thing; her slot was never read.
  - **What the reader says now:** a collapsed event is a read failure (503)
    naming the collapsed events. The message says this doesn't mean the template
    has no interviewers.
  - **The fallback claim:** the job's interview plan (`jobInterviewPlan.info`)
    and `interview.info` do carry no interviewers. But "nothing to fall back to"
    was never the issue: the templates have interviewers.
- **The template editor isn't a reliable source for interviewer slots.** How it
  renders them depends on per-user UI state in Ashby. Earlier live reads saw
  expanded slots ("Slot #1 — 2 Eligible Matches…", the text `parseAssignment`
  was built from); current reads with the same saved session see every event
  collapsed. That holds whichever replacement is chosen:
  - Clicking "Interviewers" on each event to expand it.
  - Reading the schedule's summary view, which lists eligible interviewers
    already resolved, with counts and avatars per session, and needs no clicks.
    It appeared on a schedule that wasn't yet booked. Still unchecked: whether
    each avatar carries the full name in its markup (only single-interviewer
    sessions show a name in text), and how a two-slot panel appears there.

  The summary view was ruled out (October 1). Its avatars carry no name in
  their markup and have no tooltip; the stack shows at most three; and
  initials avatars have no image to identify anyone by.
- **The same template reads differently between runs** (October 1, 2026, the
  Applied AI Engineer onsite). This is direct evidence that what the editor
  renders isn't stable between reads.
  - **Code:** no change that affects finding slots ran between these reads.
    Worker `35522fc` and `0c77cb5` differ only in the count-mismatch message.
  - **Runs on `35522fc`:**
    - 22:47 and 22:48 MDT: "Welcome" was refused, with no slots in its stretch of
      the page.
    - Another run that same deploy got past "Welcome" and read every slot's names
      (Lunch read 4 for 3 eligible).
  - **Runs on `0c77cb5`:** 22:59 and 23:00 MDT, "Welcome" was refused again.
  - **Cause: load timing** (settled by the stretch logging, October 2). The
    slots load after the page itself:
    - "Interviewers 1 | Loading filters... | Add Interviewer Slot" first;
    - then "Slot #1 — Calculating matches...";
    - then the eligible-match count.

    The reader had looked once, so its result depended on which stage it caught
    (three of four runs caught "Loading filters..."). The section was never
    collapsed on these reads, and no click was ever needed.
  - **Fix:**
    - The reader waits once for the page as a whole to stop showing either
      loading message, two quiet checks half a second apart, before deciding
      anything about an event.
    - It considers a click only when an "Interviewers" pill is actually there.
      Without one, a section with no slot is a read failure, and nothing is
      clicked.
  - **Time limit:** the whole plan read, page opening included, has one 80-second
    budget that every wait comes out of, so seven events can't add up to minutes.
    The dashboard's request timeout for it is 90 seconds (it was 55). Step 2
    shows a running clock while it reads, including when the plan loads by
    itself.
  - **Matcher text split across lines:** Ashby renders "All are true:" as "All"
    and "are true:" on separate lines. These are joined before the matcher type
    is checked, so an "Any are true" matcher can't slip past the refusal.
- **Luminai Scheduling SOP rules** (October 3, 2026, rules revision 6). All are
  in `scheduling-rules/luminai.json`; none are hardcoded.
  - **No onsite on Wednesdays** (`agenda.excludedWeekdays`: `wed`, judged in
    America/Los_Angeles). This is hard in both previews. Availability that only
    fits on a Wednesday gets its own no-fit line asking for another day.
  - **Gabrielle Struckell hosts Welcome** (`sessions.preferredInterviewers`).
    - The calendar-checked preview offers Welcome to Gabrielle first, while
      Gabrielle is free at its time. Otherwise, an eligible colleague who is free
      takes it, at the same time. Gabrielle is used, flagged, only when nobody
      is free.
    - This is a per-session ordered preference, not the general
      free-interviewer-first rule. The unchecked preview has no interviewer
      identities, so it doesn't apply this preference.
  - **Debriefs** (`debriefs`). Sessions whose Ashby interview has `isDebrief` are
    never proposed with the agenda. They're listed as "Not proposed here … once
    the onsite is confirmed". `meetingHoursExempt: true` records that the SOP
    allows debriefs before 9am or after 5pm Pacific. The step that schedules a
    debrief after the onsite is confirmed isn't built yet; it would need a
    confirmed-onsite signal (the schedule reaching `Scheduled` in Ashby). No
    open Luminai job has a debrief in its plan today.
  - **Meeting hours:** Sanjay Saraf (sanjay@luminai.com) 07:00–17:00 Pacific,
    weekdays assumed. Shawn Greenspan's are still to come.
  - **Post format.** Calendar-checked posts now follow the SOP:
    - the instruction line, then the candidate and role;
    - "LinkedIn - Ashby", with LinkedIn taken from the candidate's Ashby profile
      and the line saying "(not in Ashby)" when there's none;
    - `---- H:MM Break -----` between sessions with a gap;
    - an Interview Plan / Shared Prompt / Shared Interview Prep / NDA Sent
      block. Its four items are left "to add" or "to confirm", because the
      dashboard has no source for them.
  - **Event titles on busy flags (SOP item 2): blocked on Google Calendar
    scope, not on implementation.** The SOP wants each clash to show the
    clashing event's title, so a person can judge whether it's an internal
    meeting that can move or an external one that can't.
    - **Why it can't yet:** the dashboard reads interviewers' calendars through
      Google free/busy, which returns only busy intervals, never titles.
    - **What's needed:** titles require read access to events (for example
      `calendar.events.readonly`, or `calendar.readonly`). That means Anna
      reconnecting Google Calendar with the broader access.
    - **Once she has:** the flag can carry the title beside the time it already
      shows.
  - **Patrick Lii** has left Luminai. Nothing in the code named him; the
    deactivated-account handling is generic. He's still listed in Ashby slots
    (Lunch and both One on Ones on the Applied AI Engineer onsite), where
    removing him would make the template match what Ashby books.
- **Interviewer identity overrides** (October 14, 2026, rules revision 7).
  Ashby's slots list interviewers by name, and the dashboard matches names to
  active Ashby accounts. A name with more than one active account refuses,
  naming the session and the interviewer, unless
  `interviewerIdentities.overrides` in the client's rules gives the email to use.
  There's no fallback for a name without one.
  - **Joe Penn → joe@luminai.com.** Joe's duplicate Ashby account is
    intentional, per the Luminai Scheduling SOP: don't merge or deactivate it to
    make the name unique.
  - **An override is always checked, never trusted.** Its email must match
    exactly one active account, and that account must be one of the active
    accounts with the name; otherwise it refuses and says which. This applies
    whenever the name has an active account, not only while it's ambiguous, so
    a stale override can't quietly pick someone else.
  - The deactivated-account filter and the interviewer lookup share one matcher
    (`activeAccount` in `src/scheduling/booking-facts.js`), so they can't
    disagree.
- **A per-candidate Slack channel: what it would take** (not built; posts still
  go to #luminai-rc-team). The SOP wants `hiring-<candidate-name>-<role>` with
  Joe, Mary, Kesava, Gabby and the hiring manager.
  - **Scopes:**
    - `channels:manage` (public) or `groups:write` (private) for
      `conversations.create`;
    - the same plus `conversations.invite` permission;
    - `users:read.email` to find people. The bot has `chat:write`, `users:read`
      and `users:read.email` today.
  - **Workspace:** the channel would be created in Carrara's workspace, where the
    bot is. Joe, Mary, Kesava, Gabby and the hiring managers are Luminai people.
    They can only be invited if they're members of Carrara's workspace, or
    through Slack Connect, which a bot can't set up on its own. That's the same
    boundary that keeps interviewer names as plain text.
  - **Naming:** a slug from the candidate's name and the job title (lowercase,
    hyphens, 80 characters at most, Slack's allowed characters only). It also
    needs a rule for an existing name (a second application, or the same
    name), since names must be unique and archived channels still reserve
    theirs.
  - **Membership:**
    - The fixed four come from config as emails.
    - The hiring manager comes from the application's hiring team in Ashby
      (role "Hiring Manager").
    - Each person maps to a Slack user by email (`users.lookupByEmail`), and
      anyone who can't be found is reported, not skipped.
  - **Lifecycle:** when to archive the channel (hired, rejected, withdrawn), and
    whether the Schedule button's approvers change per channel.
- **The calendar-checked preview is advisory** (October 2, 2026).
  - **What it does:** it always proposes agendas in template order, at the
    earliest start that fits.
    - **Hard:** the candidate's submitted availability, start windows (Lunch
      12:00–13:30 PT), the break budget, zero interview limits (excluded
      upstream), and Welcome first. A template with Welcome elsewhere is
      refused, not rearranged.
    - **Advisory, flagged per session:** busy time on the primary calendar, and
      time outside assumed or verified meeting hours. Each flag names the
      interviewer, the clashing time and the minutes (`flags.js` holds the
      wording).
  - **Not done on purpose:** sessions are never reordered and times never moved
    to avoid a conflict. At a session's fixed time a free eligible interviewer
    is preferred to a busy one, which changes who, never when.
  - **Status and posting:**
    - A flagged result is `needs_attention`. The page heads it "⚠️
      Calendar-checked options need attention" and marks each clash.
    - The Slack post opens with "⚠️ Needs attention: N calendar clashes. This
      schedule is not ready to send" and lists each clash under its session.
  - **When there's no fit:** if the start windows or availability can't be met
    even with everyone treated as free, the existing no-fit report comes back.
    That includes the cheapest break allowance that would fit ("one break of up
    to 30 minutes").
  - **Unchanged:** the default solver (`advisory: false`), held to the original
    by `full-calendar-schedule-v1.test.js`.
- **Step 3's availability refresh failed silently** (October 2, 2026).
  - **What happened:** "Refresh submitted availability" returned 409 after about
    20 seconds on every attempt (six since 22:42 MDT, per Railway's HTTP log),
    but nothing appeared. The status line was in Step 4's card, and Step 4 stays
    locked, showing only its title, until Step 3 has windows. So every outcome
    without windows, the failure and "none found" alike, was written somewhere
    invisible.
  - **Fix:**
    - The status line now sits under the button in Step 3, with a running clock.
    - Every outcome ends in a message: windows imported, none found, or
      "Couldn't read the submitted availability: <reason>".
    - The result also stays in Step 3's summary once it collapses.
  - **Which 409:** the roughly 20-second timing fits the grid read (a 1-second
    pause, then a 15-second wait for the week grid). That failure was never
    logged, so it's unconfirmed. When the grid can't be read, the refusal and a
    worker log line (`[availability-reader]`) now say what was found: day
    headers, timezone labels, grid cells. Each other wait names what didn't load
    instead of becoming the worker's generic "could not read".
- **A slot can list someone Ashby no longer counts as eligible** (October 2,
  2026).
  - **What happened:** on the Applied AI Engineer onsite, Lunch read 4 names
    against "3 Eligible Matches" and both One on Ones read 6 against 5. The
    extra names were real people, not controls or alternates; the slot text
    marks nobody differently. Each slot lists one more person ("4 Employees",
    "6 Employees") than Ashby counts. The one listed in all three is Patrick Lii (who has since left Luminai),
    whose Ashby account is deactivated (`isEnabled: false`).
  - **Worker:** the names read must equal the slot's own "N Employees". When
    they outnumber "N Eligible Matches", every name goes on with Ashby's count.
  - **Dashboard:** `excludeDeactivated` in `booking-facts.js` runs in
    `/full-plan`, before anything uses the plan. It looks each name up in
    Ashby's directory, including deactivated accounts, and drops a name whose
    only accounts are deactivated. The active people left must equal Ashby's
    count exactly. A name with no account, two active accounts, or a count still
    off refuses, naming who was read.
  - **In Step 2:** the plan shows "Listed in Ashby but not eligible: Patrick Lii
    (deactivated in Ashby)".
  - **Still not detected:** alternates. Other reasons Ashby might exclude a
    listed person (such as a paused interviewer) would refuse rather than be
    guessed at.
- **Step 2 expands collapsed events, under a write guard** (October 1, 2026). The
  template editor is a live client's configuration, and this is the first part
  of the system that interacts with a write-capable page.
  - **Clicks:** the only thing ever clicked is an event's own "Interviewers"
    control, and only if it's a link, button or tab. It's never a form field,
    label or submit button, and never a link out of the template. Nothing is
    typed and no key is pressed.
  - **Focus:** if anything editable has focus before a click, or gets it after
    one (a blur can save), reading stops at once.
  - **Write guard** (`worker/template-guard.js`, plan reads only):
    - Any request that isn't GET, HEAD or OPTIONS is aborted inside the browser
      unless it is GraphQL whose every operation is a query. That covers
      mutations, persisted operations it can't classify, form posts and beacons.
    - WebSockets are never connected, and service workers are blocked.
    - A mutation at any point, or any write while expanding, fails the read.
    - Unclassifiable requests during page load are blocked and logged, but don't
      fail the read.
  - **After reading:** every field that was on the page must still hold its
    starting value, and every row its title and duration. The worker logs one
    line per read: events expanded, fields compared, writes blocked, sockets
    held closed. There's no reload to compare against; the guard is the stronger
    check, since nothing it blocks can reach Ashby.
  - **Not yet verified live:**
    - The expander's markup.
    - Where the expanded slots render.
    - How Ashby's page loads its data. If it reads through requests the guard
      can't classify, the page won't load ("Events section never loaded") and
      the log names each blocked request.

    The first live Step 2 read settles all three. The tests run a real browser
    against a page written for them, so they test the safeguards, not Ashby.
- **⚠️ Booking through Ashby's UI: "Manual Schedule" sits next to two items that email the
  candidate.** The scheduling card's **Actions** menu reads, in order: "Send Direct Booking
  Link" (sends the candidate a booking link), "Request Candidate Availability" (emails the
  candidate), **"Manual Schedule"**, "View All Scheduling Options", "Cancel Candidate
  Availability Link". The worker selects "Manual Schedule" by **exact name, exactly once**, and
  runs under the write guard, which blocks every write not on the booking allowlist. **Both are
  load-bearing. Neither can be relaxed:** without exact matching a layout change could select a
  neighbour; without the guard, a mis-selection would email the candidate.
- **Booking through Ashby's UI: what the guarded observation runs found** (October 12–13,
  2026, TEST application, every write blocked unless listed). Booking is being built as UI
  automation approved by the Slack Schedule button; the API route can't send (below).
  - **Write sequence**, in order:
    1. Actions → "Manual Schedule": `ApiCreateTemplateDraftScheduleForInterviewSchedule(interviewScheduleId)`
       creates an unsent draft on the candidate's existing availability-request schedule.
    2. Every edit: `ApiUpdateDraftSchedule`, carrying the **whole draft** (each event's times,
       interview, selected interviewers, alternates, feedback, slot filter).
    3. The communications screens: `ApiRefreshDraftInterviewScheduleCandidateConfirmationEmailPreview(draftInterviewScheduleId)`
       regenerates the candidate email preview.
    4. Calendar Invites → Send Now → **Schedule**: `ApiScheduleInterviewScheduleFromDraft(interviewScheduleId, draftInterviewScheduleId)`.
       It carries only those two IDs and books into the existing schedule.
    - `ApiUpdateDraftScheduleCalendarSettings` fires on page load and on edits; it's a view
      preference, and the composer works with it blocked. Keep it blocked.
  - **Checks built on that sequence:** each draft save may only move toward the approval
    (every field unchanged or equal to its approved value, no interviewer or interview outside
    the approval), and the final save must equal it exactly. Send has no content, so the draft
    is re-read and compared immediately before Send is permitted.
  - **The candidate email preview goes stale.** With the refresh blocked, the email still showed
    an earlier date (Wed, Oct 14) after the draft moved to Mon, Oct 12. The refresh must run
    after the final edit, and the pre-Send check reads the email's subject date and agenda
    against the approval; a stale email stops the run.
  - **Warnings:** a short allowlist of confirmable dialogs; everything else stops the run.
    Never confirmed: "Heads up: The interview time is in the past." Dialogs are detected by
    the worker after every action. An in-page observer missed this real dialog.
  - **Entry:** load Ashby's shell, then navigate inside the app. Cold-loading a deep URL
    (a draft, or the job pipeline's candidate panel) shows an error page under the guard.
  - **Time zone:** the composer's zone is a per-draft dropdown in Ashby's scheduling
    view, not the signed-in account's zone or the candidate's availability zone.
    Compare instants, never displayed text.
  - **Accounts:** invites go out as Anna's account in production (intended, per the SOP).
    The first real send uses hayleysamuels511@gmail.com as candidate and hayley@luminai.com as
    interviewer. Development runs locally against TEST with Hayley's session first.
  - **Discarding a draft:** `ApiDeleteDraftInterviewSchedule(draftInterviewScheduleId)`, from the
    schedule's **Drafts** tab (`/schedules/<schedule>/drafts`), via the unlabelled icon button
    beside the draft's link. It fires on one click with **no confirmation**. The worker finds
    it only as the single button beside the single link to that exact draft, and the
    permission is bound to that draft's ID. An unsent draft is visible: the schedule's header
    reads "Draft · Waiting on Schedule", so dry runs and failed runs must delete theirs.
  - **Never permitted:** `ApiCancelInterviewScheduleProcess`, which the activity feed's
    "Delete Activity" sends. It cancels the candidate's whole scheduling activity, not a
    draft (observed blocked, October 13). The schedule overview page also has
    "Invalidate Availability Request" and "Email Candidate" beside its "Manual Schedule"
    button; the worker never uses that page's buttons.
  - **Times:** Start/End list quarter-hour times, but a typed time off that grid is offered
    as its own option ("1:05pm" saved as `13:05`), so the solver's 5-minute times work. Typing
    filters loosely ("1:00pm" also matched "11:00pm"), so the worker clicks the option whose
    text is exactly the target time, never Enter. End moves with Start, keeping the length.
    Saves carry exact instants with offset (`2026-10-12T13:00:00.000-06:00`).
  - **Discard verified (October 13):** with only `ApiDeleteDraftInterviewSchedule` permitted, once,
    bound to the TEST draft `28d21b6a…`, one click deleted it (`200`) and the Drafts tab then
    listed no drafts. TEST's availability-request schedule (`69ffae5a…`) is still open.
- **Booking through Ashby's API sends nothing** (tested October 12, 2026). Don't repeat this test.
  - **What was blocking it:** nothing in Ashby's permissions. "Blocked on IT permissions"
    was never tied to a specific setting. Luminai's `ASHBY_API_KEY` has `interviews:write`
    (checked with `apiKey.info`), and the dashboard mounts the booking engine with
    `source: null, executor: null`. `ASHBY_SCHEDULING_KEY`, `SCHEDULING_EXECUTION_ENABLED`
    and `DATABASE_URL` belong to the Poetic tracker, not this dashboard.
  - **The test:** one approved `interviewSchedule.create` on the TEST candidate
    (application `8dfd8f14…`, job TEST), "Initial" interview, `mary@luminai.com`, for
    2026-10-15 17:00–17:30Z. Ashby returned `Scheduled` with `interviewerCalendarEventId`,
    `location` and `meetingLink` all null. Mary received no invite, and the candidate
    address (Hayley's own Gmail) received no invite or confirmation. The schedule
    (`a8f06fd8…`) was then cancelled by hand in Ashby's UI, and no cancellation notice arrived
    either.
  - **No send endpoint exists.** None of Ashby's 205 API endpoints sends invitations or the
    candidate confirmation. `candidate.addEmailMessage` only attaches an email sent
    elsewhere, and `communicationTemplate.list` only lists templates. The SOP's "Send
    Calendar Invites" step exists only in Ashby's UI.
  - **Can't add to Ashby's own schedule:** `interviewSchedule.update` works only on
    schedules created by the same API key, so it can't add events to an
    availability-request schedule made in Ashby. Booking by API would leave that schedule
    open beside the new one.
  - **What's left for booking:** a person clicking Send in Ashby, or the worker automating
    Ashby's scheduler (draft → Send), which reverses the write guard's design. Either way,
    this app never writes to Google Calendar: its token only has the free/busy scope.
  - **Key scope:** the same key also has `candidates:write`, `offers:write`,
    `organization:write`, `apiKeys:write` and more. The dashboard only needs read access.
    Split it before any booking work.
  - **Separate from the "TEST petrino with Mary" records below.** The TEST application's
    availability-request schedule (`69ffae5a…`) was still open after the test; close it in
    Ashby.
- **The Slack "Schedule" button (phase two, stage 1) is built but not configured.**
  - **What it does:** on calendar-checked posts, a Schedule button with Slack's
    own confirmation dialog records an approval of that exact option (state
    `discussion_approved`, with who, when and the draft's digest). It then updates
    the message to show who approved it, that nothing is booked yet, and to book
    it in Ashby by hand for now. Booking isn't built: it was never blocked on
    permissions (see "What was blocking it" above). It is never booking
    approval, and stages 2–4 (Ashby booking, calendar invites, candidate email)
    aren't built.
  - **The endpoint:** `POST /api/slack/interactions` is one of two routes outside
    Basic Auth; the other is `GET /privacy.html`, the Google OAuth privacy policy
    (Luminai only, like the other scheduling pages; 404 elsewhere).
    Until configured it's a 404 on every dashboard.
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
- **Google Calendar data in drafts expires after 90 days** (`src/scheduling/calendar-retention.js`).
  Runs on startup and daily, Luminai only. Ninety days after the later of a draft's last
  session end and its last audit entry, it removes each session's `busy` flags and the
  "free on primary calendar" / "calendar clash flagged" label. The draft, its audit trail and
  rules-based `hours` flags stay. The digest is recomputed, so an old Slack button is refused.
  Logs are `[calendar-retention]` lines with draft ids and counts, no names.
  Not covered: Slack messages already posted (they still show the clashes), and
  `booking-ledger.json`, which has no calendar field and no deployed path that writes it.
- **Reconciling an unconfirmed Slack post** (October 14, 2026). A post Slack didn't
  confirm leaves the draft `discussion_uncertain`, which blocks that candidate's next
  post. The failure is now named on the draft (`deliveryError`, and the `issue`
  line) and logged: Slack refusing the post (not delivered), an HTTP error, or no
  answer within 15 seconds. Before this, the reason was discarded, so the October 14
  TEST Onsite post (`6681e79e…`) can't be explained: it never reached the channel,
  and its rebuilt message was well within Slack's limits.
  - **"Check Slack"** (booking page, and the Scheduling tab's draft list) opens two
    choices, made after looking in the channel: "It isn't there" rejects the draft
    so the option can be posted again; "It's there" takes the message's link, which
    must be in the draft's channel, and Slack's `chat.getPermalink` must confirm the
    message exists. The draft then becomes `shared` with that message, so its
    Schedule button works.
  - The dashboard can't look in the channel itself: the bot token's scopes are
    `chat:write`, `users:read` and `users:read.email`, without `channels:history`.

Google Cloud project was being configured in Carrara with External audience and Anna
as test user. Verify its current publishing state on resume. If still Testing,
Google refresh authorization expires after seven days; reauthorization may be needed.
Resolve production OAuth setup before relying on unattended long-term reads.

## Booking dry run in the worker (feature/booking-dry-run, October 13, 2026)

`worker/booking-dry-run.js` runs the booking dry run inside the scheduling worker
with the saved Ashby session: every step up to "Schedule", never clicked, then
the draft is deleted. Send is never a permitted write, so the guard would block it
even if clicked.

- **A command, not a route.** Nothing the worker serves or the dashboard runs loads
  it. The Slack-approved check below reaches the composer through
  `worker/booking-compose.js` instead; `test/booking-dry-run-worker.test.js`
  fails if anything else in `worker/`, or anything in `src/`, loads the robot.
  The image still starts `bootstrap.js`.
- **Two locks, checked before the session is read or a browser starts:**
  `BOOKING_DRY_RUN=on` on the worker (unset by default; setting it redeploys the
  worker, but `railway variable delete` did not, so run `railway redeploy`
  afterwards and wait for the new deployment), and an allowlist of applications in
  `worker/booking-locks.js` (only TEST, `8dfd8f14`, with its job, candidate, email
  and three schedules: Initial Screen, First Round and Onsite Interview), shared
  with the Slack-approved check.
  Adding an application takes a commit.
- **Checks before any write:** the plan is complete, starts at least 15 minutes
  out, and the saved session is for this client and `ASHBY_EXPECTED_IDENTITY`. In
  Ashby, the run refuses if the session was signed out, then checks that the
  account button reads exactly that identity (for example "Anna Jones Luminai").
- **Running it:**
  1. Build the plan locally from the dashboard's calendar-checked preview with
     `src/scheduling/booking-plan.js`. Anna's Ashby account zone is
     America/Los_Angeles (it was recorded here earlier as America/New_York,
     which was wrong). Neither that nor the candidate's availability zone sets
     the composer's zone: it's a per-draft dropdown in Ashby's scheduling view
     (the "Select a timezone" buttons; on October 14 and 16, in Anna's session,
     they read "America/Denver" and "MDT", and the composer, candidate invite,
     interviewer invites and confirmation email were all in MDT). The robot
     reads the draft's zone and enters the approved times in it (see "The
     composer's zone is read" below); a zone it can't read refuses before any
     save, and the draft is deleted. It never changes the dropdown: picking a
     zone would be a new kind of write and isn't permitted.
  2. Run `railway ssh -s scheduling-worker -- node worker/booking-dry-run.js
     --plan-base64 <base64 plan JSON>`. It runs as the worker's user, has a
     240-second deadline (exit 124, naming any draft left behind), and prints a
     report without page contents.
  3. Check the schedule's Drafts tab is empty.
- **Run in the worker, October 14, 2026** (TEST, First Round, Hayley then Mary on
  October 15, 19:00–20:00Z), Anna's saved session:
  - Two plans in America/New_York (taken then, wrongly, to be Anna's account
    zone) refused at the composer's zone check (0 saves;
    drafts deleted). The second, with the zone label in the refusal (commit
    `9abfb9f`), showed "America/Denver" and "MDT".
  - The same plan in America/Denver: `dry_run_complete`, 11/11 checks, 3 saves
    with none refused, the confirmation email from "Anna Jones
    <anna@luminai.com>", the draft deleted, and the Drafts tab empty afterwards.
    The only blocked write was the expected `ApiUpdateDraftScheduleCalendarSettings`.
- **Not yet verified:**
  - What sets the per-draft zone dropdown's starting value on a new draft. It has
    been America/Denver every time so far, in Anna's session (her account zone is
    America/Los_Angeles) and with a Pacific candidate (October 16).
  - A session copied from a local Chrome profile into a fresh context is signed
    out by Ashby about 3 seconds after load, so the worker's session path
    can't be reproduced locally; it works in the worker.
  - It can't see whether the dashboard is reading Ashby at the same moment. Run
    it when nobody is. (The Slack-approved check below takes turns with the
    dashboard's inspections; the SSH command doesn't.)

## The Ashby check after a Slack approval (October 14, 2026)

Approving a calendar-checked post with Slack's Schedule button now has the worker
compose that schedule in Ashby, as the connected account, and stop at Ashby's own
Schedule button, which it never clicks. On success the draft is **left in Ashby**
for a person to open and send; any refusal deletes it. Nothing sends invitations
or candidate email: Send isn't a permitted write, and a test fails if any worker
file permits it or the composer clicks Schedule.

- **Off switch and allowlist:** `BOOKING_COMPOSE=on` on the scheduling worker
  (unset by default; after deleting it, `railway redeploy`), and the TEST-only
  allowlist in `worker/booking-locks.js`. When either is shut, the approval is
  recorded, the check is "skipped", and the message says to book by hand.
- **The plan is fixed at posting.** When a calendar-checked option is posted,
  `bookingPlanForPost` (`src/scheduling/booking-plan.js`) builds the composer's
  plan from the option and Ashby's application (the activity holding every
  session's interview gives the card title) and stores it in the draft's plan, so
  the approval's digest covers exactly what's composed. Posts made before this
  change have no plan, so approving one just records the approval. The plan's
  zone is the candidate's availability zone.
- **The composer's zone is read, not required to match** (October 16). The first
  Slack-triggered check (TEST, Onsite) refused because the plan was in
  America/Los_Angeles (TEST's availability had been resubmitted in Pacific) while
  the composer showed "America/Denver" and "MDT". The composer's zone is a
  per-draft dropdown in Ashby's scheduling view, not derived from the account
  (Anna's is America/Los_Angeles) or the candidate's availability. The
  composer now reads it (`composerZone` in `worker/booking-check.js`): exactly one
  "Select a timezone" button must hold an IANA name, and any other may only be
  that zone's own abbreviation, or the check refuses. The approved instants are
  typed in that zone. Every save is still checked against the approved
  instants, so a misread zone refuses rather than booking a different time.
- **Where candidates see their times: their own zone, not the composer's**
  (October 19). This is different from what was assumed above. On TEST's Onsite
  the composer showed MDT (sessions typed as 11:00am MDT), but the candidate's
  invite preview showed the same sessions in the candidate's zone, "10:00 AM -
  10:30 AM (PDT)". Interviewer invites state times in the schedule's Primary
  Interview Timezone (Ashby says so on the screen, with an "Update Primary
  Interview Timezone" link). So three zones can be in play on one draft: the
  composer's, the candidate's, and the Primary Interview Timezone. The preview
  checks therefore read each time with its zone label (PDT, MDT, GMT-7 and so
  on) and compare instants, never rendered strings: the candidate's agenda
  items and date, and each interviewer invite's "Thu, Oct 22, 2026 11:00am -
  11:30am MDT" line. A different instant, or a zone label that can't be read,
  refuses; interviewer names and recipients are checked as before. The first
  Onsite run past the invite settings refused on this spuriously (10:00 AM PDT
  against an expected 11:00 AM MDT, the same instant).
  Not yet changed: the candidate confirmation email's date and times are still
  compared as text in the composer's zone. Its body has times without a zone
  label, and it's likely in the candidate's zone too; it's Off on the Onsite
  template for now, so once it's turned on, expect the check to refuse there
  until its format has been seen.
- **Two Communications layouts** (October 19). The Calendar Invites screen isn't
  the same for every schedule, so a check built against one layout refuses on the
  other:
  - One-session schedules (TEST's First Round): "Send Candidate Invite" and
    "Send Interviewer Invite(s)" checkboxes.
  - TEST's six-session Onsite: no checkboxes. Between the "Calendar Invites and
    Notifications" and "Candidate Invite" headings there are dropdowns: two
    reading "Send calendar invites" and one "Send one invite per block". The
    markup doesn't say which "Send calendar invites" is the candidate's; both
    must read it. The first Onsite runs refused with "Couldn't find 'Send
    Candidate Invite'" until the screen snapshot in the log showed this.

  TEST's one-session First Round (October 20) also showed the dropdown layout,
  with two "Send calendar invites" and no "Send one invite per block" (and no
  "Manage Candidate Invites" heading), so the check refused. That screen was
  read mid-load (2 requests in flight, 24 spinners), so no one-session rule was
  built from it: the check now waits for the Calendar Invites screen to settle
  (no requests in flight and a second of quiet, within 15 seconds; otherwise it
  refuses) before reading anything on it. The next run, settled (nothing in
  flight, previews drawn), showed the same: two "Send calendar invites", no
  per-block setting, no "Manage Candidate Invites" heading. So for a
  one-session plan the check requires exactly those two and that heading's
  absence; several sessions still need "Send one invite per block"; anything
  else refuses.

  The check accepts either layout, whichever appears. For the dropdowns it
  requires exactly those three, each reading exactly that, and accepts only
  "Send one invite per block"; anything else, or both layouts, or neither,
  refuses. It never opens or changes them (`checkInviteDropdowns` in
  `worker/booking-check.js`).

  The previews below them are told apart by document order, not position or
  heading level (`partitionPreviews`): the candidate's single combined invite
  ("Invite for Onsite, Onsite, … and Lunch" on the Onsite) sits between the
  "Candidate Invite" and "Interviewer Invites" headings, and one interviewer
  invite per session after the second. Each heading must appear once, in that
  order, with exactly one candidate preview and one interviewer preview per
  session; anything else refuses. (The previous check looked only at level-2
  headings and refused on the Onsite with "Couldn't tell the candidate invite
  from the interviewer invites".)
- **Candidate confirmation email Off** (October 19). TEST's Onsite schedule had
  "Candidate Confirmation Email Off", though the SOP requires one for onsites
  (Hayley is turning it on in Luminai's Onsite template). The check accepts Off
  and never turns it on, but it is never silent: a composed draft's Slack
  message opens with "⚠️ No candidate confirmation email will be sent", the
  notification text says so, and so does the thread reply. With it On, the
  email is opened and checked as before.
- **Robot Send: the rule is being reversed** (Hayley, October 19). "Send stays
  off the permission list" was Hayley's instruction. It's being reversed because
  invites come from whoever clicks Send: a person clicking it means the
  candidate hears from them rather than Anna, which the SOP forbids. Nothing
  sends yet; the order is fixed:
  1. **Observe the Schedule menu** (done in the check now). The first try
     (October 19) was stopped by a dialog on opening Schedule: "Heads Up — No
     Location is set for this interview's calendar invites… Invite Settings
     page. Cancel / Submit". It's a real configuration gap (the SOP requires
     Google Meet as an onsite's interview room), so it's on the never-confirm
     list beside "the interview time is in the past": the check refuses and
     says the schedule needs a location in Ashby's Invite Settings. Hayley is
     setting it on Luminai's Onsite template; once that's done the menu
     observation can proceed. With the location set, the next run showed
     "Schedule" as a plain button, so the dropdown-only observation didn't
     click it. Since then (October 20) the check clicks Schedule whatever it
     is, with the write guard on and no permit for Send, and logs one
     `screen (schedule-clicked)` line: the path before and after, every write
     Ashby attempted (blocked; a click that sends at once shows
     `ApiScheduleInterviewScheduleFromDraft` here), any dialog, any menu, and
     the screen. Nothing is confirmed or clicked after it. A dialog, a blocked
     write or a navigation refuses (and deletes the draft); a menu is closed
     with Escape.
  - The confirmation email check passed on a real run (October 20), clearing
    the gate for Send.
  - The first Schedule-click run (October 20) didn't get that far: it refused
    at the candidate invite preview, "its agenda has 0 items". The previews
    hadn't drawn when the check arrived, and had when it refused 20 seconds
    later, so either they were slower than the 15-second wait or the agenda's
    format differed (this was the first morning start). The preview read now
    waits 30 seconds, and if the agenda still can't be read the check logs its
    shape only (Hayley approved): how many lists and items, and each item's
    first 20 characters with every letter after the time masked as "x" and
    unusual spaces named ([nbsp], [nnbsp]); never a name, and only on that
    failure (`maskAgendaItem`). On the six-session
     layout "Schedule" is a dropdown. The check opens it once, logs everything
     it offers (`screen (schedule-menu)`), and closes it with Escape. Nothing in
     it is clicked, and the write guard still blocks any write the click might
     attempt. A plain "Schedule" button is never clicked.
  2. **The confirmation email check must pass on its own** before Send goes
     live. Why the old check was wrong: it searched the email body for each
     session's start time, in the composer's zone (Mountain), as a substring.
     On October 19 it passed on an email whose times were all Pacific, because
     "2:00 PM" matched inside "12:00 PM" and "2:30 PM" inside "12:30 PM". A
     contains-match can pass without understanding anything. The email's
     format was seen by logging only its date and time lines, once, on TEST
     (since removed, with its marker, so no candidate-facing email text stays
     in the logs): the same agenda as the candidate invite, one line per
     session such as "11:00 AM - 11:30 AM (PDT) - Onsite - Hayley Samuels", in
     the candidate's zone, with a name sometimes on its own line instead
     (Mary Petrino's, split as "Mary Petrino (", "LinkedIn", ")"). The check
     now reads it like the invite: each agenda line's zone, times compared as
     moments, the subject's and body's dates in that zone, every approved
     interviewer named (a name-only line below a time line belongs to it) and
     no one else. A stale date, a missing zone, a stranger or a missing name
     refuses. It's now on in Luminai's Onsite template, and its date and times are
     still compared as text in the composer's zone; enabling Send while that's
     unproven would dispatch an email nothing has verified.
  3. **Send, built October 20; `BOOKING_SEND` is off until Hayley turns it
     on to watch the first one.** What the Schedule click does was seen first
     (October 20, write guard on): on this layout clicking Schedule *is* the
     send. It fired `ApiScheduleInterviewScheduleFromDraft` at once, with no
     dialog or menu (the guard blocked it; Ashby then showed an error panel).
     Whoever clicks it sends, which is why a person clicking breaks the SOP.
     - **Announced at posting, or it doesn't send.** When a calendar-checked
       option is posted, the dashboard asks the worker (`send-status`,
       read-only) whether approving it would send. Only a clear yes marks the
       stored plan `send: true` with `sendAs` (the approval's digest covers
       both), and words that post's Schedule confirmation: "Approving sends this
       schedule now: Ashby's invitations to the candidate and interviewers, and
       the candidate's confirmation email if it's on, all from Anna Jones's
       account. Nothing is retried." A post without the mark never sends, even
       if `BOOKING_SEND` is turned on before it's approved.
     - **Locks, all checked again at approval:** the plan's `send: true`;
       `BOOKING_SEND` exactly `on` (separate from `BOOKING_COMPOSE`); the
       application and activity on `SEND_ALLOWED` (TEST's First Round
       `199e1b3d` since October 20, 23:39Z, a never-booked activity; the earlier
       `bbf93574` and `8dc8e6b6` are cancelled and on neither list; Hayley the
       only interviewer; sent by the robot October 26, then cancelled), and
       TEST's six-session Onsite `c95bfecf` since October 26, 19:44Z, a
       never-booked activity for the first multi-session send (the old Onsite
       `d98941b3` stays compose-only); every recipient on
       `SEND_RECIPIENTS`; Anna's session. The composer checks them once more
       before arming.
     - **Fresh re-read before the click** (every check, sending or not): the
       composer records Ashby's own read of the draft as it loads, repeats it
       just before Schedule, and compares the draft Ashby returns with the
       approval by exact time, interview and interviewer. No recorded read, not
       exactly one copy of the draft, or any difference refuses (draft deleted,
       nothing clicked). A read is what the write guard counts as one (its
       `classify`, which also accepts GraphQL's `{ … }` shorthand). The first
       real re-read (October 20) refused: no read was recorded. When that
       happens the check now logs every request that mentioned the draft, by
       structure only (operation names, read or write, batched, query text or
       persisted, and where the draft's ID sits in the response with the field
       names around it; never values), to fix the re-read to match. The next
       run's log showed the read: `ApiGetDraftSchedule`, with the draft at
       `data.draftInterviewSchedule` and again in the schedule's own list of
       drafts (`…interviewSchedule.drafts`), which the one-copy rule had
       rejected. The re-read now takes only that operation and that copy, and
       every other copy must have exactly the same sessions, times,
       interviews and interviewers, or it refuses (`draftReadCopy`).
     - **One permit, one click.** Exactly one `ApiScheduleInterviewScheduleFromDraft`
       for this schedule and this draft, usable only while armed; armed once,
       just before the one click, and disarmed after. The safety test enforces
       one permit, armed after the re-read, one click.
     - **After the click nothing is retried or refused**: the send may have
       happened. Ashby's answer, any navigation, dialogs (read, never answered)
       and the screen are logged; the draft is always kept. The dashboard then
       reads Ashby's API (three times, ten seconds apart): `Scheduled` with
       events matching the approval is `sent` (or `sent` with what differs);
       otherwise `send_uncertain`, which the sweep follows until Ashby shows it
       sent and never deletes. A worker failure on a sending post is also
       `send_uncertain`, never "nothing was sent".
     - **Slack where Send is on:** the post says "press Schedule, which sends it
       from Anna Jones's account"; the approved message says "Checking and
       sending in Ashby", then "Sent from Anna Jones's account at … Ashby shows
       it Scheduled, matching this approval", or "⚠️ The send may have gone …
       nothing will be retried". An announced post that didn't send says why
       ("Not sent automatically: …").
     - **The first real send (October 20, `32cf646b`) booked but didn't
       invite.** Clicking Schedule fires two writes: the booking
       (`ApiScheduleInterviewScheduleFromDraft`, permitted, accepted) and then
       `ApiPublishPendingCalendarUpdates`, which publishes the calendar
       invites. The guard blocked the second, so Ashby showed the schedule
       "Scheduled · Pending invites" with "Send to Candidate" / "Send to
       Interviewers" buttons, and nothing arrived. The check then called it
       sent from "Scheduled" alone, and Slack said the invitations and the
       confirmation email went out. That was false. Fixed (`BOOKING_SEND`
       was turned off first):
       - **Never sent without evidence.** After the click the check reads the
         schedule's page in Ashby (`classifyInviteStatus`): pending on "Pending
         invites", "Not Sent" or the Send to … buttons; sent only on an explicit
         "invites sent" with no pending sign; otherwise unknown. The page for
         invites that went out hasn't been seen yet, so the first good send may
         read as unknown. States: `sent` (Scheduled and invites sent),
         `booked_invites_pending` ("Booked, but the invitations were not sent
         … send them by hand"), `booked_invites_unknown`. The confirmation
         email is never claimed delivered, only whether it was on.
       - **The second write is permitted**: one `ApiPublishPendingCalendarUpdates`,
         armed with Send at the same click and until Ashby has tried it, only if
         its variables name this schedule or draft (their names are logged); a
         request that doesn't stays blocked and the invites show pending.
       - **The false message is corrected by the sweep**: a robot `sent` with no
         invite evidence is re-read (worker `invite-status`, read-only) and
         restated, with a "Correction:" reply in its thread.
       - The invite dropdowns' values weren't read (Hayley: Ashby plainly tried
         to send, so they were set to send; opening them isn't worth a new kind
         of action).
       - That booking's invites are still pending; they can be sent from the
         schedule's page in Ashby.
     - **The second real send (October 20, `9837bf0e`, TEST First Round
       `8dc8e6b6`, Mon 26 Oct) invited but sent no confirmation email.** The
       click fired three writes: the booking and the publish (both permitted,
       accepted; the publish named the schedule, its variables
       `externalCalendarNotificationSettings, internalCalendarNotificationSettings,
       interviewScheduleId, scopes`), then
       `ApiSendPersonalizedCandidateConfirmationEmailForDraftInterviewSchedule`,
       which the guard blocked. The schedule's page then read "Scheduled ·
       Waiting on RSVPs" with no Send Calendar Invites section, which the
       check didn't yet count as sent, so it recorded "invites unknown". Since
       then: "Waiting on RSVP(s)" with no pending sign and no "Send to …" button
       counts as sent; the confirmation email write is permitted like the
       publish (once, armed with Send, only if its variables name this
       schedule or draft, their names logged), and the email is reported only
       from Ashby's answer to it ("not sent: send it by hand" otherwise). That
       booking's message got a thread note: invitations sent, confirmation
       email not sent.
     - **Multi-word zones** (October 20): the composer showed "America/Los
       Angeles" with a space (and "PDT"); every earlier draft had shown
       America/Denver, which has none, so it only surfaced now. A zone-shaped
       button's spaces become underscores and the result must be a real IANA
       zone, or the check refuses; abbreviations are untouched.
     - **A re-used activity composes as "Rescheduling".** After its interview
       was cancelled, `8dc8e6b6` came back to NeedsScheduling in the API (the
       page still said "Provided availability", so Ready to schedule showed 0
       until availability was requested and submitted again), left a draft at
       the cancelled time, and its next draft's composer read "Rescheduling TEST
       TEST First Round Unsaved", which the check refuses (it requires
       "Scheduling …"). Send tests use a never-booked activity instead; whether
       to accept reschedules is a separate decision.
     - **To watch the first send:** set `BOOKING_SEND=on` on the scheduling
       worker (and `railway redeploy` if a variable change doesn't redeploy),
       then post a fresh TEST First Round option (only a post made with Send on
       is marked) and approve it. Turning it off: delete the variable and
       redeploy; posts already marked then compose only and say so.
  - **Recipient allowlist** (`SEND_RECIPIENTS` in `worker/booking-locks.js`):
    a robot Send may reach only hayleysamuels511@gmail.com and
    hayley@luminai.com, as candidate and every interviewer. TEST's Onsite has
    colleagues (Joe, Mary, Anna) as interviewers, so "TEST-only" alone wouldn't
    keep real invites off their calendars. Since October 26 joe@, mary@ and
    anna@luminai.com are on the list too (Hayley): they're internal, know the
    six-session Onsite test (`c95bfecf`) is coming, and stay its eligible
    interviewers, so its invites reach their calendars. Until Send exists, each check logs
    whether its recipients would pass (`send recipients: …`).
- **No screen is read before it has settled** (rule since October 20, after
  the fourth false conclusion from an early read). The composer's shared
  helpers settle after every in-app navigation and every action: nothing in
  flight and a second of quiet, within 15 seconds, or the check refuses
  ("Ashby didn't finish loading …"). Every refusal now logs the screen it
  stopped on, structure only.
- **"Configure Communications" is gone from the composer** (October 20, TEST's
  First Round `8dc8e6b6`, a fully loaded screen). In its place: a `Next`
  button and a `Communications` link to `/schedules/drafts/<draft>/communication`.
  The check refused at it ("Couldn't find 'Configure Communications'");
  nothing was booked. Since then (Hayley's decision) the check clicks the
  `Communications` link to this draft, only when the old button is absent and
  exactly one such link is present; the old button only if it's the one way
  shown; anything else refuses. `Next` is never clicked. Either way the
  Calendar Invites screen must follow.
- **The worker logs each check** (`[booking]` lines): when it starts
  (application, schedule, sessions, plan zone, any draft it replaces), then its
  outcome: composed, refused or uncertain at which step and why, each draft
  created, kept, deleted or left (and to delete by hand), the composer's zone and
  the save count. Each sweep delete logs what happened to the draft. Lines carry
  the dashboard draft's ID, which is the Slack post's "Draft reference".
  As it runs, it also logs each session's entered date, start and end (and
  whether each had to be typed or was already set), every save attempt by
  number (passed or REFUSED by the content check, with its times and selected
  interviewers, then whether Ashby accepted it), any dialog, and the
  communications screen as JSON: on arrival, and again if the check stops on
  it. The screen line lists every control (role or tag, type, name, text, and
  checked, disabled, expanded, selected and hidden states), the headings, and
  loading signals (GraphQL requests in flight, `aria-busy`, progress bars,
  spinners, "Loading" text). Never field values or email text: inputs give
  their type and name, the email editor its length.
- **How it runs** (`src/scheduling/ashby-check.js`): the approving click queues the
  check (`ashbyCheck` on the draft, revision-checked). Checks run one at a time in
  approval order, each as one signed `compose` request to the worker
  (`worker/booking-compose.js`, 5-minute timeout; the worker stops at 4 minutes).
  In the worker, Ashby work takes turns: a check waits up to 2 minutes for running
  inspections, and an inspection during a check gets "Ashby is busy". A check also
  won't start while the Ashby sign-in window is open.
- **Before making a draft** the check reads the schedule's Drafts tab. A draft the
  dashboard composed for the same schedule earlier (from an earlier approval) is
  deleted first, by its recorded ID, and that earlier message says "Superseded".
  Any other draft refuses: someone else's draft could be sent by mistake.
- **Short notice:** an approval less than two hours before the first interview
  isn't composed (the sweep would delete it at once). The message says "too close
  to the first interview — book this in Ashby by hand". It's checked again when a
  queued check's turn comes.
- **States, each shown on the approved Slack message:** too close, queued, running, composed
  ("Composed and waiting in Ashby … open it and click Send", with the sender and the
  delete deadline), skipped, refused (the step and reason; the draft deleted, or
  where to delete it by hand), not started (the worker refused before starting),
  uncertain (no clear answer; a draft may be left, with how to delete it). Nothing
  is retried. After a restart, a check still running is marked uncertain, and one
  still queued "didn't start".
- **The sweep** (every 5 minutes, same queue): for each composed draft it reads the
  schedule from Ashby's API. Sent (`Scheduled` or later) is recorded with whether
  what was booked matches the approval (times and interviewers per session); a sent
  schedule is never deleted. Unsent, the draft is deleted at whichever comes first:
  two hours before the first interview, or 24 hours after composing. The message
  then says when it was deleted and that it needs booking by hand. A draft already
  gone is "no longer in Ashby"; a delete that fails says so and how to delete it by
  hand. An unreadable schedule is left for the next sweep.
- **Not yet verified, and settled by the first TEST approval from Slack:**
  - Whether a draft made under Anna's account is visible to, and sendable by, other
    Ashby users, or only Anna.
  - Whether a reopened draft keeps everything, including "Calendar Invites: Send
    Now" and the confirmation email settings.
  - Who invitations come from when someone other than Anna clicks Send.
  - That Ashby's Drafts tab lists every draft on a schedule (the "no other
    drafts" check relies on it).
  - TEST is at Onsite Interview in Ashby (October 14), with availability submitted
    on its Onsite schedule (`d98941b3…`, now on the allowlist). Its earlier
    Initial Screen and First Round schedules are cancelled.

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
