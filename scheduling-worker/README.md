# Work Trial Tracker

> Scheduling project checkpoint: [start here](docs/scheduling-project/README.md).
> Development paused September 22, 2026. This index covers both repositories,
> current branches, Luminai status, private rollout history and portable setup.

A shared dashboard for tracking work-trial candidate scheduling and onboarding tasks.
Built from Sadiqeh's checklist — one card per candidate, with the full set of
dropdowns, YES / NOT YET toggles, red→green FDE/FDS checkboxes, and per-item notes.

- **Standalone web app** — one URL your whole team opens.
- **Shared data** — everyone sees the same candidates, synced every few seconds.
- **Google sign-in** — Carrara accounts only, limited to the named people in `users.js`.

---

## What's in here

```
work-trial-tracker/
├── server.js         # Express API + Google sign-in + serves the app
├── users.js          # who is allowed in, and who can approve
├── lib/
│   ├── scheduler.js       # when bots run
│   ├── botstore.js        # run log, bot config, caches, readiness notices
│   ├── ashby.js           # READ-ONLY Ashby client (allowlisted endpoints)
│   ├── slack.js           # posting and editing messages
│   ├── bots.js            # wires the bots to the server
│   ├── sheets.js          # READ-ONLY Google Sheets client (service account)
│   ├── http.js            # postJson + mapLimit
│   ├── effective.js       # panel value vs stored value — shared with the browser
│   ├── fields.js          # THE field schema — shared with the browser
│   ├── trialwindow.js     # THE derivation of the work trial's start and end
│   └── interviewtitles.js # cached interview id -> title
├── bots/
│   ├── ashby-panel.js             # bot 1 — live Ashby panel
│   ├── ashby-panel.config.js      # stage/interview title matching, cache TTL
│   ├── work-trial-suggestions.js  # who is at Work Trial and not in the tracker
│   ├── readiness-sweep.js         # bot 3 — T-72h / T-24h outstanding items
│   ├── readiness-sweep.config.js  # the checks, milestones, tracker URL
│   ├── pool-health.js             # bot 6 — weekly pool health report
│   ├── pool-health.config.js      # pools, thresholds, acknowledged exceptions
│   ├── sheet-sync.js              # bot 10 — fills empty fields, keeps three matching
│   ├── sheet-sync.config.js       # the column map, blank rules, guards
│   ├── pre-trial-sessions.config.js # sessions that are NOT the trial date
│   └── housekeeping.js            # prunes the run log by age
├── .env.example      # the environment variables you need to set
├── package.json
├── test/
│   └── sheet-sync.test.js # acceptance tests for bot 10 — `npm test`
├── public/
│   └── index.html    # the entire front-end (one file)
└── README.md
```

Storage is automatic:
- **`DATABASE_URL` set** (e.g. on Railway) → shared Postgres. **Use this for the team.**
- **not set** (your laptop) → a local `data.json`, handy for testing.

---

## Run it locally

You need Google OAuth credentials before the app will start — it refuses to boot
without them rather than failing later at sign-in.

**One-time setup in Google Cloud** (Console → APIs & Services → Credentials → your
OAuth client). Add this to **Authorised redirect URIs**, alongside the production one:

```
http://localhost:3000/auth/google/callback
```

Google will not redirect to a URI it doesn't know, so without this line sign-in
works on Railway but not on your laptop. Both URIs can live on the same client.

**Then:**

```bash
npm install
cp .env.example .env      # fill in GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET
npm run dev               # reads .env; plain `npm start` does not
```

Generate a session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Open http://localhost:3000 — you'll get the sign-in page. Sign in with your
`@carrara.is` account, add a candidate, refresh, it persists. Leave `DATABASE_URL`
blank and it uses a local `data.json` file, so you're not touching the team's data.
Locally the five people in `users.js` are the allowlist directly; no database needed.

---

## Deploy to Railway

You need two things in the Railway project: **this app** and **a Postgres database**.

### 1. Get the code into Railway

