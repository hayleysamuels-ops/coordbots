# AGENTS.md

> Scheduling project checkpoint: [start here](docs/scheduling-project/README.md).
> Development paused September 22, 2026. This index covers both repositories,
> current branches, Luminai status, private rollout history and portable setup.

Orientation for a coding agent taking over this repository. Written 15 Sep 2026
against commit `1c164fc`.

`README.md` is the operator-facing document (how to deploy, how to turn bots on,
what each bot posts). This file is the engineer-facing one: how the pieces fit,
what is load-bearing, and what will bite you. Where they overlap, the README is
authoritative on operations and this file is authoritative on code structure.

Anything this document could not establish from the repository is marked
**Unknown** rather than guessed.

---

## 1. Project overview

### What it does

A shared web dashboard for tracking **work-trial candidates** at Poetic, operated
by the Carrara talent-ops team. One card per candidate, holding the scheduling and
onboarding checklist: NDA, laptop and desk assignment, calendar holds, Slack
updates, main partner (DRI), debrief scheduling, and so on.

Around that core it has grown four things:

1. A **day-view calendar** showing which trials run on which days, with lane
   packing, room and laptop collision detection, and partner capacity.
2. An **assignment suggester** proposing a partner, desk and laptop for upcoming
   trials that lack them. Proposes only; a person accepts.
3. A **declines rail** beside the calendar, reading the Poetic Interviews Google
   Calendar and surfacing room and interviewer declines.
4. A set of **bots** that read Ashby, a Google Sheet and the calendar, and post to
   Slack.

### Primary users

Three to six Carrara talent-ops people (`users.js` seeds five named accounts plus
the `carrara.is` domain restriction). They use it daily and already know every
candidate by name. They do not need onboarding copy; they need to see state
quickly and to be told when something is missing.

### Current status

In production and in daily use. 594 tests pass. Roughly:

| Area | Status |
|---|---|
| Candidate cards, checklist, notes | Complete, in daily use |
| Google sign-in, user allowlist | Complete |
| Day-view calendar | Complete |
| Assignment suggester | Complete including accept path |
| Declines rail | Complete, reading live calendar |
| Bots 1, 3, 6, 10, housekeeping | In production |
| `declines-watch` Slack bot | **Built and enabled, never observed running** |
| Bot 7 (setup kickoff) | Not built; on hold |

---

## 2. Architecture

### Shape

A single Node process. No build step, no bundler, no framework beyond Express.
Bots run in-process on a scheduler; there is no worker service.

```
browser (public/index.html, one file)
   |  short-poll every ~4s, PUT on edit
   v
server.js  ── Express: auth, /api/*, static, UMD module routes
   |
   ├── lib/bots.js ──> bots/*.js  ──> lib/ashby.js   (Ashby, read-only)
   |      ^                        ├─> lib/sheets.js  (Sheets, read-only)
   |      |                        ├─> lib/calendar.js(Calendar, read-only)
   |      └── lib/scheduler.js     └─> lib/slack.js   (posts)
   |
   └── lib/botstore.js ──> Postgres (or bots.json locally)
                           candidates: Postgres (or data.json locally)
```

### Frontend

**`public/index.html` is the entire front end**: ~3,700 lines of HTML, CSS and
inline JavaScript in one file. No React, no build, no modules. This is
deliberate and should not be "modernised" without a reason — see §7.

Major sections are marked with banner comments (`/* ---------- Day view ---------- */`).
Find them with `grep -n "  /\* ---------- " public/index.html`.

Shared logic lives in **UMD modules** under `lib/`, loaded by both Node and the
browser:

| Module | Browser global | Purpose |
|---|---|---|
| `lib/fields.js` | `FIELDS` | The field schema. One definition. |
| `lib/effective.js` | `EFFECTIVE` | Panel value vs stored value precedence |
| `lib/dateday.js` | `DATEDAY` | Calendar-day integers, spans, windows |
| `lib/dri-aliases.js` | `DRI` | Partner name spellings → canonical people |
| `lib/assignment-inventory.js` | `INVENTORY` | People, desks, laptops, emails |
| `lib/suggest-assignments.js` | `SUGGEST` | Partner/desk/laptop proposals |
| `lib/declines.js` | `DECLINES` | Calendar decline classification |

