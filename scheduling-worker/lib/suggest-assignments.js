(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./dateday"), require("./assignment-inventory"));
  } else {
    root.SUGGEST = factory(root.DATEDAY, root.INVENTORY);
  }
})(typeof self !== "undefined" ? self : this, function (DATEDAY, INV) {
  "use strict";

  /**
   * Propose a partner, a desk and a laptop for trials that have not started.
   *
   * PROPOSES ONLY. Nothing here writes anything, and there is deliberately no
   * accept path in this module: the sheet-versus-accepted-value question in
   * §2.8 of the spec is unresolved, and building accept before it is decided
   * would bake in an answer nobody chose.
   *
   * Everything takes a prepared list of trials rather than reading candidates,
   * so it is testable without a DOM and cannot drift from the calendar: the
   * caller builds each trial's span with the same DATEDAY.trialSpan the bars
   * use, and overlap is the same coversDay.
   */

  /* Trials overlap when any day is covered by both. Same rule as the board. */
  function overlaps(a, b) {
    if (!a || !b) return false;
    return a.startDay <= b.endDay && b.startDay <= a.endDay;
  }

  /** Days of a span that fall strictly before `day`, for "already finished". */
  function finishedBefore(span, day) {
    return span && span.endDay < day;
  }

  /**
   * The partner suggestion.
   *
   *   role        the candidate's role, hard filtered. No cross-role fallback.
   *   span        the candidate's own trial span
   *   today       calendar integer, for deciding what has finished
   *   trials      [{ span, personId }] every OTHER trial with a partner
   *
   * Availability and last-partnered are keyed on personId, never on a label.
   * Shantam booked as Sales-Shantam on the 14th is unavailable as
   * FDS-Shantam J on the 14th, and in the data those look like two people.
   */
  function suggestPartner(opts) {
    var role = opts.role, span = opts.span, today = opts.today;
    var trials = opts.trials || [];
    var roster = (INV.PARTNER_ROLES[role] || []);
    /* Partner names on the board that resolve to nobody. Their trials are
       invisible to the rotation, so any claim about who has or has not
       partnered may be wrong, and the claim says so instead of pretending.
       A lookup that failed is not an answer. */
    var unresolved = (opts.unresolved || []).filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (!roster.length) {
      return { ok: false, reason: "No partner list for " + (role || "an unknown role") + "." };
    }

    /* Busy is per person, computed once. */
    var busy = {}, heldByProposal = {};
    trials.forEach(function (t) {
      if (t.personId && overlaps(t.span, span)) {
        busy[t.personId] = true;
        if (t.proposal) heldByProposal[t.personId] = t.name || "another trial";
      }
    });

    /* When this person is most recently committed to a trial, in any role.
       COMMITTED, NOT COMPLETED. §2.3.3 originally said "a trial that has
       already finished", which drew the line at past versus future and put it
       in the wrong place: a confirmed booking for next month is a fact about
       who is spoken for, and ignoring it meant a partner already booked for
       1 Oct still read as "has not partnered a recorded trial" while being
       offered for 17 Sep. Amended 11 Sep 2026 to committed versus not.
       A PROPOSAL still counts for nothing, because nobody has agreed to it. */
    var lastDone = {}, recent30 = {};
    var from = DATEDAY.addDays(span.startDay, -30);
    trials.forEach(function (t) {
      if (!t.personId || !t.span) return;
      /* A PROPOSAL IS NOT USE. It blocks an overlapping day, because two
         trials at once is impossible, and it does nothing else. Letting one
         count toward "last partnered" or the 30-day tie-break would make the
         board rotate around work nobody has agreed to, and would mean two
         candidates who overlap nobody could not be offered the same person,
         which is a perfectly good answer. §2.3.3 is explicit that this counts
         a trial that has already finished. */
      if (t.proposal) return;
      if (lastDone[t.personId] === undefined || t.span.endDay > lastDone[t.personId]) {
        lastDone[t.personId] = t.span.endDay;
      }
      if (t.span.endDay >= from && t.span.endDay < span.startDay) {
        recent30[t.personId] = (recent30[t.personId] || 0) + 1;
      }
    });

    function rank(entries) {
      return entries.slice().sort(function (a, b) {
        /* Never partnered ranks as infinitely stale, so they go first. */
        var la = lastDone[a.person], lb = lastDone[b.person];
        var na = la === undefined, nb = lb === undefined;
        if (na !== nb) return na ? -1 : 1;
        if (!na && la !== lb) return la - lb;
        var ra = recent30[a.person] || 0, rb = recent30[b.person] || 0;
        if (ra !== rb) return ra - rb;
        return String(INV.displayName(a.person)).localeCompare(String(INV.displayName(b.person)));
      });
    }

    var free = roster.filter(function (e) {
      if (e.tier === "trainee") return false;   // never suggested automatically
      return !busy[e.person];
    });
    var primary = rank(free.filter(function (e) { return e.tier === "primary"; }));
    var fallback = rank(free.filter(function (e) { return e.tier === "fallback"; }));

    var pick = primary[0] || fallback[0] || null;
    if (!pick) {
      /* Say which of the blockers are only proposals. "No partner free" is
         true against recorded data and still leaves a reader looking for the
         booking that took them. */
      var byProposal = roster.filter(function (e) {
        return e.tier !== "trainee" && heldByProposal[e.person];
      }).map(function (e) { return heldByProposal[e.person]; });
      return { ok: false,
        reason: "No " + role + " partner free on these dates." +
          (byProposal.length
            ? " " + countPhrase(byProposal.length, "is", "are") + " suggested for " +
              listNames(byProposal) + ", also only a proposal."
            : "") };
    }
    var isFallback = !primary[0];
    var name = INV.displayName(pick.person);
    var last = lastDone[pick.person];

    return {
      ok: true,
      value: pick.sheetLabel,
      display: name,
      personId: pick.person,
      tier: pick.tier,
      fallback: isFallback,
      reason: (isFallback ? "No " + role + " partner free, " + name + " can cover. " : "") +
        (last === undefined
          ? "No recorded trial for this person." + incompleteNote(unresolved)
          : last < today
            ? "Last partnered " + fmtDay(last) + "."
            /* Not "last partnered": it has not happened yet. */
            : "Already booked through " + fmtDay(last) + ".") +
        " No overlapping trial recorded on these dates." +
        alsoProposedFor(pick.person, trials),
    };
  }

  /**
   * "Why does this say Advait again?"
   *
   * Because the same person is the right answer for two trials that do not
   * clash. Saying so answers the question without pretending the rotation
   * moved, which is the same honesty the desk reason gained when it started
   * naming a neighbour that is only a proposal.
   */
  function alsoProposedFor(personId, trials) {
    var others = (trials || []).filter(function (t) {
      return t.proposal && t.personId === personId && t.name;
    });
    if (!others.length) return "";
    return " Also proposed for " + listNames(others.map(function (t) { return t.name; })) +
      " on " + listNames(others.map(function (t) { return fmtDay(t.span.startDay); })) +
      ", which " + (others.length === 1 ? "is" : "are") + " only " +
      (others.length === 1 ? "a proposal" : "proposals") + ".";
  }

  /**
   * The laptop suggestion.
   *
   * Filters on location and NEVER guesses. An unknown location returns no
   * suggestion and says so: most candidates are SF, and defaulting to SF would
   * hand somebody in New York a laptop that is three thousand miles away.
   */
  function suggestLaptop(opts) {
    var span = opts.span, today = opts.today, role = opts.role;
    var location = String(opts.location == null ? "" : opts.location).trim();
    var trials = opts.trials || [];

    if (!location) {
      return { ok: false, reason: "Location unknown, so no laptop is suggested." };
    }
    var pool = INV.LAPTOPS.filter(function (l) {
      if (l.location !== location) return false;
      /* SF-Poetic 3 is reserved for Platform and is out of everyone else's pool. */
      if (l.reservedFor && l.reservedFor !== role) return false;
      return true;
    });
    if (!pool.length) {
      return { ok: false, reason: "No laptop listed for " + location + "." };
    }

    var busy = {}, lastDone = {}, heldByProposal = {};
    trials.forEach(function (t) {
      if (!t.laptop) return;
      if (overlaps(t.span, span)) {
        busy[t.laptop] = true;                                // includes future bookings
        if (t.proposal) heldByProposal[t.laptop] = t.name || "another trial";
      }
      if (t.proposal) return;                                 // a proposal is not use
      if (finishedBefore(t.span, today)) {
        if (lastDone[t.laptop] === undefined || t.span.endDay > lastDone[t.laptop]) {
          lastDone[t.laptop] = t.span.endDay;
        }
      }
    });

    var free = pool.filter(function (l) { return !busy[l.id]; });
    if (!free.length) {
      var held = pool.filter(function (l) { return heldByProposal[l.id]; })
        .map(function (l) { return heldByProposal[l.id]; });
      return { ok: false,
        reason: "No " + location + " laptop free on " + range(span) + "." +
          (held.length
            ? " " + countPhrase(held.length, "is", "are") + " suggested for " +
              listNames(held) + ", also only a proposal."
            : "") };
    }
    free.sort(function (a, b) {
      var la = lastDone[a.id], lb = lastDone[b.id];
      var na = la === undefined, nb = lb === undefined;
      if (na !== nb) return na ? -1 : 1;
      if (!na && la !== lb) return la - lb;
      return INV.LAPTOPS.indexOf(a) - INV.LAPTOPS.indexOf(b);   // array order
    });
    var pick = free[0];
    var last = lastDone[pick.id];
    return {
      ok: true, value: pick.id,
      reason: (last === undefined ? "Not used on any recorded trial."
                                  : "Not used since " + fmtDay(last) + ".") +
        " No overlapping booking recorded on these dates.",
    };
  }

  /**
   * The desk suggestion.
   *
   * Spacing is a PREFERENCE, not a constraint. Four desks and three same-day
   * trials cannot all be non-adjacent, so when the best option sits next to an
   * occupied desk it is still suggested and the adjacency is said out loud.
   * Saying it is the point; silently producing an answer that looks spaced
   * would be worse than the crowding.
   */
  function suggestDesk(opts) {
    var span = opts.span, today = opts.today;
    var trials = opts.trials || [];
    var current = opts.current;

    if (!INV.isDeskNeeded(current)) {
      return { ok: false, needed: false,
               reason: String(current).trim() + " needs no desk." };
    }
    if (!INV.DESKS.length) {
      return { ok: false, reason: "No desks listed." };
    }

    var occupiedBy = {}, lastDone = {};
    trials.forEach(function (t) {
      if (!t.desk || !INV.isKnownDesk(t.desk)) return;
      if (overlaps(t.span, span)) occupiedBy[t.desk] = t;   // a booking OR a proposal
      if (t.proposal) return;                                 // a proposal is not use
      if (finishedBefore(t.span, today)) {
        if (lastDone[t.desk] === undefined || t.span.endDay > lastDone[t.desk]) {
          lastDone[t.desk] = t.span.endDay;
        }
      }
    });

    var free = INV.DESKS.filter(function (d) { return !occupiedBy[d]; });
    if (!free.length) {
      var heldD = Object.keys(occupiedBy).filter(function (d) { return occupiedBy[d].proposal; })
        .map(function (d) { return occupiedBy[d].name || "another trial"; });
      return { ok: false,
        reason: "No desk free on " + range(span) + "." +
          (heldD.length
            ? " " + countPhrase(heldD.length, "is", "are") + " suggested for " +
              listNames(heldD) + ", also only a proposal."
            : "") };
    }

    var occupiedIdx = Object.keys(occupiedBy).map(function (d) { return INV.DESKS.indexOf(d); });
    function spacing(desk) {
      var i = INV.DESKS.indexOf(desk);
      if (!occupiedIdx.length) return Infinity;
      return occupiedIdx.reduce(function (min, j) {
        return Math.min(min, Math.abs(i - j));
      }, Infinity);
    }

    free.sort(function (a, b) {
      var sa = spacing(a), sb = spacing(b);
      if (sa !== sb) return sb - sa;                   // maximum spacing first
      var la = lastDone[a], lb = lastDone[b];
      var na = la === undefined, nb = lb === undefined;
      if (na !== nb) return na ? -1 : 1;
      if (!na && la !== lb) return la - lb;
      return INV.DESKS.indexOf(a) - INV.DESKS.indexOf(b);
    });

    var pick = free[0];
    var gap = spacing(pick);
    var last = lastDone[pick];
    var base = last === undefined ? "Not used on any recorded trial."
                                  : "Not used since " + fmtDay(last) + ".";

    var out = { ok: true, value: pick, spacing: gap === Infinity ? null : gap, reason: base };
    if (gap === Infinity) {
      out.reason = base + " No other desk is taken or suggested on these dates.";
      return out;
    }
    /* Which neighbour, and is it the same role? That is the case Hayley cares
       most about, so it is a distinct label rather than a softer wording. */
    var i = INV.DESKS.indexOf(pick);
    var nearest = null;
    Object.keys(occupiedBy).forEach(function (d) {
      var dist = Math.abs(INV.DESKS.indexOf(d) - i);
      if (dist === gap && !nearest) nearest = occupiedBy[d];
    });
    var who = nearest && nearest.name ? nearest.name : "another trial";
    /* Whether the neighbour is a booking or another proposal changes what a
       reader should do about it, so it is said rather than implied. */
    var alsoProposed = nearest && nearest.proposal ? ", also only a proposal" : "";
    if (gap === 1) {
      out.adjacent = true;
      out.sameRole = !!(nearest && opts.role && nearest.role === opts.role);
      out.proposedNeighbour = !!(nearest && nearest.proposal);
      out.reason = base + " Next to " + who +
        (out.sameRole ? ", who is also " + opts.role : "") + alsoProposed + "." +
        " Only " + INV.DESKS.length + " desks, so spacing was not possible.";
    } else {
      out.proposedNeighbour = !!(nearest && nearest.proposal);
      out.reason = base + " " + gap + " desks from " + who + alsoProposed + ".";
    }
    return out;
  }

  /* ---- copy helpers ----
     Facts only. "Free" would read as a real availability check, and nothing
     here looks at anybody's calendar; it reads what the tracker records. */
  function fmtDay(day) {
    if (day == null) return "";
    var d = new Date(Date.UTC(Math.floor(day / 10000), (Math.floor(day / 100) % 100) - 1, day % 100));
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  }
  /**
   * Said whenever history is known to be incomplete.
   *
   * "Has not partnered a recorded trial" was shown about somebody who had,
   * because their name did not resolve and their trial silently disappeared.
   * The sentence is only safe when everything on the board resolved.
   */
  function incompleteNote(unresolved) {
    if (!unresolved || !unresolved.length) return "";
    return " " + countPhrase(unresolved.length, "partner name", "partner names") +
      " on the board (" + listNames(unresolved) + ") " +
      (unresolved.length === 1 ? "does" : "do") +
      " not match anybody, so recorded history may be incomplete.";
  }

  function countPhrase(n, one, many) { return n === 1 ? "One " + one : n + " " + many; }
  function listNames(names) {
    var u = names.filter(function (v, i) { return names.indexOf(v) === i; });
    if (u.length === 1) return u[0];
    if (u.length === 2) return u[0] + " and " + u[1];
    return u.slice(0, -1).join(", ") + " and " + u[u.length - 1];
  }

  function range(span) {
    if (!span) return "";
    return span.days > 1 ? fmtDay(span.startDay) + " to " + fmtDay(span.endDay)
                         : fmtDay(span.startDay);
  }

  return {
    overlaps: overlaps,
    suggestPartner: suggestPartner,
    suggestLaptop: suggestLaptop,
    suggestDesk: suggestDesk,
    _internal: { fmtDay: fmtDay, range: range, finishedBefore: finishedBefore },
  };
});
