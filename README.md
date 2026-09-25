# coordbots

Monorepo for Carrara recruiting operations tooling.

| Directory | What it is | Railway service |
|---|---|---|
| `candidate-dashboard/` | Per-client coordinator dashboard | `coordbots` in dashboard-january / -luminai / -profound |
| `candidate-dashboard/worker/` | Luminai scheduling worker | `scheduling-worker` in dashboard-luminai (branch: feature/client-ashby-connection) |
| `ashby-scorecard-bot/` | Ashby → Slack scorecard reminders | — |
| `scheduling-worker/` | Poetic work-trial tracker worker (imported from work-trial-tracker) | not currently deployed — location unconfirmed |
| `scheduling-rules/` | Per-client scheduling policy config + JSON Schema | read by nothing yet |

Per-client config lives in environment variables and `scheduling-rules/`. Secrets never go in the repo.
