# coordbots

Monorepo for Carrara recruiting operations tooling.

| Directory | What it is | Railway service |
|---|---|---|
| `candidate-dashboard/` | Per-client coordinator dashboard | `coordbots` in each of the six dashboard projects below |
| `candidate-dashboard/worker/` | Luminai scheduling worker | `scheduling-worker` in dashboard-luminai |
| `ashby-scorecard-bot/` | Ashby → Slack scorecard reminders | `Feedback Reminder Bot` |
| `scheduling-worker/` | Copy of the Poetic work-trial tracker (squashed from work-trial-tracker `feature/scheduling-discussion-approvals` at `bbb1052`) | none: nothing deploys from this directory |
| `scheduling-rules/` | Per-client scheduling policy config + JSON Schema | read by nothing yet |

## Railway projects

Build sources below were read from Railway on 25 September 2026. Every repo-connected service has watch paths, so a
push only redeploys the services whose directory changed. The dashboards exclude `candidate-dashboard/worker/`,
which only the Luminai `scheduling-worker` service builds, and every `candidate-dashboard/` service excludes
`candidate-dashboard/docs/`, so documentation-only changes redeploy nothing.

| Project | Service | Builds from |
|---|---|---|
| dashboard-january | `coordbots` | this repo, branch `main`, root `/candidate-dashboard`, rebuilds only on changes under `/candidate-dashboard/**` except `/candidate-dashboard/worker/**` and `/candidate-dashboard/docs/**` |
| dashboard-luminai | `coordbots` | this repo, branch `feature/client-ashby-connection`, root `/candidate-dashboard`, rebuilds only on changes under `/candidate-dashboard/**` except `/candidate-dashboard/worker/**` and `/candidate-dashboard/docs/**` |
| dashboard-luminai | `scheduling-worker` | this repo, branch `feature/client-ashby-connection`, root `/candidate-dashboard`, Dockerfile `candidate-dashboard/worker/Dockerfile`, rebuilds only on changes under `/candidate-dashboard/**` except `/candidate-dashboard/docs/**` |
| dashboard-profound | `coordbots` | this repo, branch `main`, root `/candidate-dashboard`, rebuilds only on changes under `/candidate-dashboard/**` except `/candidate-dashboard/worker/**` and `/candidate-dashboard/docs/**` |
| dashboard-poetic | `coordbots` | this repo, branch `main`, root `/candidate-dashboard`, rebuilds only on changes under `/candidate-dashboard/**` except `/candidate-dashboard/worker/**` and `/candidate-dashboard/docs/**` |
| dashboard-forus | `coordbots` | this repo, branch `main`, root `/candidate-dashboard`, rebuilds only on changes under `/candidate-dashboard/**` except `/candidate-dashboard/worker/**` and `/candidate-dashboard/docs/**` |
| dashboard-runlayer | `coordbots` | this repo, branch `main`, root `/candidate-dashboard`, rebuilds only on changes under `/candidate-dashboard/**` except `/candidate-dashboard/worker/**` and `/candidate-dashboard/docs/**` |
| poetic-worktrialtracker | `work-trial-tracker` | the separate `hayleysamuels-ops/work-trial-tracker` repo, branch `main`, repo root |
| poetic-worktrialtracker | `scheduling-worker` | no connected repo: deployed by CLI upload (`railway up`), Dockerfile `worker/Dockerfile`, last deployed 18 September 2026 |
| poetic-worktrialtracker | `Postgres` | Railway Postgres image |
| Feedback Reminder Bot | `Feedback Reminder Bot` | this repo, branch `main`, root `/ashby-scorecard-bot`, rebuilds only on changes under `/ashby-scorecard-bot/**` |

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

Per-client config lives in environment variables and `scheduling-rules/`. Secrets never go in the repo.
