# Ashby → Slack Scorecard Reminder Bot — Client Setup Playbook

A repeatable, start-to-finish guide for standing this bot up at a new client.
When an interview scheduled in **Ashby** ends, the bot sends the interviewer a
**Slack DM** reminding them to submit their scorecard, with a direct link — and
skips anyone who has already submitted.

**Time:** ~20–30 minutes per client.
**Cost:** ~$5/month for always-on hosting (Railway).
**You don't need to be a developer** — every step is copy/paste, in order.

---

## How it works (read this once)

Ashby does **not** publish an "interview ended" webhook. Its interview webhooks
(`interviewScheduleCreate` / `interviewScheduleUpdate`) fire when an interview is
*scheduled or changed*, not when it wraps. So the bot does the timing itself:

1. Ashby calls the bot's webhook whenever an interview is scheduled or updated.
2. The bot verifies the request, reads each interview's scheduled **end time**,
   and schedules a series of reminders relative to it (default: end, 24h, and
   the 48h SLA deadline).
3. A loop checks every 30 seconds; as each reminder time passes, it DMs only the
   interviewers who still haven't filed their scorecard — so nudges escalate
   until it's in and stop the moment it is.

```
Ashby ──webhook──▶ bot ──▶ saved reminders ──▶ (fire at end, 24h, 48h) ──▶ Slack DMs
```

Two consequences that shape this whole guide:

- **The bot must stay awake 24/7** (that 30-second loop). So it can't run on a
  laptop long-term, and it can't use a host that "sleeps" idle apps.
- **Interviewers are matched to Slack by email.** A person's Ashby email must
  match their Slack email or the DM can't be delivered.

---

## What you need per client

- **Admin access to the client's Ashby** (to create webhooks + an API key).
- **A Slack workspace** to install the bot app in, and permission to install it.
- **The bot code** (this repo/folder) on your computer.
- A card for the ~$5/month host (Railway). Free trial credit covers setup.

> **One value changes per client and must be unique:** the webhook secret
> (Section 4). Generate a fresh one each time. The Ashby API key and Slack token
> are also per-client. Never reuse another client's secrets.

---

## Section 0 — Get the code onto your machine

If you're copying this from an existing client, duplicate the whole
`Ashby-Scorecard-Bot` folder to a new location and delete these throwaway files
if present: `.env`, `data/`, `node_modules/`. Keep everything in `src/`,
`scripts/`, `package.json`, and the `.example` files.

Open **Terminal** and move into the folder (adjust the path to where you put it;
the quotes matter if the path has spaces):

```bash
cd "/path/to/Ashby-Scorecard-Bot"
```

---

## Section 1 — Install Node.js (once per computer)

The bot runs on Node.js. Check whether it's already installed:

```bash
node -v
```

If that prints a version (e.g. `v22.x`), skip to Section 2. If it says
`command not found`:

1. Go to <https://nodejs.org> and download the **LTS** version for macOS (the
   green button — it's a `.pkg` installer).
2. Open the `.pkg` and click through with the default options.
3. **Quit Terminal completely and reopen it** (this refreshes the PATH).
4. Confirm:

   ```bash
   node -v
   npm -v
   ```

   Both should print version numbers.

---

## Section 2 — Create the Slack app

1. Go to <https://api.slack.com/apps> → **Create New App → From scratch**.
2. Name it (e.g. `Scorecard Reminder`), pick the client's workspace, **Create App**.
3. Left sidebar → **OAuth & Permissions**.
4. Under **Scopes → Bot Token Scopes**, add these four:

   | Scope | Why |
   | --- | --- |
   | `chat:write` | send messages |
   | `users:read` | read user directory |
   | `users:read.email` | find a person by their email |
   | `im:write` | open a DM |

5. Scroll up → **Install to Workspace** → **Allow**.
6. Copy the **Bot User OAuth Token** (starts with `xoxb-`). This is your
   `SLACK_BOT_TOKEN`.

---

## Section 3 — Configure and test locally

Testing on your laptop first confirms Slack works before you touch hosting.

1. Create your config file from the template:

   ```bash
   cp .env.example .env
   ```

2. Generate a **unique webhook secret** and copy the output — you'll use it in
   two places (the `.env` and Ashby):

   ```bash
   openssl rand -hex 32
   ```

