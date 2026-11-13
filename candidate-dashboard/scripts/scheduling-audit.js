"use strict";
/**
 * The scheduling audit (src/scheduling/audit.js), by hand: before onboarding
 * a client, and whenever a configured one may have drifted.
 *
 * Usage, from candidate-dashboard/, inside the client's Railway project so
 * its ASHBY_API_KEY (and SCHEDULING_CLIENT_ID, if configured) are set:
 *   railway run -- node scripts/scheduling-audit.js [options]
 *
 * Options:
 *   --rules=<clientId>    Check scheduling-rules/<clientId>.json. Default:
 *                         SCHEDULING_CLIENT_ID; none for an unconfigured client.
 *   --lists=<file>        A file with the worker's BOOKING_COMPOSE_JOBS= and
 *                         BOOKING_SEND_JOBS= lines (they're the worker
 *                         service's variables, not the dashboard's). Default:
 *                         those variables from the environment, if set.
 *   --snapshot=<file>     Compare with the titles saved by a previous run, to
 *                         find renames (Ashby keeps no rename history), then
 *                         save this run's titles there. Kept out of the repo.
 *   --lookback-days=<n>   Past schedules read for what events show. Default 90.
 *   --json                The findings as JSON instead of the report.
 *
 * Read-only: Ashby .list/.info endpoints only. Prints titles and staff names,
 * never candidates. Exits 1 when anything has drifted or blocks onboarding.
 */
const fs = require("fs");
const path = require("path");
const { readAshby, audit, renderReport } = require("../src/scheduling/audit");
const { loadRules } = require("../src/scheduling/rules");
const { jobList } = require("../worker/job-lists");

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a); if (!m) { console.error(`Unknown argument: ${a}`); process.exit(2); } return [m[1], m[2] ?? true]; }));

function listsFrom(env) {
  const have = ["BOOKING_COMPOSE_JOBS", "BOOKING_SEND_JOBS"].filter(n => String(env[n] ?? "").trim());
  if (!have.length) return null;
  // jobList is the worker's own parser: the audit reads the lists as it does.
  return { compose: jobList(env, "BOOKING_COMPOSE_JOBS"), send: jobList(env, "BOOKING_SEND_JOBS") };
}

(async () => {
  const apiKey = process.env.ASHBY_API_KEY;
  if (!apiKey) { console.error("ASHBY_API_KEY isn't set. Run this inside the client's Railway project (railway run -- node ...)."); process.exit(2); }

  const clientId = args.rules === true ? null : args.rules || process.env.SCHEDULING_CLIENT_ID || null;
  let rules = null;
  if (clientId) {
    const loaded = loadRules({ clientId, log: { log() {}, warn() {} } });
    try { rules = loaded.get(); } catch (e) { console.error(`The rules for ${clientId} can't be used: ${e.message}`); process.exit(2); }
  }
  let env = process.env;
  if (typeof args.lists === "string") {
    env = {};
    for (const line of fs.readFileSync(args.lists, "utf8").split("\n")) { const i = line.indexOf("="); if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1); }
  }
  const lists = listsFrom(env);
  const snapshotFile = typeof args.snapshot === "string" ? path.resolve(args.snapshot) : null;
  let previous = null;
  if (snapshotFile && fs.existsSync(snapshotFile)) previous = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));

  const data = await readAshby({ apiKey, lookbackDays: Number(args["lookback-days"]) || 90, log: { warn: m => console.error(m) } });
  const report = await audit({ data, rules, lists, previous });
  if (snapshotFile) fs.writeFileSync(snapshotFile, JSON.stringify(report.snapshot, null, 2));

  if (args.json) console.log(JSON.stringify({ blocking: report.blocking, drift: report.drift, notices: report.notices }, null, 2));
  else {
    console.log(renderReport(report, { title: `Scheduling audit${clientId ? ` (${clientId}, rules revision ${rules.rulesRevision})` : ""}` }));
    console.log(`\nChecked against: ${[rules ? `scheduling-rules/${clientId}.json` : null, lists ? "the worker's job lists" : null, previous ? `the snapshot from ${previous.at.slice(0, 10)}` : null].filter(Boolean).join(", ") || "nothing configured (onboarding view)"}.`);
    if (!previous) console.log(snapshotFile ? "No earlier snapshot: renames are found from the next run on." : "Renames aren't checked without --snapshot.");
  }
  process.exit(report.drift.length || report.blocking.length ? 1 : 0);
})().catch(e => { console.error(`The audit failed: ${e.message}`); process.exit(2); });
