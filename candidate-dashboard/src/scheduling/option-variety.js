"use strict";
// Two agendas only count as different options when they're on different
// candidate-local days, start at least an hour apart, or use a different
// interviewer for at least one session. Five agendas five minutes apart with
// the same panel aren't five choices.
const HOUR = 3600000;
const dayIn = (ms, timezone) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
const panel = option => option.events.map(e => e.interviewer.userId || e.interviewer.name).join("|");

function different(a, b, timezone) {
  const sa = Date.parse(a.start), sb = Date.parse(b.start);
  return dayIn(sa, timezone) !== dayIn(sb, timezone) || Math.abs(sa - sb) >= HOUR || panel(a) !== panel(b);
}

// True when `option` differs from every option already accepted.
const distinctFrom = (accepted, option, timezone) => accepted.every(a => different(a, option, timezone));

// Start windows (scheduling-rules sessions.placementWindows): true when the
// session may start at `start`. Shared by both previews.
function withinStartWindows(session, start) {
  return !session.placementWindows || session.placementWindows.every(w => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: w.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(start).map(x => [x.type, x.value]));
    const t = `${p.hour}:${p.minute}`;
    return t >= w.earliestStart && t <= w.latestStart;
  });
}

module.exports = { distinctFrom, withinStartWindows };
