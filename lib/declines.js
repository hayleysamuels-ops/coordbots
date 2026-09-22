(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DECLINES = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * Room and interviewer declines on work trial sessions.
   *
   * Reads a SNAPSHOT in the shape of fixtures/poetic-interviews-*.json, which
   * is real production data captured from the live calendar. That shape is the
   * contract: when a live feed lands it produces the same thing and this file
   * does not change.
   *
   * Read-only, and touches nothing else. It does not feed the readiness sweep,
   * the suggester, the day model or the trial cards.
   */

  /* Config, not inline, so a new laptop account that does not match shows up
     as a number the rail reports rather than as silence. */
  var MACHINE_PATTERN = /^(forgeaccount|poeticaccount)\d+@/i;
  var ROOM_DOMAIN = /@resource\.calendar\.google\.com$/i;

  /* Poetic's two domains ONLY. Eight local parts appear under both, and
     antony@withforge.com is antony@poetic.com. This is deliberately not
     generalised: 185 attendees in the fixture are candidates, and collapsing
     gmail.com by local part would merge strangers. */
  var POETIC_DOMAINS = ["poetic.com", "withforge.com"];

  function lower(v) { return String(v == null ? "" : v).trim().toLowerCase(); }

  /** Two addresses for one person become one key. Everything else is itself. */
  function normaliseAddress(email) {
    var e = lower(email);
    var at = e.lastIndexOf("@");
    if (at < 0) return e;
    var local = e.slice(0, at), domain = e.slice(at + 1);
    if (POETIC_DOMAINS.indexOf(domain) >= 0) return local + "@poetic.com";
    return e;
  }

  function isRoom(a) { return a.resource === true || ROOM_DOMAIN.test(lower(a.email)); }

  /** An address on one of Poetic's own domains. */
  function isInternal(email) {
    var e = lower(email);
    var at = e.lastIndexOf("@");
    return at >= 0 && POETIC_DOMAINS.indexOf(e.slice(at + 1)) >= 0;
  }
  function isMachine(a) { return MACHINE_PATTERN.test(lower(a.email)); }

  /** room, machine or human. Decided before anything is counted. */
  function classify(a) {
    if (isRoom(a)) return "room";
    if (isMachine(a)) return "machine";
    return "human";
  }

  /**
   * Every decline in the snapshot, grouped by session.
   *
   *   snapshot        the captured calendar
   *   eventIndex      { <ashbyEventId>: { id, name } } for tracker candidates.
   *                   Empty is a legitimate state: the tracker does not expose
   *                   interview event ids yet, so everything is unmatched.
   *   personForEmail  (address) -> person id or null. Null is REPORTED.
   *   mainPartnerFor  (candidateId) -> person id or null
   *   todayDay        calendar integer; sessions before today drop off
   *
   * Returns entries ordered by session start, soonest first.
   */
  function readDeclines(opts) {
    opts = opts || {};
    var snapshot = opts.snapshot || { events: [] };
    var index = opts.eventIndex || {};
    var personForEmail = opts.personForEmail || function () { return null; };
    var mainPartnerFor = opts.mainPartnerFor || function () { return null; };
    var dayOf = opts.dayOf || function () { return null; };
    var today = opts.todayDay === undefined ? null : opts.todayDay;

    var entries = [], suppressed = 0, unresolved = {}, rooms = 0, humans = 0;

    (snapshot.events || []).forEach(function (ev) {
      var declines = [], unresolvedHere = [];
      (ev.attendees || []).forEach(function (a) {
        if (a.responseStatus !== "declined") return;
        var kind = classify(a);
        if (kind === "machine") { suppressed++; return; }
        if (kind === "room") {
          rooms++;
          declines.push({ kind: "room", label: a.displayName || a.email,
                          email: a.email, comment: a.comment || null });
          return;
        }
        humans++;
        var personId = personForEmail(a.email);
        /* THE CANDIDATE TIER IS AN INFERENCE FROM THE DOMAIN, and it is worth
           naming as one. The tracker holds no candidate email addresses, so
           "the candidate declined" is really "somebody outside Poetic's two
           domains declined a session that is about a candidate". In the
           12-day capture that is 1 of 16 human declines and it is Preston
           Vaughn, which is right. An external INTERVIEWER would be called a
           candidate by this rule, and the fix for that is candidate emails,
           not a cleverer guess. */
        var external = !isInternal(a.email);
        if (!personId && !external) unresolvedHere.push(normaliseAddress(a.email));
        declines.push({ kind: external ? "candidate" : "human", personId: personId,
                        external: external,
                        label: a.displayName || a.email, email: a.email,
                        comment: a.comment || null });
      });
      if (!declines.length) return;

      var match = ev.ashbyEventId ? index[ev.ashbyEventId] || null : null;
      /* Past sessions drop off at end of day. A decline on a session that has
         already happened is history, not something to act on. */
      var day = dayOf(ev.start);
      /* Dropped before the unresolved addresses are merged: naming somebody in
         a notice about a session the rail does not show sends a reader looking
         for an entry that is not there. */
      if (today !== null && day !== null && day < today) return;
      unresolvedHere.forEach(function (a) { unresolved[a] = true; });

      /* Which of the human declines is the main partner, if we can tell. */
      var partnerId = match ? mainPartnerFor(match.id) : null;
      declines.forEach(function (d) {
        if (d.kind === "human" && partnerId && d.personId === partnerId) d.kind = "mainPartner";
      });

      entries.push({
        eventId: ev.id,
        ashbyEventId: ev.ashbyEventId || null,
        candidateId: match ? match.id : null,
        candidateName: match ? match.name : null,
        summary: ev.summary || "",
        start: ev.start,
        end: ev.end,
        day: day,
        declines: declines,
      });
    });

    entries.sort(function (a, b) {
      return String(a.start).localeCompare(String(b.start)) ||
             String(a.eventId).localeCompare(String(b.eventId));
    });

    return {
      entries: entries,
      suppressed: suppressed,
      roomCount: rooms,
      humanCount: humans,
      /* Addresses that resolved to nobody. Reported, never dropped: this is the
         personFor alias bug in a new place. */
      unresolved: Object.keys(unresolved).sort(),
      capturedAt: snapshot.capturedAt || null,
      source: snapshot.calendarSummary || null,
      /* Whether the index could attribute anything at all. */
      matchedCount: entries.filter(function (e) { return e.candidateId; }).length,
      indexSize: Object.keys(index).length,
    };
  }

  return {
    MACHINE_PATTERN: MACHINE_PATTERN,
    POETIC_DOMAINS: POETIC_DOMAINS,
    normaliseAddress: normaliseAddress,
    classify: classify,
    isRoom: isRoom,
    isInternal: isInternal,
    isMachine: isMachine,
    readDeclines: readDeclines,
  };
});
