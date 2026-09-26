# "Schedule" button on Full schedule options — design analysis

Status: analysis only, 25 September 2026. Nothing here is built. Based on
`feature/client-ashby-connection` at `ad5b592` (after the scheduling flag, PR #4).

**The request:** each option under **Full schedule options** on the booking page gets a
**Schedule** button. Clicking it posts that option to a shared Slack channel, where a
coordinator clicks to confirm.

## Summary

- **Posting to Slack mostly exists.** The onsite discussion flow already turns a
  schedule into a draft and posts it to Slack. It claims the post before sending, so a
  crash can never double-post. It checks a revision and a content digest, re-checks the
  candidate in Ashby, and routes to a shared channel. The Schedule button can reuse
  nearly all of that.
- **The Slack button and the click handling are new.** Today's Slack message is plain
  text with no buttons. The dashboard has no endpoint Slack can call, no signature
  verification, and no link between a Slack user and an approver.
- **The existing booking approval can't be reused.** `approveBooking` always refuses on
  this deployment, because no booking adapter is connected. It also deliberately refuses
  to count a discussion approval as a booking approval.
- **While booking is off, clicking should record a confirmation, not queue a booking.**
  The Slack message would be updated to say who confirmed and that nothing was booked.
  When booking is turned on later, it needs its own fresh approval.
- **Luminai isn't configured for Slack at all today.** None of `SCHEDULING_SLACK_*` is
  set on the Luminai dashboard.
- **Decided: Slack is Carrara's workspace, shared by all clients.** That means one Slack
  app, one signing secret, one bot token and one workspace ID to verify. Two
  consequences:
  - **Each client's channel is a data-isolation control.** One bot sits in every
    client's channel, so the only thing keeping one client's candidates out of another
    client's channel is each dashboard's own channel config (section 1a).
  - **Clicks need routing,** if there's one app for all clients. Slack sends every click
    from an app to a single Request URL, but each client runs its own dashboard. Section
    2 compares a router service with one Slack app per client. It recommends one app per
    client: no router, and Slack itself stops each client's bot posting outside its own
    channel.
- **Slack user IDs identify the individual who confirmed.** The shared dashboard login
  can't do that (section 3).

## 1. What exists and what's new

### What the Full schedule options are today

The **Suggest full schedule** button calls `POST /api/scheduling-booking/suggest-full-schedule`
(`booking-routes.js`), which runs `proposeFullSchedule()` (`full-schedule.js`). It returns
up to five agenda options, each a list of events (title, start, end, a suggested
interviewer, eligible alternatives).

- **Nothing is saved.** The options are computed per request and rendered by `booking.js`.
  There is no stored option a button could point to.
- **They aren't calendar-checked.** The result says `availabilityVerified: false` and
  `status: "needs_review"`. The page already tells coordinators: "Suggested interviewers
  are eligible choices, not confirmed available. These options cannot send invitations."
  Anything posted to Slack has to carry the same warning.

### Reusable pieces

| Piece | Where | Reusable? | Notes |
|---|---|---|---|
| Slack posting | `scheduling/slack.js` | **Partly** | `chat.postMessage` with a bearer token, a 15-second timeout, and a receipt check (`ok`, `ts`, `channel`). Reusable as the transport. But it sends plain text only (`mrkdwn: false`, `parse: "none"`, no `blocks`), so it can't carry a button. Needs a block-building version. |
| Claim before posting | `service.share()` | **Yes, as is** | Saves `sharing` before calling Slack, then `shared` with the receipt, or `discussion_uncertain` if the response can't be verified. That's exactly the protection a Schedule button needs against double-posting. |
| Revision and digest checks | `service.current()`, `digest()` | **Yes** | Any action on a draft must match its current revision and a SHA-256 digest of its content. The same check should bind a Slack click to the exact option that was posted. |
| Re-checking the candidate in Ashby | `share()` via `templateReader` | **Yes** | Before posting, it confirms the candidate and application in Ashby haven't changed. |
| Shared-channel routing | `service.destination()` | **Yes** | `SCHEDULING_SLACK_ROUTING=client` plus `SCHEDULING_SLACK_CHANNEL_ID` already means "post everything to one shared channel". That's the "shared Slack channel" in this request. It validates channel ID format. |
| Turning an external proposal into a draft | `service.importSource()` | **Yes, as the pattern** | It converts a tracker proposal's events into discussion-draft sessions: interviewer names joined into text, location "Room / location to confirm", blockers copied into notes. A full-schedule option can be converted the same way. |
| Draft storage | `scheduling/store.js` | **Yes, with one decision** | A locked JSON file with revision-checked writes. It allows only **one active draft per candidate** (`draft`, `sharing`, `discussion_uncertain`). So a coordinator can't post option 1 and then option 3 separately unless the first is rejected. Either post one option at a time, or post all options in one message with a button per option. |
| Approver check | `service.actor()` | **The rule, not the identity** | It requires `{ id, canApprove: true }`. Today that identity only comes from the dashboard login (`auth.js`, a username and password in `SCHEDULING_APPROVERS_JSON`). A Slack click needs a new way to produce the same shape (section 3). |
| `approveBooking` | `service.approveBooking()` | **No** | Calls `booking.approve()`, but `setup.js` passes no `booking`, so it always returns 503 "Ashby booking is not connected". Its comment says a discussion approval is never reused for booking; a booking needs freshly checked availability and a separate approval. |
| Booking engine | `booking-engine.js` | **No, not now** | `draft()` needs a verified availability source (`source: null` in `server.js`), and `approve()` needs a verified executor (`executor: null`). Both refuse on this deployment. |

### New work

1. **A Schedule button on each option** in `booking.js`.
2. **A server endpoint that creates the draft from an option.** It must rebuild the
   options on the server, from the current Ashby plan and submitted availability, then
   pick the chosen one and check it matches what the coordinator saw. It must never
   accept an agenda sent from the browser; `booking-routes.js` already follows that rule.
   Then it converts the option into a discussion draft, like `importSource()` does.
3. **A Slack message with a button.** Built with blocks: the agenda, the timezone, the
   "not calendar-checked, nothing booked" warning, and a **Confirm** button. The button's
   value carries the draft ID, revision and digest.
4. **Receiving clicks** (section 2): a small Slack router service holding the one Request
   URL for Carrara's workspace, which verifies Slack's signature and forwards each click
   to the right client's dashboard. Plus a dashboard endpoint that accepts only clicks
   the router has signed.
5. **A way to map Slack users to approvers** (section 3).
6. **A new "confirmed" state** and the rules for reaching it (section 4).
7. **Updating the Slack message after a click,** so the channel shows who confirmed and
   the button can't be pressed again.
8. **Configuration:** a Slack signing secret, a bot token, the shared channel, and the
   approver-to-Slack mapping. Plus setting up the Slack app itself.

### 1a. Channel routing is a data-isolation control

Every client's scheduling channel lives in Carrara's workspace, and one bot token can
post to all of them. A wrong channel therefore wouldn't fail. It would post one client's
candidate names, interview plan and interviewers into another client's channel, visible
to everyone there. So the rules for choosing a channel are security rules, not
conveniences:

- **The channel comes only from that client's dashboard config:**
  `SCHEDULING_SLACK_CHANNEL_ID` for shared-channel routing, or
  `SCHEDULING_CANDIDATE_CHANNELS_JSON` for per-candidate routing. It never comes from a
  browser request, a Slack payload, a button value, or anything typed by a person.
- **A missing or malformed channel refuses; it never falls back.** No default channel,
  no "first channel the bot is in", and no borrowing another client's setting.
- **The existing discussion flow already does this, and the Schedule button must keep
  it.** `service.destination()` reads the channel only from config, and returns no
  channel (with the message "Candidate channel not configured") when it's missing or
  isn't a valid channel ID. `share()` then refuses with 503 "Configure this client's
  Slack destination first." The `channelId` the browser sends is only compared against
  the configured one (409 "Slack destination changed" if they differ). It's never used
  to choose where to post.
- **Clicks get the same check.** A click must come from the channel recorded for that
  draft, which must still be that client's configured channel. Otherwise, refuse and
  change nothing.
- **One test per rule.** A missing channel refuses, a request-supplied channel is
  ignored, and a click from another channel is refused. Also add a startup check that no
  two clients' dashboards are configured with the same channel ID (see section 5).

## 2. What Slack interactivity requires

### One app, one Request URL, many dashboards

Slack sends every button click from an app to that app's single Request URL. Each client
has its own dashboard service (`coordbots` in each `dashboard-<client>` Railway
project), with its own drafts, approvers and config. The click has to reach the right
dashboard, and the routing is part of the isolation boundary:

- **Recommended: a small Slack router service in Carrara's Railway workspace.** It's the
  Request URL. It verifies Slack's signature, reads the client ID from the button value,
  and looks up that client's dashboard address in **its own config**, never from the
  payload. It then forwards the click with a per-client shared secret, signed the same
  way the dashboard already signs calls to its worker (`worker-auth.js`: timestamp,
  nonce, HMAC).
  - **The dashboard doesn't trust the router blindly.** It re-checks that the channel in
    the click is its own configured channel, and that the draft ID belongs to its own
    store.
  - **A client ID the router doesn't know is refused,** with no fallback.
- **Alternative: send Slack's signed request straight to the right dashboard.** Also
  workable, but only one URL can be registered, so something still has to route. The
  router is that something, kept small and separate.
- **Only Luminai needs it today.** Build it for many clients anyway: its whole purpose
  is keeping clients apart.

### Counter-option: one Slack app per client, no router

Still Carrara's one workspace, but a separate Slack app per client dashboard: six apps
for the six dashboards, created only when a client turns the scheduling pilot on. Each
app has its own bot user, bot token, signing secret and Request URL, pointing straight
at that client's dashboard (e.g. `https://<client dashboard>/api/slack/interactions`).
There's no router service; each dashboard verifies Slack's signature itself, with its
own app's signing secret.

The workspace ID is still one value (Carrara's), checked by every dashboard. The app ID
differs per client, and each dashboard checks that the click came from its own app.

| | Router (one app) | One app per client |
|---|---|---|
| **New infrastructure** | A new router service in a new Carrara-level Railway project, with its own deploys, monitoring and secrets. Plus a per-client forwarding secret set on both the router and the dashboard. | No new service. Each dashboard gets one new endpoint and its own Slack credentials. The "infrastructure" is six Slack app registrations, managed in Slack's admin pages rather than Railway. |
| **Cross-client blast radius** | **Workspace-wide.** One bot token can post to every client's channel, so the per-client channel config is the only thing keeping clients apart. One leaked token, or one router bug that picks the wrong client, can expose any client's data. | **One client.** Each bot is invited only to its own client's channel. With only `chat:write` (and not `chat:write.public`), Slack refuses posts to channels the bot isn't in (`not_in_channel`), so a mistyped channel ID fails instead of leaking. A leaked token or signing secret exposes one client, and is rotated without touching the others. Slack enforces the isolation, as well as our config. |
| **Onboarding effort per client** | Low. Add the client to the router's map and forwarding secret, set the dashboard's channel and forwarding secret, and invite the one existing bot to the new channel. No Slack admin step. | Higher. Create the app (repeatable from a saved app manifest), have a workspace admin install it, set its Request URL, invite its bot to the channel, and set its bot token and signing secret on that dashboard. Roughly 15–30 minutes, including an admin approval, each time a client turns scheduling on. |

**Other differences:**
- **Channel appearance.** Per-client apps can be named per client (e.g. "Luminai
  Scheduling"), so a message's poster shows at a glance which client it belongs to.
  With one app, every client's messages come from the same bot.
- **Code.** Per-client apps put signature verification inside the dashboard, next to the
  data it protects, with one fewer hop. The router splits it across two services, with
  a second signature scheme in between.
- **Carrara-wide changes.** Per-client apps make these six-times work: rotating
  credentials, changing scopes, updating the Slack app itself. The router does each
  once.
- **Failure scope.** Per-client apps have no shared component whose outage stops every
  client's confirmations. The router is that component.

**Recommendation: one app per client**, given that section 1a treats channel routing as
a data-isolation control. It adds a second, Slack-enforced boundary on top of the
dashboard config, needs no new service, and limits any credential leak to one client.
The cost is admin onboarding per client. With only Luminai on the pilot today, and
clients added one at a time, that cost is small. Choose the router instead if needing a
Slack admin for every onboarding becomes the bottleneck, or if app count becomes a
workspace-policy problem.

If this option is chosen, the rest of this document changes as follows:
- Section 2's router, the forwarding secrets, and open question 5 fall away.
- Each dashboard's endpoint verifies Slack's signature directly, with that client's
  signing secret. It needs the raw request body, exempt from `express.json()` and Basic
  Auth.
- The per-client config (section 5) gains `SCHEDULING_SLACK_SIGNING_SECRET` and
  `SCHEDULING_SLACK_APP_ID`. `SCHEDULING_SLACK_BOT_TOKEN` becomes a per-client token
  rather than a shared one.

### Protocol

Check these details against Slack's current documentation before building; they're from
general knowledge of Slack's platform, not checked against it for this write-up.

- **A Slack app with Interactivity turned on,** installed in Carrara's workspace, with
  one **Request URL**: the router's public HTTPS address plus a path such as
  `/slack/interactions`.
- **Bot token and scopes.** `chat:write` to post and update messages, and the bot must be
  a member of the shared channel. `users:read` (and `users:read.email`) only if the
  approver mapping uses email (section 3).
- **What Slack sends.** A `POST` with `Content-Type: application/x-www-form-urlencoded`
  and a single `payload` field holding JSON. For a button click, `payload.type` is
  `block_actions`, with the clicker (`user.id`, `user.team_id`), the workspace (`team.id`),
  the app (`api_app_id`), the button (`actions[0].action_id`, `actions[0].value`), the
  message (`container.message_ts`, `channel.id`) and a `response_url`.
- **Signature verification, on every request, before anything else.**
  - Slack sends `X-Slack-Request-Timestamp` and `X-Slack-Signature`.
  - Compute `v0=` + HMAC-SHA256 with the app's **signing secret** over
    `v0:<timestamp>:<raw request body>`, and compare in constant time.
  - Reject timestamps more than 5 minutes old, to block replayed requests.
  - This needs the **raw body bytes**. `server.js` runs `express.json()` for every route,
    so the Slack route must read its raw body before any parser touches it.
- **The dashboard route can't sit behind the dashboard login.** `basicAuth` guards
  everything, and neither Slack nor the router can send a Basic Auth header. The route
  that receives forwarded clicks has to be exempt from Basic Auth and accept only
  requests carrying the router's valid per-client signature. It should also only be
  mounted where `schedulingEnabled` is true, like the other scheduling routes.
- **Reply within 3 seconds.** Slack shows the clicker an error if the response takes
  longer. Revalidating against Ashby can take longer than that, so answer `200`
  straight away, do the work afterwards, then report the result through the
  `response_url` (usable for a limited time and number of calls) or `chat.update`.
- **Duplicate clicks.** Two coordinators can press at once, or one can double-click. The
  revision check on the draft makes the second click fail safely; it should get a
  private "already confirmed by …" reply instead of an error.

## 3. Mapping the Slack user who clicked to an approver

The goal: only listed approvers can confirm, identified by something Slack guarantees,
never by a name or text in the message.

**Recommended: record each approver's Slack user ID in config.**
- Slack is Carrara's workspace, so the IDs are Carrara coordinators' own Slack user IDs.
  The tracker's `users.js` already records these for its approvers, but copy them
  deliberately per client rather than sharing a list: approving for one client mustn't
  mean approving for all.
- Add `slackUserId` to each approver in that client's `SCHEDULING_APPROVERS_JSON`, e.g.
  `{ "username": "…", "password": "…", "slackUserId": "U…" }`.
- There's one workspace ID to verify (Carrara's), and one app ID. Both belong in the
  router's config and are checked there. The dashboard can check them again from the
  forwarded payload.
- On a click, after the signature check:
  1. Require `team.id` to be Carrara's workspace and `api_app_id` to be the scheduling
     app.
  2. Look up `user.id` among the approvers' `slackUserId`s.
  3. If it's found, act as that approver: `{ id: username, canApprove: true }`, the same
     shape `actor()` already requires.
  4. If it isn't, change nothing and reply privately to that user only: "You're not an
     approver for this client." Log the attempt with the Slack user ID.
- Slack user IDs are stable and come from the signed payload itself, so they can't be
  forged without the signing secret.

**Alternative: match by email.** Call `users.info` for the clicker, and compare their
email with an email on each approver. This needs `users:read.email`, an extra API call
on every click, and approvers to have emails in config; today they only have usernames.
Worth it only if keeping Slack IDs in config is impractical.

**Per-person attribution is a gain over today.**
- The dashboard's approval login is shared. Luminai's only approver entry is
  `Luminai Scheduler`, and the notes feature is documented as having no author for the
  same reason. So an approval made through the dashboard records which login was used,
  not who used it.
- A Slack user ID belongs to one person, and it arrives inside the signed payload. A
  confirmation made from Slack can record the individual: their Slack user ID, their
  approver entry, the time, and the revision and digest they confirmed.
- To keep that, each person who can confirm needs their own approver entry with their
  own `slackUserId`. Mapping several Slack users to the shared `Luminai Scheduler` entry
  would throw the attribution away again.

**Still to decide:**
- **Keep scheduling channels out of Slack Connect.** A clicker from another workspace
  would fail the Carrara workspace check. That's the right outcome for approvals, but
  the channel shouldn't be shared outside Carrara in the first place, because it carries
  client candidate data.
- **Who gets individual approver entries** to replace the shared `Luminai Scheduler`
  login?

## 4. What clicking should do while booking is off

**First, a correction:** the dashboard doesn't read `SCHEDULING_EXECUTION_ENABLED`. That
variable belongs to the Poetic tracker's worker (`scheduling-worker/worker/server.js`,
on `main` only).
On Luminai, booking is off because `server.js` passes `executor: null` and `source: null`
to the booking engine, so `approve()` refuses with "Booking adapter has not been
verified". Booking is also blocked on IT permissions, which is recorded here as given;
nothing in the code refers to it. The recommendation below applies to either gate.

**Recommendation: clicking records a coordinator confirmation, and nothing else.**
1. **Revalidate before recording.** The option must still be in the future. The
   application must still be active in the same stage. The availability submission must
   be unchanged (same `updatedAt`). The interview plan must be unchanged (same
   `templateRevision`). Those are the checks `/full-plan` and `/calendar-availability`
   already run. If any fail, mark the draft stale, update the Slack message to say so,
   and record nothing.
2. **Record `confirmed`** with who confirmed (the mapped approver username and Slack user
   ID), when, and which revision and digest. Add it to the draft's audit trail.
3. **Update the Slack message:** "Confirmed by \<name\> at \<time\>. Not booked: booking
   is disabled." Remove the button, so the confirmation can't be repeated or reversed
   from Slack.
4. **Show it on the dashboard** alongside the existing drafts, so the coordinator knows
   to book it in Ashby by hand.

**What a confirmation must not do:**
- **It must not be treated as booking approval,** now or later. If a confirmation turned
  into a booking once booking is enabled, it could book a schedule approved weeks
  earlier against calendars that have since changed. That contradicts the existing rule
  in `approveBooking` and the handoff ("Approval to post an onsite draft to Slack is
  separate and does not approve booking"). When booking is turned on, a confirmed option
  should prefill a new booking draft that goes through the booking engine's own fresh
  checks and approval.
- **It must not send anything to the candidate or interviewers.** No calendar
  invitations, no confirmation email, no Ashby write.
- **It must not say the times are available.** The options aren't calendar-checked. The
  message and the confirmed state should keep saying "not calendar-checked" until a
  calendar check exists.

**Name it plainly.** In the dashboard, "Schedule" reads as "this books the schedule".
Something like "Post to Slack for confirmation", with a Slack button labelled "Confirm
this option", avoids implying it books anything.

## 5. Configuration and open questions

The lists below assume the router. With one app per client (section 2's
recommendation), the router list goes away, and each client's list gains a signing
secret, an app ID and its own bot token instead of a forwarding secret.

**Once, for Carrara's workspace** (in the router):
- The Slack app's signing secret, e.g. `SLACK_SIGNING_SECRET`.
- Carrara's workspace ID and the app ID, to verify on every click.
- A map from client ID to dashboard address and that client's forwarding secret. This
  map is what decides where a click goes, so it lives only in the router's config.

**Per client, on that client's dashboard** (none is set on Luminai today):
- `SCHEDULING_SLACK_BOT_TOKEN`: exists in code, not set on Luminai. With one app, every
  client uses the same bot token. Each dashboard can still post to any channel the bot
  is in, so the channel config below is what enforces isolation.
- `SCHEDULING_SLACK_ROUTING=client` and `SCHEDULING_SLACK_CHANNEL_ID` /
  `SCHEDULING_SLACK_CHANNEL_NAME`: exist in code, not set on Luminai. That client's own
  channel, never shared with another client.
- The router's forwarding secret for this client (new).
- `slackUserId` on each approver in `SCHEDULING_APPROVERS_JSON` (new field): Carrara
  Slack user IDs, one per person.

**Guarding against config mistakes:**
- Nothing in one dashboard can see another dashboard's config, so a duplicated channel
  ID wouldn't be caught at runtime. Add a check at deploy or audit time, e.g. a script
  reading each dashboard's channel settings from Railway, that fails if two clients
  share a channel.

**Open questions:**
1. Post one option at a time, or all options in one message with a button each? The
   one-active-draft-per-candidate rule decides what's possible without changing the store.
2. Who gets individual approver entries to replace the shared `Luminai Scheduler` login?
3. Should confirming be undoable, and by whom? The recommendation above makes it final
   from Slack, and reversible only from the dashboard.
4. Once booking is allowed: should a confirmed option expire (e.g. after 24 hours)
   before it can prefill a booking draft?
5. Where does the router run? It can't live inside a single client's `dashboard-*`
   project, since it serves all of them. A new Carrara-level Railway project, like the
   Feedback Reminder Bot, fits.
