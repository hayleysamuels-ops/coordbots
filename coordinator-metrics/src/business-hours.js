"use strict";

/**
 * Business hours between two instants, in a given IANA time zone.
 *
 * Booking turnaround is reported in business hours rather than clock
 * hours because clock hours punish a coordinator for the weekend. A
 * request that lands at 17:00 on Friday and is booked at 09:30 on Monday
 * is 64 clock hours and about 2 business hours; only the second number
 * describes how fast anyone worked.
 *
 * Weekends are excluded entirely. Public holidays are NOT — they vary by
 * country and by client, nothing in Ashby says which apply, and guessing
 * a calendar would quietly inflate a handful of measurements. A holiday
 * therefore reads as a slow day, which is at least honest.
 */

const formatterCache = new Map();

function partsIn(timeZone, date) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    });
    formatterCache.set(timeZone, formatter);
  }
  const out = {};
  for (const { type, value } of formatter.formatToParts(date)) out[type] = value;
  return out;
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Walks hour by hour in the target zone and counts the hours that fall
 * on a weekday inside the business window.
 *
 * Hour granularity rather than exact minutes: the inputs are an
 * Ashby stage-entry timestamp and an event-creation timestamp, and the
 * metric is reported as a median in hours. Minute precision would be
 * false precision, and stepping hours keeps this correct across DST
 * transitions without any offset arithmetic — each step is re-read in
 * the target zone rather than assumed.
 */
function businessHoursBetween(startIso, endIso, timeZone, { start = 8, end = 18 } = {}) {
  const from = new Date(startIso);
  const to = new Date(endIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  if (to <= from) return 0;

  // A gap this large is almost always a data artefact rather than a
  // coordinator genuinely sitting on something for a year. Counting it
  // hour by hour would also be slow, so it is capped and still counted
  // at the cap — dropping it would quietly flatter the p90, which is
  // the number most worth trusting here.
  // 45 days. The p90 of real turnaround is about eight days, so the cap
  // cannot move the reported statistics, and it bounds the hour-by-hour
  // walk across ~15,000 schedules per client.
  const MAX_HOURS = 24 * 45;
  const spanHours = Math.min((to - from) / 3600000, MAX_HOURS);

  let hours = 0;
  for (let i = 0; i < spanHours; i++) {
    const at = new Date(from.getTime() + i * 3600000);
    const p = partsIn(timeZone, at);
    const dow = WEEKDAY_INDEX[p.weekday];
    if (dow === 0 || dow === 6) continue;
    const hour = parseInt(p.hour, 10) % 24;
    if (hour >= start && hour < end) hours += 1;
  }
  return hours;
}

module.exports = { businessHoursBetween };
