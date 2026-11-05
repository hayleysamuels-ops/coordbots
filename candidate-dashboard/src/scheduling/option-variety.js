"use strict";
// Two agendas only count as different options when they're on different
// candidate-local days, start at least an hour apart, or use a different
// interviewer for at least one session. Five agendas five minutes apart with
// the same panel aren't five choices.
const HOUR = 3600000;
const dayIn = (ms, timezone) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
const { peopleOf } = require("./panel");
const panel = option => option.events.map(e => peopleOf(e).map(p => p.userId || p.name).join("+")).join("|");

function different(a, b, timezone) {
  const sa = Date.parse(a.start), sb = Date.parse(b.start);
  return dayIn(sa, timezone) !== dayIn(sb, timezone) || Math.abs(sa - sb) >= HOUR || panel(a) !== panel(b);
}

// True when `option` differs from every option already accepted.
const distinctFrom = (accepted, option, timezone) => accepted.every(a => different(a, option, timezone));

// "Suggest another time" (Slack): true when `start` is on a different
// candidate-local day from each avoided start, or an hour or more from it.
// Unlike distinctFrom, a different panel at the same time doesn't count.
const awayFromStarts = (start, avoided, timezone) => avoided.every(a => {
  const sa = Date.parse(a), sb = Date.parse(start);
  return dayIn(sa, timezone) !== dayIn(sb, timezone) || Math.abs(sa - sb) >= HOUR;
});

// Start windows (scheduling-rules sessions.placementWindows): true when the
// session may start at `start`. With a latestEnd, it must also finish by then,
// on the same local date (Luminai: lunch finishes by 13:30, whatever its
// length). Shared by both previews.
function withinStartWindows(session, start) {
  const local = (ms, tz) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(ms).map(x => [x.type, x.value]));
  return !session.placementWindows || session.placementWindows.every(w => {
    const s = local(start, w.timezone), t = `${s.hour}:${s.minute}`;
    if (t < w.earliestStart || t > w.latestStart) return false;
    if (w.latestEnd === undefined) return true;
    const e = local(start + session.durationMinutes * 60000, w.timezone);
    return `${e.year}-${e.month}-${e.day}` === `${s.year}-${s.month}-${s.day}` && `${e.hour}:${e.minute}` <= w.latestEnd;
  });
}

module.exports = { distinctFrom, awayFromStarts, withinStartWindows };
