# Ashby → Slack scorecard-reminder bot

When an interview scheduled in **Ashby** ends, this bot sends the interviewer a
**Slack DM** reminding them to submit their scorecard, with a direct link — then
escalating follow-ups (default 24h, and a final 48h SLA reminder) until it's in.

## How it works (and one important caveat)

Ashby does **not** publish an "interview ended" webhook. Its interview webhooks
are `interviewScheduleCreate` and `interviewScheduleUpdate`, which fire when a
schedule is *created or changed* — not at the moment an interview wraps up.

So this bot does the timing itself:

1. Ashby calls the webhook whenever an interview is scheduled or updated.
2. The bot verifies the signature, reads every interview event, and schedules a
   series of reminders relative to the event's **scheduled end time**
   (`endTime`) — by default at the end, at 24h, and at the 48h SLA deadline.
3. A background loop checks every 30 seconds. As each reminder time passes, it
   DMs only the interviewers who **still haven't submitted**, so nudges escalate
   until the scorecard is in and stop the moment it is. Later reminders use
   firmer wording; the final one calls out the SLA deadline.

Reminders are saved to `data/store.json`, so a restart won't drop pending ones.
Updates and cancellations from Ashby reschedule or remove the reminders.

```
Ashby ──webhook──▶ /webhooks/ashby ──▶ store ──▶ 30s loop ──▶ Slack DMs
(schedule created/updated)   (verify + parse)   (fire at end, 24h, 48h; skip submitters)
```

## Prerequisites

