"use strict";

/**
 * Runs one sync and exits. Use this for the initial 12-month backfill
 * rather than waiting for the overnight schedule:
 *
 *   npm run sync -- --kind=full
 *   npm run sync -- --kind=full --client=forus
 *
 * Read-only against Ashby; writes only to this app's own SQLite file.
 */

const config = require("../src/config");
const sync = require("../src/sync");
const metrics = require("../src/metrics");
const store = require("../src/db");

function arg(name, fallback) {
  const match = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

(async () => {
  const kind = arg("kind", "incremental") === "full" ? "full" : "incremental";
  const only = arg("client", null);

  console.log(`[sync-once] database: ${store.FILE}`);

  if (only) {
    const client = config.clients.find((c) => c.id === only);
    if (!client) {
      console.error(`[sync-once] unknown client "${only}". Configured: ${config.clientIds.join(", ") || "none"}`);
      process.exit(1);
    }
    await sync.syncClient(client, kind);
    metrics.rebuild();
  } else {
    await sync.syncAll(kind);
  }

  const payload = metrics.getOverview();
  if (payload) {
    console.log(
      `[sync-once] overview: ${payload.totals.events} events, ${payload.totals.hours}h, ` +
        `${payload.totals.candidates} candidates across ${payload.byClient.length} clients`
    );
  }
  process.exit(0);
})().catch((err) => {
  console.error("[sync-once] failed:", err);
  process.exit(1);
});