3. Open `.env` in a text editor (`open -e .env` opens TextEdit) and fill in:

   - `SLACK_BOT_TOKEN=` → the `xoxb-…` token
   - `ASHBY_WEBHOOK_SECRET=` → the string from step 2
   - `ASHBY_API_KEY=` → an Ashby API key (Ashby → Admin → Integrations → API
     Keys; read/write is fine, minimum needed is `candidatesRead`)
   - `DEBUG_PAYLOADS=true` → leave on for now
   - Save as **plain text**, filename exactly `.env` (not `.env.txt`).

4. Install dependencies and start the server:

   ```bash
   npm install
   npm start
   ```

   You should see `listening on :3000`. Leave this window running.

5. In a **new** Terminal tab (`Cmd+T`), `cd` into the folder again, then send a
   fake "interview just ended" event to yourself. Use **your own Slack email**:

   ```bash
   TEST_INTERVIEWER_EMAIL=you@yourcompany.com node scripts/send-test.js now
   ```

   Within ~30 seconds you should get a Slack DM from the bot. If the server tab
   logs `No Slack user for …`, the email doesn't match a Slack account — rerun
   with the right one.

6. Stop the local server when done: click that tab and press `Ctrl+C`. (Your
   laptop isn't the real home — that's the next section.)

---

## Section 4 — Deploy to Railway (always-on hosting)

Railway keeps the bot awake 24/7 and deploys straight from Terminal (no GitHub
needed).