Each is served by an explicit route in `server.js` (`/fields.js`, `/effective.js`,
and so on) and loaded by a `<script src>` tag. **The browser global name is the
name the module assigns to `root.X`, which is not always the name Node code binds
it to.** `test/browser-globals.test.js` enforces that the inline script only
references globals the browser actually receives. This exists because of a
production outage — see §10.

### Backend / API

`server.js`, ~670 lines. Routes above `app.use(requireAuth)` are public
(login, OAuth callback, wordmark); everything below requires a session.

| Route | Purpose |
|---|---|
| `GET /api/state` | All candidates + who you are |
| `PUT /api/candidates/:id` | Save one candidate (validates reversed dates) |
| `DELETE /api/candidates/:id` | Remove one |
| `GET /api/me` | Current user |
| `GET /api/bots`, `POST /api/bots/:name/config`, `POST /api/bots/:name/run` | Bots panel |
| `GET /api/panel/:ashbyCandidateId` | Bot 1's live Ashby panel |
| `GET /api/suggestions`, `POST /api/suggestions/:id/(un)dismiss` | Link suggestions |
| `GET /api/sheet-suggest`, `GET /api/panel-suggest` | Sheet/Ashby row matching |
| `GET /declines-snapshot.json` | Live calendar, or the fixture when unconfigured |
| `GET /declines-fixture.json` | The recorded capture, always |

### Data model

Two storage backends, chosen automatically:

- **`DATABASE_URL` set** → Postgres. This is production.
- **not set** → `data.json` (candidates) and `bots.json` (bot state) on disk.

Both are gitignored. Tables are created on boot by `lib/botstore.js`
(`CREATE TABLE IF NOT EXISTS`); **there is no migration system**. Schema changes
mean editing those statements and thinking about existing rows yourself.

Tables: `run_log`, `bot_config`, `pool_snapshot`, `ashby_panel_cache`,
`lookup_cache`, `suggestion_dismissals`, `readiness_notice`, `users`, and the
candidates table.

A candidate row is roughly:

```js
{ id, name, values: { ...field keys... }, fieldNotes: {},
  sheetSource: { <field>: {tab, cell, header, raw, value, fillReason, at, runId, by} },
  acceptedSource: { <field>: {value, by, at, reason, source} },
  createdAt, updatedAt, updatedBy }
```

`values` keys come from `lib/fields.js`. `sheetSource` is written by bot 10;
`acceptedSource` by the suggester's accept path. The two are distinct
provenances and bot 10 can tell them apart — see §7.

### Authentication

Google OAuth. A session is a **signed cookie**, not a session table row, so it
survives restarts. The cookie proves identity only; permission is re-read from
the `users` table on every request, so revoking access takes effect immediately.
`users.js` seeds the allowlist and restricts to the `carrara.is` domain.

`server.js` contains a deliberate comment explaining why the ID token's signature
is **not** verified locally. Read it before touching that path.

### External services

| Service | Client | Direction | Credential |
|---|---|---|---|
| Ashby | `lib/ashby.js` | Read only, endpoint allowlist | `ASHBY_READ_KEY` |
| Google Sheets | `lib/sheets.js` | Read only | `GOOGLE_SA_KEY_B64` |
| Google Calendar | `lib/calendar.js` | Read only, one scope | `GOOGLE_CAL_SA_KEY_B64` |
| Slack | `lib/slack.js` | Posts and edits | `SLACK_BOT_TOKEN` |

The two Google service accounts are **separate by design**. A test asserts
neither file reads the other's credential.

---

## 3. Bots and agents

No LLMs are involved anywhere. "Bot" here means a scheduled job. There are no
prompts, no model calls, and no AI APIs in this repository.

