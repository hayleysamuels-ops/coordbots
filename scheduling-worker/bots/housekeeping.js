"use strict";
/**
 * Housekeeping — keeps the run log from growing forever.
 *
 * The readiness sweep ticks every fifteen minutes, so run_log gains roughly a
 * hundred rows a day. Trimming is by AGE only: quiet ticks are deliberately
 * kept, because a run that did nothing is the alive signal, and "the bot
 * quietly did nothing this morning" is the exact failure the log exists to
 * catch. Dropping no-ops would remove the evidence and leave only the noise.
 */
const KEEP_DAYS = 90;

async function run({ botStore, dryRun, log = console.log }) {
  if (dryRun) {
    return {
      outcome: "dry_run",
      summary: { keepDays: KEEP_DAYS, note: "would delete run_log rows older than " + KEEP_DAYS + " days" },
    };
  }
  const removed = await botStore.pruneRunLog(KEEP_DAYS);
  log("[housekeeping] pruned " + removed + " run_log row(s) older than " + KEEP_DAYS + " days");
  return { outcome: "ok", summary: { keepDays: KEEP_DAYS, rowsDeleted: removed } };
}

module.exports = {
  name: "housekeeping",
  title: "Housekeeping",
  description: "Deletes run log rows older than " + KEEP_DAYS + " days. Keeps quiet ticks.",
  // everyMinutes: 1440 buckets to one slot per day, so this runs once a day.
  schedule: { timeZone: "America/Los_Angeles", everyMinutes: 1440 },
  // Pruning is internal bookkeeping, not something anyone reads in Slack, so it
  // ships live rather than needing a coordinator to turn it on.
  defaults: { enabled: true, dryRun: false },
  run,
  _internal: { KEEP_DAYS },
};