**Option A — from GitHub (easiest to update later)**
1. Put this folder in a GitHub repo.
2. On https://railway.app → **New Project → Deploy from GitHub repo** → pick the repo.

**Option B — from your terminal (no GitHub)**
```bash
npm i -g @railway/cli
railway login
railway init          # creates a new project
railway up            # uploads and deploys this folder
```

Railway auto-detects Node, runs `npm install`, then `npm start`. It sets `PORT` for you.

### 2. Add the database
In the project canvas: **New → Database → Add PostgreSQL**. Railway provisions it.

### 3. Connect the app to the database
The app service needs a `DATABASE_URL` variable pointing at that Postgres.
- Open the **app service → Variables → New Variable**.
- Name: `DATABASE_URL`
- Value: `${{Postgres.DATABASE_URL}}`  ← Railway's reference syntax; it autocompletes as you type `${{`.

Save. Railway redeploys. The log should now print `[storage] Postgres`.

### 4. Set the sign-in variables
Still in the app service **Variables**, add all three:

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from the Google Cloud OAuth client |
| `GOOGLE_CLIENT_SECRET` | from the same client |
| `SESSION_SECRET` | a long random string — see the generator command above |

The app won't start without them. Changing `SESSION_SECRET` signs everyone out.

In Google Cloud, the production redirect URI must be registered:

```
https://work-trial-tracker-production.up.railway.app/auth/google/callback
```

### 5. Get the public URL
App service → **Settings → Networking → Generate Domain**. That link is what you
send to the 4–5 people on the team. Done.

---

## Using it

- **New candidate** → name + FDE/FDS spins up the full checklist.
- Everything auto-saves and syncs; the pill in the top bar shows **Synced / Offline**.
- The top bar shows who you're signed in as; that verified name tags your updates.
- **Export** downloads a JSON backup snapshot anytime.

### Who can get in

Sign-in is restricted twice over: Google is asked to show only `carrara.is`
accounts, **and** the server independently checks the verified email ends in
`@carrara.is` before creating a session. The `hd` hint alone is never trusted.

On top of that, only people in the `users` table can view the tracker. A valid
Carrara account that isn't listed gets a "ask Hayley to add you" page.

**To add someone:** add a row to `users.js` and redeploy, or insert straight into
the `users` table for immediate effect.

**To remove someone:** delete their row, or set `active = false` to keep the record.
Either takes effect within about 4 seconds — the users table is re-checked on every
request, so a 30-day cookie does not keep a departed person signed in.

**`can_approve`** is stored but unused so far. It's the flag the Slack bot approval
queue will read, via `canApprove(user)` in `users.js`. `slack_user_id` is stored for
the same reason — the bot will look people up by that ID.

## Updating the app later
- **GitHub deploy:** push to the repo → Railway redeploys automatically.
- **CLI deploy:** run `railway up` again from this folder.

## Notes & limits
- Sync is short-polling (~4s), which is plenty for this volume. It is not sub-second live.
- Conflict handling is last-write-wins per candidate; a card you're actively typing in
  is never overwritten by an incoming sync.
- Sessions are a signed cookie (httpOnly, secure over HTTPS, 30-day expiry) rather
  than rows in a session table, so they survive Railway restarts and redeploys.
- The cookie proves identity only. What you're allowed to do is re-read from the
  users table on every request, so access changes apply immediately.

---

## Known issues

### A cancelled or archived candidate can still generate a readiness post

**Not fixed. Logged deliberately.**

On 2 Sept 2026 bot 3 posted **Shukran Amdeen** to `#poetic-rc-team` as an FDS
trial due the next day, with five outstanding items. The trial had been
cancelled. Tess: *"almost had jump scare here but confirming it was canceled."*

Nothing in the chain misbehaved. The application was `Archived`, all three of its
Work Trial schedules were `Cancelled`, so the panel correctly declined to answer
the trial date — a cancelled schedule is not a thing that is happening. The
readiness sweep then fell back to the **stored manual `startDate`** on the tracker
row, which nobody had cleared, and rendered it as *"date only — assumed 09:00"*.