Bots are registered in the `BOTS` array in `lib/bots.js`. Each module exports
`{ name, title, description, schedule, defaults, requires, dryRequires, run }`.
`run(ctx)` receives `{ ashby, slack, channelId, botStore, runId, dryRun, log,
now, getCandidates, putCandidate, sheets, panelFor }` and returns
`{ outcome, summary, message }`.

`lib/scheduler.js` ticks every 30s in `America/Los_Angeles` and computes a slot
key like `2026-08-31T07:00`. `run_log` has `UNIQUE(job_name, slot_key)`, so if
Railway runs two copies only one owns the run.

**`defaults` is a seed, not the live state.** Current enabled/dry-run values live
in `bot_config` and are edited from the Bots panel in the UI. The live state of
each flag is **Unknown** from the repository alone.

| Bot | File | Trigger | Reads | Writes |
|---|---|---|---|---|
| Ashby panel (bot 1) | `bots/ashby-panel.js` | On request from the UI | Ashby | `ashby_panel_cache` |
| WT suggestions | `bots/work-trial-suggestions.js` | On request | Ashby | nothing |
| Readiness sweep (bot 3) | `bots/readiness-sweep.js` | every 15m | Ashby, candidates | Slack, `readiness_notice` |
| Pool health (bot 6) | `bots/pool-health.js` | Mon 07:00 PT | Ashby | Slack, `pool_snapshot` |
| Sheet sync (bot 10) | `bots/sheet-sync.js` | every 60m | Google Sheet, candidates | candidates |
| Declines watch | `bots/declines-watch.js` | every 10m | Calendar, candidates | Slack, `lookup_cache` |
| Housekeeping | `bots/housekeeping.js` | daily | `run_log` | `run_log` |

### Bot 1 — Ashby panel

Not scheduled. Answers `GET /api/panel/:id` from the UI. Derives the trial
window through `lib/trialwindow.js` (the single source of truth for what the
trial is), classifies pre-trial sessions, and returns a `panel` object with
`trialStart`, `trialEnd`, `scheduleState`, `interviewEventIds` and a `fields`
map. Cached 15 minutes in `ashby_panel_cache`.

`scheduleState` is three-valued: `scheduled`, `unscheduled`, `unknown`. See §7.

### Bot 3 — readiness sweep

At T-72h and T-24h before a trial, posts what is still outstanding. Checks are
declared in `bots/readiness-sweep.config.js`. A check may read one field (`key`)
or several (`keys`, all must be done). `roles` scopes a check to positions.
Posts once per (candidate, milestone); T-24 **edits** the T-72 message.

### Bot 10 — sheet sync

Reads the WT Tracker Google Sheet and fills tracker fields. The most
safety-critical bot in the repo. Its guarantees:

- Columns bind by **header text**, not position, and error loudly on a missing
  mapped header.
- Never writes a non-empty field except for the three **authoritative** fields
  (`computer`, `desk`, `driName`), and even then only if sync itself wrote the
  current value. Anything else is a **conflict**: reported, never overwritten.
- `MAX_CANDIDATES_PER_RUN = 5`, `MAX_WRITES_PER_RUN = 200`, both abort the whole
  run rather than partially applying.
- Shape assertions per column abort the run if the sheet has shifted.
- Never creates or deletes a row. **The Sheets client has no write capability
  injected at all** — a guarantee by absence, not by a check.

### Declines watch

Reads the live calendar, classifies declines (room / machine / human /
candidate), and posts one Slack message per decline. Dedupes on
`(ashbyEventId, normalised email)` in `lookup_cache`, posting only on a
transition **into** `declined`. A first run absorbs everything, posts nothing,
and announces itself once.

**It refuses to post unless the snapshot says `live: true`.** There is no
parameter that can point it at the fixture.

---

## 4. Development

```bash
npm install                 # express and pg only
npm run dev                 # loads .env, starts on PORT (default 3000)
npm start                   # no .env loading; used in production
npm test                    # node --test test/*.test.js  (594 tests)
npm run test:clock          # the whole suite at 20 simulated dates
```

**There is no linter, no typechecker and no build step.** `npm test` is the
whole gate. Do not add one without asking — see §11.

