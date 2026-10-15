# CLAUDE.md — coordinator-metrics

Read [README.md](README.md) first. It covers what the dashboard measures,
the counting rules, and why the data gets here the way it does. This file
is the short list of things that look wrong and are not.

## Key design facts (don't "fix" these — they're intentional)

- **There is no `listApplications()` in `ashby.js`, and that is the point.**
  `application.list` returns every application an org ever received —
  242,611 on Forus, 236,896 on January — of which ~8,000 reached an
  interview. The bulk sweep cost 27 minutes per full sync and 254MB of
  storage, and grows forever. `syncApplications()` resolves only the ids
  that stored schedules actually reference, through `application.info` at
  concurrency 8. Pruning the rest changed no metric. Don't reintroduce a
  bulk sweep because "one call is cheaper than 8,000" — it isn't, after the
  first run. Measured against the real orgs: the first full backfill is
  about 21 minutes wall clock for five clients at concurrency 2 (Forus
  12 of them, resolving 7,483 applications), and every nightly run after
  that only refreshes applications still marked Active.

- **Applications are synced AFTER schedules, not before.** The set worth
  fetching is defined by which schedules exist, so the order is load-bearing,
  not stylistic.

- **A full sync refreshes Active applications but never re-reads archived
  ones.** Archived and Hired are terminal; re-reading them every night would
  triple the call count to learn nothing. The drop-off metric depends on
  catching the Active → Archived transition, which this does.

- **Reschedules are reported two ways on purpose, and both are labelled on
  the page.** Ashby has no reschedule history and no cancellation reason
  (verified across schedule fields, event fields, `application.listHistory`
  and `extraData`). The derived figure infers one from cancelled-then-
  re-booked schedules and covers the full window; the observed figure is
  exact but only counts forward from first sync. Don't collapse them into
  one number — the honesty is the feature, and `renderDataQuality()` exists
  to say so in the UI.

- **`sumWindow()` has an exclusive upper bound, and removing it silently
  inflates every period.** Interviews are booked ahead, so the daily series
  legitimately contains future dates. The original "last 7 days" sum had no
  upper bound and swept in everything on the calendar for next month,
  reporting it as volume delivered this week. `test/metrics.test.js` pins
  this.

- **Charts fade from `fadeFrom` onward: tomorrow for daily bars, the
  current Monday for weekly ones.** The in-progress week is only partly
  elapsed. Drawn solid, every chart ends in a cliff that reads as a
  collapse in volume rather than a Tuesday.

- **Median booking turnaround excludes gaps under a minute.** A direct
  booking creates the schedule and the event in the same instant, so its gap
  is zero and those dominate the sample — with them in, Forus's median was
  0h against a p90 of 23.4h. The tile shows the waited/booked-outright split
  rather than hiding the bimodality.

- **Day and week bucketing happens in JS, not SQL.** SQLite has no IANA time
  zone support, and each client's tab buckets in its own zone. `localBuckets()`
  also builds week keys from the *local* calendar date, so a Sunday-evening
  US interview doesn't land in the following week — `test/buckets.test.js`
  pins both that and the DST behaviour.

- **Metrics are computed once per sync and cached, never per request.**
  `syncAll()` calls `metrics.rebuild()` itself when it finishes, so callers
  don't have to remember — one of them (the scheduler) originally didn't.

- **`scheduledBy` is a user object, not a string.** node:sqlite refuses to
  bind an object rather than coercing it, which is how this surfaced. Stored
  split into `scheduled_by_id`/`scheduled_by_name`; it names who actually
  booked each slot, which is per-coordinator attribution data if that is ever
  wanted.

- **Coordinator and recruiter are stored on every application but not shown
  anywhere.** The agreed attribution is per client, not per coordinator
  within a client. The columns exist so a breakdown is a query away rather
  than a re-sync.

- **`node:sqlite`, not `better-sqlite3`.** No native build means a deploy
  can't fail on node-gyp or a blocked install script — which it did locally
  on the first attempt. It has no `db.transaction()` helper, hence the
  `transaction()` wrapper in `db.js`.

- **Every table is keyed on `(client_id, id)`.** Ashby ids are per-org UUIDs
  with no cross-org uniqueness guarantee and this process holds five orgs in
  one file.

- **One shared Basic Auth credential, checked in `src/auth.js` only.** The
  agreed posture is internal-first: everyone who can log in sees every tab.
  A client-facing per-client view needs real per-user auth, and keeping the
  decision in one file is what makes that a contained change.

- **Watch patterns live in `railway.json`, NOT the Railway dashboard.**
  Config-as-code overrides the dashboard for any field it sets, so editing
  watch paths in the UI will appear to work and then be silently ignored on
  the next deploy — change `railway.json` instead. Two things to know about
  the patterns: they are **repo-root-relative even though the service has a
  root directory** (hence the `/coordinator-metrics/` prefix on every one),
  and a `!` negation only takes effect if an earlier rule included the files
  it excludes, so the broad include has to come first. The root directory
  itself is the one setting that cannot go in this file and still lives in
  the dashboard.

- **Doc-only changes deliberately do not redeploy.** A redeploy restarts the
  container mid-sync, and the nightly full sync takes about 21 minutes.

## Conventions

- No build step and no frontend framework, matching the sibling dashboards.
  Charts are hand-built inline SVG.
- Design tokens at the top of `public/style.css` are copied verbatim from
  `candidate-dashboard/public/style.css`. Keep them in sync by copying, not
  by linking — neither app has a build step to resolve an import.
- Per-client settings are suffixed environment variables
  (`ASHBY_API_KEY_FORUS`), not one JSON blob, so each key stays a discrete
  Railway variable.

## Guardrails

- **Read-only against Ashby.** Every endpoint used is a `.list` or `.info`.
  Nothing here writes to a client's ATS, and nothing should start.
- **Secrets never go in the repo.** `.env` is gitignored; real keys live in
  Railway variables.
- **The SQLite file must be on a Railway volume.** The backfill is
  re-derivable at the cost of a long sync; the observed-reschedule history
  is not re-derivable at all.