1. Install the Railway CLI. If it fails with a permissions error (`EACCES`), add
   `sudo` and enter your Mac password (typing is invisible — that's normal):

   ```bash
   npm i -g @railway/cli
   # if EACCES:
   sudo npm i -g @railway/cli
   ```

2. Log in (opens your browser), create a project, and deploy:

   ```bash
   railway login
   railway init      # name it, e.g. "scorecard-bot-<client>"
   railway up        # press Enter to select the service when prompted
   ```

   > If `railway up` ever returns **401 Unauthorized**, your session expired —
   > run `railway login` again, then `railway up`.

3. Set the environment variables (same as your `.env`). Open the dashboard:

   ```bash
   railway open
   ```

   Click the service box → **Variables** tab → add each (or use **Raw Editor**
   to paste all at once):

   - `SLACK_BOT_TOKEN`
   - `ASHBY_WEBHOOK_SECRET`
   - `ASHBY_API_KEY`
   - `REMINDER_DELAY_MINUTES` → `0`
   - `REMINDER_SCHEDULE_HOURS` → `0,24,48` (end, 24h, 48h SLA — change if the client's cadence differs)
   - `DEBUG_PAYLOADS` → `true`

   **Do not set `PORT`** — Railway sets it automatically (usually 8080) and the
   bot reads it. Saving variables triggers a redeploy.

4. Same panel → **Settings → Networking → Generate Domain** (enter port `8080`
   if asked). Copy the public URL, e.g.
   `https://scorecard-bot-<client>-production.up.railway.app`.

5. Confirm it's live — open this in a browser (append `/health`):

   `https://<your-domain>.up.railway.app/health` → should show `{"ok":true}`.

Your webhook endpoint is that domain **+ `/webhooks/ashby`**.

---

## Section 5 — Create the Ashby webhooks

In the client's Ashby (needs admin): **Admin → Integrations → Webhooks**.

Create **two** webhooks, identical except the type:

| Field | Webhook 1 | Webhook 2 |
| --- | --- | --- |
| Webhook type | `interviewScheduleUpdate` | `interviewScheduleCreate` |
| Request URL | `https://<your-domain>.up.railway.app/webhooks/ashby` | same |
| Secret token | your `ASHBY_WEBHOOK_SECRET` (exact match) | same |

Save each. Ashby sends a test "ping" to the bot; if the webhook saves as
**enabled**, it's connected. If it shows *disabled*, tick "enabled" and save
again to resend the ping.

*(Why two: `Create` catches newly scheduled interviews; `Update` catches
reschedules and changes.)*

---

## Section 6 — Real end-to-end test + field calibration

Ashby's exact payload field names can vary slightly by workspace, so verify once
with a real event. Stream the logs:

```bash
railway logs
```

In Ashby, **schedule a short test interview** (use a test candidate) ending
~3 minutes out, with **yourself as the interviewer** (email matching your Slack).

In the logs you should see, in order:

1. A `[server] Raw payload:` block (the webhook arriving).
2. `[reminders] Scheduled 1 reminder(s) … at <time>`.
3. ~3 minutes later: `[slack] Reminder sent to …`, and a Slack DM to you with
   the real candidate name, role, and scorecard link.

**Calibration check:** in that raw payload, confirm each interviewer has an
`email` and the event has an `endTime`. If your workspace names anything
differently, adjust the `pick([...])` lists in `src/ashby.js`, then redeploy
(`railway up`). In practice the defaults have matched.

---

## Section 7 — Customize the DM message

The message text is the `buildMessage` function in **`src/slack.js`**. Edit the
strings there (greeting, the scorecard line, the "Prefer Slack?" line). Slack
formatting: `*bold*`, `<url|link text>`, `:emoji:`.

After any code change, redeploy:

```bash
railway up
```

Then trigger a test (Section 6, or the local `send-test`) to see the new copy.

---

## Section 8 — Production hardening (do before handing off)

- **Quiet the logs / stop logging candidate data:** set `DEBUG_PAYLOADS` to
  `false` in Railway Variables (save to redeploy).
- **Survive restarts:** add a Railway **Volume** mounted at `/data`, and set a
  `DATA_DIR=/data` variable. This keeps pending reminders if the service
  redeploys or restarts.
- **Confirm interviewer emails match** between Ashby and Slack for the client's
  team, or DMs silently skip. Optionally set `FALLBACK_SLACK_CHANNEL` to a
  channel ID so mismatches get flagged there instead of only logged.

---

## Environment variables reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | Slack bot token (`xoxb-…`) |
| `ASHBY_WEBHOOK_SECRET` | yes | Shared secret; must match the value in Ashby |
| `ASHBY_API_KEY` | recommended | Enables skip-if-submitted + candidate/role names (`candidatesRead`) |
| `REMINDER_DELAY_MINUTES` | no | Baseline minutes after end time before the first reminder (default `0`) |
| `REMINDER_SCHEDULE_HOURS` | no | Escalating reminder times in hours after end (default `0,24,48`) |
| `EXCLUDE_INTERVIEW_NAME_PATTERNS` | no | Interview names to skip, e.g. debriefs (default `debrief`); also auto-skips events Ashby marks as not requiring feedback |
| `FALLBACK_SLACK_CHANNEL` | no | Channel ID to flag interviewers with no Slack match |
| `DEBUG_PAYLOADS` | no | `true` logs raw payloads (use during setup, off in prod) |
| `DATA_DIR` | no | Where reminders persist; point at a mounted volume in prod |
| `PORT` | no | Set automatically by the host — don't set it manually |

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `command not found: npm` | Node isn't installed — Section 1. |
| `EACCES` installing the Railway CLI | Rerun with `sudo`. |
| `railway up` → `401 Unauthorized` | Session expired — `railway login`, then `railway up`. |
| Webhook saves as *disabled* in Ashby | Bot wasn't reachable at ping time. Confirm `/health` works, then re-enable the webhook in Ashby. |
| No DM arrives, log says `No Slack user for …` | The interviewer's Ashby email ≠ their Slack email. |
| Nothing in logs after scheduling in Ashby | Check the webhook's **delivery log** in Ashby (shows the response it got). Confirm URL ends in `/webhooks/ashby` and the secret matches. |
| DM has no candidate name / link | `ASHBY_API_KEY` missing or lacks `candidatesRead`; or field names differ — see Section 6 calibration. |
| Reminders lost after a redeploy | Add a volume + `DATA_DIR` (Section 8). |

---

## Per-client checklist (copy this per engagement)

```
[ ] Code copied to a fresh folder (no old .env / data / node_modules)
[ ] Node.js installed (node -v works)
[ ] Slack app created; 4 scopes added; installed; xoxb- token copied
[ ] .env created; unique webhook secret generated; token + Ashby key filled
[ ] Local test DM received
[ ] Railway: CLI installed, logged in, project created, deployed
[ ] Railway: 5 variables set; domain generated; /health returns {"ok":true}
[ ] Ashby: interviewScheduleUpdate webhook (URL + secret) enabled
[ ] Ashby: interviewScheduleCreate webhook (URL + secret) enabled
[ ] Real test interview → payload seen in logs → DM received
[ ] Field calibration confirmed (email + endTime present)
[ ] Message wording customized if needed
[ ] Hardening: DEBUG_PAYLOADS=false, volume + DATA_DIR, emails verified
```
