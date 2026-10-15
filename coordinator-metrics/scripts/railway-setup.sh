#!/usr/bin/env bash
#
# One-time Railway setup for the coordinator-metrics deployment.
#
# Creates the project and a repo-connected service, attaches the volume the
# SQLite history lives on, and copies each client's Ashby key across from
# that client's existing dashboard project — so no key is ever typed out,
# pasted into a terminal, or written to a file.
#
# Prerequisites: `railway login` (already done on this machine) and the
# branch below pushed to GitHub.
#
# Things this script CANNOT set, to do in the dashboard afterwards (it
# prints a reminder for each):
#
#   1. Root directory  ->  /coordinator-metrics
#   2. Watch paths     ->  /coordinator-metrics/**
#   3. The volume, if the CLI's buggy `volume add` fails (see below)
#
# Without the root directory the build will try to build the whole monorepo
# and fail. Without watch paths every push to coordbots redeploys this
# service unnecessarily, which also interrupts a running sync.

set -euo pipefail

PROJECT="coordinator-metrics"
SERVICE="coordinator-metrics"
REPO="hayleysamuels-ops/coordbots"
BRANCH="${BRANCH:-main}"
MOUNT_PATH="/data"

# client id : the Railway project holding that client's existing dashboard : IANA zone
CLIENTS=(
  "january:dashboard-january:America/New_York"
  "forus:dashboard-forus:America/New_York"
  "luminai:dashboard-luminai:America/Los_Angeles"
  "poetic:dashboard-poetic:America/Los_Angeles"
  "runlayer:dashboard-runlayer:America/New_York"
)

if [ -z "${DASHBOARD_PASSWORD:-}" ]; then
  echo "Set DASHBOARD_PASSWORD before running, e.g.:" >&2
  echo "  DASHBOARD_PASSWORD=\"\$(openssl rand -base64 24)\" ./scripts/railway-setup.sh" >&2
  exit 1
fi

# Each step is skipped if it has already happened, so the script can be
# re-run safely after a failure partway through. Without this, a second run
# would create a duplicate Railway project rather than resuming.

if railway status > /dev/null 2>&1; then
  echo "==> Project already linked in this directory, skipping create"
  railway status | sed -n '1,4p'
else
  echo "==> Creating project $PROJECT"
  railway init --name "$PROJECT"
fi

if railway variables --service "$SERVICE" > /dev/null 2>&1; then
  echo "==> Service $SERVICE already exists, skipping create"
else
  echo "==> Creating service $SERVICE from $REPO ($BRANCH)"
  # `railway add` prompts for variables interactively unless --variables is
  # passed; press Esc at that prompt, the variables are all set further down.
  railway add --service "$SERVICE" --repo "$REPO" --branch "$BRANCH"
fi

echo "==> Setting base variables"
client_ids=""
for entry in "${CLIENTS[@]}"; do
  id="${entry%%:*}"
  client_ids="${client_ids:+$client_ids,}$id"
done

railway variables --service "$SERVICE" --skip-deploys \
  --set "CLIENTS=$client_ids" \
  --set "DASHBOARD_USER=carrara" \
  --set "DASHBOARD_PASSWORD=$DASHBOARD_PASSWORD" \
  --set "DASHBOARD_TITLE=Coordinator Metrics" \
  --set "OVERVIEW_TIMEZONE=America/New_York" \
  --set "HISTORY_MONTHS=12" \
  --set "INCREMENTAL_DAYS=60" \
  --set "FULL_SYNC_HOUR=3" \
  --set "INCREMENTAL_MINUTES=60" \
  --set "SYNC_ON_BOOT=true" \
  --set "CLIENT_CONCURRENCY=2" \
  --set "SHORT_NOTICE_HOURS=24" \
  --set "BUSINESS_HOUR_START=8" \
  --set "BUSINESS_HOUR_END=18"