`npm run test:clock` exists because a suite full of date fixtures can grow a
test that reads "today" and passes until a Monday. It runs everything at twenty
offsets under a shifted clock. Run it after touching anything date-related.

The app refuses to boot without Google OAuth credentials.

### Testing style

Tests are `node:test` with `node:assert`. Three patterns you will meet:

1. **Plain module tests.** `require` the module, assert on it.
2. **Source-slice sandboxes.** Because `public/index.html` has no module
   boundary, front-end tests cut functions out of the file by source marker and
   run them in `new Function` with stubs. They fail loudly if the code moves,
   deliberately. See `test/dayview.test.js`, `test/declines.test.js`.
3. **Source assertions.** Some tests assert that particular code or CSS exists
   (`assert.match(html, /.../)`), used for invariants a runtime test cannot
   reach — CSS rules, the absence of a write path, the shape of a comment that
   records a decision.

Fixtures are real data where possible. `fixtures/poetic-interviews-*.json` is a
redacted capture of the live calendar; external addresses are replaced with
stable `external-NNN@redacted.invalid` pseudonyms so counts and attribution are
identical. **Do not repoint tests at live data.** The 64 machine / 16 human /
5 room assertions are the contract.

---

## 5. Environment and configuration

Never commit values. `.env` is gitignored; `.env.example` documents every name.

| Variable | Required | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` | yes | OAuth client. App refuses to boot without it. |
| `GOOGLE_CLIENT_SECRET` | yes | OAuth client secret |
| `SESSION_SECRET` | yes | Signs session cookies. Changing it signs everyone out. |
| `DATABASE_URL` | production | Postgres. Unset → local `data.json`. |
| `PORT` | no | Defaults to 3000 |
| `ASHBY_READ_KEY` | bots | Read-only Ashby key |
| `SLACK_BOT_TOKEN` | bots | `xoxb-…`, needs `chat:write` |
| `SLACK_CHANNEL_ID` | bots | `C0AU1FFSU2H` is `#poetic-rc-team` |
| `GOOGLE_SA_KEY_B64` | bot 10 | Service account JSON, base64, **sheet reader** |
| `POETIC_SHEET_ID` | bot 10 | Spreadsheet id |
| `GOOGLE_CAL_SA_KEY_B64` | declines | Service account JSON, base64, **calendar reader** |
| `POETIC_CALENDAR_ID` | declines | `…@group.calendar.google.com` |
| `TRACKER_BASE_URL` | optional | Base for Slack deep links |

The tracker runs without any bot credential; bots stay idle and say so in the UI.

**Two Google service accounts, not one.** `GOOGLE_SA_KEY_B64` reads the
spreadsheet; `GOOGLE_CAL_SA_KEY_B64` reads the calendar. Do not consolidate them.

The calendar must be shared with the calendar service account at **"See all
event details"**. At "See free/busy information only" Google returns events with
no `attendees` array at all, and every decline silently disappears.
`lib/calendar.js` detects this specific case and fails loudly.

Dev vs production differs only by which variables are set. There are no
environment branches in the code beyond the storage choice.

---

## 6. Deployment

- Hosted on **Railway**. Push to `main` auto-deploys.
- Postgres is a Railway plugin; `DATABASE_URL` is set from it.
- Production URL: `https://work-trial-tracker-production.up.railway.app`
- `.dockerignore` excludes `node_modules/`, `.git/`, `.env`, `data.json`, `bots.json`.
  `fixtures/` **is** shipped (it is redacted; the declines route reads it when
  no calendar credential is configured).
- **No migration step.** Tables are created on boot with `CREATE TABLE IF NOT
  EXISTS`. Changing a column means writing the `ALTER` yourself and considering
  existing rows.

Verifying a deploy landed: decode the build log's `containerimage.descriptor`
base64 and compare `org.opencontainers.image.created` to the push time. Matching
log text is unreliable and has produced a false "it deployed" before.

**Do not open production Postgres to a local shell** to read something the app
already serves through its authenticated API. That was ruled on explicitly.

---

## 7. Important implementation details

Things that will look wrong until you know why.