That fallback is deliberate and load-bearing elsewhere: unlinking a row, or an
Ashby outage, must not make information disappear. So the fix is not to remove
the fallback. The likely shape is for the sweep to skip a candidate whose linked
application is archived, or whose schedules are all cancelled — which means the
panel has to *say* that it declined for that reason, rather than simply returning
no date. The panel currently cannot distinguish "nothing booked yet" from
"everything that was booked is cancelled", and the readiness sweep needs that
distinction to stay silent safely.

Two related things worth knowing while this stands:

- The same fallback fires for any row whose trial is genuinely not booked yet —
  including, now, a row where only the agent shadowing is scheduled. If someone
  typed a date on such a row by hand, the sweep will use it.
- The tracker's own `status` field (`DONE` / `CANCELED`) already suppresses the
  untouched-row flag in the UI but is **not** consulted by the sweep. Setting a
  row to `CANCELED` is the current manual workaround.

## Bots

Bots run inside the same web process — there is no second service to deploy. The
scheduler checks every 30 seconds whether a job is due in **America/Los_Angeles**,
so 07:00 PT stays 07:00 PT through daylight saving.

### One resolver, two runtimes

`lib/effective.js` decides whether a field's value comes from the Ashby panel or
from what a person typed. The tracker loads it at `/effective.js` and the
readiness sweep requires it as a module, so the two cannot drift apart.

### One derivation of the trial date

`lib/trialwindow.js` is the only place that decides when the work trial starts
and ends. The trial date feeds at least nine things — the panel header, progress,
needs-attention, the role filter, sort, export, the suggestion strip's 7-day
window, and both readiness milestones — so it is derived once and read
everywhere. Two rules matter:

**Windows are per schedule, never across them.** Sid Panjwani had two `Scheduled`
schedules on the Work Trial stage: agent shadowing (1 session, 3 Sept) and the
real trial (9 sessions, 8 Sept). Flattening every event and taking the earliest
start with the latest end gave `3 Sept 14:30 → 8 Sept 20:15` — a start from one
schedule and an end from another. That is worse than a wrong date, because no
single real thing has those bounds. Eight of the twenty candidates at Work Trial
on 4 Sept 2026 had a window like that.

**Sessions are classified by identity, never by date order.** See
`bots/pre-trial-sessions.config.js`. "Skip the earliest session" would be wrong:
when only the shadowing is booked, the correct reading is "shadowing 3 Sept, work
trial not yet booked", not "the trial is whatever is left".

Where more than one schedule holds core sessions, the trial window comes from the
**fullest** one — a trial day is nine or fourteen sessions, a lone session is a
screening or a debrief — and the row says the others were not merged in, with
their statuses.

**Schedule status is a tie-break, not the primary key**, and that ordering
matters. Preferring a live schedule first reads as the safer rule and is not: on
4 Sept 2026 Joe Khosbayar's real trial was a `WaitingOnFeedback` 9-session
schedule on 3 Sept, while the only `Scheduled` schedule on his stage was a
1-session **Debrief** on 4 Sept. Ranking by liveness would have made his debrief
the trial date — the same "a session that is not the trial became the trial date"
failure, arriving through status instead of through flattening. Checked across
all 20 candidates at the stage: liveness-as-tie-break moves no row, and
liveness-first moves exactly Joe, wrongly. Where session counts genuinely tie,
the still-to-come schedule wins.

`Cancelled` schedules are dropped before any of this, which is why a superseded
trial does not compete — Poetic cancels the old schedule when a trial moves.

Anything the derivation cannot assert becomes a flag on the card rather than a
confident answer: an unclassified session carrying the date on its own, a
pre-trial session that appears after the trial (a data error, since pre-trial
sessions always come first), unreadable interview titles, or more than one
schedule with sessions.

### Bot 1 — live Ashby panel

Each candidate card shows a read-only panel of the fields Ashby can answer,
beside the manual fields, which are untouched: **Position · Work trial scheduled
· Trial dates · Pre-trial sessions · EBS status · Agent shadowing · Debrief
scheduled**. Nothing is written to Ashby or to the tracker by the bot.