for entry in "${CLIENTS[@]}"; do
  id="${entry%%:*}"
  rest="${entry#*:}"
  source_project="${rest%%:*}"
  tz="${rest#*:}"
  up="$(echo "$id" | tr '[:lower:]' '[:upper:]')"

  echo "==> $id: copying key and display config from $source_project"
  vars="$(railway variables --service coordbots --project "$source_project" --environment production --kv)"
  # Every `|| true` here is load-bearing under `set -e`: a grep that matches
  # nothing returns non-zero, and a failed command substitution in an
  # assignment exits the script rather than leaving the variable empty.
  key="$(printf '%s\n' "$vars" | grep '^ASHBY_API_KEY=' | cut -d= -f2- || true)"
  name="$(printf '%s\n' "$vars" | grep '^CLIENT_NAME=' | cut -d= -f2- || true)"
  accent="$(printf '%s\n' "$vars" | grep '^CLIENT_ACCENT_COLOR=' | cut -d= -f2- || true)"

  if [ -z "$key" ]; then
    echo "    no ASHBY_API_KEY found in $source_project — skipping $id" >&2
    continue
  fi

  # Written as `if` blocks, not `[ -n "$x" ] && args+=(...)`: under `set -e`
  # that one-liner exits the whole script whenever the test is false, which
  # is exactly the ordinary case of a client having no accent colour.
  args=(--set "ASHBY_API_KEY_${up}=${key}" --set "CLIENT_TIMEZONE_${up}=${tz}")
  count=2
  if [ -n "$name" ]; then
    args+=(--set "CLIENT_NAME_${up}=${name}")
    count=$((count + 1))
  fi
  if [ -n "$accent" ]; then
    args+=(--set "CLIENT_ACCENT_COLOR_${up}=${accent}")
    count=$((count + 1))
  fi

  railway variables --service "$SERVICE" --skip-deploys "${args[@]}" > /dev/null
  echo "    set $count variables for $id"
done

# The volume goes LAST and never aborts the run.
#
# `railway volume add` in CLI 5.27.2 ignores --mount-path, prompts for it
# interactively anyway, and then panics on Option::unwrap() at
# volume.rs:836 when the prompt returns nothing. Because this used to run
# before the variables, that panic took the whole script down with it and
# the Ashby keys and dashboard password were never set — the expensive
# half failing for the cheap half's bug.
#
# So: everything that works reliably happens first, and this is attempted
# afterwards on a best-effort basis. If it fails, create the volume in the
# Railway dashboard instead (Service > Settings > Volumes, mount at /data),
# which takes a few seconds and is not version-dependent.
if railway volume list 2>/dev/null | grep -q "$MOUNT_PATH"; then
  echo "==> Volume already attached at $MOUNT_PATH"
elif railway volume --service "$SERVICE" add --mount-path "$MOUNT_PATH" < /dev/null; then
  echo "==> Attached volume at $MOUNT_PATH"
else
  echo ""
  echo "!!  Could not attach the volume from the CLI (a known 5.27.2 bug)."
  echo "!!  Everything else above succeeded. Add it in the Railway dashboard:"
  echo "!!    Service > Settings > Volumes > mount path $MOUNT_PATH"
  echo "!!"
  echo "!!  This is NOT optional. Without a volume the SQLite file lives in"
  echo "!!  the container, so every redeploy throws away the twelve-month"
  echo "!!  backfill and the observed-reschedule history — and the latter"
  echo "!!  cannot be rebuilt from Ashby at all."
  echo ""
fi

cat <<'DONE'

==> Done. Remaining manual steps, all in the Railway dashboard:

    Settings > Source
      Root directory : /coordinator-metrics
      Watch paths    : /coordinator-metrics/**

    Plus the volume, if the CLI reported it could not attach one above.

    The dashboard password was generated by the shell that launched this
    script and is not printed anywhere. Read it back from Railway with:

      railway variables --service coordinator-metrics --kv | grep DASHBOARD_PASSWORD

    Then redeploy. The first boot runs an incremental sync only; trigger the
    twelve-month backfill once with:

      curl -X POST -u carrara:<password> https://<domain>/api/sync?kind=full

    It takes roughly ten minutes across five clients and the dashboard fills
    in as each one finishes.
DONE
