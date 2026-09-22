# Carrara coordinator tools

- [Candidate dashboard](candidate-dashboard/README.md): client dashboards,
  scheduling review and connection setup.
- [Ashby scorecard bot](ashby-scorecard-bot/README.md): feedback reminders.

## Scheduling project — paused September 22, 2026

Start with the [Luminai scheduling handoff](candidate-dashboard/docs/scheduling-handoff.md).
It records current deployment, Google/Ashby connection status, San Francisco onsite
and travel context, verified vs unfinished behavior, and the next steps to resume
from another computer. Work is paused at the user's request.

Scheduling pilot branch: `feature/client-ashby-connection`.
[Draft PR #2](https://github.com/hayleysamuels-ops/coordbots/pull/2).
Luminai’s web deployment follows this branch; main and other clients do not yet
contain the full pilot. Booking remains disabled pending verified availability,
communications review, an executor, and explicit coordinator approval.

Poetic’s separate work-trial tracker remains in scope for eventual integration;
its code lives outside this repository. Client branch/rule isolation remains
unfinished. This documentation checkpoint does not change runtime scheduling rules.
