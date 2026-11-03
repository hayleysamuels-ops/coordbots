"use strict";
// Panels: an interview whose Ashby template has two or more interviewer slots
// (worker/plan-reader.js). A panel session carries `slots`, one eligible list
// per slot in Ashby's order, and `requiredCount` = the number of slots; a
// proposed panel event carries `interviewers`, one person per slot in the same
// order, instead of the one-person `interviewer`.
//
// Two-person panels are supported (Welcome: Gabrielle Struckell and Grace
// Buckingham on most onsites since September). Larger ones are refused by name
// until the search is sized for them (Senior PM's four-person Case Study).
const MAX_PANEL = 2;

// Everyone on an event, in slot order: [interviewer] or the panel.
const peopleOf = e => Array.isArray(e?.interviewers) ? e.interviewers : e?.interviewer ? [e.interviewer] : [];

// A session's slot lists: its own for a panel, else its one eligible list.
const slotsOf = s => Array.isArray(s?.slots) ? s.slots.map(x => x.eligibleInterviewers) : [s.eligibleInterviewers];

// True when a session's assignment is one the searches can use: one slot, or a
// panel of 2..MAX_PANEL slots whose people are all in its eligible list.
function validAssignment(s, key = p => p.userId) {
  if (s.requiredCount === 1 && s.slots === undefined) return true;
  if (!Array.isArray(s.slots) || s.slots.length < 2 || s.slots.length > MAX_PANEL || s.requiredCount !== s.slots.length) return false;
  const all = new Set((s.eligibleInterviewers || []).map(key));
  return s.slots.every(x => Array.isArray(x?.eligibleInterviewers) && x.eligibleInterviewers.length && x.eligibleInterviewers.every(p => all.has(key(p))));
}

// The refusal for a panel larger than supported, worded so auto-post files it
// as needing a person (auto-post.js NEEDS_PERSON matches " is a panel: ").
const tooLarge = s => `"${String(s.title || "This interview").trim()}" is a panel: it has ${s.slots.length} interviewer slots, so it expects ${s.slots.length} people. Two-person panels are supported; larger ones aren't yet, so this can't be proposed or booked here. Schedule it by hand in Ashby.`;

module.exports = { MAX_PANEL, peopleOf, slotsOf, validAssignment, tooLarge };
