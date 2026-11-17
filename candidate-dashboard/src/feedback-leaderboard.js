"use strict";

// The feedback leaderboard, as a pure function: no Ashby, no disk, so every
// rule here is directly testable (test/feedback-leaderboard.test.js).
//
// Rules agreed 2026-11-17:
// - Ranked on the share of a person's COMPLETED interviews with their
//   scorecard in. Higher is better. That's the measure, not speed.
// - Completed = the schedule isn't cancelled, the interview ended within the
//   last `days` and at least `dueAfterHours` ago (FEEDBACK_OVERDUE_HOURS),
//   so a scorecard isn't counted missing before it's due.
// - Only people who owe a scorecard on that interview count (`owersFor`,
//   the same rule as Feedback Overdue and Interviews Today): hosts, debriefs
//   and NO_FEEDBACK_INTERVIEWS events never count, for or against anyone.
//   Someone who only ever hosts never appears.
// - A scorecard counts if it's tied to that interview event and credited to
//   that person, whenever it was submitted. Late still counts as in.
// - At least `minInterviews` completed interviews to appear at all.
// - People who have left (not in `enabledUserIds`) are left out entirely.
// - Ties (common: most people at most clients are at 100%): the faster
//   median time from interview end to submission first, then more completed
//   interviews, then name, so the order is stable between refreshes.
//   Changed 2026-11-17 from count-first: with nearly everyone complete,
//   count-first made it a leaderboard about volume. Promptness is the thing
//   worth showing among people who are all complete, and the thing they
//   control. Share stays the primary measure; median only breaks ties.
// - Only the top `size` are returned. No full ranking, no bottom of the
//   table, no "where you sit". `qualifying` is how many people met the
//   minimum (the "N people have done 8+ interviews" line), and
//   `othersAtFull` how many qualifying people at 100% didn't make the top
//   `size`, so a perfect record isn't invisible ("N others also at 100%").
//   Neither names anyone.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function buildLeaderboard({ schedules, scorecards, enabledUserIds, owersFor, now, days, minInterviews, dueAfterHours, size = 10 }) {
  const windowStart = now - days * DAY;
  const dueBy = now - dueAfterHours * HOUR;

  // eventId -> userId -> earliest submittedAt (ms)
  const inByEvent = new Map();
  for (const s of scorecards) {
    const at = Date.parse(s.submittedAt);
    if (Number.isNaN(at)) continue;
    const people = inByEvent.get(s.eventId) || new Map();
    if (!people.has(s.userId) || at < people.get(s.userId)) people.set(s.userId, at);
    inByEvent.set(s.eventId, people);
  }

  const byPerson = new Map();
  for (const schedule of schedules) {
    if (schedule.status === "Cancelled") continue;
    for (const event of schedule.interviewEvents || []) {
      const end = Date.parse(event.endTime);
      if (Number.isNaN(end) || end < windowStart || end > dueBy) continue;
      for (const person of owersFor(event)) {
        if (!person.id || !enabledUserIds.has(person.id)) continue;
        const p = byPerson.get(person.id) || { userId: person.id, name: "", completed: 0, submitted: 0, hoursToSubmit: [], lastSeen: 0 };
        // The name as of their most recent interview, in case it changed.
        if (end >= p.lastSeen) {
          p.lastSeen = end;
          p.name = `${person.firstName || ""} ${person.lastName || ""}`.trim() || person.email || "Unknown";
        }
        p.completed += 1;
        const at = (inByEvent.get(event.id) || new Map()).get(person.id);
        if (at != null) {
          p.submitted += 1;
          p.hoursToSubmit.push(Math.max(0, at - end) / HOUR);
        }
        byPerson.set(person.id, p);
      }
    }
  }

  const qualified = [...byPerson.values()]
    .filter((p) => p.completed >= minInterviews)
    .map((p) => ({
      userId: p.userId,
      name: p.name,
      completed: p.completed,
      submitted: p.submitted,
      share: p.submitted / p.completed,
      medianHoursToSubmit: median(p.hoursToSubmit),
    }));

  qualified.sort(
    (a, b) =>
      b.share - a.share ||
      (a.medianHoursToSubmit ?? Infinity) - (b.medianHoursToSubmit ?? Infinity) ||
      b.completed - a.completed ||
      a.name.localeCompare(b.name)
  );

  return {
    days,
    minInterviews,
    qualifying: qualified.length,
    othersAtFull: qualified.slice(size).filter((p) => p.submitted === p.completed).length,
    top: qualified.slice(0, size).map((p, i) => ({ rank: i + 1, ...p })),
  };
}

module.exports = { buildLeaderboard, median };
