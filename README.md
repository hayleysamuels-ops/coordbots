# coordbots

Monorepo for Carrara recruiting operations tooling.

For Luminai's scheduling pilot (gated by `SCHEDULING_CLIENT_ID`), start with the
[scheduling handoff](candidate-dashboard/docs/scheduling-handoff.md).

| Directory | What it is | Railway service |
|---|---|---|
| `candidate-dashboard/` | Per-client coordinator dashboard | `coordbots` in each of the seven dashboard projects below |
| `candidate-dashboard/worker/` | Luminai scheduling worker | `scheduling-worker` in dashboard-luminai |
| `ashby-scorecard-bot/` | Ashby → Slack scorecard reminders, sent when someone presses Remind on a dashboard (manual-only: no automatic reminders) | `scorecard-bot` in dashboard-pace |
| `candidate-channel-bot/` | Ashby → Slack: archives a candidate's channel when their application is archived or hired. Luminai only for now | `candidate-channel-bot` in dashboard-luminai |
| `scheduling-worker/` | Copy of the Poetic work-trial tracker (squashed from work-trial-tracker `feature/scheduling-discussion-approvals` at `bbb1052`) | none: nothing deploys from this directory |
| `coordinator-metrics/` | Cross-client coordinator volume dashboard: one tab per client plus an overview, twelve months of Ashby history in a SQLite file on a volume | `coordinator-metrics` in project `coordinator-metrics` |
| `candidate-dashboard/scheduling-rules/` | Per-client scheduling policy config + JSON Schema. Moved from the repo root on 29 September 2026 so the deployed dashboard can read it. | read at runtime by the dashboard whose `SCHEDULING_CLIENT_ID` matches (today Luminai, for interviewer attendance) |

## Railway projects

Build sources below were read from Railway on 25 September 2026; Luminai's two services were moved to `main` on 28 September 2026. Every repo-connected service has watch paths, so a
push only redeploys the services whose directory changed. The dashboards exclude `candidate-dashboard/worker/`,
which only the Luminai `scheduling-worker` service builds, and every `candidate-dashboard/` service excludes
`candidate-dashboard/docs/`, so documentation-only changes redeploy nothing.

**Never add `candidate-dashboard/scheduling-rules/` to a watch-path exclusion.** Unlike
`docs/`, these files are read at runtime, so a rules change has to redeploy. A change
redeploys all seven dashboards; only the one whose `SCHEDULING_CLIENT_ID` matches a file
reads it.

| Project | Service | Builds from |
|---|---|---|
| dashboard-january | `coordbots` | this repo, branch `main`, root `/candidate-dashboard`, rebuilds only on changes under `/candidate-dashboard/**` except `/candidate-dashboard/worker/**` and `/candidate-dashboard/docs/**` |
| dashboard-luminai | `coordbots` | this repo, branch `main`, root `/candidate-dashboard`, rebuilds only on changes under `/candidate-dashboard/**` except `/candidate-dashboard/worker/**` and `/candidate-dashboard/docs/**` |
| dashboard-luminai | `scheduling-worker` | this repo, branch `main`, root `/candidate-dashboard`, Dockerfile `candidate-dashboard/worker/Dockerfile`, rebuilds only on changes under `/candidate-dashboard/**` except `/candidate-dashboard/docs/**` |
| dashboard-poetic | `coordbots` | this repo, branch `main`, root `/candidate-dashboard`, rebuilds only on changes under `/candidate-dashboard/**` except `/candidate-dashboard/worker/**` and `/candidate-dashboard/docs/**` |
| dashboard-forus | `coordbots` | this repo, branch `main`, root `/candidate-dashboard`, rebuilds only on changes under `/candidate-dashboard/**` except `/candidate-dashboard/worker/**` and `/candidate-dashboard/docs/**` |
| dashboard-runlayer | `coordbots` | this repo, branch `main`, root `/candidate-dashboard`, rebuilds only on changes under `/candidate-dashboard/**` except `/candidate-dashboard/worker/**` and `/candidate-dashboard/docs/**` |
| dashboard-litellm | `coordbots` | this repo, branch `main`, root `/candidate-dashboard`, rebuilds only on changes under `/candidate-dashboard/**` except `/candidate-dashboard/worker/**` and `/candidate-dashboard/docs/**`. Created 18 November 2026 with the CLI; root directory, builder and watch paths were set through `railway api` (`serviceInstanceUpdate`) because `railway environment edit --service-config` reported success and changed nothing. Volume `coordbots-volume` at `/data`. |
| poetic-worktrialtracker | `work-trial-tracker` | the separate `hayleysamuels-ops/work-trial-tracker` repo, branch `main`, repo root |
| poetic-worktrialtracker | `scheduling-worker` | no connected repo: deployed by CLI upload (`railway up`), Dockerfile `worker/Dockerfile`, last deployed 18 September 2026 |
| poetic-worktrialtracker | `Postgres` | Railway Postgres image |
| coordinator-metrics | `coordinator-metrics` | this repo, branch `main`, root `/coordinator-metrics`, rebuilds only on changes under `/coordinator-metrics/**` except `*.md`. **Its watch patterns come from `coordinator-metrics/railway.json`, not the dashboard** — config-as-code overrides the UI, so editing them there is silently ignored. Unlike the seven per-client dashboards this is a SINGLE deployment holding every client's Ashby key, with a volume for its SQLite history |
| dashboard-pace | `scorecard-bot` | this repo, branch `main`, root `/ashby-scorecard-bot`, rebuilds only on changes under `/ashby-scorecard-bot/**`. Created 18 November 2026. Manual-only (`AUTOMATIC_REMINDERS` unset): no Ashby webhooks, nothing sent unprompted. **No public address**, on purpose: the Pace dashboard calls it at `http://scorecard-bot.railway.internal:3000` (its `REMINDER_BOT_URL`). Never run `railway domain` on it, which creates one. Uses Pace's own Slack app (bot user `talent_os`) and the Pace dashboard's Ashby key. Volume `scorecard-bot-volume` at `/data` (the 4-hour cooldown). |
| dashboard-luminai | `candidate-channel-bot` | this repo, branch `main`, root `/candidate-channel-bot`, rebuilds only on changes under `/candidate-channel-bot/**` |