**Pre-trial sessions** is its own row, next to the trial dates, and it carries
the date. A card reads *"trial 8 Sept 08:30 → 19:45"* alongside *"Agent shadowing
3 Sept 14:30"*: the shadowing stays visible, because a coordinator still has to
run it, and it is visibly not the trial date.

**Linking.** A tracker row is linked to an Ashby candidate by a person, once.
The bot suggests matches by name; a coordinator clicks to confirm; the id is
stored on the row. Names are never re-resolved afterwards — Poetic merges
duplicate candidate records, and re-resolving by name could silently repoint a
row at a different person.

**Four panel states**, deliberately distinct:

| State | Means | Fix |
|---|---|---|
| live | fetched fine | — |
| stale | Ashby unreachable | shows last values with their age; retry |
| not linked | no id stored | pick a candidate |
| linked but not found | the stored id no longer resolves, usually a merge | re-link |

A panel is **never blank**, because an empty panel could be misread as "nothing
is scheduled". If a stage or interview title cannot be read, the affected field
says `UNKNOWN` rather than `NO`.

**NDA / Workplace Agreement stays manual.** Ashby exposes no e-signature
endpoint — ten candidates were probed and all 404. There is no source to read.

**Row flag.** A row shows `Untouched Nd · starts in Nd` when nobody has edited it
for 3+ days and the trial starts within 5. It is deliberately blunt: bot 3 is the
one that says *what* is incomplete.

Everything matched inside Ashby is matched on a **title**, because the API does
not expose interviewer-pool wiring on any endpoint. Titles live in
`bots/ashby-panel.config.js`.

### Work Trial suggestions

A strip above the list shows candidates who have reached the **Work Trial** stage
in Ashby (FDE, FDS and Sales) but have no tracker row.

**The bot never creates a row.** It proposes; a coordinator clicks, and the row is
created by the browser through the same save path as the "New candidate" button —
already linked to that Ashby candidate, so the panel is live immediately and no
name matching is involved.

**The duplicate case.** If an *unlinked* row already carries that name, it offers
to **link them** rather than add a second row. A partial name match ("Ari" against
"Ari Blumkin") is offered as a *possible match* to confirm, never acted on. A
shared first name alone is not a match, so it will not propose linking strangers.

**What the main list shows:** candidates at Work Trial with no trial booked yet
(these need action), trials coming up, and trials that ended within
`suggestRecentDays` — a trial that finished two days ago still needs a debrief
booked and feedback chased. Anything older moves behind an expandable
"N with trials more than 7 days ago" line — **adds only**. A link or
possible-match suggestion stays visible however old the trial is: an unlinked row
that matches an Ashby candidate is a defect in data already held, not work
someone is choosing to take on: somebody parked at the stage is worth
knowing about, but is not a row to create today. Tune the window in
`bots/ashby-panel.config.js`.

Ordering is needs-action first: unscheduled, then soonest upcoming, then most
recently finished.

**Dismissals persist** in `suggestion_dismissals`, with who dismissed and when.
They survive a redeploy, and sit behind a "N dismissed" toggle with an undo, so
nothing is permanently buried. A dismissal is per candidate: it holds until
someone undoes it.

A footnote counts anyone at Work Trial in other roles, so they are excluded but
not invisible.

**"New candidate" is unchanged.** Poetic skips stages — candidates get scheduled
without ever being moved to Work Trial — so adding by hand is a normal path, not
a fallback.

Cost is about 24 Ashby reads per refresh (3 pages of active applications plus one
schedule read per suggestion), cached 15 minutes.

### Bot 3 — readiness sweep

Posts to `#poetic-rc-team` what is still not done before a work trial, at
**T-72h** and **T-24h**. Only the red items — green never appears, and if nothing
is red nothing is posted at all.

A trial booked **inside 72h fires on detection** rather than being skipped: the
T-72 moment has passed but is still owed. That is the case that actually bites.

**T-24 edits the T-72 message** rather than posting again, so the channel shows
one list burning down. At most two posts per candidate, enforced by the
`readiness_notice` table — keyed on **(candidate, milestone)**.

