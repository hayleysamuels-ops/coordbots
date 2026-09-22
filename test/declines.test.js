"use strict";
/**
 * The declines reader, tested against real recorded data.
 *
 * fixtures/poetic-interviews-2026-09-07_to_09-18.json is a real capture of the
 * live Poetic Interviews calendar on 14 Sep 2026, 477 events over 12 days. Not
 * synthetic, deliberately: two defects this week survived because a harness
 * supplied something the browser never had, and a table I presented as
 * production was built from candidate objects I had written inline.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const D = require("../lib/declines");
const INV = require("../lib/assignment-inventory");

const SNAPSHOT = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "fixtures", "poetic-interviews-2026-09-07_to_09-18.json"), "utf8"));

const read = (o) => D.readDeclines(Object.assign({ snapshot: SNAPSHOT }, o || {}));

const dayOfIso = (iso) => Number(new Intl.DateTimeFormat("en-CA",
  { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" })
  .format(new Date(iso)).replace(/-/g, ""));

/** An event the rail will actually show on 14 Sept: has an id, a decline that
    survives classification, and a session that has not already happened. */
const upcomingWithDecline = SNAPSHOT.events.find((e) => e.ashbyEventId &&
  dayOfIso(e.start) >= 20260914 &&
  (e.attendees || []).some((a) => a.responseStatus === "declined" && D.classify(a) !== "machine"));

test("the fixture is the real capture, and says so", () => {
  assert.equal(SNAPSHOT.events.length, 477);
  assert.match(SNAPSHOT.note, /REAL production data/);
  assert.equal(SNAPSHOT.timeZone, "America/Los_Angeles");
  assert.equal(SNAPSHOT.window.start, "2026-09-07");
});

/* ---------------- classification, the three counts ---------------- */

test("exactly 64 machine declines are suppressed, and the count is reported", () => {
  // A watcher that does not filter these is 75 percent noise on day one.
  const r = read();
  assert.equal(r.suppressed, 64);
  assert.ok(r.suppressed > r.humanCount + r.roomCount, "which is why it is reported, not hidden");
});

test("exactly 16 human declines surface", () => {
  assert.equal(read().humanCount, 16);
});

test("exactly 5 room declines surface, and they are the five", () => {
  const r = read();
  assert.equal(r.roomCount, 5);
  const rooms = [];
  r.entries.forEach((e) => e.declines.forEach((d) => {
    if (d.kind === "room") rooms.push({ summary: e.summary, room: d.label, start: e.start });
  }));
  assert.equal(rooms.length, 5);
  // Four of these are live problems. This feature found them.
  const names = rooms.map((x) => x.summary);
  assert.ok(names.some((n) => /Danni El Tayeb/.test(n) && /Customer Exec Presentation/.test(n)));
  assert.ok(names.some((n) => /Ari Blumkin/.test(n) && /Debrief/.test(n)));
  assert.equal(names.filter((n) => /Tyler Robb/.test(n)).length, 3, "three on Tyler Robb");
  // the same two rooms throughout
  assert.deepEqual([...new Set(rooms.map((x) => x.room))].sort(),
    ["1 Beach-3-Invariant (6) [Zoom]", "1 Beach-3-Summit (14) [Zoom]"]);
});

test("the machine pattern is config, so a new laptop account is a number not silence", () => {
  assert.ok(D.MACHINE_PATTERN instanceof RegExp);
  assert.equal(D.isMachine({ email: "forgeaccount1@poetic.com" }), true);
  assert.equal(D.isMachine({ email: "poeticaccount8@poetic.com" }), true);
  assert.equal(D.isMachine({ email: "forgeaccount99@poetic.com" }), true, "a new one still matches");
  assert.equal(D.isMachine({ email: "newlaptop3@poetic.com" }), false,
    "and one that does not match is a human, so it surfaces rather than vanishing");
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "declines.js"), "utf8");
  assert.match(src, /var MACHINE_PATTERN = /, "named, not inline at the call site");
});

test("a room is a room by either signal", () => {
  assert.equal(D.classify({ resource: true, email: "x@poetic.com" }), "room");
  assert.equal(D.classify({ email: "abc@resource.calendar.google.com" }), "room");
  assert.equal(D.classify({ email: "ben@poetic.com" }), "human");
});

/* ---------------- identity ---------------- */

test("the two Poetic domains are one person", () => {
  assert.equal(D.normaliseAddress("antony@withforge.com"), D.normaliseAddress("antony@poetic.com"));
  assert.equal(INV.personForEmail("antony@withforge.com"), "antony");
  assert.equal(INV.personForEmail("antony@poetic.com"), "antony");
  assert.equal(INV.personForEmail("ANTONY@WithForge.com"), "antony", "case folded");
});

