# candidate-channel-bot

Archives a candidate's Slack channel when their Ashby application reaches a
terminal state. The bot posts a short closing notice naming the outcome, then
archives the channel, so the history ends with context instead of going quiet.

Deployed for Luminai only at present. Everything client-specific is an
environment variable, so a second client needs a new Railway service and a new
set of variables, not a code change.

## How it works

1. Ashby fires `applicationUpdate` whenever an application changes. The payload
   carries the application's `status`, one of `Active`, `Hired`, `Archived` or
   `Lead`. An archive sets it to `Archived`; a hire sets it to `Hired`, so that
   one webhook covers both outcomes. `candidateHire` is accepted too, and the
   bot deduplicates when both arrive for the same hire.
2. The bot derives the channel name from the candidate's name:
   `CANDIDATE_CHANNEL_PREFIX` plus a slug. With the prefix `cand-`, Jane Smith
   maps to `#cand-jane-smith`. Accents fold to ASCII, punctuation becomes
   hyphens, and the result is capped at Slack's 80 characters.
3. If the candidate still has an `Active` or `Lead` application for another
   role, the channel is left open.
4. It posts the closing notice and archives the channel.

Nothing is deleted. An archived Slack channel keeps its history, stays
searchable, and any member can unarchive it if a process reopens.

## The safety guard

`CANDIDATE_CHANNEL_PREFIX` is required and is the guard. The bot archives a
channel only when the channel's own name starts with that prefix, and archives
nothing at all when the prefix is unset. The check runs again immediately before
`conversations.archive`, not just at lookup, so a channel that does not look
like a candidate channel cannot be closed by this bot.

`DRY_RUN` defaults to **true**. A fresh deploy reports what it would archive and
changes nothing until someone sets it to `false`.

### The prefix is not enough on its own

Carrying the prefix does not make a channel a candidate channel. Luminai's
workspace has `#hiring-nyc-event`, a recruiting event channel sitting in the
same namespace. Nothing would archive it today, because no candidate's name
slugs onto that string, but `CHANNEL_DENYLIST` makes that a rule rather than a
coincidence. Run the calibration listing, and denylist everything in the output
that is not somebody's candidate channel.

## Slack app setup

Create a Slack app in the client's workspace with these bot scopes:

| Scope | Why |
|---|---|
| `channels:read`, `groups:read` | find the candidate's channel by name |
| `channels:manage` | archive public channels |
| `groups:write` | archive private channels |
| `chat:write` | post the closing notice |
| `channels:join` | join a public channel it is not in, so it can post |

Install it, then copy the `xoxb-` bot token into `SLACK_BOT_TOKEN`.

**Private candidate channels need the bot invited by hand.** Slack does not let
an app join a private channel on its own. Until it is invited, the bot cannot
see the channel in `conversations.list` and will report "no live channel".

## Ashby webhook setup

In Ashby, under **Admin > Integrations > Webhooks**, create one webhook:

- Event: `applicationUpdate`
- URL: `https://<your-domain>/webhooks/ashby`
- Secret: the value in `ASHBY_WEBHOOK_SECRET` (generate per client with
  `openssl rand -hex 32`, and never reuse another client's)

Optionally add a second webhook for `candidateHire` against the same URL and
secret. It is redundant with `applicationUpdate` and safe to add: the bot keys
its dedupe record on application plus outcome, so a hire is handled once.

Ashby pings the endpoint when you save the webhook. The bot answers the ping,
which is what enables it.

## Rolling it out

Order matters, because the first mistake you want to catch is a naming
convention that does not match reality.

1. Fill `.env` from `.env.example`. Leave `DRY_RUN=true`.
2. Confirm the convention against the live workspace:

   ```bash
   node scripts/dry-run.js --list
   ```

   That prints every live channel carrying the prefix, and flags private ones
   the bot is not in. If the real channels are not named the way the convention
   predicts, fix the prefix (or the channels) before going further.
3. Preview one candidate, including the notice it would post:

   ```bash
   node scripts/dry-run.js "Jane Smith" archived
   ```

   The script forces dry-run on and cannot archive anything.
4. Deploy, point the Ashby webhook at it, and confirm `/health` returns
   `{"ok":true,...}` with the prefix and outcomes you expect.
5. Let a few real archives and hires come through with `DRY_RUN=true` and read
   the logs. Each one logs the channel it would have closed.
6. When the log reads correctly, set `DRY_RUN=false` and redeploy.

## Environment variables

See `.env.example` for the annotated list. The ones that change behaviour most:

| Variable | Default | Effect |
|---|---|---|
| `CANDIDATE_CHANNEL_PREFIX` | none (required) | the naming convention and the safety guard |
| `DRY_RUN` | `true` | report only, archive nothing |
| `CHANNEL_DENYLIST` | empty | channels that carry the prefix but must never be archived |
| `ARCHIVE_ON` | `archived,hired` | drop `hired` to keep hires' channels open for onboarding |
| `POST_CLOSING_NOTICE` | `true` | post the outcome before archiving |
| `REQUIRE_ALL_APPLICATIONS_CLOSED` | `true` | keep the channel open while another application is live |
| `ASHBY_API_KEY` | empty | needed for the check above, and for the profile link |
| `DATA_DIR` | `./data` | where the record of handled events lives |

## Known limits

- **Name collisions.** Two candidates with the same name derive the same channel
  name. Whichever channel exists is the one that gets archived. If that matters
  at a client, switch the lookup to carry the Ashby candidate ID in the channel
  topic.
- **Renamed channels.** The lookup is by name, so a renamed channel stops
  matching and the bot reports "no live channel" rather than archiving the wrong
  one.
- **A failed lookup is retried, a missing channel is not.** When no channel
  matches, the bot records the event as handled so it does not re-check forever.
  When Slack or Ashby errors, nothing is recorded, so the next webhook retries.
- **Unverifiable other-application checks proceed.** If the Ashby lookup for a
  candidate's other applications fails, the bot logs a warning and archives
  anyway, on the grounds that the webhook already said this application is
  terminal. Set `REQUIRE_ALL_APPLICATIONS_CLOSED=false` if you would rather not
  make the call at all.
- **Persistence needs a volume.** Without `DATA_DIR` on a mounted volume, a
  redeploy forgets which events were handled. The practical cost is at most a
  duplicate notice attempt in a channel that is already archived, which Slack
  rejects.

## Tests

```bash
npm test
```

Covers webhook parsing for each status, the decision rules, dedupe per outcome,
channel-name derivation, and the prefix guard from both directions.