**The Feedback Reminder Bot project was Console's and is gone** (18 November 2026). Console is not a
client. Its service was stopped, its Ashby key, Slack token and webhook secret deleted from
Railway, and the project deleted (Railway finishes the deletion on 20 November 2026). Console
has been asked to revoke the key; the Slack app is being removed at api.slack.com. The code in
`ashby-scorecard-bot/` stays for Pace.

**Profound is no longer a coordination client** (17 November 2026). Leave it out of every
all-client script, loop and check. Its `dashboard-profound` Railway project was deleted on
17 November 2026, after checking its volume: it held only Ashby-derived caches (application
records, dismissals, reschedule tracking, interviewer settings), and no `notes.json`, so no
coordinator notes were ever saved there. coordinator-metrics deliberately still carries
Profound as an `ended` client, as our record of our own work; see
`coordinator-metrics/CLAUDE.md`.

**LiteLLM** (live 18 November 2026, https://litellm-candidate-dash.up.railway.app). Settings agreed: `ONSITE_STAGE_KEYWORDS=onsite`,
`DISPLAY_TIMEZONE=America/Los_Angeles`, `NO_FEEDBACK_INTERVIEWS=Lunch with the Team,Coffee`,
and Interviewer Weekly Limits, Interviewer Training, Offers, Availability Submitted and
the feedback leaderboard switched off (no weekly limits, no interviewer pools, no Ashby
offers ever, booking links instead of availability requests, and too few interviewers
for a top ten). **To do: swap its Ashby key for a read-only one.** The key in use was
created with read AND write scopes (candidates, jobs, offers, interviews, organization,
API keys). The dashboard only reads, so the write access is unused, but a leaked key
could change their Ashby. Ask LiteLLM for a key with read scopes only, then replace
`ASHBY_API_KEY` on Railway and in `candidate-dashboard/.env.litellm`.

## Two things called scheduling-worker

`scheduling-worker/` in this repo is a copy of the Poetic work-trial tracker. No
service builds from it. The tracker's web service builds from the separate
work-trial-tracker repo, and the tracker's `scheduling-worker` service was uploaded
from a local checkout with no repo connected, so it may not match this copy.

The `scheduling-worker` service in **dashboard-luminai** is a different program. It
builds `candidate-dashboard/worker/` and serves the `/booking` endpoint the Luminai
dashboard calls. The tracker worker has no `/booking` route, so pointing the Luminai
service at the tracker worker breaks availability and interview-plan reads with
"Could not confirm booking status." That happened on 25 September 2026; the service
now builds `candidate-dashboard/worker/Dockerfile` again.

Per-client config lives in environment variables and `candidate-dashboard/scheduling-rules/`. Secrets never go in the repo.
