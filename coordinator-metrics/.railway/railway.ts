import { defineRailway, github, project, service, volume } from "railway/iac";

/**
 * Railway configuration for the coordinator-metrics service.
 *
 * This replaces `railway.json`, which Railway deprecated with a cutoff
 * of 2026-12-01.
 *
 * It was produced by `railway config pull`, NOT by `railway config
 * migrate`. That distinction matters and cost a day: `migrate` only
 * translates railway.json, and the volume was never in railway.json, so
 * the file it generated omitted the volume entirely and planned to
 * DETACH it —
 *
 *     volumeAttachments.coordinator-metrics-volume.mountPath ("/data" -> null)
 *
 * — which would have taken the SQLite database offline. `pull` imports
 * the live project instead, so the volume comes with it. If this file
 * ever needs regenerating, use `pull`, and never `migrate`.
 *
 * Volumes are declared as `volumeMounts: { "<mountPath>": <volumeNode> }`
 * — keyed by MOUNT PATH with the node as the value. Not by volume name,
 * and not with a config object; several plausible-looking spellings all
 * silently produce a detach plan rather than an error.
 */
export default defineRailway(() => {
  // Holds metrics.sqlite. Losing it costs a ~21-minute Ashby backfill
  // for most tables and the observed-reschedule history outright, which
  // cannot be re-derived at all — see src/backup.js.
  const coordinatorMetricsVolume = volume("coordinator-metrics-volume", {
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
    allowOnlineResize: true,
    region: "sfo",
    sizeMB: 5000,
  });

  const coordinatorMetrics = service("coordinator-metrics", {
    source: github("hayleysamuels-ops/coordbots", {
      branch: "main",
      checkSuites: false,
      // The one setting that could not live in railway.json and had to
      // be set in the dashboard. It is in code now.
      rootDirectory: "/coordinator-metrics",
    }),
    build: {
      buildEnvironment: "V3",
      builder: "RAILPACK",
      // Repo-root-relative even though the service has a root
      // directory, hence the /coordinator-metrics/ prefix on each. A
      // `!` negation only bites if an earlier rule included the files
      // it excludes, so the broad include has to come first.
      //
      // The two negations existed in railway.json but were NEVER in
      // Railway's stored config — `pull` returned only the broad
      // pattern — because Config as Code applied them per deploy
      // instead. After cutover nothing reads railway.json, so without
      // them here every docs-only commit would redeploy, restarting
      // the container mid-sync.
      //
      // Keep in step with the path filters in
      // .github/workflows/coordinator-metrics-smoke.yml, which computes
      // the deployable commit the same way.
      watchPatterns: [
        "/coordinator-metrics/**",
        "!/coordinator-metrics/*.md",
        "!/coordinator-metrics/**/*.md",
      ],
    },
    replicas: { sfo: 1 },
    volumeMounts: { "/data": coordinatorMetricsVolume },
  });

  return project("coordinator-metrics", {
    // Variables stay in the Railway dashboard: six Ashby API keys, the
    // dashboard password and the R2 credentials. IaC never reads or
    // writes them, so none of those values are ever rendered into this
    // file. Do not switch this to managed without moving the secrets
    // somewhere that is not a git repository first.
    variables: { managed: false },
    resources: [coordinatorMetrics, coordinatorMetricsVolume],
  });
});
