"use strict";
/**
 * A calendar day as a comparable integer, and the one definition of a reversed
 * range.
 *
 * Shared with the browser for the same reason lib/effective.js and lib/fields.js
 * are: the reversed-date rule is now enforced in two places, and a validation
 * rule that disagrees between client and server is the kind of defect nobody
 * sees until it lets something through. Required as a module on the server,
 * served to the browser at /dateday.js.
 *
 * Lifted from the view's own parseDay, unchanged: only YYYY-MM-DD parses, and
 * anything else is null rather than NaN or 0, because a typo must never sort or
 * compare as a real date.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DATEDAY = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** 20260914, or null when there is no real date here. */
  function parseDay(v) {
    if (v === null || v === undefined) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var probe = new Date(Date.UTC(y, mo - 1, d));
    // Rejects 2026-02-31, which Date would otherwise roll into March.
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
    return y * 10000 + mo * 100 + d;
  }

  /**
   * Is this pair reversed?
   *
   * Only when BOTH dates are real. An incomplete or unparseable pair is not
   * reversed: rejecting there would block the first of two edits and make a
   * valid range unreachable. Equal dates are fine, that is a single-day trial.
   */
  function isReversed(startRaw, endRaw) {
    var s = parseDay(startRaw), e = parseDay(endRaw);
    if (s === null || e === null) return false;
    return e < s;
  }

  /* ---------------- the day model ----------------
     A day is the calendar integer parseDay produces, so it is the same day the
     card prints. Arithmetic below is pure calendar arithmetic on those integers,
     via UTC, which is what makes it DST-proof: the integers already came out of
     isoToDay in America/Los_Angeles, and adding a day to a calendar date cannot
     be shortened by a clock change. */

  function toUTC(day) {
    var y = Math.floor(day / 10000), mo = Math.floor(day / 100) % 100, d = day % 100;
    return Date.UTC(y, mo - 1, d);
  }
  function fromUTC(ms) {
    var dt = new Date(ms);
    return dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
  }
  var DAY_MS = 86400000;

  /** The day n calendar days after `day`. Negative n goes back. */
  function addDays(day, n) { return fromUTC(toUTC(day) + n * DAY_MS); }

  /** Whole calendar days from a to b. Same day is 0. */
  function diffDays(a, b) { return Math.round((toUTC(b) - toUTC(a)) / DAY_MS); }

  /**
   * The days a trial occupies, from its resolved start and end.
   *
   * The four cases, all of them:
   *   start set, end null    single day at start
   *   start null             null, meaning excluded from the Day view entirely.
   *                          Those rows are the Awaiting a date group in List.
   *   end before start       single day at start, flagged reversed. NEVER
   *                          dropped: a naive range iterates zero days, so the
   *                          trial would appear on no days and vanish rather
   *                          than look wrong.
   *   either unparseable     already null from parseDay, so it falls into one of
   *                          the above. No second guard.
   *
   * Status is not consulted. A DONE trial whose dates are live still occupies
   * those days, consistent with the Upcoming rule: status is shown on the card,
   * it does not decide membership.
   */
  function trialSpan(startDay, endDay) {
    if (startDay === null || startDay === undefined) return null;
    var reversed = endDay !== null && endDay !== undefined && endDay < startDay;
    var end = (endDay === null || endDay === undefined || reversed) ? startDay : endDay;
    return {
      startDay: startDay,
      endDay: end,
      days: diffDays(startDay, end) + 1,
      reversed: reversed,
    };
  }

  /** Does this trial run on this day? Membership is asked per day rather than by
      expanding every trial into a list, so a typo'd year cannot allocate an
      array of forty thousand days. */
  function coversDay(span, day) {
    if (!span) return false;
    return day >= span.startDay && day <= span.endDay;
  }

  /** 1-based position of `day` within the span. Day 2 of 3. */
  function dayIndex(span, day) {
    if (!coversDay(span, day)) return null;
    return diffDays(span.startDay, day) + 1;
  }

  /** Is this the last day of a multi-day trial? That is when the debrief lands. */
  function isFinalDay(span, day) {
    return !!span && day === span.endDay;
  }

  /**
   * The day columns to render.
   *
   * Anchored at the given day: that day, tomorrow, the day after. Back seven
   * days, because yesterday matters for debriefs and it is cheap. Forward as far
   * as there is data.
   *
   * FORWARD IS CAPPED, which the spec does not ask for. A single mistyped year
   * would otherwise render tens of thousands of columns and hang the page, and
   * this view has already met three rows with dates entered backwards. Anything
   * past the cap is counted and reported rather than silently cut.
   */
  var WINDOW_BACK = 7;
  var WINDOW_FORWARD_CAP = 90;

  function dayColumns(anchorDay, spans) {
    var last = addDays(anchorDay, 2);          // always at least three columns
    var beyond = 0;
    var capDay = addDays(anchorDay, WINDOW_FORWARD_CAP);
    (spans || []).forEach(function (s) {
      if (!s) return;
      if (s.endDay > capDay) { beyond++; return; }
      if (s.endDay > last) last = s.endDay;
    });
    var days = [];
    for (var d = addDays(anchorDay, -WINDOW_BACK); d <= last; d = addDays(d, 1)) days.push(d);
    return { days: days, anchorDay: anchorDay, beyond: beyond };
  }

  return { parseDay: parseDay, isReversed: isReversed,
           addDays: addDays, diffDays: diffDays, trialSpan: trialSpan,
           coversDay: coversDay, dayIndex: dayIndex, isFinalDay: isFinalDay,
           dayColumns: dayColumns,
           WINDOW_BACK: WINDOW_BACK, WINDOW_FORWARD_CAP: WINDOW_FORWARD_CAP };
});