### One derivation of the trial date

`lib/trialwindow.js` is the only place that decides what a candidate's work
trial is. Windows are computed **per schedule**, never across them, because
flattening events produced a start from one schedule and an end from another.
Classification is by **session identity**, not date order. Bot 1 and the
suggestion strip both consume it. Do not compute a trial window anywhere else.

### `effective()` precedence, and the three schedule states

`EFFECTIVE.resolve(candidate, key, panelEntry, storedValue)` decides whether the
Ashby panel or the stored value wins. `PANEL_COVERS` lists which fields the
panel may answer.

The panel's `scheduleState` is three-valued and this is load-bearing:

- `scheduled` — a trial session is booked; the panel owns the dates.
- `unscheduled` — Ashby has a work-trial schedule with no trial session
  (NeedsScheduling, waiting on the candidate, or cancelled). **Positive
  information that beats a stored date.**
- `unknown` — no work-trial schedule at all; the stored value stands.

Before this existed, "Ashby says not scheduled" and "Ashby was never asked" both
fell through to the same silent fallback, and a cancelled trial kept rendering
on its old dates. Derived from the stage list **including cancelled schedules** —
`onStage()` filters those out, so it cannot be used for this.

### Provenance: three kinds of value

A field's value came from one of three places, and bot 10 can tell which:

- **sync** — `sheetSource[field].value` still matches what is stored
- **accepted** — `acceptedSource[field].value` still matches
- **typed** — neither

`provenanceOf()` is **self-invalidating**: it confirms against the stored value,
not the presence of a record, so a desk accepted on Thursday and hand-edited on
Friday reads as `typed` from Friday on. Provenance is used **only to word the
conflict**. Resolution is identical for all three: on a difference the sheet is
reported and the tracker is left alone. Do not add an overwrite path for
accepted values without asking — the invariant that "conflict" means one thing
is the point.

### Suggestions are computed as a set, and count nowhere

`suggestAll()` processes suggestible candidates in start-date order and treats an
earlier candidate's proposed partner, desk and laptop as occupied for the ones
after it. Partner and laptop are hard constraints; desk spacing is a preference
that gets labelled when it fails.

A suggestion is stamped on the **render-time entry**, never on the candidate, so
it cannot reach `values` and therefore cannot reach the readiness sweep, bot 10,
capacity counts or collision detection. That is a guarantee by construction. A
proposal also never counts toward rotation ranking — only a **confirmed** booking
does, from the moment it exists whether or not its dates have passed.

### The calendar band

- Day columns are a CSS grid; a trial is **one element spanning N columns**,
  never one per day.
- A trial reaching past the window edge is drawn **clipped with its real dates
  intact**, never redrawn as starting at the boundary. A reversed date range
  renders as a single day at the start with a flag, never dropped — a naive
  range iterates zero days and the trial vanishes.
- The hover panel lives in a **body-level layer positioned `fixed`**, not inside
  the scroller. CSS `overflow-x: auto` forces `overflow-y` from `visible` to
  `auto`, so the horizontal scroller is also a vertical scroll container and a
  panel inside it is clipped or makes the band scroll on hover.
- **There is no `scroll-behavior` in the stylesheet.** CSS `scroll-behavior`
  governs programmatic scrolls too, so it silently turned every `scrollLeft`
  assignment into an animation the next render cancelled. Smoothness is opt-in
  per call.
- The column floor is `cols * 220px + (cols - 1) * 8px`. The gutters are part of
  the sum; omitting them yields 212px columns.

### Honest-copy invariants

A recurring rule, enforced by tests in several places: **a missing answer and a
negative answer must not render the same way.** Concretely:

- The sync pill says "Offline, not saved" on the write path and "Offline,
  retrying" on the read path, because only the read path retries.
- The readiness sweep's laptop check reads `computer` and `desk`, not the
  hand-maintained `laptopDesk` select.
- The declines rail says "Main partner highlighting is off" when no interviewer
  emails are configured, rather than showing no main-partner declines.
