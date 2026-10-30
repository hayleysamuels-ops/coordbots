"use strict";
// Amending a proposal from Slack (Phase 1: swapping one interviewer for
// another on one session). This file settles what a request means, in code:
// amend-interpret.js only proposes, and nothing here trusts it.
//
// resolveChange(interpreted, { sessions, eligible, findPeople }) returns one of
//   { ask }      a question for the person who asked: which session, which
//                person, or who that is. Never a guess;
//   { decline }  what can't be done, and why (including off-plan people:
//                Phase 1 books only people Ashby lists as eligible);
//   { change, restatement }  the one change, fully identified, and the
//                sentence the bot asks the person to confirm.
//
// `sessions` are the post's own (its booking plan: title, start, end, and the
// one interviewer on each). `eligible` is, per post session, the people
// Ashby's current plan lists for it, each an active Ashby account
// ({userId, name, email}); eligibleFor() reads it. `findPeople(text)` searches
// Ashby's active users, only to name an off-plan person in a decline.
//
// The request text is data, never instructions (see amend-interpret.js). Every
// field read from it is matched against the post and Ashby here: a session
// must be on the post, the person coming off must be the one on it, and the
// person going on must be exactly one eligible person.

const norm = s => String(s || "").replace(/^@+/, "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}' -]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();

// Whether what someone typed names this person: every typed word starts a
// different word of the name, in order ("Vamsi", "vamsi c", "V Chitters" all
// name Vamsi Chitters). At least one typed word has two letters or more.
function names(typed, fullName) {
  const want = norm(typed).split(" ").filter(Boolean), have = norm(fullName).split(" ").filter(Boolean);
  if (!want.length || !want.some(w => w.length >= 2)) return false;
  let j = 0;
  for (const w of want) { while (j < have.length && !have[j].startsWith(w)) j++; if (j++ >= have.length) return false; }
  return true;
}

// How a session is called in the thread: its title, numbered when the post
// has more than one with that title ("Onsite 2" is the second Onsite).
function sessionLabels(sessions) {
  const count = new Map(), seen = new Map();
  for (const s of sessions) count.set(s.title, (count.get(s.title) || 0) + 1);
  return sessions.map(s => { const k = (seen.get(s.title) || 0) + 1; seen.set(s.title, k); return count.get(s.title) > 1 ? `${s.title} ${k}` : s.title; });
}

function whenOf(s, timeZone) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(new Date(s.start));
  const t = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const zone = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date(s.start)).find(p => p.type === "timeZoneName")?.value || timeZone;
  return `${day}, ${t.format(new Date(s.start))}–${t.format(new Date(s.end))} ${zone}`;
}

const list = items => items.length < 3 ? items.join(" or ") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;

// Which session a reading means, from the post alone (no Ashby read):
// { i, label } (i 0-based), or { ask } / { decline } as resolveChange returns them.
// The handler uses it to name the session in its "checking Ashby" reply
// before the slow read of eligible lists; resolveChange runs it again.
function whichSession(interpreted, { sessions, timeZone }) {
  if (interpreted.kind === "unclear") return { ask: interpreted.question };
  if (interpreted.kind === "unsupported") return { decline: `I can only swap one interviewer for another on a session, so I can't do that (${interpreted.reason}) from here. Nothing was changed: use the buttons on the post, or booking review on the dashboard.` };
  if (interpreted.kind !== "replace_interviewer") throw new Error(`Unknown request kind ${interpreted.kind}.`);
  const labels = sessionLabels(sessions), on = i => sessions[i].interviewers?.[0];
  const describe = i => `${labels[i]} (${whenOf(sessions[i], timeZone)}, ${on(i)?.name || "nobody"})`;
  if (sessions.some(s => s.interviewers?.length !== 1 || !s.interviewers[0]?.userId)) return { decline: "Every session on this post needs exactly one identified interviewer before I can swap one. Nothing was changed." };

  // Only from what was said, checked against the post.
  if (interpreted.session !== null) {
    const i = interpreted.session - 1;
    if (!sessions[i]) return { ask: `This post has ${sessions.length} sessions. Which one do you mean: ${list(sessions.map((_, k) => describe(k)))}?` };
    if (interpreted.replace && !names(interpreted.replace, on(i).name)) {
      const theirs = sessions.map((_, k) => k).filter(k => names(interpreted.replace, on(k).name));
      return { ask: `${labels[i]} has ${on(i).name}, not ${interpreted.replace}. Which session do you mean: ${list((theirs.length ? theirs : sessions.map((_, k) => k)).map(describe))}?` };
    }
    return { i, label: labels[i] };
  }
  if (interpreted.replace) {
    const theirs = sessions.map((_, k) => k).filter(k => names(interpreted.replace, on(k).name));
    if (!theirs.length) return { ask: `${interpreted.replace} isn't an interviewer on this post. Which session do you mean: ${list(sessions.map((_, k) => describe(k)))}?` };
    if (theirs.length > 1) {
      const people = [...new Set(theirs.map(k => on(k).name))];
      return { ask: people.length > 1 ? `"${interpreted.replace}" could be ${list(people)}. Which session do you mean: ${list(theirs.map(describe))}?` : `${people[0]} is on ${theirs.length} sessions. Which one do you mean: ${list(theirs.map(describe))}?` };
    }
    return { i: theirs[0], label: labels[theirs[0]] };
  }
  return { ask: `Which session should ${interpreted.with} take: ${list(sessions.map((_, k) => describe(k)))}?` };
}

