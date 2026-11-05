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
// Interviewer load passing over someone the preference order put first
// (scheduling-rules interviewerLoad), as the post says it: "Keshav Malhotra
// suggested over Ariel Perez Chavez — Ariel has 2 interviews this week,
// Keshav has 0." First names for the counts; no pronouns.
const interviews = n => `${n} interview${n === 1 ? "" : "s"}`;
const firstName = name => String(name).trim().split(/\s+/)[0];
function describeLoadOverride(o) {
  return `${o.chosen.name} suggested over ${o.over.name} — ${firstName(o.over.name)} has ${interviews(o.over.count)} ${o.weekLabel}, ${firstName(o.chosen.name)} has ${o.chosen.count}.`;
}
// "this week" when the session's week (its Monday, YYYY-MM-DD, in
// `timeZone`) is the current one, else "the week of Mon, Nov 9".
function loadWeekLabel(week, timeZone, now = Date.now()) {
  const { weekKey } = require("../interviewer-load");
  if (week === weekKey(now, timeZone)) return "this week";
  return `the week of ${new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${week}T12:00:00Z`))}`;
}
const person = p => p && typeof p.name === "string" && p.name.trim() && p.name.length <= 200 && Number.isInteger(p.count) && p.count >= 0;
// Server-side shape check for one session's load overrides stored on a draft.
function validLoadOverrides(list) {
  return Array.isArray(list) && list.length <= 6 && list.every(o => o && person(o.chosen) && person(o.over) && typeof o.weekLabel === "string" && o.weekLabel.length <= 40);
}
module.exports = { describeFlag, validFlags, describeLoadOverride, loadWeekLabel, validLoadOverrides };
