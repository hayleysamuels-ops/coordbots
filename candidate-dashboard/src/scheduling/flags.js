"use strict";
// Wording for a calendar-checked agenda's advisory flags: a session whose
// interviewer is busy, or outside their meeting hours, at its time. One place,
// so the booking page and the Slack post say the same thing. Names only: no
// pronouns, since the system can't know anyone's.
const range = (flag, timeZone) => {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const zone = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date(flag.start)).find(p => p.type === "timeZoneName")?.value || timeZone;
  return `${f.format(new Date(flag.start))}–${f.format(new Date(flag.end))} (${zone})`;
};
const minutes = n => `${n} minute${n === 1 ? "" : "s"}`;
function describeFlag(flag, timeZone) {
  if (flag.kind === "busy") return `${flag.name} is busy ${range(flag, timeZone)} on their primary calendar. The meeting needs moving, or booking over.`;
  const which = flag.hoursSource === "verified" ? "verified meeting hours" : "assumed meeting hours";
  return `${minutes(flag.minutes)} of this session (${range(flag, timeZone)}) is outside ${flag.name}'s ${which}${flag.hoursLabel ? ` (${flag.hoursLabel})` : ""}.`;
}
// Server-side shape check for flags stored on a draft.
function validFlags(list) {
  return Array.isArray(list) && list.every(f => f && ["busy", "hours"].includes(f.kind) && typeof f.name === "string" && f.name.length <= 200 &&
    [f.start, f.end].every(v => typeof v === "string" && Number.isFinite(Date.parse(v))) && Number.isInteger(f.minutes) && f.minutes > 0 &&
    (f.kind === "busy" || (["verified", "default", "override", "assumed"].includes(f.hoursSource) && (f.hoursLabel == null || typeof f.hoursLabel === "string"))));
}
module.exports = { describeFlag, validFlags };