That key used to include the derived trial start, on the reasoning that a
rescheduled trial should start over. It does not work: the derived start moved
whenever *any* event moved. On 2 Sept 2026 Sid Panjwani's agent shadowing was
rescheduled three times in an afternoon, and each move produced a new key —
so nothing looked handled and the sweep posted afresh each time. Three posts went
to `#poetic-rc-team`, with the milestones reading backwards (T-24, then T-72,
then T-24). A timestamp cannot be a de-duplication key when the timestamp is the
thing that moves.

A reschedule now **edits** the existing message and labels it
*"(rescheduled — was …)"*, so the moved date is legible rather than silently
changing under a message. `trial_start` is still recorded on the row; it is just
not identity. The change migrates the live table's primary key on boot,
collapsing any duplicates to the most recently posted row per milestone.

Trial time comes from the panel when a row is linked, and from the stored date
otherwise. A date-only row has no clock time, so it is treated as starting at
09:00 PT (`assumedStartHourPT`). Unlinked rows are swept too; they just have
fewer live answers.

Never `@here`. `onShiftSlackUserId` in the config mentions one person, or nobody,
which is the default — there is no rota in any system.

Two Ashby-derived lines are worded differently on purpose, because they are
different problems: *"still needs scheduling"* is a coordinator's job, while
*"waiting on the candidate to book"* is a chase.

The checks mirror the tracker's own field schema, including role scope, so the
sweep never asks about a field the card does not show. **Two scopes are worth a
human confirming** — AS docs and agent shadowing apply to FDE *and Sales*, and
the 9pm DRI reminder applies to *every* role. That is what the card does today;
whether it is still right is a question for Sadiqeh.

### Bot 6 — pool health report

Posts to `#poetic-rc-team` every **Monday 07:00 PT**, and there is a **Run now**
button in the tracker. It posts even on a clean week: it is a standing report, so
silence should mean "no report", not "no problems".

Five sections, problems first: **Unstaffable** (no one available) · **Single point
of failure** (exactly one) · **Concentration** (anyone in 3+ pools) · **Newly
paused** (diff against last week) · **Capacity** (weekly limits vs interviews
booked).

### Bot 10 — sheet sync

Fills tracker fields that are **empty** from the WT Tracker Google Sheet, hourly.
It **ships dry-run**: it reads, plans every write, and records the plan in the run
log for someone to read in the Bots panel. Nothing is written until a coordinator
turns dry-run off.

What it cannot do, by construction:

- **Cannot overwrite an answer.** For every field except the three the sheet owns,
  a value is final once it is there. A field is treated as empty only when it is
  unset, blank, or holding exactly the default the card would show anyway — `NOT
  YET` on a toggle, a select's first option, `false` on a red/green check. That
  default is read from the field's own spec in `lib/fields.js`, never from a list
  kept in the bot. Anything else is a person's answer and is left alone, including
  a field holding `TBD`: the sheet treats "TBD" as blank, but someone who typed it
  in the tracker has answered.
  One consequence worth knowing: deliberately choosing a default stores the same
  value as never touching the field, so the sheet may fill over it.
- **Three fields are authoritative** — `driName`, `computer`, `desk`. For these the
  sheet is kept matching on every run rather than filled once. Ownership is
  decided from `sheetSource`: a tracker value equal to what sync last wrote is
  sync’s to update; anything else is somebody’s edit and becomes a **conflict**,
  left alone and surfaced on the card and the run row. A coordinator who fixed a
  desk assignment must not have it reverted an hour later by a stale sheet row.
  A blank sheet cell never blanks a field, and an agreeing sheet is never a
  conflict. Every other field stays fill-once.
- **Plans no no-ops.** A write whose value already matches what the card shows is
  dropped, so the run counts and the candidate cap reflect real changes.