- Node.js 18+
- A Slack workspace where you can install an app
- Ashby admin access (to create the webhook)
- A public HTTPS URL for the server (see [Deploying](#deploying))

## 1. Create the Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → *From scratch*.
2. Under **OAuth & Permissions → Bot Token Scopes**, add:
   - `chat:write` — send messages
   - `users:read` and `users:read.email` — find a user by their email
   - `im:write` — open a DM channel
3. Click **Install to Workspace** and copy the **Bot User OAuth Token**
   (starts with `xoxb-`). That's your `SLACK_BOT_TOKEN`.

> The bot DMs interviewers by looking them up on their **email**. This only
> works when the interviewer's Ashby email matches their Slack email. Mismatches
> are logged and (optionally) posted to `FALLBACK_SLACK_CHANNEL`.

## 2. Configure the bot

```bash
cp .env.example .env
# then edit .env
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | Slack bot token (`xoxb-…`) |
| `ASHBY_WEBHOOK_SECRET` | yes | Secret you'll enter in Ashby; used to verify signatures |
| `ASHBY_API_KEY` | recommended | Enables "skip if already submitted" + enriches the DM with candidate name/job title (`candidatesRead` permission) |
| `REMINDER_DELAY_MINUTES` | no | Baseline minutes after end time before the first reminder (default `0`) |
| `REMINDER_SCHEDULE_HOURS` | no | Escalating reminder times in hours after end (default `0,24,48`) |
| `EXCLUDE_INTERVIEW_NAME_PATTERNS` | no | Interview names to skip, e.g. debriefs (default `debrief`) |
| `ASHBY_APP_BASE_URL` | no | Ashby web app base for the DM links (default `https://app.ashbyhq.com`) |
| `FALLBACK_SLACK_CHANNEL` | no | Channel ID to notify when an interviewer has no Slack match |
| `DEBUG_PAYLOADS` | no | `true` logs full raw payloads — leave on for first setup |

```bash
npm install
npm start
```

You should see `listening on :3000`.

## 3. Create the Ashby webhook

1. In Ashby: **Admin → Integrations → Webhooks → New**.
2. **Webhook type:** `interviewScheduleUpdate`.
   Create a **second** webhook for `interviewScheduleCreate` too, pointing at the
   same URL, so newly scheduled interviews are also picked up.
3. **Request URL:** `https://YOUR_PUBLIC_HOST/webhooks/ashby`
4. **Secret token:** the exact value you put in `ASHBY_WEBHOOK_SECRET`.
5. Save. Ashby sends a **ping** — the bot answers it and the webhook enables.
   (If your server is unreachable, Ashby leaves the webhook *disabled*; fix the
   URL, then re-enable it in Ashby.)

## 4. Confirm the payload field names

Payload shapes can vary slightly by workspace. With `DEBUG_PAYLOADS=true`,
schedule a test interview in Ashby and watch the logs. The parser in
[`src/ashby.js`](src/ashby.js) already tries several common key names; if your
payload uses something different for interviewer email, `endTime`, or the
per-interviewer scorecard link, adjust the `pick()` lists there.

## Testing locally

Run the server (`npm start`) in one terminal, then in another:

```bash
# schedules a reminder ~1 minute out
node scripts/send-test.js

# end time already in the past -> fires on the next 30s tick
TEST_INTERVIEWER_EMAIL=you@yourcompany.com node scripts/send-test.js now
```

Set `TEST_INTERVIEWER_EMAIL` to your own Slack email to receive the real DM.

## Deploying

The server needs a public HTTPS URL. Options:

- **Quick test:** [ngrok](https://ngrok.com) — `ngrok http 3000`, then use the
  `https://…ngrok…/webhooks/ashby` URL in Ashby.
- **Always-on:** any Node host (Render, Railway, Fly.io, a small VM, etc.).
  Set the env vars there, run `npm start`, keep it up with the platform's
  process manager (or `pm2`). Ensure `data/` is on a persistent disk so pending
  reminders survive restarts.

## Files

| File | What it does |
| --- | --- |
| `src/index.js` | Entry point — starts server + scheduler |
| `src/server.js` | Express app, webhook endpoint, signature check, ping |
| `src/signature.js` | HMAC-SHA256 verification of `Ashby-Signature` |
| `src/ashby.js` | Parses the webhook; optional API enrichment |
| `src/reminders.js` | Schedules, persists, and fires reminders |
| `src/slack.js` | Looks up the interviewer and sends the DM |
| `scripts/send-test.js` | Sends a signed sample webhook |

## Skip if already submitted

If `ASHBY_API_KEY` is set, then right before sending — not when the webhook
arrives — the bot calls `applicationFeedback.list` for the interview's
application and drops any interviewer who has already filed their scorecard for
that interview event. If everyone on the event has submitted, no DMs go out.

Matching is by Ashby user id first, then email, and (when the feedback record
carries one) scoped to the specific interview event so filing feedback for a
different round on the same application doesn't suppress this reminder. If the
API key is missing or the call fails, the bot errs on the side of reminding
everyone rather than risk skipping someone who hasn't submitted.

## Reminder schedule

Each interview gets a series of reminders, timed off its end time and set by
`REMINDER_SCHEDULE_HOURS` (default `0,24,48`):

- **0h** — right at the end, friendly nudge.
- **24h** — follow-up, firmer, if still not submitted.
- **48h** — final reminder that calls out the SLA deadline.

Every stage re-checks Ashby and only DMs people who still haven't submitted, so
an interviewer stops getting pinged the moment their scorecard is in. Change the
cadence by editing `REMINDER_SCHEDULE_HOURS` (e.g. `0,48` for just end + 48h).

## Which interviews get reminders

The bot only reminds for sessions that actually need a scorecard. Because the
webhook doesn't include the interview's name or type, the bot looks up each
interview via Ashby's `interview.info` (needs `ASHBY_API_KEY` with
`interviewsRead`) and skips the event when:

- Ashby marks the interview as a **debrief** (`isDebrief = true`), or
- the interview **doesn't require feedback** (`isFeedbackRequired = false`), or
- the interview **title matches** `EXCLUDE_INTERVIEW_NAME_PATTERNS` (default
  `debrief`) — a secondary safety net.

It also drops individual interviewers Ashby marks as not required to give
feedback (e.g. shadowers), so they aren't nagged. Any debriefs queued before
this logic existed are cleared by a one-time sweep on the next restart. Without
an API key the bot can't classify interviews and will remind for everything, so
the key is required for debrief filtering to work.

## Notes & limitations

- Reminders fire at the interview's **scheduled** end time (plus the offsets),
  not the actual end. If an interview runs long or ends early, timing is based
  on the Ashby calendar.
- If an interview is rescheduled, Ashby sends an update and any not-yet-sent
  reminders move with it. If an interview (or its whole schedule) is
  **cancelled**, its reminders are dropped — the bot reconciles against the
  event set in each webhook (a cancelled schedule arrives with no events) and
  also clears any cancelled interviews left in the queue on restart.
- A stage that has already fired won't re-fire, even if Ashby sends another
  update.