test("a candidate address is never collapsed with a Poetic one", () => {
  // 185 attendees in the fixture are candidates. Generalising the local-part
  // rule would merge strangers.
  assert.notEqual(D.normaliseAddress("sam@gmail.com"), D.normaliseAddress("sam@poetic.com"));
  assert.equal(D.normaliseAddress("sam@gmail.com"), "sam@gmail.com");
  assert.equal(INV.personForEmail("sam@gmail.com"), null);
  assert.deepEqual(D.POETIC_DOMAINS, ["poetic.com", "withforge.com"], "two domains, not a rule");
});

test("an address that resolves to nobody is reported, never dropped", () => {
  // The personFor alias bug in a new place.
  const r = read({ personForEmail: INV.personForEmail });
  assert.ok(r.unresolved.length, "the fixture has attendees we cannot name");
  assert.equal(r.humanCount, 16, "and every one still counted");
  assert.deepEqual(r.unresolved, r.unresolved.slice().sort(), "listed, in a stable order");
  for (const a of r.unresolved) assert.equal(INV.personForEmail(a), null);
});

test("the people with no address at all stay on the unresolved path", () => {
  // mz and ria were held back for a day and confirmed from Ashby records on
  // 14 Sep. These three have no address to confirm.
  for (const id of ["alex", "joshv", "platform"]) {
    assert.deepEqual(INV.PEOPLE[id].emails, [], id + " has no address at all");
  }
  assert.equal(INV.personForEmail("alex@poetic.com"), null,
    "and a plausible guess at one resolves to nobody, deliberately");
  assert.equal(INV.hasEmails(), true);
  assert.equal(Object.keys(INV.PEOPLE).filter((k) => (INV.PEOPLE[k].emails || []).length).length, 17,
    "fifteen partners plus courtney and aviv, who decline but do not partner");
});

test("mz and ria resolve now that Ashby confirmed them", () => {
  assert.equal(INV.personForEmail("michael.zuccarino@poetic.com"), "mz");
  assert.equal(INV.personForEmail("ria@poetic.com"), "ria");
  assert.equal(INV.personForEmail("ria@withforge.com"), "ria", "both domains, one person");
});

/* ---------------- matching ---------------- */

test("an event whose ashbyEventId matches nothing is unmatched, not dropped", () => {
  const r = read();
  assert.equal(r.indexSize, 0, "no index supplied, so nothing can match");
  assert.equal(r.matchedCount, 0);
  assert.ok(r.entries.length, "and every session with a decline is still listed");
  r.entries.forEach((e) => {
    assert.equal(e.candidateName, null);
    assert.ok(e.summary, "with its summary, so a decline we cannot attribute is still a decline");
  });
});

test("a supplied index does attribute the session", () => {
  // A decline that SURVIVES classification: a machine decline is suppressed,
  // so an event whose only decline is one produces no entry to attribute.
  const withId = SNAPSHOT.events.find((e) => e.ashbyEventId &&
    (e.attendees || []).some((a) => a.responseStatus === "declined" &&
      D.classify(a) !== "machine"));
  assert.ok(withId, "the fixture has one");
  const r = read({ eventIndex: { [withId.ashbyEventId]: { id: "c1", name: "Ari Blumkin" } } });
  const hit = r.entries.find((e) => e.ashbyEventId === withId.ashbyEventId);
  assert.equal(hit.candidateId, "c1");
  assert.equal(hit.candidateName, "Ari Blumkin");
  assert.equal(r.matchedCount, 1);
});

test("nothing is matched on the candidate name in the summary", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "declines.js"), "utf8");
  assert.equal(/summary.*match|parseSummary|nameFrom/i.test(src), false,
    "the summaries look parseable and are not reliable enough to hang this on");
  assert.match(src, /index\[ev\.ashbyEventId\]/, "ashbyEventId only");
});

/* ---------------- only declines ---------------- */

test("an accepted, tentative or needsAction attendee never appears", () => {
  const r = read();
  const statuses = new Set();
  SNAPSHOT.events.forEach((e) => (e.attendees || []).forEach((a) => statuses.add(a.responseStatus)));
  assert.ok(statuses.has("accepted") && statuses.has("needsAction"),
    "the fixture contains them, so excluding them means something");
  assert.equal(r.roomCount + r.humanCount,
    r.entries.reduce((n, e) => n + e.declines.length, 0), "only declines are carried");
});

test("sessions are ordered soonest first", () => {
  const starts = read().entries.map((e) => e.start);
  assert.deepEqual(starts, starts.slice().sort(), "by session start");
});

test("a session in the past drops off", () => {
  const dayOf = (iso) => {
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
    return Number(d.replace(/-/g, ""));
  };
  const all = read({ dayOf }).entries.length;
  const from14 = read({ dayOf, todayDay: 20260914 }).entries.length;
  assert.ok(from14 < all, "the 9 Sept room decline is behind us");
  assert.ok(from14 > 0, "and the upcoming ones remain");
  read({ dayOf, todayDay: 20260914 }).entries.forEach((e) =>
    assert.ok(e.day >= 20260914, "nothing before today"));
});