Every fill is labelled `filled_unset` (the field had no stored value) or
`filled_default` (it held the default the card was already showing). The label is
recorded per field in `candidate.sheetSource` and counted on the run row as
`filledUnset` / `filledDefault`, and the dry-run plan marks the second kind. They
are both fills, but a fill over a stored default is the one to look at first if a
value ever appears that somebody did not expect.
- **Cannot create or delete a row.** It only mutates rows it was handed, and
  `lib/bots.js` passes it `putCandidate` with no delete counterpart — the same
  guarantee-by-absence as the read-only Ashby client.
- **Cannot touch a field Ashby answers**, checked against `lib/effective.js` at
  plan time rather than trusting the column map.
- **Cannot match by name.** It writes only to rows carrying a `sheetRowKey` that a
  person confirmed by clicking. Name similarity is used to *suggest* and nowhere
  else.

**Rows a person has hidden are skipped.** A hidden row is one somebody filed
away, and syncing it would resurrect the archive — as of 8 September 2026 the
sheet holds 120 candidate rows of which 105 are hidden. Row visibility is not
in the values API, so this is a second read (`spreadsheets.get`, `rowMetadata`),
and it is **required**: if visibility cannot be read, or the metadata stops
short of the data, the run aborts rather than defaulting those rows to visible.

`hiddenByFilter` is deliberately **not** a reason to skip. A filter view is
something someone left switched on, and it must never get to decide which
candidates sync. Filter-hidden rows are counted separately so the choice stays
visible rather than becoming folklore.

It also records `linkedToHiddenRows`: linked candidates whose confirmed
`sheetRowKey` names a row somebody hid. That is expected as trials finish and
get filed away — but it distinguishes "this candidate was archived" from "this
key resolves to nothing", which means the sheet changed under a confirmed link
and a person needs to look. It costs no extra read; it uses the visibility
already fetched for the run.

Every run records `visibleRows`, `hiddenByUserRows` and `hiddenByFilterRows` in
the run log, and the Bots panel shows them, so a batch of rows being archived —
or coming back — is visible instead of silently changing what syncs.

**Columns are found by their header text**, not by position, so inserting or
reordering a column in the sheet is harmless — the values are still read from the
right place and the recorded cell reference cites where the value actually is. The
fixed indices in the column map remain only as a fallback for a sheet with *no*
header row, which is how this one read until 8 September 2026.

If a header row is present but a mapped column is missing from it — renamed,
deleted, or pushed outside the read range — the run **aborts and writes nothing**,
reporting which header it could not find. It deliberately does not fall back to
the old position: that is how a single inserted column ends up writing one
field's data into the next field along, with every value still looking plausible.
A missing *context-only* header (an Ashby-owned column) costs a line of detail on
a suggestion and is reported rather than treated as a failure.

It also aborts the whole run, writing nothing, if a shape assertion fails or the
plan would write to more than `MAX_CANDIDATES_PER_RUN` (5) candidates. The cap
counts **candidates**, not fields, because a candidate is the unit a person
reviews — one freshly linked candidate can legitimately need all 15 syncable
fields at once, and a cap counted in writes punished exactly that ordinary case
while saying nothing about the failure it guards. A restructured sheet shows up
as *many candidates* changing in one run, which is what this catches.
`MAX_WRITES_PER_RUN` (200) remains as a backstop for the pathological case the
candidate count cannot see; a legitimate run cannot reach it.

If the visible set is **empty** — everything filed away, normal at the end of a
cycle — the run finishes `ok` with the note *"no visible rows to sync"* and the
assertions are skipped. They only mean something against rows that exist: "First
Name is populated" is false for an empty set and would otherwise abort, reading
as a broken sheet when nothing is broken. The counts still distinguish an empty
sheet from a fully archived one.

**Panel density.** Both panels are compact once there is nothing to decide.
The sheet panel, when linked, is one line — the sheet row's name and number —
with who linked it, when, and what has been filled behind a click. The Ashby
panel, in its live state, collapses to a summary plus the refresh age when all
seven values are readable; any field that is UNKNOWN or not booked stays
expanded with its reason, and clicking the summary expands all seven. Data flags
are never collapsed. Disclosure is a button, never a hover, and the default is
collapsed. The unlinked, not-found, unconfigured and stale states are unchanged:
those are the ones that need to be noticed.

