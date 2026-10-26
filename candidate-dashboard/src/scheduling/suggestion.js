"use strict";
// Slack's "Suggest another time" and "Suggest different interviewer": what a
// replacement post records, and how the steer builds up across replacements.
//
// A post made from a suggestion keeps `plan.suggestion` (under the digest):
//   replaces: the draft it replaced; kind: "time" | "interviewer";
//   session: for "interviewer", the 0-based session that was changed;
//   by: who asked (their Slack email);
//   avoidStarts: every start to keep away from, earliest first;
//   excludeInterviewers: [{ session, userId, name }], every person left out.
// Each new suggestion adds one steer to the ones before it, so asking twice
// never brings back an option already turned down. Steers carry over only
// while the candidate's submission is the one they were made against: a
// resubmission starts again from just this request.
const fail = message => { throw Object.assign(new Error(message), { status: 500 }); };
const isInstant = v => typeof v === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
const MAX = 50;

function checkSuggestion(s) {
  const ok = s && typeof s.replaces === "string" && ["time", "interviewer"].includes(s.kind) && typeof s.by === "string" && s.by &&
    (s.kind !== "interviewer" || Number.isInteger(s.session) && s.session >= 0) &&
    Array.isArray(s.avoidStarts) && s.avoidStarts.length <= MAX && s.avoidStarts.every(isInstant) &&
    Array.isArray(s.excludeInterviewers) && s.excludeInterviewers.length <= MAX &&
    s.excludeInterviewers.every(x => Number.isInteger(x?.session) && x.session >= 0 && typeof x.userId === "string" && x.userId && typeof x.name === "string");
  if (!ok) fail("The suggestion record is incomplete.");
  return { replaces: s.replaces, kind: s.kind, ...(s.kind === "interviewer" ? { session: s.session } : {}), by: s.by,
    avoidStarts: s.avoidStarts.map(a => new Date(Date.parse(a)).toISOString()),
    excludeInterviewers: s.excludeInterviewers.map(x => ({ session: x.session, userId: x.userId, name: x.name })) };
}

// The steer for a new request on `row` (the post the button was pressed on).
// `carry` is false when the candidate resubmitted since that post: then only
// this request applies. Throws (409) when the request can't be made.
function nextSuggestion(row, { kind, session = null, by, carry = true }) {
  const plan = row.plan, sessions = plan.bookingPlan?.sessions || [];
  const earlier = carry && plan.suggestion ? plan.suggestion : { avoidStarts: [], excludeInterviewers: [] };
  const base = { replaces: row.id, kind, by, avoidStarts: [...earlier.avoidStarts], excludeInterviewers: [...earlier.excludeInterviewers] };
  if (kind === "time") {
    base.avoidStarts.push(new Date(Date.parse(sessions[0]?.start || plan.sessions[0].start)).toISOString());
  } else {
    const s = sessions[session];
    if (!Number.isInteger(session) || !s) throw Object.assign(new Error("That session isn't on this post."), { status: 409 });
    const person = s.interviewers?.[0];
    if (s.interviewers?.length !== 1 || !person?.userId) throw Object.assign(new Error("That session's interviewer can't be identified, so they can't be left out."), { status: 409 });
    base.session = session;
    if (!base.excludeInterviewers.some(x => x.session === session && x.userId === person.userId))
      base.excludeInterviewers.push({ session, userId: person.userId, name: String(person.name || person.email || "the interviewer") });
  }
  if (base.avoidStarts.length > MAX || base.excludeInterviewers.length > MAX) throw Object.assign(new Error("This candidate has had too many suggestions. Use booking review on the dashboard."), { status: 409 });
  base.avoidStarts.sort((a, b) => Date.parse(a) - Date.parse(b));
  return checkSuggestion(base);
}

// What the replacement post says about where it came from.
function suggestionNote(s) {
  const what = s.kind === "time" ? "another time" : `a different interviewer for session ${s.session + 1}`;
  return `Suggested in Slack by ${s.by}: ${what}, replacing the earlier post (draft ${s.replaces}).`;
}

module.exports = { checkSuggestion, nextSuggestion, suggestionNote };