- A failed calendar read renders "This is a fault, not an empty week."
- `test/copy.test.js` and `test/styles.test.js` enforce no em dashes, Ember only
  on flag dots and the stretched-capacity indicator, and a set of token rules.

### Design system

`DESIGN.md` is the locked visual brief for the calendar band. It supersedes the
visual sections of the older day-view specs. Contrast is **computed** in
`test/design.test.js`, not asserted: every ink is measured against every role
ground and must clear 4.5:1. FDS green was lightened from `#A4C69B` to `#A8CA9F`
because `--ink-2` measured 4.48:1 against the original.

---

## 8. Coding conventions

- **CommonJS**, `"use strict"`, no transpilation. Node ≥ 18.
- **UMD** for anything the browser also needs (see §2). Add a `server.js` route
  and a `<script src>` tag, and use the global name the module assigns.
- **Two-space indent**, double quotes in `lib/` and `bots/`, mixed in
  `public/index.html` (match the surrounding block).
- **Config is data, in a `*.config.js` file** next to the bot. Thresholds,
  column maps and vocabularies do not belong inline.
- **Comments explain why, not what**, and frequently record a decision, the
  incident that caused it, and what must not be done. Several tests assert the
  presence of these comments. Do not tidy them away.
- **Errors**: bots return `{ outcome: "skipped" | "ok" | "error", summary,
  message }` rather than throwing; the framework records the row either way.
  Client fetches distinguish 401 (sign out), 400 (rejected, surfaced inline) and
  everything else (offline).
- **Naming**: bot files are kebab-case, field keys are camelCase, calendar-day
  integers are `YYYYMMDD` numbers called `day`/`startDay`/`endDay`.
- **Tests are expected with every behaviour change**, and are expected to be
  able to fail. Several tests in this repo assert that the *old* broken shape
  would fail the same check.

---

## 9. Known issues and incomplete work

### Open

- **`declines-watch` has never been observed running.** It is enabled with
  `dryRun: false` and a 10-minute schedule. Its first run should absorb the
  existing declines, post nothing, and post one announcement line. `firstRun` is
  detected by "no `decline_seen` key has ever been stored"; if that table were
  ever pre-populated it would skip the absorb and post the backlog.
- **The candidate decline tier is inferred from the email domain.** The tracker
  holds no candidate email addresses, so "The candidate declined" really means
  "somebody outside Poetic's two domains declined". An external *interviewer*
  would be misread as a candidate. The fix is candidate emails.
- **`TBD_IS_A_VALUE` is `false`** in `bots/sheet-sync.config.js`. Every run
  reports a per-field count of TBD cells so the blast radius can be read before
  the flag is turned on. Turning it on lets `TBD` overwrite real values on the
  three authoritative fields.
- **Two `roles`-scoped readiness checks are unreviewed.** `fdeShareDocs`,
  `agentShadowSched` and `agentShadowRec` are `["FDE", "Sales"]`, excluding FDS.
  Separately, `fds9pm` is named for FDS but applies to **all** roles. Both were
  raised for a decision and neither has had one.
- **Column Q holds an unmapped value**, `"BOOKING LINK SENT"`, pending a
  decision on agent-shadowing scope. It is counted and reported every run and
  writes nothing.
- **Kyro Kohan has two candidate records** (`cmu2uxgrq23im`, `cmu2uy7ht1dje`),
  both rendering cards and both firing the readiness sweep. Declines dedupe
  correctly regardless. The duplicate itself is not fixed.