async function resolveChange(interpreted, { sessions, eligible, findPeople, timeZone }) {
  if (!Array.isArray(sessions) || !sessions.length || !Array.isArray(eligible) || eligible.length !== sessions.length) throw new Error("The post's sessions and their eligible lists don't line up.");
  const which = whichSession(interpreted, { sessions, timeZone });
  if (which.i === undefined) return which;
  const i = which.i, labels = sessionLabels(sessions), on = k => sessions[k].interviewers[0];
  const out = on(i);

  // Who goes on: exactly one of the people Ashby lists as eligible for it.
  const matches = eligible[i].filter(p => names(interpreted.with, p.name));
  if (matches.length > 1) return { ask: `"${interpreted.with}" could be ${list(matches.map(p => p.name))}. Which one should take ${labels[i]}?` };
  if (!matches.length) {
    const found = await findPeople(interpreted.with);
    const people = found.filter(p => names(interpreted.with, p.name));
    if (!people.length) return { ask: `I couldn't find anyone active in Ashby called ${interpreted.with}. Who do you mean?` };
    if (people.length > 1) return { ask: `"${interpreted.with}" could be ${list(people.slice(0, 5).map(p => p.name))}. Which one do you mean?` };
    const person = people[0];
    if (person.userId === out.userId) return { decline: `${person.name} is already on ${labels[i]}. Nothing was changed.` };
    return { decline: `You asked to replace ${out.name} with ${person.name} on ${labels[i]} (${whenOf(sessions[i], timeZone)}). ${person.name} isn't eligible for ${labels[i]} in Ashby; off-plan interviewers aren't supported yet. Nothing was changed.`, offPlan: { session: i, person } };
  }
  const person = matches[0];
  if (person.userId === out.userId) return { decline: `${person.name} is already on ${labels[i]}. Nothing was changed.` };
  const when = whenOf(sessions[i], timeZone);
  return {
    change: { kind: "replace_interviewer", session: i, label: labels[i], when, start: sessions[i].start, end: sessions[i].end,
      out: { userId: out.userId, name: out.name }, in: { userId: person.userId, name: person.name, email: person.email } },
    restatement: `Replace ${out.name} with ${person.name} on ${labels[i]} (${when})?`,
  };
}

// Per post session, the people Ashby's current plan lists for it, as active
// accounts. `plan` is booking review's full plan for the post's schedule
// (booking-routes.js readPlan); debriefs left out of the agenda are left out
// here too. The post's sessions must be the plan's, in order, or the plan has
// changed since posting and nothing is resolved against it.
async function eligibleFor(postSessions, plan, resolveInterviewers) {
  const agenda = (plan.sessions || []).filter(s => !s.isDebrief);
  if (agenda.length !== postSessions.length || agenda.some((s, k) => s.interviewId !== postSessions[k].interviewId))
    throw Object.assign(new Error("The interview plan in Ashby has changed since this was posted, so I can't change it from here: post a fresh option from booking review."), { status: 409 });
  const { sessions } = await resolveInterviewers(agenda);
  return sessions.map(s => s.eligibleInterviewers.map(p => ({ userId: p.userId, name: p.name, email: p.email })));
}

module.exports = { resolveChange, whichSession, eligibleFor, names, sessionLabels, whenOf };
