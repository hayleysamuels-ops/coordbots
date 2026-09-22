"use strict";
/**
 * A small scheduler for named jobs, in a named timezone.
 *
 * Why not a cron library: the only hard parts are (a) getting the timezone
 * right across daylight saving, which Intl does for us, and (b) not running the
 * same job twice. Both are handled below in about thirty lines.
 *
 * Not running twice matters because Railway can restart the app, or run more
 * than one copy of it, and a weekly report posted twice into a team channel is
 * worse than one posted late. Each due moment produces a slot key like
 * "2026-08-31T07:00". The run log has a UNIQUE(job_name, slot_key), so whichever
 * copy inserts first owns the run and the rest step aside.
 *
 * A side effect of keying on the slot rather than the clock: if the app is down
 * or deploying at 07:00, it still runs when it comes back, as long as that is
 * within graceMinutes. The slot has no row yet, so it is still owed.
 */

const TICK_MS = 30 * 1000;

// Local wall-clock parts in a given timezone. Intl handles DST for us.
function partsIn(timeZone, date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: weekdays[p.weekday],
    date: p.year + "-" + p.month + "-" + p.day,
    hour: Number(p.hour === "24" ? 0 : p.hour),
    minute: Number(p.minute),
  };
}

/**
 * If the job is due now (or recently enough to still be worth running),
 * returns the slot key. Otherwise null.
 */
function dueSlot(schedule, now = new Date()) {
  const { timeZone, weekday, hour, minute = 0, graceMinutes = 60 } = schedule;
  const p = partsIn(timeZone, now);
  if (p.weekday !== weekday) return null;
  const minutesNow = p.hour * 60 + p.minute;
  const minutesDue = hour * 60 + minute;
  if (minutesNow < minutesDue || minutesNow > minutesDue + graceMinutes) return null;
  return p.date + "T" + String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
}

/**
 * For jobs that tick rather than fire weekly. Returns the current bucket, e.g.
 * every 15 minutes -> "2026-09-01T18:15". Same dedupe story as dueSlot: the
 * bucket is the slot key, so two instances ticking together cannot both run.
 */
function intervalSlot(schedule, now = new Date()) {
  const { timeZone, everyMinutes } = schedule;
  const p = partsIn(timeZone, now);
  const bucket = Math.floor((p.hour * 60 + p.minute) / everyMinutes) * everyMinutes;
  const hh = String(Math.floor(bucket / 60)).padStart(2, "0");
  const mm = String(bucket % 60).padStart(2, "0");
  return p.date + "T" + hh + ":" + mm;
}

function startScheduler({ jobs, runJob, log = console.log }) {
  const timer = setInterval(async () => {
    for (const job of jobs) {
      try {
        const slot = job.schedule.everyMinutes ? intervalSlot(job.schedule) : dueSlot(job.schedule);
        if (slot) await runJob(job, { trigger: "schedule", slotKey: slot });
      } catch (e) {
        log("[scheduler] " + job.name + " failed: " + e.message);
      }
    }
  }, TICK_MS);
  timer.unref?.();
  const names = jobs.map((j) => j.name + " (" + describe(j.schedule) + ")").join(", ");
  log("[scheduler] watching: " + (names || "no jobs"));
  return () => clearInterval(timer);
}

function describe(s) {
  if (s.everyMinutes) return "every " + s.everyMinutes + "m " + s.timeZone;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (
    days[s.weekday] +
    " " +
    String(s.hour).padStart(2, "0") +
    ":" +
    String(s.minute || 0).padStart(2, "0") +
    " " +
    s.timeZone
  );
}

module.exports = { startScheduler, dueSlot, intervalSlot, partsIn };
