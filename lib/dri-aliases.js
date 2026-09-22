(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DRI = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Maps the raw driName strings that appear in sheet column M to canonical people.
  // Matching is EXACT on the trimmed, case-folded raw string. It is deliberately
  // not fuzzy: a new spelling must surface as unresolved rather than silently
  // merge into the wrong person or silently split into a new one.
  //
  // Reviewed and confirmed by a person. Do not re-derive it. Three canonical
  // names carry surnames supplied afterwards from pool-health's concentration
  // list — Dillon Bogart, Advait Shroff, Erik Zhang — which changes what is
  // displayed, not what matches.
  var DRI_ALIASES = {
    // Confirmed against Ashby user records
    "Sam Henderson":        ["sam h", "fde-sam h", "sam henderson"],   // sam@poetic.com
    "Shantam Jain":         ["shantam", "fds-shantam j"],              // shantam@poetic.com
    "Shashank Pancharpula": ["shashank", "sales-shashank"],            // shashank@poetic.com
    "Ria Sharma":           ["fde-ria s"],                             // ria@poetic.com
    "Michael Zuccarino":    ["mz", "fde-mz"],                          // michael.zuccarino@poetic.com

    // Merged on string identity, not confirmed against an Ashby user
    "Dillon Bogart":        ["dillon", "fds-dillon"],

    // Single spelling, prefix stripped for display only
    "Neel":                 ["neel"],
    "Dan K":                ["dan k"],
    "Alex Morgan":          ["alex morgan"],
    "Advait Shroff":        ["advait"],
    "Erik Zhang":           ["fde-erik"],
    "Liam":                 ["fde-liam"],
  };

  /**
   * Values that mean "nobody is assigned", not "somebody called this".
   *
   * A COPY of bots/sheet-sync.config.js's BLANK_EQUIVALENTS and NOT_YET_MARKERS,
   * which is not the arrangement anyone would choose. It cannot be imported:
   * this module is served to the browser, and that config is a server-side
   * CommonJS module that pulls in the whole column map. Instead
   * test/dri-aliases.test.js asserts this list covers both of those, so the two
   * cannot drift without a test going red.
   */
  var UNASSIGNED_VALUES = [
    "", "-", "—", "?", "tbd", "tbc", "n/a", "na", "none", "pending",
    "not yet", "unassigned", "unknown",
  ];

  function fold(raw) {
    return String(raw == null ? "" : raw).trim().toLowerCase();
  }

  /* Built once. A linear scan of twelve people's spellings on every card on
     every day column is the kind of thing that is fine until it is not. */
  var LOOKUP = (function () {
    var out = {};
    for (var canonical in DRI_ALIASES) {
      if (!Object.prototype.hasOwnProperty.call(DRI_ALIASES, canonical)) continue;
      DRI_ALIASES[canonical].forEach(function (alias) { out[fold(alias)] = canonical; });
    }
    return out;
  })();

  /**
   * resolveDri(raw) -> { canonical, raw, matched, unassigned }
   *
   *   unassigned  nobody is on it. Its own state, never a person. This is the
   *               most actionable thing on the board, so it must not be able to
   *               arrive as a partner named "NOT YET" the way it nearly did in
   *               the sheet sync.
   *   matched     the spelling is one we know. canonical is the map key.
   *   otherwise   canonical is the raw string exactly as given. The name still
   *               works, it just carries a flag — a new spelling surfaces
   *               rather than being guessed at.
   */
  function resolveDri(raw) {
    var folded = fold(raw);
    if (UNASSIGNED_VALUES.indexOf(folded) >= 0) {
      return { canonical: null, raw: raw == null ? "" : String(raw),
               matched: false, unassigned: true };
    }
    var hit = LOOKUP[folded];
    if (hit) return { canonical: hit, raw: String(raw), matched: true, unassigned: false };
    return { canonical: String(raw).trim(), raw: String(raw), matched: false, unassigned: false };
  }

  /**
   * A guess at who an unresolved spelling might be, for suggestion text only.
   *
   * NEVER performs the merge. Strips a known role prefix and compares what is
   * left, so "fde-sam h" would suggest Sam Henderson — but an unresolved string
   * stays unresolved until a person adds it to the map above. The whole point
   * of exact matching is that a wrong merge is invisible and a missing one is
   * not.
   */
  function suggestFor(raw) {
    var folded = fold(raw).replace(/^(fde|fds|sales)-/, "");
    if (!folded) return null;
    var best = null;
    for (var canonical in DRI_ALIASES) {
      if (!Object.prototype.hasOwnProperty.call(DRI_ALIASES, canonical)) continue;
      var names = DRI_ALIASES[canonical].concat([canonical]);
      for (var i = 0; i < names.length; i++) {
        var n = fold(names[i]).replace(/^(fde|fds|sales)-/, "");
        if (n === folded || n.indexOf(folded) === 0 || folded.indexOf(n) === 0) {
          if (!best) best = canonical;
        }
      }
    }
    return best;
  }

  /**
   * The tracker's vocabulary of absence, applied to any field.
   *
   * Exported from this module because this is where the list lives, and a
   * fourth copy of it is worse than the slightly odd home. A desk reading
   * "TBD" is not a desk, for the same reason a partner called "NOT YET" is not
   * a partner.
   */
  function isUnset(v) { return UNASSIGNED_VALUES.indexOf(fold(v)) >= 0; }

  return {
    isUnset: isUnset,
    DRI_ALIASES: DRI_ALIASES,
    UNASSIGNED_VALUES: UNASSIGNED_VALUES,
    resolveDri: resolveDri,
    suggestFor: suggestFor,
  };
});
