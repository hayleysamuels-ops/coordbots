"use strict";
// Standing interviewer requests: who an @mention amend asked for on which
// session, kept on every post after it (plan.requested, under the digest) so
// no later rebuild drops them silently. Every rebuild for the schedule honours
// them: Slack's suggestion buttons, a later amend, auto-post and booking
// review's Post (service.requestsFor reads the latest post's).
//
// A request is { session, interviewId, label, userId, name, by, byName }:
// the 0-based agenda session and its Ashby interview (so a plan that changed
// underneath is noticed), the person asked for, and who asked (Slack email and
// display name).
//
// A request ends only by an explicit choice: a later amend on that session
// replaces it; "Suggest different interviewer" on that session, or "Drop the
// Slack requests" in booking review, releases it, and the new post says so.
const MAX = 30;
const fail = message => { throw Object.assign(new Error(message), { status: 500 }); };
const str = v => typeof v === "string" && v.length > 0 && v.length <= 200;

function checkRequested(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > MAX || !list.every(r => Number.isInteger(r?.session) && r.session >= 0 && [r.interviewId, r.label, r.userId, r.name, r.by, r.byName].every(str))
    || new Set(list.map(r => r.session)).size !== list.length) fail("The interviewer requests are incomplete.");
  return list.map(r => ({ session: r.session, interviewId: r.interviewId, label: r.label, userId: r.userId, name: r.name, by: r.by, byName: r.byName })).sort((a, b) => a.session - b.session);
}

// "Vamsi Chitters on Onsite 2 (requested by Anna Jones)"
const describeRequest = r => `${r.name} on ${r.label} (requested by ${r.byName})`;
const list = items => items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const describeRequests = rs => list(rs.map(describeRequest));

// The requests after an amend on `session`: theirs replaced by this one.
function withRequest(requested, r) { return checkRequested([...checkRequested(requested).filter(x => x.session !== r.session), r]); }
// The requests after "Suggest different interviewer" on `session`, and the
// one that released (or null).
function releaseSession(requested, session) {
  const all = checkRequested(requested);
  return { requested: all.filter(x => x.session !== session), released: all.find(x => x.session === session) || null };
}

// What a calendar search requires for these requests (calendar-inputs.js
// requireInterviewers), after checking each still names the same interview in
// the plan's agenda. A request on a session that moved or went is returned in
// `gone`, for the caller to word.
function requirementsFor(requested, agenda) {
  const require = [], gone = [];
  for (const r of checkRequested(requested)) {
    if (agenda[r.session]?.interviewId === r.interviewId) require.push({ session: r.session, userId: r.userId, name: r.name, request: r });
    else gone.push(r);
  }
  return { require, gone };
}

// What in Ashby (or the rules) would let a request be kept again, from
// calendar-inputs' reason; null when nothing can be restored (the session is
// no longer that interview) or the reason isn't one we know how to fix.
function fixFor(r, why) {
  if (why === "not_eligible") return `make ${r.name} eligible for ${r.label} again in Ashby`;
  const limit = /^Ashby (daily|weekly) interview limit is 0$/.exec(why);
  if (limit) return `raise ${r.name}'s ${limit[1]} interview limit above 0 in Ashby`;
  if (why === "No meeting hours in the client rules") return `add ${r.name}'s meeting hours to this client's scheduling rules`;
  return null;
}

// Why a request can't be kept, and the ways out, the fix first: keeping the
// request is usually what the person wanted, and the fix works whatever the
// post. Dropping it is the fallback, and only ever drops this one request.
// `where`: "slack" (a reply in the post's thread, which a Slack rebuild only
// runs on a post that has the buttons), "dashboard" (booking review), or
// "notice" (auto-post's channel notice). `slackPost`: whether the schedule
// has an open post that Slack can rebuild (buttons and @mention work there).
function staleRequestText(r, why, { where, slackPost = where === "slack" } = {}) {
  const reason = why === "not_eligible" ? `Ashby no longer lists ${r.name} as eligible for ${r.label}`
    : why === "session_gone" ? `${r.label} is no longer that interview in the plan in Ashby`
    : `${r.name} can't be scheduled right now (${why})`;
  const fix = fixFor(r, why);
  const inSlack = mention => `choose ${r.label} under "Suggest different interviewer" so anyone eligible can take it, or @mention ${mention} naming who should take ${r.label}`;
  const inReview = `press "Drop" next to this request in booking review on the dashboard, so anyone eligible can take ${r.label}`;
  const drop = where === "slack" ? inSlack("me here")
    : where === "dashboard" ? `press "Drop" next to this request here, so anyone eligible can take ${r.label}${slackPost ? `; or, on the open post in Slack, ${inSlack("the bot in its thread")}` : ""}`
    : slackPost ? `on the open post for this candidate, ${inSlack("the bot in its thread")}; or ${inReview}` : inReview;
  const again = where === "slack" ? "try again here" : where === "dashboard" ? "preview again" : "post an option from booking review";
  return `${r.name} was requested for ${r.label} by ${r.byName}, but ${reason}, so no new option can keep that request. ${fix ? `To keep it, ${fix}, then ${again}. To drop it instead, ${drop}.` : `To drop it, ${drop}.`} Other requests are kept either way.`;
}

module.exports = { fixFor, checkRequested, describeRequest, describeRequests, withRequest, releaseSession, requirementsFor, staleRequestText };