/* ---------------- main partner ---------------- */

test("a main partner decline is distinguished from any other human one", () => {
  const withId = SNAPSHOT.events.find((e) => e.ashbyEventId &&
    (e.attendees || []).some((a) => a.responseStatus === "declined" &&
      D.classify(a) === "human"));
  assert.ok(withId);
  const who = withId.attendees.find((a) => a.responseStatus === "declined" && D.classify(a) === "human");
  const r = read({
    eventIndex: { [withId.ashbyEventId]: { id: "c1", name: "Someone" } },
    personForEmail: () => "neel",
    mainPartnerFor: () => "neel",
  });
  const hit = r.entries.find((e) => e.ashbyEventId === withId.ashbyEventId);
  assert.ok(hit.declines.some((d) => d.kind === "mainPartner"),
    "resolved to the candidate's DRI, so it is the main partner declining");
  assert.ok(who.email);
});

test("with no partner known, a human decline stays a plain human decline", () => {
  const r = read({ personForEmail: INV.personForEmail });
  const kinds = new Set();
  r.entries.forEach((e) => e.declines.forEach((d) => kinds.add(d.kind)));
  assert.ok(kinds.has("human"));
  assert.equal(kinds.has("mainPartner"), false,
    "no event index, so no candidate, so no DRI to compare against");
});

test("a comment on a decline is carried", () => {
  // None in the fixture do, so this path needs a test rather than an example.
  const none = read().entries.every((e) => e.declines.every((d) => d.comment === null));
  assert.equal(none, true, "confirming the fixture has none");
  const synthetic = { events: [{ id: "e1", summary: "S", start: "2026-09-20T10:00:00Z",
    attendees: [{ email: "ben@poetic.com", responseStatus: "declined", comment: "at a customer" }] }] };
  const r = D.readDeclines({ snapshot: synthetic });
  assert.equal(r.entries[0].declines[0].comment, "at a customer");
});

test("the snapshot's own provenance is carried through", () => {
  // A stale snapshot presented as current is the thing to avoid.
  const r = read();
  assert.equal(r.capturedAt, SNAPSHOT.capturedAt);
  assert.equal(r.source, "Poetic Interviews");
});

/* ================= the rail, spec section 5 ================= */

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

/** renderDeclines, sliced out and run against stubs. */
function rail(snapshot, opts) {
  const a = html.indexOf("  var declinesEl=document.getElementById(\"declines\");");
  const b = html.indexOf("  /* ---------- the panel layer ----------");
  assert.ok(a >= 0 && b > a, "the rail moved");
  const o = opts || {};
  return new Function("DECLINES", "INVENTORY", "EFFECTIVE", "SNAP", "TODAY", "HASEMAILS", "CANDS", "PANELS", "require_fields", `
    var out = { innerHTML: "" };
    var declinesEl = out;
    var document = { getElementById: function(){ return out; } };
    function headers(){ return {}; }
    var candidates = CANDS, panels = PANELS;
    function linkOf(c){ return (c.values && c.values.ashbyCandidateId) || ""; }
    var FIELDS_ = require_fields();
    function get(c,k){
      return c.values[k]===undefined ? FIELDS_.defVal(FIELDS_.field(k)) : c.values[k];
    }
    function effective(c,key){ return EFFECTIVE.resolve(c, key, null, get(c,key)); }
    function esc(s){ return (s==null?"":String(s)).replace(/[&<>"]/g,function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
    function parseDay(v){
      var m=/^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(String(v||"").trim());
      return m ? Number(m[1]+m[2]+m[3]) : null;
    }
    function todayDay(){ return TODAY; }
    var INVENTORY_ = INVENTORY;
    INVENTORY = Object.create(INVENTORY_);
    INVENTORY.hasEmails = function(){ return HASEMAILS; };
    ${html.slice(a, b)}
    declineSnapshot = SNAP;
    renderDeclines();
    return out.innerHTML;
  `)(D, INV, require("../lib/effective"), snapshot === undefined ? SNAPSHOT : snapshot,
     o.today === undefined ? 20260914 : o.today,
     o.hasEmails === undefined ? true : o.hasEmails,
     o.candidates || [], o.panels || {}, function(){ return require("../lib/fields"); });
}

test("the declines live in the action rail outside the calendar", () => {
  const rail=html.slice(html.indexOf('<aside class="action-rail"'),html.indexOf('<section class="calendar-workspace"'));
  assert.match(rail,/id="declines"/);
  assert.doesNotMatch(rail,/id="dayView"/);
});

