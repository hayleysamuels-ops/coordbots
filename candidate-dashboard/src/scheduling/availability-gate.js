"use strict";
// The candidate's availability, checked again before an approved option is
// composed in Ashby. A post records the submission it was built from
// (postedAvailability, stored in the plan so the approval's digest covers it);
// at its turn in the Ashby check queue, the submission is read again and must
// be the same (availabilityChange). A candidate who resubmits after an option
// was posted would otherwise have an old time composed, or sent.
//
// "The same" is the same time zone and the same windows, compared as instants.
// Windows that have started by the time of the check are left out on both
// sides, as the reader leaves them out (availability-source.js normalizeSubmission),
// so time passing never reads as a change.
const fail = message => { throw Object.assign(new Error(message), { status: 500 }); };
const isInstant = v => typeof v === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
const iso = v => new Date(Date.parse(v)).toISOString();

// What a post keeps of the submission (availability-source.js load()).
function postedAvailability(submission) {
  if (!submission || typeof submission.scheduleId !== "string" || typeof submission.timezone !== "string" || !Array.isArray(submission.windows) ||
    !submission.windows.every(w => isInstant(w?.start) && isInstant(w?.end))) fail("The submitted availability couldn't be recorded with the post.");
  return { scheduleId: submission.scheduleId, timezone: submission.timezone,
    windows: submission.windows.map(w => ({ start: iso(w.start), end: iso(w.end) })),
    ...(typeof submission.requestUpdatedAt === "string" ? { requestUpdatedAt: submission.requestUpdatedAt } : {}) };
}

// null when the current submission matches the posted one, else what changed,
// in words for the Slack message (counts only, never the times themselves).
function availabilityChange(posted, current, now) {
  if (current.timezone !== posted.timezone) return `the candidate's time zone changed (${posted.timezone} when posted, ${current.timezone} now)`;
  const key = w => `${iso(w.start)}/${iso(w.end)}`;
  const ahead = windows => new Set(windows.filter(w => Date.parse(w.start) > now).map(key));
  const before = ahead(posted.windows), after = ahead(current.windows);
  const removed = [...before].filter(k => !after.has(k)).length, added = [...after].filter(k => !before.has(k)).length;
  if (!removed && !added) return null;
  const n = (count, what) => `${count} window${count === 1 ? "" : "s"} ${what}`;
  return `the candidate's submitted availability changed after this was posted (${[removed && n(removed, "no longer offered"), added && n(added, "new")].filter(Boolean).join(", ")})`;
}

module.exports = { postedAvailability, availabilityChange };
