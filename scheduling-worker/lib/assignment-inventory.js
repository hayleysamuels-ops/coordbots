(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./dri-aliases"));
  else root.INVENTORY = factory(root.DRI);
})(typeof self !== "undefined" ? self : this, function (DRI) {
  "use strict";

  /* SUPPLIED BY HAYLEY 11 Sep 2026 from the sheet's own dropdown lists.
     Not derived from usage history, deliberately: the sheet only contains
     desks, laptops and partners that have already been used, so deriving would
     make the suggester permanently blind to anything new. Both lists are
     confirmed complete. */

  /* ---- People ----------------------------------------------------------
     One entry per HUMAN. Several people cover more than one role, and a
     booking under either hat makes them unavailable under both, which is why
     availability is keyed on these ids and never on a sheet label. */
  /* emails SUPPLIED BY HAYLEY from Ashby user records, 14 Sep 2026, and not
     derived from the calendar. Inferring an identity from an attendee list is
     how you end up confidently wrong about who somebody is.

     A list, because eight people at Poetic hold both a @poetic.com and a
     @withforge.com address.

     mz and ria were confirmed from Ashby user records on 14 Sep and added.
     They were held back for a day because they had been seen only as calendar
     attendees, and inferring an identity from an attendee list is how you end
     up confidently wrong about who somebody is.

     Three entries have no address at all and stay empty: alex (Alex Morgan),
     joshv (Josh V) and platform (Sikan or Yasyf). The unresolved path handles
     them, which is the point of having one. */
  var PEOPLE = {
    liam:     { name: "Liam" , emails: ["liam@poetic.com"]},
    mz:       { name: "Michael Zuccarino", emails: ["michael.zuccarino@poetic.com"] },
    ria:      { name: "Ria Sharma", emails: ["ria@poetic.com", "ria@withforge.com"] },
    samh:     { name: "Sam Henderson" , emails: ["sam@poetic.com", "sam@withforge.com"]},
    tevon:    { name: "Tevon Strand-Brown", location: "NY" , emails: ["tevon@poetic.com"]},
    alex:     { name: "Alex Morgan",        location: "NY" , emails: []},
    erik:     { name: "Erik Zhang" , emails: ["erik@poetic.com"]},
    joshv:    { name: "Josh V", trainee: true , emails: []},
    advait:   { name: "Advait Shroff" , emails: ["advait@poetic.com"]},
    antony:   { name: "Antony Bello" , emails: ["antony@poetic.com", "antony@withforge.com"]},
    benm:     { name: "Ben Mittelberger" , emails: ["ben@poetic.com"]},
    dillon:   { name: "Dillon Bogart" , emails: ["dillon@poetic.com"]},
    shantam:  { name: "Shantam Jain" , emails: ["shantam@poetic.com", "shantam@withforge.com"]},
    shashank: { name: "Shashank Pancharpula" , emails: ["shashank@poetic.com"]},
    dan:      { name: "Dan K" , emails: ["dan@poetic.com"]},
    hima:     { name: "Hima Tammineedi" , emails: ["hima@poetic.com", "hima@withforge.com"]},
    neel:     { name: "Neel" , emails: ["neel@poetic.com", "neel@withforge.com"]},
    /* ONE bookable unit covering two humans, Sikan He and Yasyf Mohamedali.
       The sheet has a single label for both, so a booking does not record
       which of them it was. Modelling them separately would let the suggester
       claim Yasyf is free on a day Yasyf was actually working, which is worse
       than the vagueness. The card and every reason say "Sikan or Yasyf".
       If rotation between them ever matters the fix is upstream: two labels in
       the sheet, and this entry splits into two with nothing else changing. */
    /* Added 15 Sep from the live decline set, supplied by Hayley and NOT
       derived from the calendar. Both appear as declining attendees; neither
       partners work trials, so they carry no role and exist here only so a
       decline names a person instead of an address.
       aviv has no surname yet. A first name is what Hayley gave and is better
       than an address; inventing the rest would be worse than either. */
    courtney: { name: "Courtney Kara", emails: ["courtney@poetic.com"] },
    aviv:     { name: "Aviv", emails: ["aviv@poetic.com"] },
    platform: { name: "Sikan or Yasyf", pair: ["Sikan He", "Yasyf Mohamedali"] , emails: []},
  };

  /* ---- Role eligibility ------------------------------------------------
     sheetLabel is the exact string the sheet uses, so bot 10's values resolve.
     tier: 'primary' ranks normally. 'fallback' is only suggested when no
     primary in that role is free, and the suggestion is labelled as such.
     'trainee' is never suggested automatically. */
  var PARTNER_ROLES = {
    FDE: [
      { person: "liam",  sheetLabel: "FDE-Liam",          tier: "primary" },
      { person: "mz",    sheetLabel: "FDE-MZ",            tier: "primary" },
      { person: "ria",   sheetLabel: "FDE-Ria S",         tier: "primary" },
      { person: "samh",  sheetLabel: "FDE-Sam H",         tier: "primary" },
      { person: "tevon", sheetLabel: "FDE-Tevon SB (NY)", tier: "primary" },
      { person: "alex",  sheetLabel: "FDE-Alex (NY)",     tier: "primary" },
      { person: "erik",  sheetLabel: "FDE-Erik",          tier: "primary" },
      { person: "joshv", sheetLabel: "FDE(Training)-Josh V", tier: "trainee" },
      { person: "hima",  sheetLabel: "Hima",              tier: "fallback" },
      { person: "neel",  sheetLabel: "Neel",              tier: "fallback" },
    ],
    FDS: [
      { person: "advait",   sheetLabel: "FDS-Advait S",   tier: "primary" },
      { person: "antony",   sheetLabel: "FDS-Antony B",   tier: "primary" },
      { person: "benm",     sheetLabel: "FDS-Ben M",      tier: "primary" },
      { person: "dillon",   sheetLabel: "FDS-Dillon",     tier: "primary" },
      { person: "shantam",  sheetLabel: "FDS-Shantam J",  tier: "primary" },
      { person: "shashank", sheetLabel: "FDS-Shashank P", tier: "primary" },
      { person: "hima",     sheetLabel: "Hima",           tier: "fallback" },
      { person: "neel",     sheetLabel: "Neel",           tier: "fallback" },
    ],
    Sales: [
      { person: "antony",   sheetLabel: "Sales-Antony",   tier: "primary" },
      { person: "shantam",  sheetLabel: "Sales-Shantam",  tier: "primary" },
      { person: "shashank", sheetLabel: "Sales-Shashank", tier: "primary" },
      { person: "dan",      sheetLabel: "Sales-Dan",      tier: "primary" },
      { person: "hima",     sheetLabel: "Hima",           tier: "primary" },
      { person: "neel",     sheetLabel: "Neel",           tier: "primary" },
    ],
    Platform: [
      { person: "platform", sheetLabel: "Platform-Sikan/Yasyf", tier: "primary" },
    ],
  };

  var ROLES = ["FDE", "FDS", "Sales", "Platform"];

  /* ---- Desks -----------------------------------------------------------
     PHYSICAL location order, confirmed by Hayley. Adjacency is array index
     distance, so this order is load-bearing. If the room order is not 1,2,3,4
     then list them in room order and everything downstream stays correct. */
  var DESKS = ["SF-Desk 1", "SF-Desk 2", "SF-Desk 3", "SF-Desk 4"];

  /* TBD is a REQUEST, not an absence: a candidate reading TBD is asking for a
     suggestion. The No Desk values mean no desk is needed and are not gaps.
     The same sentinel now governs the sync, which used to read TBD as blank
     and therefore disagreed with this file about what one string meant. */
  var DESK_NEEDS_SUGGESTION = ["TBD"];
  var DESK_NOT_NEEDED = ["NY-No Desk", "Hyde House-No Desk"];

  /* ---- Laptops --------------------------------------------------------- */
  var LAPTOPS = [
    { id: "SF-Poetic 1", location: "SF" },
    { id: "SF-Poetic 2", location: "SF" },
    { id: "SF-Poetic 3", location: "SF", reservedFor: "Platform" },
    { id: "SF-Poetic 4", location: "SF" },
    { id: "SF-Poetic 7", location: "SF" },
    { id: "SF-Poetic 8", location: "SF" },
    { id: "NY-Poetic 5", location: "NY" },
    { id: "NY-Poetic 6", location: "NY" },
  ];

  /* ---- Lookups --------------------------------------------------------- */

  var fold = function (v) { return String(v == null ? "" : v).trim().toLowerCase(); };

  /**
   * Every sheet label, folded, to the person id behind it.
   *
   * THE POINT OF THIS MODULE. "Sales-Shantam" and "FDS-Shantam J" are one
   * human, and in the data they look like two. Every availability and
   * last-partnered question resolves through here first.
   */
  var LABEL_TO_PERSON = (function () {
    var out = {};
    ROLES.forEach(function (role) {
      (PARTNER_ROLES[role] || []).forEach(function (e) {
        out[fold(e.sheetLabel)] = e.person;
      });
    });
    return out;
  })();

  /** The same, for the canonical display names in lib/dri-aliases.js. */
  var NAME_TO_PERSON = (function () {
    var out = {};
    Object.keys(PEOPLE).forEach(function (id) { out[fold(PEOPLE[id].name)] = id; });
    return out;
  })();

  /**
   * Which person is this? Takes a sheet label, a canonical name, or any
   * spelling lib/dri-aliases.js knows.
   *
   * THE ALIAS MAP IS CONSULTED, and that is the whole point of this function
   * having been wrong. It handled sheet labels ("FDS-Advait S") and full
   * canonical names ("Advait Shroff"), which is not what the sheet mostly
   * contains: it contains short forms like "Advait", "MZ" and "Sam H". Nine of
   * twenty-five candidates with a partner resolved to null, so a third of the
   * recorded history did not exist as far as the rotation was concerned, and
   * "Has not partnered a recorded trial" was shown to a person as a fact about
   * somebody who had.
   *
   * Returns null when it is nobody we know. A null is REPORTED by the caller,
   * never read as an absence of history: a lookup that failed is not an answer.
   */
  /** Every configured address, normalised, to the person holding it. */
  var EMAIL_TO_PERSON = (function () {
    var out = {};
    Object.keys(PEOPLE).forEach(function (id) {
      (PEOPLE[id].emails || []).forEach(function (e) { out[normEmail(e)] = id; });
    });
    return out;
  })();

  /* Poetic's two domains only, matching lib/declines.js. Generalising this
     would merge candidates who share a local part on unrelated domains. */
  function normEmail(email) {
    var e = fold(email);
    var at = e.lastIndexOf("@");
    if (at < 0) return e;
    var local = e.slice(0, at), domain = e.slice(at + 1);
    return (domain === "poetic.com" || domain === "withforge.com")
      ? local + "@poetic.com" : e;
  }

  /**
   * Who holds this email address? Null when nobody does, which the caller
   * REPORTS rather than treating as nobody having declined.
   */
  function personForEmail(email) {
    var k = normEmail(email);
    return k ? (EMAIL_TO_PERSON[k] || null) : null;
  }

  /** Are any interviewer emails configured at all? */
  function hasEmails() {
    return Object.keys(EMAIL_TO_PERSON).length > 0;
  }

  function personFor(value) {
    var f = fold(value);
    if (!f) return null;
    var direct = LABEL_TO_PERSON[f] || NAME_TO_PERSON[f];
    if (direct) return direct;
    var r = DRI.resolveDri(value);
    if (r.unassigned || !r.matched) return null;
    return NAME_TO_PERSON[fold(r.canonical)] || null;
  }

  /** Every role entry for a person, across roles. */
  function rolesFor(personId) {
    var out = [];
    ROLES.forEach(function (role) {
      (PARTNER_ROLES[role] || []).forEach(function (e) {
        if (e.person === personId) out.push({ role: role, tier: e.tier, sheetLabel: e.sheetLabel });
      });
    });
    return out;
  }

  /** How a person is shown. Never one half of the Platform pair. */
  function displayName(personId) {
    var p = PEOPLE[personId];
    return p ? p.name : null;
  }

  function isDeskNeeded(value) { return DESK_NOT_NEEDED.indexOf(String(value || "").trim()) < 0; }
  function isDeskRequest(value) {
    var v = String(value == null ? "" : value).trim();
    if (!v) return true;                                   // empty means TBD
    return DESK_NEEDS_SUGGESTION.indexOf(v) >= 0;
  }
  function isKnownDesk(value) { return DESKS.indexOf(String(value || "").trim()) >= 0; }

  /* The laptop column carries the same sentinel the desk column does. Without
     this, TBD in the computer column is an id matching no laptop, which is
     indistinguishable from a machine nobody has heard of. */
  var LAPTOP_NEEDS_SUGGESTION = ["TBD"];
  function isLaptopRequest(value) {
    var v = String(value == null ? "" : value).trim();
    if (!v) return true;
    return LAPTOP_NEEDS_SUGGESTION.indexOf(v) >= 0;
  }
  function isKnownLaptop(value) { return !!laptopFor(value); }
  function laptopFor(id) {
    var f = fold(id);
    for (var i = 0; i < LAPTOPS.length; i++) if (fold(LAPTOPS[i].id) === f) return LAPTOPS[i];
    return null;
  }

  return {
    PEOPLE: PEOPLE, PARTNER_ROLES: PARTNER_ROLES, ROLES: ROLES,
    DESKS: DESKS, DESK_NEEDS_SUGGESTION: DESK_NEEDS_SUGGESTION,
    DESK_NOT_NEEDED: DESK_NOT_NEEDED, LAPTOPS: LAPTOPS,
    personFor: personFor, rolesFor: rolesFor, displayName: displayName,
    personForEmail: personForEmail, hasEmails: hasEmails, normEmail: normEmail,
    isDeskNeeded: isDeskNeeded, isDeskRequest: isDeskRequest,
    isKnownDesk: isKnownDesk, laptopFor: laptopFor,
    LAPTOP_NEEDS_SUGGESTION: LAPTOP_NEEDS_SUGGESTION,
    isLaptopRequest: isLaptopRequest, isKnownLaptop: isKnownLaptop,
  };
});