test("the calendar's columns never go below 220px with the rail present", () => {
  assert.match(html, /min-width:max\(100%, calc\(var\(--cols\) \* 220px \+ \(var\(--cols\) - 1\) \* 8px\)\)/,
    "the band scrolls rather than the columns shrinking past the floor");
});

test("below 1100px the rail is full width beneath the calendar", () => {
  assert.match(html, /@media \(max-width:1100px\)\{[\s\S]*?\.calrow\{flex-direction:column\}/);
  assert.match(html, /@media \(max-width:1100px\)\{[\s\S]*?\.declines\{flex:1 1 auto;width:100%\}/);
});

test("with no interviewer emails the notice renders AND everything still lists", () => {
  /* Section 4, and the rule this week keeps producing: a lookup we cannot
     perform must not render as a negative answer. */
  const out = rail(undefined, { hasEmails: false });
  assert.match(out, /Main partner highlighting is off: no interviewer emails configured\./);
  assert.match(out, /No room\./, "room declines still list");
  assert.match(out, /declined\./, "and human declines still list");
  assert.equal(/No declines on upcoming trials/.test(out), false);
});

test("with emails configured the notice is absent", () => {
  const out = rail(undefined, { hasEmails: true });
  assert.equal(/highlighting is off/.test(out), false);
});

test("a room decline is Ember-dotted with the room in mono", () => {
  const out = rail(undefined, { today: 20260914 });
  assert.match(out, /<span class="dot"><\/span>No room\. <span class="dc-room">1 Beach-3-Invariant \(6\) \[Zoom\]<\/span> declined\./);
  assert.match(html, /\.dc-room\{font-family:var\(--mono\)/, "a room is a machine identifier");
  assert.match(html, /\.dc-line \.dot\{[^}]*background:var\(--ember\)/);
});

test("another human declining gets no dot", () => {
  const out = rail();
  assert.match(out, /<span class="dc-line plain">/);
  assert.match(html, /\.dc-line\.plain\{color:var\(--ink-2\)\}/);
});

test("an unmatched session shows its summary, prefixed", () => {
  const out = rail();
  assert.match(out, /<span class="dc-un">Unmatched<\/span>/);
  assert.match(out, /Tyler Robb/, "the summary carries who it is, even unattributed");
});

test("the footer always states the source and when it was captured", () => {
  // A stale snapshot presented as current is the thing to avoid.
  const out = rail();
  assert.match(out, /Read from Poetic Interviews\. Snapshot captured 14 September\./);
  assert.match(out, /64 laptop-account declines suppressed\./);
});

test("the empty state is a sentence, never a blank panel", () => {
  const out = rail({ events: [], calendarSummary: "Poetic Interviews", capturedAt: SNAPSHOT.capturedAt });
  assert.match(out, /No declines on upcoming trials/);
  assert.match(out, /Read from Poetic Interviews/, "and the footer is still there");
  assert.match(html, /\.dc-empty\{font-size:11\.5px;font-weight:600;color:var\(--ink-3\)\}/);
});

test("a failed read says it is a fault, not an empty week", () => {
  const out = rail(null);
  assert.match(out, /The calendar could not be read\.<\/strong> This is a fault, not an empty week\./);
  assert.equal(/No declines on upcoming trials/.test(out), false,
    "an empty state over a failure is the thing to avoid");
});

test("past sessions have dropped off by 14 Sept", () => {
  const out = rail(undefined, { today: 20260914 });
  assert.equal(/Danni El Tayeb/.test(out), false, "the 9 Sept room decline is behind us");
  assert.match(out, /Ari Blumkin/, "the 15 Sept debrief is not");
});

test("the rail changes nothing else on the page", () => {
  // Section 6. It is a read-only view of a separate source sitting beside the
  // calendar.
  const fn = html.slice(html.indexOf("  function renderDeclines(){"),
                        html.indexOf("  /* ---------- the panel layer ----------"));
  for (const w of ["putCandidate", "persist(", "values[", "acceptedSource", "renderDay("]) {
    assert.equal(fn.includes(w), false, "the rail must not touch " + w);
  }
  assert.match(server, /app\.get\("\/declines-snapshot\.json"/, "served as data");
  assert.equal(/fixtures/.test(html), false, "and not bundled into the page");
});

test("the snapshot is served as data, so a live feed replaces one route", () => {
  assert.match(server, /poetic-interviews-2026-09-07_to_09-18\.json/);
  assert.match(html, /fetch\("\/declines-snapshot\.json"/);
});

test("a known person declines by name, an unknown one by address", () => {
  // The address is not a guess at whose it is, and it appears in the
  // unresolved notice above, so it is findable rather than merely odd.
  const out = rail();
  assert.match(out, /Ben Mittelberger declined\./, "ben@poetic.com resolves");
  assert.match(out, /Antony Bello declined\./, "and so does antony@withforge.com");
  assert.equal(/michael\.zuccarino@poetic\.com/.test(out), false,
    "confirmed on 14 Sep, so never shown as a raw address again");
  // and an address we genuinely cannot place is still shown as the address
  const stray = D.readDeclines({ snapshot: { events: [{ id: "e", summary: "S",
    start: "2026-09-20T10:00:00Z",
    attendees: [{ email: "nobody@poetic.com", responseStatus: "declined" }] }] },
    personForEmail: INV.personForEmail });
  assert.deepEqual(stray.unresolved, ["nobody@poetic.com"]);
});

test("the provenance line does not change shape with the viewer's locale", () => {
  const out = rail();
  assert.match(out, /Snapshot captured 14 September\./);
  assert.match(html, /new Intl\.DateTimeFormat\("en-GB"/, "day then month, explicitly");
});

test("the unresolved notice only names addresses from sessions the rail shows", () => {
  // Otherwise it sends a reader looking for an entry that dropped off.
  const dayOf = (iso) => {
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
    return Number(d.replace(/-/g, ""));
  };
  const all = read({ dayOf, personForEmail: INV.personForEmail });
  const from17 = read({ dayOf, todayDay: 20260917, personForEmail: INV.personForEmail });
  assert.ok(from17.unresolved.length < all.unresolved.length,
    "fewer sessions shown, so fewer addresses named");
  for (const a of from17.unresolved) {
    const stillShown = from17.entries.some((e) =>
      e.declines.some((d) => D.normaliseAddress(d.email || "") === a));
    assert.ok(stillShown, a + " is named but appears in no listed session");
  }
});

/* ================= the join, once event ids exist ================= */

test("the panel exposes interview event ids, and only ids", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "bots", "ashby-panel.js"), "utf8");
  assert.match(src, /const interviewEventIds = wtSchedules\s*\n\s*\.flatMap\(\(s\) => \(s\.interviewEvents \|\| \[\]\)\.map\(\(e\) => e\.id\)\)/);
  assert.match(src, /^\s*interviewEventIds,$/m, "returned on the panel");
  // nothing a consumer could start deriving a trial date from: trialwindow.js
  // is the one place that decides what the trial is.
  const block = src.slice(src.indexOf("const interviewEventIds"),
                          src.indexOf("return {", src.indexOf("const interviewEventIds")));
  assert.equal(/startTime|endTime|title/.test(block), false,
    "ids only, so this cannot become a second date derivation");
});

test("a session joins to its candidate through the panel's event ids", () => {
  assert.ok(upcomingWithDecline, "the fixture has one the rail will show");
  const out = rail(undefined, {
    candidates: [{ id: "c1", name: "Ari Blumkin", values: { ashbyCandidateId: "a1" } }],
    panels: { a1: { state: "live",
                    panel: { interviewEventIds: [upcomingWithDecline.ashbyEventId] } } },
  });
  assert.match(out, /<span class="dc-name">Ari Blumkin<\/span>/, "named, not Unmatched");
  assert.equal(/Sessions cannot be matched to candidates yet/.test(out), false,
    "and the notice goes once anything can match");
});

test("a candidate with no panel contributes nothing, rather than a guess", () => {
  const out = rail(undefined, {
    candidates: [{ id: "c1", name: "Ari Blumkin", values: { ashbyCandidateId: "a1" } }],
    panels: { a1: { state: "stale", panel: null } },
  });
  assert.match(out, /Sessions cannot be matched to candidates yet/);
  assert.match(out, /<span class="dc-un">Unmatched<\/span>/,
    "the summaries are still shown: a decline we cannot attribute is still a decline");
});

test("an unlinked candidate is skipped without error", () => {
  const out = rail(undefined, {
    candidates: [{ id: "c1", name: "No Link", values: {} }],
    panels: {},
  });
  assert.match(out, /Declines/);
  assert.match(out, /Sessions cannot be matched to candidates yet/);
});

test("the notice disappears as soon as one candidate can be matched", () => {
  // A few unmatched among named ones reads fine; seventeen unexplained does not.
  const out = rail(undefined, {
    candidates: [{ id: "c1", name: "Someone", values: { ashbyCandidateId: "a1" } }],
    panels: { a1: { state: "live",
                    panel: { interviewEventIds: [upcomingWithDecline.ashbyEventId] } } },
  });
  assert.equal(/Sessions cannot be matched to candidates yet/.test(out), false);
  assert.match(out, /Unmatched/, "while the rest still say so individually");
});

/* ================= the two live defects, 14 Sept ================= */

test("THE main partner decline in the fixture is found: Liam on Ahmet's Build Time", () => {
  /* The only true main partner decline in the whole capture, which makes it
     the only test that would have caught this. It rendered as an ordinary
     human decline because the rail never passed mainPartnerFor, and
     readDeclines defaults that to a function returning null. Every link in the
     chain resolved; nothing walked them. A silent default looked exactly like
     "no main partner declined". */
  const ev = SNAPSHOT.events.find((e) =>
    /Build Time/.test(e.summary || "") && /Ahmet Hatip/.test(e.summary || "") &&
    (e.attendees || []).some((a) => a.responseStatus === "declined" &&
      /^liam@/i.test(a.email || "")));
  assert.ok(ev, "the fixture has Liam declining Ahmet's Build Time");

  const out = rail(undefined, {
    candidates: [{ id: "ahmet", name: "Ahmet Hatip",
                   values: { ashbyCandidateId: "a1", driName: "FDE-Liam" } }],
    panels: { a1: { state: "live", panel: { interviewEventIds: [ev.ashbyEventId] } } },
  });
  assert.match(out, /<span class="dot"><\/span>Main partner Liam declined\./);
  assert.equal(/<span class="dc-line plain">Liam declined\./.test(out), false,
    "not an ordinary human decline");
});

test("the chain the main partner match walks, link by link", () => {
  // Stated explicitly so a break anywhere in it names itself.
  const DRIM = require("../lib/dri-aliases");
  assert.equal(DRIM.resolveDri("FDE-Liam").canonical, "Liam");
  assert.equal(INV.personFor("FDE-Liam"), "liam");
  assert.deepEqual(INV.PEOPLE.liam.emails, ["liam@poetic.com"]);
  assert.equal(INV.personForEmail("liam@poetic.com"), "liam");
  // and the rail supplies the function that joins them
  assert.match(html, /mainPartnerFor:declineMainPartnerFor,/);
  assert.match(html, /return INVENTORY\.personFor\(effective\(c,"driName"\)\);/);
});

test("a decline by someone who is not this candidate's DRI stays plain", () => {
  // Neel declined AHMET's debrief, and Neel is ARI's partner. Correctly plain.
  const ev = SNAPSHOT.events.find((e) =>
    /Debrief/.test(e.summary || "") && /Ahmet Hatip/.test(e.summary || "") &&
    (e.attendees || []).some((a) => a.responseStatus === "declined" && /^neel@/i.test(a.email || "")));
  assert.ok(ev);
  const out = rail(undefined, {
    candidates: [{ id: "ahmet", name: "Ahmet Hatip",
                   values: { ashbyCandidateId: "a1", driName: "FDE-Liam" } }],
    panels: { a1: { state: "live", panel: { interviewEventIds: [ev.ashbyEventId] } } },
  });
  assert.match(out, /<span class="dc-line plain">Neel declined\./,
    "the right person on the wrong candidate is not a main partner decline");
});

test("a candidate whose DRI cannot be resolved gets plain declines, not a guess", () => {
  const ev = SNAPSHOT.events.find((e) =>
    /Build Time/.test(e.summary || "") && /Ahmet Hatip/.test(e.summary || ""));
  const out = rail(undefined, {
    candidates: [{ id: "ahmet", name: "Ahmet Hatip",
                   values: { ashbyCandidateId: "a1", driName: "Somebody New" } }],
    panels: { a1: { state: "live", panel: { interviewEventIds: [ev.ashbyEventId] } } },
  });
  assert.equal(/Main partner/.test(out), false);
  assert.equal(INV.personFor("Somebody New"), null);
});

test("the column floor accounts for the gutters, so 220 means 220", () => {
  /* node has no layout engine, so this evaluates the DECLARED formula rather
     than measuring anything. That is where the defect was: min-width is the
     grid's total width and the columns divide what is left after the gaps, so
     cols*220 alone yielded 212.3px per column at 29 columns. */
  const m = /min-width:max\(100%, calc\(var\(--cols\) \* (\d+)px \+ \(var\(--cols\) - 1\) \* (\d+)px\)\)/
    .exec(html);
  assert.ok(m, "the floor is declared with the gutters in the sum");
  const floor = Number(m[1]), gap = Number(m[2]);
  assert.equal(floor, 220);
  assert.equal(gap, 8, "and the gap matches the grid's own");
  assert.match(html, /\.daygrid\{[^}]*gap:8px/);

  // your measurement: innerWidth 1210, rail 300, scroller 856
  for (const cols of [3, 10, 29, 97]) {
    for (const vis of [3, 7]) {
      const scroller = 856;
      const width = Math.max(scroller * cols / vis, Math.max(scroller, cols * floor + (cols - 1) * gap));
      const column = (width - gap * (cols - 1)) / cols;
      assert.ok(column >= floor - 0.01,
        cols + " columns at vis " + vis + " gives " + column.toFixed(1) + "px");
    }
  }
});

test("the old formula fails that check, which is what makes it a test", () => {
  const scroller = 856, cols = 29, gap = 8, vis = 7;
  const oldWidth = Math.max(scroller * cols / vis, Math.max(scroller, cols * 220));
  const oldColumn = (oldWidth - gap * (cols - 1)) / cols;
  assert.ok(oldColumn < 220, "the shipped formula gave " + oldColumn.toFixed(1));
  assert.ok(Math.abs(oldColumn - 213) < 1,
    "which is the 213 measured in the browser, at " + oldColumn.toFixed(1));
});

test("the 1100px breakpoint is unchanged, because it was not the problem", () => {
  // At 1210 we are above it and the columns should hold 220 while the band
  // scrolls. They do now.
  assert.match(html, /@media \(max-width:1100px\)\{[\s\S]*?\.calrow\{flex-direction:column\}/);
});

/* ================= the live feed, 15 Sept ================= */

const CAL = require("../lib/calendar");

/** One route's source. requireAuth sits ABOVE these routes, so a slice to it
    runs backwards and silently checks nothing. */
function routeSource(pathName) {
  const a = server.indexOf('app.get("' + pathName + '"');
  assert.ok(a >= 0, "no route for " + pathName);
  const b = server.indexOf("\napp.", a + 1);
  return server.slice(a, b > a ? b : undefined);
}

test("exactly one scope, and it is read-only events", () => {
  // The key file carries no scope of its own, so this line and the share level
  // are the only two things limiting the credential.
  assert.equal(CAL.TOKEN_SCOPE, "https://www.googleapis.com/auth/calendar.events.readonly");
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "calendar.js"), "utf8");
  assert.equal((src.match(/googleapis\.com\/auth\//g) || []).length, 1, "one scope, once");
  assert.equal(/calendar\.readonly|auth\/calendar"/.test(src), false, "not the wider ones");
});

test("it reads its own credential and never the sheet reader's", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "calendar.js"), "utf8");
  assert.match(src, /process\.env\.GOOGLE_CAL_SA_KEY_B64/);
  // the comment explaining the separation names the other key, which is fine;
  // what must not exist is a READ of it.
  assert.equal(/process\.env\.GOOGLE_SA_KEY_B64/.test(src), false,
    "the sheet reader's key is a different service account by design");
  const sheets = fs.readFileSync(path.join(__dirname, "..", "lib", "sheets.js"), "utf8");
  assert.equal(/GOOGLE_CAL_SA_KEY_B64/.test(sheets), false, "and neither touches the other");
});

test("an unconfigured credential is a state, not a crash", () => {
  assert.equal(CAL.isConfigured(), false, "nothing is set in the test environment");
  assert.match(CAL.configError(), /GOOGLE_CAL_SA_KEY_B64 is not set/);
});

test("the window starts at midnight Pacific, whatever the season", () => {
  // Midnight PT is 07:00 or 08:00 UTC depending on daylight saving, and the
  // offset is probed rather than assumed.
  const summer = CAL.startOfTodayPT(new Date("2026-09-15T20:00:00Z"));
  assert.equal(summer.ymd, "2026-09-15");
  assert.equal(summer.iso, "2026-09-15T07:00:00.000Z", "PDT");
  const winter = CAL.startOfTodayPT(new Date("2026-12-15T20:00:00Z"));
  assert.equal(winter.ymd, "2026-12-15");
  assert.equal(winter.iso, "2026-12-15T08:00:00.000Z", "PST");
  // and late evening UTC is still the same Pacific day
  const evening = CAL.startOfTodayPT(new Date("2026-09-15T06:00:00Z"));
  assert.equal(evening.ymd, "2026-09-14", "02:00 UTC is still yesterday in California");
});

test("the briefing id is parsed exactly as the fixture's was", () => {
  const real = "d459863b-3895-4a20-b2e6-64fa7e49c7fe";
  assert.equal(CAL.ashbyEventIdFrom(
    '<a href="https://app.ashbyhq.com/interview-briefings/' + real + '">Briefing</a>'), real);
  assert.equal(CAL.ashbyEventIdFrom("no link here"), null);
  assert.equal(CAL.ashbyEventIdFrom(null), null);
  // and the fixture really does carry that id, so the parse matches the capture
  assert.ok(SNAPSHOT.events.some((e) => e.ashbyEventId === real));
});

test("a Google event becomes a fixture event, and drops the description", () => {
  // Live descriptions are large HTML blobs and are never carried through.
  const out = CAL.toFixtureEvent({
    id: "g1", summary: "FDS WT: Debrief - X", status: "confirmed",
    description: "<p>https://app.ashbyhq.com/interview-briefings/d459863b-3895-4a20-b2e6-64fa7e49c7fe</p>",
    start: { dateTime: "2026-09-20T17:00:00-07:00" }, end: { dateTime: "2026-09-20T18:00:00-07:00" },
    creator: { email: "someone@poetic.com" }, location: "1 Beach",
    attendees: [
      { email: "room@resource.calendar.google.com", resource: true,
        displayName: "1 Beach-3-Invariant (6) [Zoom]", responseStatus: "declined" },
      { email: "liam@poetic.com", responseStatus: "declined", comment: "at a customer" },
      { email: "x@poetic.com", responseStatus: "accepted", optional: true },
    ],
  });
  assert.equal(out.description, undefined, "never carried through");
  assert.equal(out.ashbyEventId, "d459863b-3895-4a20-b2e6-64fa7e49c7fe");
  assert.equal(out.start, "2026-09-20T17:00:00-07:00");
  assert.equal(out.allDay, false);
  assert.equal(out.creator, "someone@poetic.com");
  assert.deepEqual(Object.keys(out).sort(),
    ["allDay", "ashbyEventId", "attendees", "creator", "end", "id", "location", "start",
     "status", "summary"], "exactly the fixture's keys");
  assert.equal(out.attendees[0].resource, true);
  assert.equal(out.attendees[1].comment, "at a customer");
  assert.equal(out.attendees[2].optional, true);
  // and the classifier reads it without knowing where it came from
  assert.equal(D.classify(out.attendees[0]), "room");
  assert.equal(D.classify(out.attendees[1]), "human");
});

test("an all-day event keeps its date and is marked", () => {
  const out = CAL.toFixtureEvent({ id: "g2", start: { date: "2026-09-20" }, end: { date: "2026-09-21" } });
  assert.equal(out.allDay, true);
  assert.equal(out.start, "2026-09-20");
});

test("the fixture route stays, and the tests read the file not the route", () => {
  assert.match(server, /app\.get\("\/declines-fixture\.json"/, "still reachable");
  const testSrc = fs.readFileSync(__filename, "utf8");
  assert.match(testSrc, /fixtures", "poetic-interviews/, "the fixture is read from disk");
  // and nothing in this suite performs a fetch at all
  assert.equal(/\bfetch\(/.test(testSrc), false, "no test reaches the network or a route");
});

test("a live read never falls back to the fixture", () => {
  // A rail showing 14 September data while labelled live is worse than a rail
  // showing an error.
  const route = routeSource("/declines-snapshot.json");
  const catchBlock = route.slice(route.indexOf("} catch (e) {"));
  assert.equal(/sendFile/.test(catchBlock), false, "no fixture in the failure path");
  assert.match(catchBlock, /res\.status\(status\)\.json\(\{ error:/);
  // the fixture is served only when nothing is configured at all
  assert.match(route, /if \(!calendar\.isConfigured\(\)\) \{[\s\S]*?sendFile/);
});

test("each fault gets its own status and its own sentence", () => {
  const route = routeSource("/declines-snapshot.json");
  assert.match(route, /kind === "forbidden" \? 403/);
  assert.match(route, /kind === "not_found" \? 404/);
  assert.match(route, /kind === "not_configured" \? 503 : 502/);
  for (const kind of ["forbidden", "free_busy", "not_found", "not_configured", "network", "http"]) {
    assert.ok(html.includes(kind + ":"), "the rail has a sentence for " + kind);
  }
  assert.match(html, /shared at free\/busy only, which strips attendees/);
});

test("an empty window is a different state from a failed read", () => {
  const route = routeSource("/declines-snapshot.json");
  assert.match(route, /if \(!snapshot\.events\.length\) \{[\s\S]*?empty: true/);
  assert.match(html, /No sessions in the next 21 days\. The calendar was read and is empty\./);
});

test("the footer states the real read time, and says when it is stale", () => {
  const fn = html.slice(html.indexOf("  function declineProvenance(){"),
                        html.indexOf("  function fmtClock(iso){"));
  assert.match(fn, /if\(!d\.live\) return source\+" Snapshot captured "/, "the capture, unchanged");
  assert.match(fn, /A refresh since then failed, so this may be out of date/);
  assert.match(fn, /return source\+" Read "\+fmtClock\(d\.fetchedAt\)/);
});

test("courtney and aviv name a person rather than an address", () => {
  // In the live decline set and not partners: they exist in PEOPLE only so a
  // decline reads as a name. Supplied by Hayley, not derived from the calendar.
  assert.equal(INV.personForEmail("courtney@poetic.com"), "courtney");
  assert.equal(INV.displayName("courtney"), "Courtney Kara");
  assert.equal(INV.personForEmail("aviv@poetic.com"), "aviv");
  assert.equal(INV.displayName("aviv"), "Aviv", "first name only, and not invented further");
  // neither carries a role, so neither can be suggested as a partner
  assert.deepEqual(INV.rolesFor("courtney"), []);
  assert.deepEqual(INV.rolesFor("aviv"), []);
  for (const role of INV.ROLES) {
    const ids = (INV.PARTNER_ROLES[role] || []).map((e) => e.person);
    assert.equal(ids.includes("courtney"), false, role);
    assert.equal(ids.includes("aviv"), false, role);
  }
});
