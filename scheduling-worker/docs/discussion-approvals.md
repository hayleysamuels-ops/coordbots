# Onsite discussion approvals

> Scheduling project checkpoint: [start here](scheduling-project/README.md).
> Development paused September 22, 2026. This index covers both repositories,
> current branches, Luminai status, private rollout history and portable setup.

Status: review layer deployed September 18, 2026; development now paused.
Live Ashby booking remains in the existing proposal-only state. Luminai, in the shared coordbots dashboard, is the
first rollout client; Poetic follows independently.

The new Scheduling navigation tab lists the existing work-trial shell proposals.
A coordinator may copy one into a separate discussion draft, review it, and
approve sharing to the candidate's configured Slack channel. Copying does not
copy booking approval, mutate the original proposal, or send a message.
Coordinators may also assemble a discussion draft for an application represented
by an existing shell proposal, using the current published Ashby activities.

The server enforces the current user's existing `can_approve` permission. Slack
submission binds approval to the exact content hash, revision and destination.
Before posting, the server re-reads the active Ashby application and current plan.
An unavailable source prevents sharing. Discussion approval is separate from
booking approval and cannot start an Ashby worker.

Configuration names are in `.env.example`: `SCHEDULING_SLACK_ROUTING` defaults to
`candidate`. `SCHEDULING_CANDIDATE_CHANNELS_JSON` privately maps each Ashby candidate
ID to `{channelId,channelName}`. A missing mapping stops sharing. For a shared
channel, explicitly choose `client` and set `SCHEDULING_SLACK_CHANNEL_ID` and
`SCHEDULING_SLACK_CHANNEL_NAME`. Store the relevant Slack app's token in
`SCHEDULING_SLACK_BOT_TOKEN`; it needs `chat:write` and access to the target channel.
The original bots' default Slack channel is not an implicit fallback.

Discussion rows use the separate `discussion_proposals` Postgres table in
production, or `discussion.json` in single-process local development. They never
write the candidate checklist or the booking proposal table. The modules under
`lib/discussion` mirror the shared dashboard's review engine, with the existing
Postgres store adapted to a separate table. No dependencies were added.

A delivery claim is saved before Slack is called. A timeout or crash leaves
`discussion_uncertain` or `sharing`; neither is automatically retried. An operator
must reconcile the destination message before making any state correction.
There is no recovery button in this first implementation.

Remaining: verified availability and invitation execution, candidate-channel
mapping automation, and live Slack configuration/testing. The
Scheduling tab does not remove Poetic's existing worker/runtime limitations.