**Linking.** Each card has a *WT Tracker sheet* panel beside the Ashby one. "Find
sheet row" proposes matches from columns A and B; clicking **Link** saves
`sheetRowKey`, `sheetLinkedName`, `sheetLinkedBy` and `sheetLinkedAt` through the
ordinary `PUT /api/candidates/:id`. Row identity is the normalised `first|last`
pair, which survives a re-sort where a row number would not. Two rows sharing a
name get keys pinned to their row (`first|last@r7`) so they stay distinguishable;
an ambiguous or moved key resolves to nothing and writes nothing.

Every filled field records where it came from, down to the cell, in
`candidate.sheetSource` — shown on the card, so a value that appeared on its own
can be traced back and undone by hand. Every write sets `updatedBy = "sheet-sync"`.

Needs `GOOGLE_SA_KEY_B64` and `POETIC_SHEET_ID`; it does not need Ashby or Slack.
The sheet must be shared with the service account's `client_email` as Viewer — it
holds no IAM role. Acceptance tests: `npm test`.

### Turning bots on and off

Open **Admin / Automation**, then the **Bots** panel. Any signed-in coordinator can
flip two switches, no deploy needed:

- **enabled** — off means the Monday schedule skips it. **Run now** still works.
- **dry-run** — the report is written to the run log instead of posted to Slack.
  **New bots ship with dry-run ON.** Turn it off when you are happy with what it says.

A run that fails writes its failure into `run_log` rather than vanishing: the
row is claimed before the job body, and anything throwing afterwards finishes
that row with `outcome='error'` and the message. If storage itself is broken and
no row can be claimed, the log carries `FAILED BEFORE CLAIM`, which is greppable.
A bot skipped for missing configuration records `skipped_unconfigured` with the
variable name, so a missing setting is never mistaken for a crash.

A *disabled* bot deliberately writes nothing — the Bots panel already
distinguishes enabled-and-quiet from never-run, and a row every tick would be
about ninety-six a day of noise.

**Reading what a bot said.** Click a bot's name in the panel to expand it. The
last run shows the message exactly as it went to Slack — or, in dry-run, exactly
as it would have — followed by the previous few runs with their times and
outcomes. That is the point of dry-run: the team reads what a bot would have
said and says whether it is wrong, without anyone forwarding reports by hand or
reading Postgres. Expanding is display only and triggers no write.

Every run writes a row to `run_log`: what it saw, what it posted, and any error.
That table is the answer to "did the bot do anything this morning?"

**A dry run writes `run_log` and nothing else.** It must never change what a
live run would later do, and for a while it did:

- The readiness sweep recorded `readiness_notice` rows from a dry run. Recording
  a notice is what marks a milestone spoken for, so a *preview* was deciding
  that a real message would never be sent. The bot then went quiet and looked
  like it was working. Dry run is now a no-op against that table, and the same
  candidates are re-evaluated every tick — which is what a preview should do.
- Pool health saved its `pool_snapshot` before the dry-run check. That snapshot
  is the baseline the "newly paused" diff runs against, so the next live report
  would have compared itself to a preview instead of to the last thing anyone
  was told, silently swallowing every pause in between.

Caches are the exception and are written in either mode: `ashby_panel_cache` and
`lookup_cache` hold only data fetched from Ashby, are rebuildable, and change no
decision. Housekeeping already returned before pruning.

If you are diagnosing a bot that has gone quiet, this is the first thing to
check: a milestone is consumed, not repeated, so "nothing posted" and "already
handled" look identical from Slack.

### Choosing the pools

`bots/pool-health.config.js` is meant to be edited without touching code. A pool
is included if its title contains `"Work Trial"`, or if it is listed in
`extraIncludes` (which starts with `FDE Onsite Presentation Attendee`). `excludes`
removes pools regardless.

### Switching a check off

`disabledChecks` in the same config file turns a whole check off. It is not an
acknowledgement of today's findings — the question stops being asked, now and in
future:

```js
disabledChecks: [
  { check: "spof", reason: "...", decidedBy: "...", decidedOn: "2026-08-31" },
],
```

