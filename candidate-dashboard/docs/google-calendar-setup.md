# Luminai read-only calendar setup

> **Current checkpoint (September 22, 2026): work paused by the user.** Read the
> [Luminai handoff](scheduling-handoff.md) for deployed state, San Francisco onsite context,
> remaining verification, deployment branch and instructions for resuming elsewhere.

The scheduler uses Google OAuth to read busy intervals, not event titles or
contents. It never creates, updates or deletes Google Calendar events. Booking
and candidate confirmation remain separate Ashby actions requiring approval.

## Current connection

OAuth credentials are configured in the Luminai WEB service. Anna connected
`anna@luminai.com`; her September 22 screenshot confirms the account-level
read-only test passed. The full plan’s interviewer calendars have not yet been
verified at this checkpoint. No service account is used. If the External app
remains in Testing, refresh tokens expire after seven days; verify publishing
status and reauthorize as needed before resuming.

## Google Cloud administrator

1. Enable **Google Calendar API** in the chosen Google Cloud project. The user
   chose Carrara-hosted OAuth with Anna authorizing her Luminai account.
2. Configure Google Auth Platform branding and audience. Use **Internal** when
   the project belongs to Luminai's Workspace organization. If using External
   testing, add `anna@luminai.com` as a test user and review Google's testing-mode
   token expiry rules before relying on unattended access.
3. Request only `openid`, `email`, and
   `https://www.googleapis.com/auth/calendar.events.freebusy`.
4. Create an OAuth client of type **Web application**. Add this exact authorized
   redirect URI:

   `https://coordbots-production-f093.up.railway.app/api/google-calendar/callback`

5. Save the client ID and client secret directly in the Luminai dashboard web
   service's Railway variables:

   - `GOOGLE_CALENDAR_CLIENT_ID`
   - `GOOGLE_CALENDAR_CLIENT_SECRET`

   Do not paste client secrets in chat, commit them, or put them in the worker's
   variables. The OAuth callback runs on the dashboard web service.

6. Preserve the deployment's `GOOGLE_CALENDAR_ENCRYPTION_KEY`. It encrypts saved
   authorization; rotating it without a migration makes existing tokens unreadable.
   The deployment also needs `GOOGLE_CALENDAR_REDIRECT_URI` as above and
   `GOOGLE_CALENDAR_EXPECTED_EMAIL=anna@luminai.com`.
7. Redeploy the dashboard. Open `/google-calendar.html`, sign in with the existing
   Luminai Scheduler coordinator account, then choose **Continue to Google**.
   Anna must approve the listed read-only access. The app rejects any other account.
8. Use **Test read-only connection**, then **Read interviewer calendar availability**
   on the booking page to check the actual plan's interviewers. An inaccessible
   calendar is an error, never an empty/free calendar. Organization sharing
   policies still apply; this connection does not bypass them.

## Implemented boundaries

- Single-use, expiring OAuth state; browser-bound Secure/HttpOnly/SameSite cookie;
  PKCE; verified Google ID-token audience, nonce and expected email; coordinator
  permission checked both before redirect and before storing authorization.
- Offline refresh authorization is AES-256-GCM encrypted on the persistent volume
  with tenant/account/OAuth-app binding. Tokens never go to frontend JavaScript.
- Only the documented Google `freeBusy` endpoint is used; requests are split at
  50 calendar IDs and reject missing calendars, errors and mismatched coverage.
- Google calendar IDs come from exact active Ashby user identities, not arbitrary
  browser-supplied emails. Fifteen unique Luminai identities were resolved in the
  live eight-interview test plan before OAuth configuration.
- The full plan's **primary calendar** reader is wired to submitted candidate
  windows. It does not yet claim a complete schedule is available. Additional
  blocking calendars, Ashby meeting-hour rules and interview limits still need
  verified inputs to the full-calendar search core. No booking readiness flag is
  changed by connecting Google or successfully reading free/busy.

Sources: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[Google free/busy API](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query).
