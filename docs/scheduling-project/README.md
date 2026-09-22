# Scheduling project — start here

**Paused at the user's request, September 22, 2026.** GitHub is the source of truth
for scheduling code, tests, setup instructions, decisions and handoff. Resume
feature work only when requested. Hosted applications continue running.

## Complete project map

| Component | GitHub repository and branch | Entry points |
| --- | --- | --- |
| Shared dashboards and Luminai pilot | [coordbots](https://github.com/hayleysamuels-ops/coordbots/tree/feature/client-ashby-connection), `feature/client-ashby-connection` | `candidate-dashboard/src/scheduling/`, `public/booking.*`, `public/google-calendar.*`, `worker/`, `test/` |
| Poetic work-trial scheduling shell and discussion approval | [work-trial-tracker](https://github.com/hayleysamuels-ops/work-trial-tracker/tree/feature/scheduling-discussion-approvals), `feature/scheduling-discussion-approvals` | `lib/scheduling/`, `lib/discussion/`, `worker/`, `public/scheduling*`, `test/` |
| Current Luminai handoff | [scheduling-handoff.md](https://github.com/hayleysamuels-ops/coordbots/blob/feature/client-ashby-connection/candidate-dashboard/docs/scheduling-handoff.md) | Current implementation, deployment IDs, next steps and existing test records |
| Full project rollout history | [rollout-history.md](rollout-history.md) | Historical decisions, implementation and deployment evidence formerly outside Git |
| Work-trial booking contract | [approved-scheduling.md](../approved-scheduling.md) | Proposal, approval, executor and reconciliation design |
| Work-trial Slack discussion contract | [discussion-approvals.md](../discussion-approvals.md) | Separate exact-content approval, routing and delivery state |

Both repositories were verified on GitHub September 22. The runtime code and tests
were already pushed; this checkpoint adds missing local history and cross-repository
orientation. Coordbots is public; work-trial-tracker is private. Keep detailed
candidate/calendar observations in private storage, not the public repository.
Do not duplicate the two applications into a new monorepo or merge pilot branches
into main merely to resume. Their deployment and access boundaries are intentional.

## Resume on another computer

```sh
git clone --branch feature/client-ashby-connection https://github.com/hayleysamuels-ops/coordbots.git
git clone --branch feature/scheduling-discussion-approvals https://github.com/hayleysamuels-ops/work-trial-tracker.git
```

Authenticate to GitHub with access to both repositories. Read this index, the
current Luminai handoff, and each repository's README and agent instructions.
Run `npm ci` and `npm test` in `coordbots/candidate-dashboard` and in
`work-trial-tracker`. Worker dependencies have separate package manifests/lockfiles.
Use the checked-in `.env.example` files as configuration schemas, not real values.
Access existing Railway projects to configure a permitted environment. Do not
provision replacement services, rotate encryption keys or erase persistent state
just because the original laptop's `.local` folder is unavailable.

## State at pause

Luminai is the live pilot. Anna's hosted Ashby session has supported read-only
inspection, and her Google OAuth account-level free/busy test passed. Next work is
per-interviewer calendar verification and connecting complete calendars, working
hours and interview limits/counts to the full-agenda solver. Complete automatic
booking is still disabled. Account-level access does not verify all calendars.

Luminai is primarily based in San Francisco. Candidates may travel to the West
Coast for onsites. Record onsite location and Pacific display explicitly while
preserving original candidate availability timestamps/timezones. Travel dates,
arrival/departure buffers and local working hours need confirmation; do not turn
this context into assumed availability. No runtime rules changed at pause.

Poetic's discussion review layer was deployed September 18 and theme fixes on
September 21. Its booking worker/runtime and permission limitations remain; no
verified automated invitation executor is enabled. Latest pre-documentation source
was `d5980e6`. All 660 tests and the prior 20-offset clock sweep had passed at their
recorded checkpoints; those facts do not establish live booking readiness.

Booking and Slack discussion require separate exact-content approvals. Booking
must include both calendar invitations and candidate confirmation. Never replay
the already-sent manual test or send real candidate invitations as an implicit test.
Client-specific deployment/rule separation remains future work.

## What is stored outside GitHub, and why

GitHub holds source and reproducible setup, not running-system secrets or live data.
Railway variables/volumes and the existing private database hold credentials,
encrypted sessions/tokens, approval ledgers and candidate state. Keep those systems
and their backups intact. Source checkout does not restore production data.

Original `.local` scripts were one-off wrappers/previews using workstation paths,
private credential files, live candidate IDs and response captures. They are not
runtime dependencies. Supported replacements are the deployed coordinator pages
and checked-in routes/tests described below; no local file is needed to continue.

| Previous local activity | Portable replacement |
| --- | --- |
| Check Google configuration | `/google-calendar.html` and authenticated `/api/google-calendar/status` |
| Check saved Ashby session | `/ashby-connection.html` |
| Read submitted availability, plan or interviewer calendars | `/booking.html` with coordinator sign-in; routes in `src/scheduling/booking-routes.js` |
| Inspect existing unsent drafts | Advanced tools on booking review, bound to exact application/draft |
| Fictional UI previews and regression checks | Checked-in tests and local app using fictional data/configuration |
| Provision credentials or worker settings | Checked-in connection/setup guides plus Railway secret variables |
| Old screenshots, raw calendar exports, cached API responses | Stay private; repeat authorized fresh reads when resuming instead of using stale captures |

Do not commit `.env`, `.local`, private login files, JSON keys, OAuth tokens or
production database/volume snapshots. Current source lives in the named branches;
main alone is not a complete scheduling-project checkout.
