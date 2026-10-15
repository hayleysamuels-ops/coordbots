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
# Two things this script CANNOT set — the Railway CLI has no flag for
# either, so do them in the dashboard afterwards (the script prints a
# reminder):
#
#   1. Root directory  ->  /coordinator-metrics
#   2. Watch paths     ->  /coordinator-metrics/**
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

echo "==> Creating project $PROJECT"
railway init --name "$PROJECT"

echo "==> Creating service $SERVICE from $REPO ($BRANCH)"
railway add --service "$SERVICE" --repo "$REPO" --branch "$BRANCH"

echo "==> Attaching volume at $MOUNT_PATH"
# RAILWAY_VOLUME_MOUNT_PATH is set automatically once a volume is attached,
# and src/config.js prefers it over DATA_DIR, so nothing else to configure.
railway volume add --service "$SERVICE" --mount-path "$MOUNT_PATH"

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
  key="$(printf '%s\n' "$vars" | grep '^ASHBY_API_KEY=' | cut -d= -f2-)"
  name="$(printf '%s\n' "$vars" | grep '^CLIENT_NAME=' | cut -d= -f2- || true)"
  accent="$(printf '%s\n' "$vars" | grep '^CLIENT_ACCENT_COLOR=' | cut -d= -f2- || true)"

  if [ -z "$key" ]; then
    echo "    no ASHBY_API_KEY found in $source_project — skipping $id" >&2
    continue
  fi

  args=(--set "ASHBY_API_KEY_${up}=${key}" --set "CLIENT_TIMEZONE_${up}=${tz}")
  [ -n "$name" ] && args+=(--set "CLIENT_NAME_${up}=${name}")
  [ -n "$accent" ] && args+=(--set "CLIENT_ACCENT_COLOR_${up}=${accent}")

  railway variables --service "$SERVICE" --skip-deploys "${args[@]}" > /dev/null
  echo "    set ${#args[@]} variables for $id"
done

cat <<'DONE'

==> Done, with two manual steps left in the Railway dashboard:

    Settings > Source
      Root directory : /coordinator-metrics
      Watch paths    : /coordinator-metrics/**

    Then redeploy. The first boot runs an incremental sync only; trigger the
    twelve-month backfill once with:

      curl -X POST -u carrara:<password> https://<domain>/api/sync?kind=full

    It takes roughly ten minutes across five clients and the dashboard fills
    in as each one finishes.
DONE