Each entry carries a reason, a decider and a date, exactly as a suppression
does. A check switched off with no note is how a deliberate silence later gets
mistaken for a bug — or for a suppression nobody agreed to. The Slack thread
shows the reason and how old the decision is.

The report footer always lists what is switched off (`not checked: Single point
of failure, Concentration`), and a switched-off check can never contribute to the
"no problems found" line, so a quiet report is never mistaken for a clean week.
Switched-off checks are not written to the run log either. Delete a line to turn
one back on.

### Acknowledged exceptions

Known and accepted findings go in `suppressions` in the same file. They drop out
of the report body and collapse to one line at the bottom — `1 acknowledged` —
with the detail in the Slack thread, including **how old the decision is**
("acknowledged 6 months ago by Poetic IT"). Anything older than six months is
marked *worth revisiting*, so an inherited decision nobody has revisited does not
look the same as one made last week.

A suppression hides **one check for one target**. Suppressing `unstaffable` for a
pool does not hide that same pool showing up as a single point of failure. If a
suppression stops matching anything — usually because a pool was renamed — the
report says so, rather than quietly hiding a real problem forever.

### The Ashby key must be read-only

`lib/ashby.js` has a fixed list of four endpoints it may call, all reads. There is
no method that writes and no way for a caller to name its own endpoint, so nothing
in this repository can archive, reject, or advance a candidate. Adding an endpoint
to that list is a deliberate change and should be reviewed as one.

### Running a bot locally

```bash
npm run dev
```

Add `ASHBY_READ_KEY` to `.env`, then open the tracker, expand **Bots**, leave
**dry-run** on, and press **Run now**. The rendered message lands in the run log
(`bots.json` locally) without touching Slack. Add `SLACK_BOT_TOKEN` and
`SLACK_CHANNEL_ID` only when you want it to post for real.

Missing bot variables do **not** stop the tracker from starting — it runs
normally and the Bots panel shows which ones are missing.


### Coordination dashboard (September 2026)

The dashboard puts an action queue beside the calendar. Its order is overdue
starts, today/tomorrow, the next three Pacific calendar days, other blocked
work, closing out, and candidates awaiting a date. Trials only have dates;
"Today / tomorrow" does not claim an exact 24-hour start window. Declines do
have session times and can show a precise 24-hour warning.

Click a candidate in the queue, calendar or list to open the shared detail
panel. On narrow screens this is a drawer; Close or Escape returns to the
workspace. White calendar cards summarize resources and proposal counts.
Accepting a proposal still writes only to the tracker, through the existing
acceptance path. It does not book a resource in Google Calendar.

Coordination owners, resource follow-up flags and decline triage are stored in
`candidate.coordination` through the existing candidate save API. Assign to me,
Find replacement, Reschedule and Mark handled record tracker coordination only.
The detail panel links to Google Calendar for the actual session change.
Reopen reverses handled status. A different session start or set of declining
attendees requires fresh triage. Unmatched sessions remain visible and cannot
be marked handled until linked to a tracker candidate.

Possible duplicate records are flagged by shared Ashby link or normalized full
name. Compare links open each record; no records are merged or deleted and no
bot eligibility changes automatically.

Work Trial suggestions support selection, bulk add and dismiss, and undo.
Bulk add skips ambiguous matching records for individual review. Only confirmed
server writes count as completed; failed rows remain available to retry. Last
batch dismissal IDs are retained in this browser for undo, and the dismissed
list supports restoration on other browsers too. Owners remain unassigned until
someone sets a coordinator after adding the candidate.

All bot controls and snapshot import/export are under Admin / Automation. The
dashboard health label summarizes available run results, rather than claiming
that an unobserved bot is healthy.

## Onsite discussion approvals (local implementation)

The Scheduling tab can copy existing work-trial proposals into separate onsite
discussion drafts for coordinator-approved Slack sharing. Candidate-specific
channels are the default; client-wide routing is explicit. Booking remains
proposal-only. See [discussion approvals](docs/discussion-approvals.md).
