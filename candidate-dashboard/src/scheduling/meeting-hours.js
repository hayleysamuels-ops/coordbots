"use strict";
// Expands a scheduling-rules weeklyHours block ({ timezone, days, start, end })
// into concrete instants covering a range. Local times are converted with
// booking-planner's instant(), which is daylight-saving safe and refuses
// ambiguous or nonexistent wall times rather than guessing. The intervals are
// assumed hours (scheduling-rules meetingHours), never a verified schedule.
const { instant } = require("./booking-planner");

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_MS = 24 * 3600000;

function localDate(ms, timezone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ms).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// One interval per listed weekday whose hours overlap [rangeStart, rangeEnd].
// Intervals are not clipped: the solver only asks whether a whole session
// fits inside one of them.
function hoursIntervals(hours, rangeStart, rangeEnd) {
  if (!hours || !Array.isArray(hours.days) || !hours.days.length) throw Object.assign(new Error("Meeting hours need at least one weekday."), { status: 503 });
  const out = [];
  const first = Date.parse(localDate(rangeStart - DAY_MS, hours.timezone) + "T00:00Z");
  const last = Date.parse(localDate(rangeEnd + DAY_MS, hours.timezone) + "T00:00Z");
  for (let day = first; day <= last; day += DAY_MS) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (!hours.days.includes(DAYS[new Date(day).getUTCDay()])) continue;
    const start = instant(`${date}T${hours.start}`, hours.timezone), end = instant(`${date}T${hours.end}`, hours.timezone);
    if (end > rangeStart && start < rangeEnd) out.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  }
  return out;
}

module.exports = { hoursIntervals };
