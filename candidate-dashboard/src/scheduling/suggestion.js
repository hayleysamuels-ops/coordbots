"use strict";
// Slack's "Suggest another time" and "Suggest different interviewer": what a
// replacement post records, and how the steer builds up across replacements.
//
// A post made from a suggestion keeps `plan.suggestion` (under the digest):
//   replaces: the draft it replaced; kind: "time" | "interviewer" | "amend";
//   session: for "interviewer" and "amend", the 0-based session changed;
//   change: for "amend" (an @mention confirmed in the thread), who came off
//     and who went on ({ label, out, in }, each { userId, name }), and moved:
//     true when no agenda at the post's own times fit, so the times changed;
//   by: who asked (their Slack email);
//   avoidStarts: every start to keep away from, earliest first;
//   excludeInterviewers: [{ session, userId, name }], every person left out.
// Each new suggestion adds one steer to the ones before it, so asking twice
// never brings back an option already turned down. Steers carry over only
// while the candidate's submission is the one they were made against: a
// resubmission starts again from just this request. An amend leaves the
// person it took off out of that session from then on, and lets back in the
// person it put on (an amend is an explicit choice, so it outranks an earlier
// "different interviewer"). What it requires isn't carried: a later button
// press may pick anyone eligible.
const fail = message => { throw Object.assign(new Error(message), { status: 500 }); };
const isInstant = v => typeof v === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
const MAX = 50;
const person = p => p && typeof p.userId === "string" && p.userId && typeof p.name === "string" && p.name;

function checkSuggestion(s) {
  const ok = s && typeof s.replaces === "string" && ["time", "interviewer", "amend"].includes(s.kind) && typeof s.by === "string" && s.by &&
    (s.kind === "time" || Number.isInteger(s.session) && s.session >= 0) &&
    (s.kind !== "amend" || typeof s.change?.label === "string" && s.change.label && person(s.change.out) && person(s.change.in) && (s.change.moved === undefined || typeof s.change.moved === "boolean")) &&
    Array.isArray(s.avoidStarts) && s.avoidStarts.length <= MAX && s.avoidStarts.every(isInstant) &&
    Array.isArray(s.excludeInterviewers) && s.excludeInterviewers.length <= MAX &&
    s.excludeInterviewers.every(x => Number.isInteger(x?.session) && x.session >= 0 && typeof x.userId === "string" && x.userId && typeof x.name === "string");
  if (!ok) fail("The suggestion record is incomplete.");
  const who = p => ({ userId: p.userId, name: p.name });
  return { replaces: s.replaces, kind: s.kind, ...(s.kind !== "time" ? { session: s.session } : {}), by: s.by,
    ...(s.kind === "amend" ? { change: { label: s.change.label, out: who(s.change.out), in: who(s.change.in), ...(s.change.moved !== undefined ? { moved: s.change.moved } : {}) } } : {}),
    avoidStarts: s.avoidStarts.map(a => new Date(Date.parse(a)).toISOString()),
    excludeInterviewers: s.excludeInterviewers.map(x => ({ session: x.session, userId: x.userId, name: x.name })) };
}

// The steer for a new request on `row` (the post the button was pressed on).
// `carry` is false when the candidate resubmitted since that post: then only
// this request applies. Throws (409) when the request can't be made.
// For "amend", `change` is amend.js's ({ label, out, in }), and the post's
// session must still have `out` on it.
function nextSuggestion(row, { kind, session = null, by, change = null, carry = true }) {
  const plan = row.plan, sessions = plan.bookingPlan?.sessions || [];
  const earlier = carry && plan.suggestion ? plan.suggestion : { avoidStarts: [], excludeInterviewers: [] };
  const base = { replaces: row.id, kind, by, avoidStarts: [...earlier.avoidStarts], excludeInterviewers: [...earlier.excludeInterviewers] };
  if (kind === "time") {
    base.avoidStarts.push(new Date(Date.parse(sessions[0]?.start || plan.sessions[0].start)).toISOString());
  } else if (kind === "amend") {
    const s = sessions[session];
    if (!Number.isInteger(session) || !s) throw Object.assign(new Error("That session isn't on this post."), { status: 409 });
    if (s.interviewers?.length !== 1 || s.interviewers[0]?.userId !== change?.out?.userId) throw Object.assign(new Error(`${change?.out?.name || "That interviewer"} isn't on ${change?.label || "that session"} any more.`), { status: 409 });
    base.session = session;
    base.change = { label: change.label, out: { userId: change.out.userId, name: change.out.name }, in: { userId: change.in.userId, name: change.in.name } };
    base.excludeInterviewers = base.excludeInterviewers.filter(x => !(x.session === session && x.userId === change.in.userId));
    if (!base.excludeInterviewers.some(x => x.session === session && x.userId === change.out.userId))
      base.excludeInterviewers.push({ session, userId: change.out.userId, name: change.out.name });
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
  if (s.kind === "amend") return `Amended in Slack by ${s.by}: replace ${s.change.out.name} with ${s.change.in.name} on ${s.change.label}${s.change.moved ? "; no agenda at the earlier times fit, so the times moved" : ", same times"}. It replaces the earlier post (draft ${s.replaces}).`;
  const what = s.kind === "time" ? "another time" : `a different interviewer for session ${s.session + 1}`;
  return `Suggested in Slack by ${s.by}: ${what}, replacing the earlier post (draft ${s.replaces}).`;
}

module.exports = { checkSuggestion, nextSuggestion, suggestionNote };
