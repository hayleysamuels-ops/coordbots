# Scheduling review pilot

Status: local implementation, not deployed. Luminai is the first live pilot;
Anna's Ashby login is the intended scheduling identity. Anna still needs to
sign in. No real interview has been scheduled and no Slack message has been sent.

## Implemented

The Scheduling tab loads the active application's published Ashby activities,
including session titles and durations. Coordinators can use these to assemble
an onsite draft, enter assignments/times, and inspect the exact agenda before
approving it for Slack discussion. These are coordinator-authored drafts;
availability, ordering, rooms, and interviewer eligibility are not auto-verified.
Times entered in the form use the browser's displayed timezone. The saved review
shows full dates and the timezone; timestamps sent to the server include offsets.

The default Slack destination is a server-configured mapping from the Ashby
candidate ID to that candidate's channel. A client-wide channel is an explicit
per-deployment alternative. Missing candidate mappings never fall back to another
channel. The coordinator sees the channel name before approving; the server
checks the channel ID again at submission time. Renames are cosmetic; IDs govern
routing. Automatic channel discovery/creation is not connected in this change.

Approvals require an individual configured coordinator account. Existing shared
Basic Auth credentials retain dashboard access but cannot approve or create
schedule drafts. Personal accounts are configured in deployment secrets, not
entered into source code. Poetic retains its existing Google identity and approval
permission instead of using these Basic Auth accounts.

Discussion approval records the actor, reviewed content hash, channel and time.
It does not authorize booking. A durable delivery claim precedes the Slack call;
concurrent clicks lose the revision comparison. Timeout/uncertain delivery stays
blocked until an operator reconciles Slack. There is no automatic repost/retry.

## Still required for live automatic scheduling

1. Anna signs into Luminai via the normal Ashby login flow. Do not share her
   password in chat or import personal Chrome cookies into a server.
2. Inspect Luminai's complete auto-scheduling flow, actual availability sources,
   interviewer pool settings, rooms, conferencing, and candidate communications.
3. Implement a Luminai source provider and booking/reconciliation executor against
   those verified interfaces. The existing work-trial approval/worker contract is
   the model: exact content approval, fresh preflight, persisted operation intent,
   no automatic retries after an uncertain write, and read-back verification.
4. Connect that executor to a separate booking approval. The current
   `Approve and schedule in Ashby` control is disabled and its endpoint returns
   unavailable. No adapter is wired in `setup.js`. No worker runs in this change.
5. Configure Slack and candidate-channel mappings; verify the destination
   workspace. Invite the bot to the approved channel and grant `chat:write`.
6. Obtain approval of a specific test schedule, candidate, recipients, timezone,
   and communications before any test invitation. Verify actual delivery, not
   merely a successful `interviewSchedule.create` response.
7. Deploy Luminai first; then configure and verify each other client separately.

A read-only check on 18 September 2026 confirmed Luminai's existing API key
includes `interviews:write` as well as read permissions. The Software Engineer,
Product published onsite activities were readable. No write endpoint was called.
The current connected Chrome session does not include Luminai.

Official references:
- https://developers.ashbyhq.com/reference/interviewschedulecreate
- https://developers.ashbyhq.com/reference/interviewscheduleupdate
- https://docs.slack.dev/reference/methods/chat.postMessage/

## Configuration

| Variable | Meaning |
| --- | --- |
| `SCHEDULING_CLIENT_ID` | Stable client identifier, e.g. `luminai`; required for drafts. |
| `SCHEDULING_APPROVERS_JSON` | Secret JSON array of `{username,password}`; password minimum 16 characters. Use distinct coordinator accounts. |
| `SCHEDULING_SLACK_ROUTING` | `candidate` (default) or explicit `client`. |
| `SCHEDULING_CANDIDATE_CHANNELS_JSON` | Private mapping of Ashby candidate ID to `{channelId,channelName}`. |
| `SCHEDULING_SLACK_CHANNEL_ID` | Destination ID when routing mode is `client`. |
| `SCHEDULING_SLACK_CHANNEL_NAME` | Human-readable name shown for client routing. |
| `SCHEDULING_SLACK_BOT_TOKEN` | This client's Slack bot token, stored as a secret. |

The existing `ASHBY_API_KEY` is used only for documented read endpoints in the
new template reader. The new feature does not call an Ashby write endpoint.

Scheduling records live in `DATA_DIR/scheduling.json` on a persistent volume.
Use one Railway service/volume for a client; separate replicas with separate
volumes are unsupported. Writers share a short filesystem lock and atomically
replace the file. A leftover `.lock` file is a recovery condition, not permission
to retry delivery. Back up state, stop writers, inspect the relevant Slack message
and proposal before clearing it. `sharing` and `discussion_uncertain` records have
no automated retry. A future operator reconciliation tool remains to be built.

## Validation

`node --test test/*.test.js` exercises permissions, concurrency, changed drafts,
changed destinations, client isolation, unknown delivery, persisted restart state,
read-only template selection, and disabled booking. Network clients are mocked.
Browser testing uses fictional candidates and mock Slack only. This is not an
end-to-end test of live Ashby booking or live Slack permissions.