- **`README.md` is stale in one place.** Its "Known issues" section describes a
  cancelled candidate generating a readiness post; that was fixed by the
  `scheduleState` work. The rest of that section (the sweep not consulting the
  tracker's own `status` field) still stands.
- **`lookup_cache` has no TTL or invalidation.** `fetched_at` is written and
  never read. Cache busting is done by versioning the `kind` string
  (`interview_v2`).
- **Platform has no card colour.** It is a real role everywhere else; its ground
  was deliberately deferred, so it renders neutral and is *not* flagged as
  unrecognised.

### Known limitations

- Sync is ~4s short-polling, not live.
- Conflict handling is last-write-wins per candidate; the card you are typing in
  is never overwritten by an incoming poll.
- `alex`, `joshv` and `platform` have no email addresses and stay on the
  unresolved path by design.
- No layout engine in tests: anything that depends on real CSS layout is
  asserted structurally and says so.

---

## 10. History and context

Decisions and incidents that are not visible in the code but explain it.

**The recurring defect in this codebase is a failed lookup rendering as an
answer.** It has happened at least six times:

1. Bot 1 matched a `"debrief"` substring in an interview title, so
   `"FDS WT: Runbook QA Debrief"` — a session *inside* the trial — reported the
   debrief as booked and silenced the reminder for the whole FDS cohort for a
   week. Now Ashby's `isDebrief` flag only.
2. `INVENTORY.personFor` handled sheet labels and full names but not the short
   forms the sheet actually contains, so nine of twenty-five partner histories
   resolved to `null` and "Has not partnered a recorded trial" was shown about
   someone who had. Now routed through the alias map.
3. The inline script referenced `INV` while the browser global is `INVENTORY`.
   Every test passed, because the Node harness supplied it under the Node name.
   The throw was inside `renderDay`, so **every column read "No trials"** while
   the stat tiles said five trials were running.
4. A cancelled trial kept its stored dates because the panel could not say "not
   scheduled". Fixed by `scheduleState`.
5. The declines rail never passed `mainPartnerFor`, whose default returns
   `null`, so no decline could ever be a main-partner decline.
6. Bot 10 read `TBD` as blank while the suggester read it as a request.

**If you take one thing from this document, take that pattern.** When a lookup
can fail, give it somewhere to put a "no", and render that differently from a
negative answer.

### Other decisions worth knowing

- **Accepted suggestions do not lose to the sheet.** This was reversed twice.
  The final rule: on a difference, raise a conflict and leave the tracker alone,
  for all three provenances alike, so "conflict" keeps one meaning.
- **Bot 10 does not write to the sheet**, and accepting a suggestion reaches the
  tracker only. Adding a write path means a new OAuth scope and new caps; it was
  considered and declined.
- **The fixture is real data, redacted.** An earlier version shipped real
  candidate addresses; the resolution was not to exclude the file but to remove
  the PII from it, keeping counts and attribution identical.
- **Synthetic fixtures have hidden real defects twice** in this project. Prefer
  captured data, and when you report a number, say whether you measured it or
  computed it.
- **`git cherry-pick -q` is not a valid flag.** It silently did nothing and
  nearly produced the wrong commit order.
- Marker-to-marker source slices in tests have **overrun their function** more
  than once, silently checking unrelated code. Prefer brace matching.

---

## 11. Rules for future agents

1. **Never commit or echo secrets.** `.env` is gitignored. `.env.example`
   documents names only. Do not paste a base64 key into a transcript, a commit
   message or a test. `~/Downloads` may be TCC-blocked; `~/Desktop` has been
   readable.
2. **Do not open production Postgres** to read something the authenticated API
   already serves.
3. **Preserve existing functionality.** The invariants in §7 are load-bearing
   and several have incident history. If you think one is wrong, say so and ask
   rather than changing it.
4. **Run `npm test` after every change, and `npm run test:clock` after anything
   date-related.** There is no linter or typechecker; the suite is the only gate.
5. **Write tests that can fail.** Assert against real fixtures. Where a test
   cannot actually verify something (layout, live data), say so in the test
   rather than implying it measured it.
6. **Do not repoint tests at live data.** The fixture is the contract.
7. **Do not restructure the front end** into modules or a framework without
   being asked. It is one file on purpose.
8. **Do not add a linter, formatter, build step or dependency** without asking.
   The dependency list is two packages and that is deliberate.
9. **Flag uncertainty instead of guessing**, especially about anything that
   posts to Slack or writes to candidate rows. A bot posting wrong alerts into a
   working channel is worse than a bot that posts nothing.
10. **Say which of "I measured this" and "I computed this" applies** when
    reporting a fact about production. Several errors in this project's history
    were numbers produced by a script and reported as observations.
