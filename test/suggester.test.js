"use strict";
/**
 * The assignment suggester. Proposes only; nothing here writes anything.
 *
 * The inventory is Hayley's real list, so these tests use real names. That is
 * deliberate: the defects the addendum warns about are properties of the real
 * data, and a synthetic roster would not have them.
 */
const { test } = require("node:test");
const assert = require("node:assert");

const D = require("../lib/dateday");
const INV = require("../lib/assignment-inventory");
const DRI = require("../lib/dri-aliases");
const S = require("../lib/suggest-assignments");

const sp = (a, b) => D.trialSpan(D.parseDay(a), D.parseDay(b || a));
const TODAY = 20260911;
const partner = (o) => S.suggestPartner(Object.assign({ today: TODAY, trials: [] }, o));
const laptop = (o) => S.suggestLaptop(Object.assign({ today: TODAY, trials: [] }, o));
const desk = (o) => S.suggestDesk(Object.assign({ today: TODAY, trials: [], current: "TBD" }, o));

/* ================= one person, one availability ================= */

test("a booking under one role makes the person unavailable under the other", () => {
  // THE DEFECT MOST LIKELY TO SHIP UNNOTICED. Sales-Shantam and FDS-Shantam J
  // are one human and look like two in the data.
  const trials = [{ span: sp("2026-09-14"), personId: INV.personFor("Sales-Shantam"),
                    name: "Someone", role: "Sales" }];
  const r = partner({ role: "FDS", span: sp("2026-09-14"), trials });
  assert.equal(r.ok, true);
  assert.notEqual(r.personId, "shantam", "booked as Sales on the 14th, so not free as FDS");
  assert.equal(INV.personFor("Sales-Shantam"), INV.personFor("FDS-Shantam J"),
    "and the two labels resolve to one person at all");
});

test("it holds in both directions and for all three double-hatted people", () => {
  const pairs = [
    ["antony", "FDS-Antony B", "Sales-Antony", "FDS", "Sales"],
    ["shantam", "FDS-Shantam J", "Sales-Shantam", "FDS", "Sales"],
    ["shashank", "FDS-Shashank P", "Sales-Shashank", "FDS", "Sales"],
  ];
  for (const [id, labelA, labelB, roleA, roleB] of pairs) {
    assert.equal(INV.personFor(labelA), id, labelA);
    assert.equal(INV.personFor(labelB), id, labelB);
    for (const [booked, asked] of [[labelA, roleB], [labelB, roleA]]) {
      const trials = [{ span: sp("2026-09-14"), personId: INV.personFor(booked) }];
      const r = partner({ role: asked, span: sp("2026-09-14"), trials });
      assert.notEqual(r.personId, id,
        id + " booked as " + booked + " must not be offered for " + asked);
    }
  }
});

test("last partnered is per person, across roles", () => {
  // Shantam finished a Sales trial recently; that must make him stale as FDS
  // too, not look like a fresh FDS partner.
  const trials = [
    { span: sp("2026-09-08", "2026-09-09"), personId: "shantam" },
    { span: sp("2026-08-01", "2026-08-02"), personId: "advait" },
  ];
  const r = partner({ role: "FDS", span: sp("2026-09-20"), trials });
  // everyone with no history outranks both, but between these two Advait is staler
  const order = ["benm", "dillon", "shashank", "antony"];
  assert.ok(order.indexOf(r.personId) >= 0 || r.personId === "advait",
    "someone never used, or the older of the two, but never Shantam");
  assert.notEqual(r.personId, "shantam");
});

/* ================= partner ================= */

test("an FDE candidate never receives an FDS or Sales partner", () => {
  // Every FDE primary is busy, and there is still no cross-role fallback.
  const busy = INV.PARTNER_ROLES.FDE
    .filter((e) => e.tier === "primary")
    .map((e) => ({ span: sp("2026-09-14"), personId: e.person }));
  const r = partner({ role: "FDE", span: sp("2026-09-14"), trials: busy });
  if (r.ok) {
    const roles = INV.rolesFor(r.personId).map((x) => x.role);
    assert.ok(roles.includes("FDE"), r.display + " must be listed under FDE");
  }
  // and with the fallbacks busy too, it says no rather than reaching across
  const alsoBusy = busy.concat(["hima", "neel"].map((p) => ({ span: sp("2026-09-14"), personId: p })));
  const none = partner({ role: "FDE", span: sp("2026-09-14"), trials: alsoBusy });
  assert.equal(none.ok, false);
  assert.equal(none.reason, "No FDE partner free on these dates.");
});

test("a partner with an overlapping trial is excluded", () => {
  const trials = [{ span: sp("2026-09-13", "2026-09-15"), personId: "samh" }];
  for (const day of ["2026-09-13", "2026-09-14", "2026-09-15"]) {
    assert.notEqual(partner({ role: "FDE", span: sp(day), trials }).personId, "samh", day);
  }
  // and is eligible either side of it
  assert.equal(S.overlaps(sp("2026-09-12"), sp("2026-09-13", "2026-09-15")), false);
  assert.equal(S.overlaps(sp("2026-09-16"), sp("2026-09-13", "2026-09-15")), false);
});

test("a partner with any confirmed booking ranks below one with none", () => {
  // §2.3.3 as amended 11 Sep: committed versus not, never past versus future.
  // This test used to assert the opposite, which was the spec's original rule.
  const future = [{ span: sp("2026-09-25", "2026-09-26"), personId: "samh" }];
  const r = partner({ role: "FDE", span: sp("2026-09-14"), trials: future });
  assert.equal(r.ok, true);
  assert.notEqual(r.personId, "samh", "booked for 25 Sep, so not the freshest for 14 Sep");
  assert.match(r.reason, /^No recorded trial for this person\./,
    "and the person who IS picked genuinely has none");

  const withPast = partner({ role: "FDE", span: sp("2026-09-14"),
    trials: [{ span: sp("2026-09-01"), personId: "samh" }] });
  assert.notEqual(withPast.personId, "samh", "a finished trial does the same");
});

test("a never-used partner outranks everyone who has been used", () => {
  const used = INV.PARTNER_ROLES.FDE
    .filter((e) => e.tier === "primary" && e.person !== "erik")
    .map((e) => ({ span: sp("2026-09-01"), personId: e.person }));
  const r = partner({ role: "FDE", span: sp("2026-09-14"), trials: used });
  assert.equal(r.personId, "erik", "the only one with no history");
  assert.match(r.reason, /^No recorded trial for this person\./);
});

test("ordering is deterministic when everything ties", () => {
  const seen = new Set();
  for (let i = 0; i < 20; i++) seen.add(partner({ role: "FDE", span: sp("2026-09-14") }).personId);
  assert.equal(seen.size, 1, "same answer every time");
});

/* ================= tiers ================= */

test("a fallback is not offered while a primary is free", () => {
  const r = partner({ role: "FDE", span: sp("2026-09-14") });
  assert.equal(["hima", "neel"].includes(r.personId), false);
  assert.equal(r.fallback, false);
});

test("a fallback is offered when no primary is free, and is labelled", () => {
  const busy = INV.PARTNER_ROLES.FDE
    .filter((e) => e.tier === "primary")
    .map((e) => ({ span: sp("2026-09-14"), personId: e.person }));
  const r = partner({ role: "FDE", span: sp("2026-09-14"), trials: busy });
  assert.equal(r.ok, true);
  assert.equal(["hima", "neel"].includes(r.personId), true);
  assert.equal(r.fallback, true);
  assert.match(r.reason, /^No FDE partner free, (Hima Tammineedi|Neel) can cover\./);
});

test("Hima and Neel are primary for Sales and rank normally there", () => {
  const roles = (p) => INV.rolesFor(p).reduce((o, r) => (o[r.role] = r.tier, o), {});
  assert.deepEqual(roles("hima"), { FDE: "fallback", FDS: "fallback", Sales: "primary" });
  assert.deepEqual(roles("neel"), { FDE: "fallback", FDS: "fallback", Sales: "primary" });
  // with every other Sales primary busy, they are a normal pick, not a fallback
  const busy = ["antony", "shantam", "shashank", "dan"].map((p) => ({ span: sp("2026-09-14"), personId: p }));
  const r = partner({ role: "Sales", span: sp("2026-09-14"), trials: busy });
  assert.equal(["hima", "neel"].includes(r.personId), true);
  assert.equal(r.fallback, false, "primary for Sales, so no fallback wording");
  assert.equal(/can cover/.test(r.reason), false);
});

test("the trainee is never suggested automatically", () => {
  const busy = INV.PARTNER_ROLES.FDE
    .filter((e) => e.person !== "joshv")
    .map((e) => ({ span: sp("2026-09-14"), personId: e.person }));
  const r = partner({ role: "FDE", span: sp("2026-09-14"), trials: busy });
  assert.equal(r.ok, false, "Josh V stays assignable by hand only");
  assert.equal(r.reason, "No FDE partner free on these dates.");
});

/* ================= the Platform pair ================= */

test("Platform is one bookable unit, named for both people", () => {
  const r = partner({ role: "Platform", span: sp("2026-09-14") });
  assert.equal(r.ok, true);
  assert.equal(r.display, "Sikan or Yasyf", "never one name: picking one would invent a fact");
  assert.equal(r.personId, "platform");
  assert.deepEqual(INV.PEOPLE.platform.pair, ["Sikan He", "Yasyf Mohamedali"]);
  // booked is booked, because the sheet does not record which of them it was
  const busy = [{ span: sp("2026-09-14"), personId: "platform" }];
  assert.equal(partner({ role: "Platform", span: sp("2026-09-14"), trials: busy }).ok, false);
});

/* ================= laptop ================= */

test("an unknown location suggests no laptop and says so", () => {
  for (const loc of ["", null, undefined, "   "]) {
    const r = laptop({ span: sp("2026-09-14"), location: loc });
    assert.equal(r.ok, false, JSON.stringify(loc));
    assert.equal(r.reason, "Location unknown, so no laptop is suggested.");
  }
  // and never quietly defaults to SF, which is where most candidates are
  assert.equal(laptop({ span: sp("2026-09-14"), location: "" }).value, undefined);
});

test("laptops filter on location", () => {
  assert.match(laptop({ span: sp("2026-09-14"), location: "NY" }).value, /^NY-/);
  assert.match(laptop({ span: sp("2026-09-14"), location: "SF" }).value, /^SF-/);
  const ny = INV.LAPTOPS.filter((l) => l.location === "NY").map((l) => l.id);
  assert.deepEqual(ny, ["NY-Poetic 5", "NY-Poetic 6"]);
});

test("SF-Poetic 3 is reserved for Platform", () => {
  // Every other SF laptop busy, and it is still not offered.
  const others = INV.LAPTOPS
    .filter((l) => l.location === "SF" && l.id !== "SF-Poetic 3")
    .map((l) => ({ span: sp("2026-09-14"), laptop: l.id }));
  const r = laptop({ span: sp("2026-09-14"), location: "SF", role: "FDE", trials: others });
  assert.equal(r.ok, false, "SF-Poetic 3 must stay out of an FDE pool");
  const p = laptop({ span: sp("2026-09-14"), location: "SF", role: "Platform", trials: others });
  assert.equal(p.ok, true);
  assert.equal(p.value, "SF-Poetic 3", "and is available to Platform");
});

test("a laptop committed on an overlapping future day is excluded", () => {
  const trials = [{ span: sp("2026-09-20", "2026-09-22"), laptop: "SF-Poetic 1" }];
  const r = laptop({ span: sp("2026-09-21"), location: "SF", trials });
  assert.notEqual(r.value, "SF-Poetic 1");
  // the same laptop on non-overlapping days is eligible
  const clear = laptop({ span: sp("2026-09-14"), location: "SF", trials });
  assert.equal(clear.value, "SF-Poetic 1", "not overlapping, so back in the pool");
});

test("longest ago first, never used first of all", () => {
  const trials = INV.LAPTOPS.filter((l) => l.location === "SF" && !l.reservedFor)
    .map((l, i) => ({ span: sp("2026-09-0" + (i + 1)), laptop: l.id }));
  const withoutOne = trials.slice(1);
  assert.equal(laptop({ span: sp("2026-09-14"), location: "SF", trials: withoutOne }).value,
    "SF-Poetic 1", "never used beats everything");
  assert.equal(laptop({ span: sp("2026-09-14"), location: "SF", trials }).value,
    "SF-Poetic 1", "and the oldest completed use is first");
});

test("no laptop free says so, with the dates", () => {
  const all = INV.LAPTOPS.filter((l) => l.location === "SF")
    .map((l) => ({ span: sp("2026-09-13", "2026-09-15"), laptop: l.id }));
  const r = laptop({ span: sp("2026-09-14"), location: "SF", role: "Platform", trials: all });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "No SF laptop free on Sep 14.");
});

/* ================= desk ================= */

test("the no-desk values are not gaps", () => {
  for (const v of INV.DESK_NOT_NEEDED) {
    const r = desk({ span: sp("2026-09-14"), current: v });
    assert.equal(r.ok, false);
    assert.equal(r.needed, false, v + " must not count as a gap");
    assert.equal(r.reason, v + " needs no desk.");
  }
});

test("TBD and empty are requests for a suggestion, not absences", () => {
  for (const v of ["TBD", "", null, undefined]) {
    assert.equal(INV.isDeskRequest(v), true, JSON.stringify(v));
    assert.equal(desk({ span: sp("2026-09-14"), current: v }).ok, true);
  }
  assert.equal(INV.isDeskRequest("SF-Desk 2"), false, "a real desk is not a request");
});

test("spacing is maximised where possible", () => {
  const trials = [{ span: sp("2026-09-13", "2026-09-15"), desk: "SF-Desk 1",
                    name: "Brandon Wagoner", role: "FDE" }];
  const r = desk({ span: sp("2026-09-14"), trials, role: "FDS" });
  assert.equal(r.value, "SF-Desk 4", "furthest from the one that is taken");
  assert.equal(r.spacing, 3);
  assert.match(r.reason, /3 desks from Brandon Wagoner/);
  assert.equal(r.adjacent, undefined);
});

test("three same-day candidates across four desks still get three suggestions", () => {
  // The 14 Sep case from the spec. Brandon at desk 1; Ari and Ahmet need desks.
  const day = sp("2026-09-14");
  const taken = [{ span: sp("2026-09-13", "2026-09-15"), desk: "SF-Desk 1",
                   name: "Brandon Wagoner", role: "FDE" }];
  const first = desk({ span: day, trials: taken, role: "FDS" });
  assert.equal(first.ok, true);
  assert.equal(first.value, "SF-Desk 4");

  const taken2 = taken.concat([{ span: day, desk: first.value, name: "Ari Blumkin", role: "FDS" }]);
  const second = desk({ span: day, trials: taken2, role: "FDE" });
  assert.equal(second.ok, true, "a third suggestion is still produced");
  assert.equal(second.value, "SF-Desk 2", "the middle pair, equidistant, array order breaks it");
  assert.equal(second.adjacent, true, "and the crowding is stated, not hidden");
  assert.match(second.reason, /Next to Brandon Wagoner/);
  assert.match(second.reason, /Only 4 desks, so spacing was not possible/);
});

test("same-role adjacency is labelled distinctly from cross-role", () => {
  const day = sp("2026-09-14");
  const sameRole = desk({ span: day, role: "FDE",
    trials: [{ span: day, desk: "SF-Desk 1", name: "Brandon Wagoner", role: "FDE" },
             { span: day, desk: "SF-Desk 3", name: "Ari Blumkin", role: "FDS" },
             { span: day, desk: "SF-Desk 4", name: "Ahmet Hatip", role: "FDS" }] });
  assert.equal(sameRole.value, "SF-Desk 2");
  assert.equal(sameRole.adjacent, true);
  assert.equal(sameRole.sameRole, true);
  assert.match(sameRole.reason, /who is also FDE/);

  const crossRole = desk({ span: day, role: "Sales",
    trials: [{ span: day, desk: "SF-Desk 1", name: "Brandon Wagoner", role: "FDE" },
             { span: day, desk: "SF-Desk 3", name: "Ari Blumkin", role: "FDS" },
             { span: day, desk: "SF-Desk 4", name: "Ahmet Hatip", role: "FDS" }] });
  assert.equal(crossRole.adjacent, true);
  assert.equal(crossRole.sameRole, false);
  assert.equal(/who is also/.test(crossRole.reason), false);
});

test("no desk free says so, with the dates", () => {
  const all = INV.DESKS.map((d) => ({ span: sp("2026-09-13", "2026-09-15"), desk: d }));
  const r = desk({ span: sp("2026-09-13", "2026-09-15"), trials: all });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "No desk free on Sep 13 to Sep 15.");
});

test("an unknown desk in the sheet is ignored rather than treated as taken", () => {
  // It is flagged elsewhere; here the point is it does not silently join the
  // inventory or block a real desk.
  const trials = [{ span: sp("2026-09-14"), desk: "SF-Desk 99" }];
  const r = desk({ span: sp("2026-09-14"), trials });
  assert.equal(r.ok, true);
  assert.equal(INV.isKnownDesk("SF-Desk 99"), false);
  assert.equal(r.value, "SF-Desk 1", "the real desks are all still free");
});

/* ================= general ================= */

test("an empty inventory produces a message, not a crash", () => {
  const realDesks = INV.DESKS.slice();
  INV.DESKS.length = 0;
  try {
    const r = desk({ span: sp("2026-09-14") });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "No desks listed.");
  } finally {
    INV.DESKS.push.apply(INV.DESKS, realDesks);
  }
  assert.equal(partner({ role: "Nope", span: sp("2026-09-14") }).ok, false);
  assert.equal(partner({ role: "Nope", span: sp("2026-09-14") }).reason,
    "No partner list for Nope.");
});

test("nothing is written, and there is no accept path in this module", () => {
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "suggest-assignments.js"), "utf8");
  assert.equal(/accept/i.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), false,
    "accept is not built until section 2.8 is decided");
  for (const w of ["putCandidate", "fetch(", "localStorage", "values[", "sheetSource"]) {
    assert.equal(src.includes(w), false, "must not write: " + w);
  }
});

test("the copy states observations, never conclusions", () => {
  const r = partner({ role: "FDE", span: sp("2026-09-14") });
  assert.match(r.reason, /No overlapping trial recorded on these dates\./,
    "recorded, not 'free': nothing here checked anyone's calendar");
  const l = laptop({ span: sp("2026-09-14"), location: "SF" });
  assert.match(l.reason, /recorded/);
  for (const text of [r.reason, l.reason, desk({ span: sp("2026-09-14") }).reason]) {
    assert.equal(text.includes("—"), false, "no em dashes");
    assert.equal(/\bassigned\b/i.test(text), false, "suggested, never assigned");
    assert.equal(/\bavailable\b/i.test(text), false,
      "availability is a claim about people, not about the tracker");
  }
});

/* ================= presentation, §2.7 ================= */

const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

test("three chip states get three treatments, and none is dashed twice", () => {
  const rule = (sel) => {
    const i = html.indexOf("  " + sel + "{");
    assert.ok(i > 0, sel + " missing");
    return html.slice(i, html.indexOf("}", i));
  };
  // confirmed: filled, mono
  assert.match(rule(".chip.mono"), /font-family:var\(--mono\)/);
  assert.match(rule(".chip"), /background:var\(--paper\)/);
  // unset: dashed, Manrope, unchanged
  assert.match(rule(".chip.none"), /border:1px dashed/);
  assert.match(rule(".chip.none"), /background:transparent/);
  // suggested: solid hairline, unfilled, and NOT dashed
  assert.match(rule(".chip.sugg"), /border:1px solid var\(--ink-2\)/);
  assert.match(rule(".chip.sugg"), /background:transparent/);
  assert.equal(/dashed/.test(rule(".chip.sugg")), false,
    "dashed already means unset; a dashed suggestion would collide with it");
});

test("the word Suggested appears on every proposal, not a colour alone", () => {
  const fn = html.slice(html.indexOf("  function suggChip(label, s, machine){"),
                        html.indexOf("  function suggBlock(entry){"));
  assert.match(fn, /<span class="sugg-tag">Suggested<\/span>/);
  // it is inside the chip markup, so it cannot be styled away separately
  assert.ok(fn.indexOf('sugg-tag">Suggested') < fn.indexOf('class="sugg-val'),
    "the word comes before the value");
  assert.match(html, /\.sugg-tag\{[^}]*font-weight:700/, "and is not a whisper");
});

test("a proposal never enters the partner meta row", () => {
  // "FDS · Shantam Jain · 1 running" with a proposed name in it would be
  // indistinguishable from a booking. Proposals get their own row instead.
  const card = html.slice(html.indexOf("  function renderBar(bar,days,entries,today,cols){"),
                          html.indexOf("  function renderDay(){"));
  const metaStart = card.indexOf('var meta=dri.unassigned?"":');
  const metaEnd = card.indexOf("var flags=[]");
  const meta = card.slice(metaStart, metaEnd);
  assert.equal(/sugg/i.test(meta), false, "the meta row knows nothing about suggestions");
  // and the block sits outside both the meta row and the kit row
  assert.match(card, /compactBarSummary\(e,flags\)\+\s*'<span class="tc-kit">/);
  const kit = card.slice(card.indexOf('<span class="tc-kit">'));
  assert.equal(/suggBlock|sugg-tag/.test(kit), false, "nor does the kit row");
});

test("an unassigned partner still shows the flag, with the proposal beside it", () => {
  // The gap is real until somebody accepts. Both things are true and both are
  // said: "No main partner" is the state, the suggestion is a proposal.
  const card = html.slice(html.indexOf("  function renderBar(bar,days,entries,today,cols){"),
                          html.indexOf("  function renderDay(){"));
  assert.match(card, /if\(dri\.unassigned\) flags\.push\("No main partner"\);/);
  assert.match(card, /compactBarSummary\(e,flags\)/);
});

test("suggestions are stamped on the entry, never on the candidate", () => {
  // This is the guarantee that keeps them out of the sweep, bot 10, the
  // capacity counts and collision detection: they never reach values.
  assert.match(html, /suggestAll\(entries,today\);/, "one pass over the board");
  assert.match(html, /try\{\s*\n\s*var c = e\.c/, "with a per-candidate boundary inside");
  const fn = html.slice(html.indexOf("  function suggestAll(entries, today){"),
                        html.indexOf("  /* Three states, three treatments"));
  assert.equal(/\.values\s*\[/.test(fn), false, "never writes into values");
  assert.equal(/putCandidate|persist\(/.test(fn), false, "and never persists");
});

test("a trial that has already started gets no suggestions", () => {
  const fn = html.slice(html.indexOf("  function suggestAll(entries, today){"),
                        html.indexOf("  /* Three states, three treatments"));
  assert.match(fn, /if \(today === null\) return;/);
  assert.match(fn, /return e\.span && e\.span\.startDay >= today;/,
    "only trials that have not started");
});

test("no proposal is made for a field that already holds a value", () => {
  const fn = html.slice(html.indexOf("  function suggestAll(entries, today){"),
                        html.indexOf("  /* Three states, three treatments"));
  assert.match(fn, /if \(e\.dri\.unassigned\) \{/, "partner only when unassigned");
  assert.match(fn, /if \(INVENTORY\.isDeskNeeded\(deskNow\) && INVENTORY\.isDeskRequest\(deskNow\)\)/,
    "desk only when TBD or empty, and only when one is needed");
  assert.match(fn, /if \(INVENTORY\.isLaptopRequest\(effective\(c, "computer"\)\)\)/,
    "laptop only when unset or TBD, the same sentinel the desk uses");
});

test("when nothing fits, the reason is shown rather than an empty space", () => {
  const fn = html.slice(html.indexOf("  function suggChip(label, s, machine){"),
                        html.indexOf("  function suggBlock(entry){"));
  assert.match(fn, /if \(!s\.ok\) \{/);
  assert.match(fn, /class="sugg-none"/);
  assert.match(fn, /esc\(suggNoOption\(label, s\)\)/,
    "through the shared function, so the card and the panel cannot drift");
});

test("a fallback partner is marked as one on the card, not only in the reason", () => {
  const fn = html.slice(html.indexOf("  function suggChip(label, s, machine){"),
                        html.indexOf("  function suggBlock(entry){"));
  assert.match(fn, /s\.fallback \? '<span class="sugg-note">fallback<\/span>' : ""/);
});

/* ================= a suggestion counts nowhere ================= */

test("a suggested partner is not counted in anybody's concurrent load", () => {
  // suggestTrials reads effective() values only, so a proposal cannot appear
  // in the trials list the capacity numbers are computed from.
  const fn = html.slice(html.indexOf("  function suggestTrials(entries){"),
                        html.indexOf("  /**\n   * Suggestions for the whole board"));
  assert.match(fn, /personId: INVENTORY\.personFor\(effective\(e\.c, "driName"\)\)/);
  assert.equal(/\.sugg\b/.test(fn), false, "the trials list knows nothing about proposals");
  assert.equal(/suggest/i.test(fn.replace(/suggestTrials/g, "")), false);
});

test("a suggested desk is not counted in collision detection", () => {
  const fn = html.slice(html.indexOf("  function collisionsOn(dayEntries){"),
                        html.indexOf("  /** A desk or laptop as shown"));
  assert.match(fn, /var v=effective\(e\.c,k\);/, "reads the confirmed value");
  assert.equal(/sugg/i.test(fn), false, "and nothing else");
});

test("a suggested laptop is not counted as committed for anyone else", () => {
  // Two candidates on the same day, neither with a laptop. Both get the same
  // proposal, because a proposal commits nothing.
  const day = sp("2026-09-14");
  const r1 = laptop({ span: day, location: "SF", role: "FDE" });
  const r2 = laptop({ span: day, location: "SF", role: "FDE" });
  assert.equal(r1.value, r2.value,
    "identical inputs give identical proposals; neither reserves anything");
  assert.equal(r1.ok, true);
});

test("the capacity numbers on the card come from confirmed partners only", () => {
  const fn = html.slice(html.indexOf("  function concurrentFor(entries,canonical,day){"),
                        html.indexOf("  /**\n   * Distinct trials for this partner"));
  assert.match(fn, /e\.dri\.canonical===canonical/);
  assert.equal(/sugg/i.test(fn), false);
  // e.dri is built from effective(), before any suggestion exists
  assert.match(html, /entries\.push\(\{c:c,span:span,dri:driOf\(c\)\}\)/);
  assert.match(html, /function driOf\(c\)\{ return DRI\.resolveDri\(effective\(c,"driName"\)\); \}/);
});

test("proposals are computed after collisions, and feed nothing back", () => {
  // Order matters: they read every confirmed value including the collisions
  // just resolved, and are then stamped somewhere nothing else reads.
  const render = html.slice(html.indexOf("  function renderDay(){"),
                            html.indexOf("    var laid=layoutBars(days,entries);"));
  assert.ok(render.indexOf("e.clash.desk=true") < render.indexOf("suggestAll(entries,today)"),
    "collisions are resolved from confirmed values first");
  const after = html.slice(html.indexOf("suggestAll(entries,today);"));
  assert.equal(/collisionsOn\(|concurrentFor\(entries/.test(
    after.slice(0, after.indexOf("function renderBar"))), false,
    "and nothing recomputes from them afterwards");
});

/* ================= accept, §2.7 ================= */

/** The accept helpers, sliced from index.html and run against stubs. */
function accepter() {
  const a = html.indexOf("  function suggNoOption(label, s){");
  const b = html.indexOf("  /** The suggestion section of the panel");
  assert.ok(a >= 0 && b > a, "the accept helpers moved");
  return new Function("NOW", `
    var who = "Hayley";
    var touched = [], persisted = [];
    function touch(c){ touched.push(c.id); c.updatedBy = who; }
    function persist(c){ persisted.push(c.id); }
    var Date_ = Date;
    function Date(){ return { toISOString: function(){ return NOW; } }; }
    ${html.slice(a, b)}
    return { suggNoOption, acceptSuggestion, acceptAll, SUGG_FIELDS,
             touched: touched, persisted: persisted };
  `)("2026-09-11T10:00:00.000Z");
}

const cand = () => ({ id: "c1", name: "Ari Blumkin", values: {} });

test("accepting writes the value and its own provenance", () => {
  const A = accepter();
  const c = cand();
  const ok = A.acceptSuggestion(c, "desk", { ok: true, value: "SF-Desk 4", reason: "Not used since Sep 3." });
  assert.equal(ok, true);
  assert.equal(c.values.desk, "SF-Desk 4");
  assert.deepEqual(c.acceptedSource.desk, {
    value: "SF-Desk 4", by: "Hayley", at: "2026-09-11T10:00:00.000Z",
    reason: "Not used since Sep 3.", source: "suggester",
  });
  assert.deepEqual(A.persisted, ["c1"], "and it is saved");
});

test("acceptedSource is the third provenance, distinct from the other two", () => {
  // bot 10 must be able to answer which of the three a field is.
  const A = accepter();
  const c = cand();
  A.acceptSuggestion(c, "desk", { ok: true, value: "SF-Desk 4", reason: "r" });
  assert.equal(c.sheetSource, undefined, "not sheet-owned");
  assert.ok(c.acceptedSource.desk.source === "suggester", "and not merely typed");
  const { provenanceOf } = require("../bots/sheet-sync")._internal;
  assert.equal(provenanceOf(c, "desk", c.values.desk), "accepted");
});

test("a field with no option is never accepted", () => {
  const A = accepter();
  const c = cand();
  assert.equal(A.acceptSuggestion(c, "desk", { ok: false, reason: "No desk free on Sep 13." }), false);
  assert.equal(A.acceptSuggestion(c, "desk", null), false);
  assert.deepEqual(c.values, {}, "nothing written");
  assert.deepEqual(A.persisted, [], "and nothing saved");
});

test("accept all takes what exists and names what it skipped", () => {
  const A = accepter();
  const c = cand();
  const res = A.acceptAll(c, {
    driName: { ok: true, value: "FDS-Advait S", display: "Advait Shroff", reason: "Has not partnered." },
    desk:    { ok: false, reason: "No desk free on Sep 13 to Sep 15." },
    computer:{ ok: true, value: "SF-Poetic 1", reason: "Not used since Sep 3." },
  });
  assert.deepEqual(res.took, ["Partner", "Laptop"], "the two good ones are accepted");
  assert.equal(c.values.driName, "FDS-Advait S");
  assert.equal(c.values.computer, "SF-Poetic 1");
  assert.equal(c.values.desk, undefined, "and the one with no option is untouched");
  assert.deepEqual(res.skipped, ["Desk: No desk free on Sep 13 to Sep 15."]);
});

test("the skipped report is the SAME string the panel shows, from one function", () => {
  // Your condition: not a paraphrase, not "1 field skipped", and not a second
  // code path that can drift as the rules change.
  const A = accepter();
  const s = { ok: false, reason: "No FDS partner free on these dates." };
  const shown = A.suggNoOption("Partner", s);
  const reported = A.acceptAll(cand(), { driName: s }).skipped[0];
  assert.equal(reported, shown, "identical, because both call suggNoOption");
  assert.equal(shown, "Partner: No FDS partner free on these dates.");
  // and all three renderers call it
  assert.match(html, /esc\(suggNoOption\(label, s\)\)/, "the card");
  assert.match(html, /esc\(suggNoOption\(label, sg\)\)/, "the panel");
  assert.match(html, /skipped\.push\(suggNoOption\(pair\[1\], s\)\)/, "the report");
});

test("the reason itself comes from the suggester, not from the view", () => {
  // One code path from the rule to every reader of it.
  const real = S.suggestDesk({ span: sp("2026-09-13", "2026-09-15"), today: TODAY, current: "TBD",
    trials: INV.DESKS.map((d) => ({ span: sp("2026-09-13", "2026-09-15"), desk: d })) });
  assert.equal(real.ok, false);
  const A = accepter();
  assert.equal(A.suggNoOption("Desk", real), "Desk: No desk free on Sep 13 to Sep 15.");
});

test("accepting re-renders and puts the same panel back", () => {
  // A render replaces every bar, so without this the panel would close and the
  // skipped fields would vanish with it. A report that disappears is not one.
  assert.match(html, /function renderKeepingPanel\(id\)\{[\s\S]*?render\(\);[\s\S]*?renderCandidateDetail\(\);/);
  assert.match(html, /if\(acceptSuggestion\(c,t\.getAttribute\("data-f"\),s\)\) renderKeepingPanel\(id\);/);
  assert.match(html, /var res=acceptAll\(c,en\.sugg\);\s*\n\s*renderKeepingPanel\(id\);/);
});

test("a field with no option gets no Accept control", () => {
  // A disabled button would imply there might be something to accept.
  const fn = html.slice(html.indexOf("  function panelSuggestions(entry){"),
                        html.indexOf("  /* Panel markup by candidate id"));
  const noneBranch = fn.slice(fn.indexOf("if (!sg.ok) {"), fn.indexOf("acceptable++"));
  assert.equal(/data-act="accept"/.test(noneBranch), false);
  assert.match(noneBranch, /ps-none/);
  // and Accept all only appears when more than one field actually has an option
  assert.match(fn, /acceptable > 1/);
});

test("the accept controls are in the panel only, never on the card", () => {
  const card = html.slice(html.indexOf("  function suggBlock(entry){"),
                          html.indexOf("  /**\n   * The wording when a field has no option"));
  assert.equal(/data-act="accept/.test(card), false, "the card is display");
  assert.equal(/<button/.test(card), false);
  const panel = html.slice(html.indexOf("  function panelSuggestions(entry){"),
                           html.indexOf("  /* Panel markup by candidate id"));
  assert.match(panel, /data-act="accept"/);
  assert.match(panel, /data-act="acceptall"/);
});

test("the card leads with a count, so it reads as waiting rather than settled", () => {
  // Your condition. At one column the value chips wrap; the count is what
  // survives at the top of the wrap, and it names no value so it cannot be
  // mistaken for one.
  const fn = html.slice(html.indexOf("  function suggBlock(entry){"),
                        html.indexOf("  /**\n   * The wording when a field has no option"));
  assert.match(fn, /<span class="sugg-count">' \+ open \+ " suggested<\/span>"/);
  assert.match(fn, /if \(s\.driName\.ok\) open\+\+/, "counts only what can be accepted");
  assert.match(fn, /var count = open\s*\n?\s*\? /, "and says nothing when there is nothing to accept");
  // it is still not a control: the card stays display-only
  assert.equal(/<button/.test(fn), false);
});

test("a field with no option does not inflate the count", () => {
  const fn = html.slice(html.indexOf("  function suggBlock(entry){"),
                        html.indexOf("  /**\n   * The wording when a field has no option"));
  // open++ is guarded by .ok on all three
  assert.equal((fn.match(/\.ok\) open\+\+/g) || []).length, 3);
});

/* ================= proposals see each other ================= */

/** suggestAll, sliced out and driven with real candidate rows. */
function board(cands, today) {
  const a = html.indexOf("  function suggestTrials(entries){");
  const b = html.indexOf("  /* Three states, three treatments");
  assert.ok(a >= 0 && b > a, "the suggestion pass moved");
  return new Function("DATEDAY", "DRI", "INVENTORY", "SUGGEST", "EFFECTIVE", "FIELDS", "CANDS", "TODAY", `
    function get(c,k){ return c.values[k]===undefined?FIELDS.defVal(FIELDS.field(k)):c.values[k]; }
    function effective(c,key){ return EFFECTIVE.resolve(c,key,null,get(c,key)); }
    function nameSortKey(c){
      var p=String(c.name||"").trim().split(/\\s+/).filter(Boolean);
      return [(p.length?p[p.length-1]:"").toLowerCase(),(p.length?p[0]:"").toLowerCase()];
    }
    ${html.slice(a, b)}
    var entries = CANDS.map(function(c){
      return { c: c, span: DATEDAY.trialSpan(DATEDAY.parseDay(get(c,"startDate")),
                                             DATEDAY.parseDay(get(c,"endDate"))),
               dri: DRI.resolveDri(effective(c,"driName")) };
    });
    suggestAll(entries, TODAY);
    return entries;
  `)(D, DRI, INV, S, require("../lib/effective"), require("../lib/fields"), cands, today);
}

const bcand = (id, name, start, end, over) => ({
  id, name,
  values: Object.assign({ status: "NOT STARTED", position: "FDS", location: "SF",
                          startDate: start, endDate: end }, over || {}),
});

/* The four real candidates from 11 Sep. Anthony and Charlie overlap on 21 Sep. */
const BOARD = [
  bcand("v", "Vivian (Yiting) G.", "2026-09-17", "2026-09-18"),
  bcand("a", "Anthony El Raachini", "2026-09-20", "2026-09-21"),
  bcand("c", "Charlie Cheesman", "2026-09-21", "2026-09-22"),
  bcand("g", "Andres Galeano", "2026-10-01", "2026-10-02"),
];

test("two overlapping candidates never get the same suggested partner", () => {
  const e = board(BOARD, 20260911);
  const by = {};
  e.forEach((x) => { by[x.c.id] = x.sugg; });
  assert.ok(by.a.driName.ok && by.c.driName.ok, "both get a partner");
  assert.notEqual(by.a.driName.value, by.c.driName.value,
    "Anthony and Charlie share 21 Sep; one person cannot partner two trials at once");
});

test("two overlapping candidates never get the same suggested laptop", () => {
  const e = board(BOARD, 20260911);
  const by = {};
  e.forEach((x) => { by[x.c.id] = x.sugg; });
  assert.ok(by.a.computer.ok && by.c.computer.ok);
  assert.notEqual(by.a.computer.value, by.c.computer.value,
    "one laptop cannot be in two places on 21 Sep");
});

test("two overlapping candidates never get the same suggested desk", () => {
  const e = board(BOARD, 20260911);
  const by = {};
  e.forEach((x) => { by[x.c.id] = x.sugg; });
  assert.notEqual(by.a.desk.value, by.c.desk.value);
});

test("non-overlapping candidates may share, because nothing conflicts", () => {
  const e = board(BOARD, 20260911);
  const by = {};
  e.forEach((x) => { by[x.c.id] = x.sugg; });
  // Vivian 17 to 18 and Andres 1 to 2 Oct overlap nobody
  assert.equal(by.v.desk.value, by.g.desk.value,
    "reusing a desk on separate weeks is correct, not a clash");
});

test("when the set runs out the later candidate gets a reason, not a duplicate", () => {
  // Six FDS partners and four desks; put nine overlapping trials on one day.
  const many = [];
  for (let i = 0; i < 9; i++) many.push(bcand("x" + i, "Cand " + i, "2026-09-21", "2026-09-21"));
  const e = board(many, 20260911);
  const partners = e.map((x) => x.sugg && x.sugg.driName).filter((s) => s && s.ok).map((s) => s.value);
  assert.equal(new Set(partners).size, partners.length, "no partner proposed twice");
  const refused = e.map((x) => x.sugg && x.sugg.driName).filter((s) => s && !s.ok);
  assert.ok(refused.length, "the ones with nobody left are refused");
  assert.match(refused[0].reason, /^No FDS partner free on these dates\./);

  const desks = e.map((x) => x.sugg && x.sugg.desk).filter((s) => s && s.ok).map((s) => s.value);
  assert.equal(new Set(desks).size, desks.length, "and no desk proposed twice");
  assert.ok(desks.length <= INV.DESKS.length);
});

test("a refusal says which blockers are only proposals, and names them", () => {
  // "No partner free" is true against recorded data and still leaves a reader
  // hunting for a booking that does not exist.
  // FDS has six primaries plus two fallbacks, so it takes nine to exhaust it.
  const many = [];
  for (let i = 0; i < 9; i++) many.push(bcand("x" + i, "Cand " + i, "2026-09-21", "2026-09-21"));
  const e = board(many, 20260911);
  const refused = e.map((x) => x.sugg && x.sugg.driName).filter((s) => s && !s.ok);
  assert.equal(refused.length, 1, "exactly the ninth");
  assert.match(refused[0].reason, /suggested for Cand /, "names the candidate holding it");
  assert.match(refused[0].reason, /also only a proposal\.$/);
});

test("a desk adjacent to a proposed desk says the neighbour is a proposal", () => {
  const three = [
    bcand("p", "Priya One", "2026-09-21", "2026-09-21"),
    bcand("q", "Quinn Two", "2026-09-21", "2026-09-21"),
    bcand("r", "Rosa Three", "2026-09-21", "2026-09-21"),
  ];
  const e = board(three, 20260911);
  const reasons = e.map((x) => x.sugg.desk.reason);
  assert.ok(reasons.some((r) => /also only a proposal/.test(r)),
    "at least one is placed against another proposal and says so");
  // and the first one, placed against nothing, no longer overclaims
  assert.match(reasons[0], /No other desk is taken or suggested on these dates\./);
});

test("the first candidate by date gets first claim, and the order is stable", () => {
  const e1 = board(BOARD, 20260911);
  const e2 = board(BOARD.slice().reverse(), 20260911);
  const pick = (es, id) => es.filter((x) => x.c.id === id)[0].sugg.driName.value;
  assert.equal(pick(e1, "a"), pick(e2, "a"), "input order must not change the answer");
  assert.equal(pick(e1, "c"), pick(e2, "c"));
});

test("a candidate does not block itself", () => {
  // Its own row is in the booked list; excluding it is what stops a candidate
  // with a confirmed laptop being refused its own desk suggestion.
  const one = [bcand("s", "Solo Person", "2026-09-21", "2026-09-21",
                     { computer: "SF-Poetic 1", driName: "FDS-Advait S" })];
  const e = board(one, 20260911);
  assert.equal(e[0].sugg.desk.ok, true);
  assert.equal(e[0].sugg.driName, undefined, "already has a partner, so none is proposed");
  assert.equal(e[0].sugg.computer, undefined, "and already has a laptop");
});

test("a proposal blocks an overlapping day and nothing else", () => {
  // It must not count as use. §2.3.3 defines last-partnered as a trial that has
  // ALREADY FINISHED, and two candidates who overlap nobody may correctly be
  // offered the same person.
  const day = sp("2026-09-21");
  const later = sp("2026-09-28");
  const proposal = [{ span: day, personId: "advait", name: "Someone", proposal: true }];
  assert.notEqual(partner({ role: "FDS", span: day, trials: proposal }).personId, "advait",
    "blocked where it overlaps");
  assert.equal(partner({ role: "FDS", span: later, trials: proposal }).personId, "advait",
    "and not ranked down anywhere else");
  // the same for a laptop and a desk
  const lp = [{ span: day, laptop: "SF-Poetic 1", name: "Someone", proposal: true }];
  assert.notEqual(laptop({ span: day, location: "SF", trials: lp }).value, "SF-Poetic 1");
  assert.equal(laptop({ span: later, location: "SF", trials: lp }).value, "SF-Poetic 1");
});

test("non-overlapping candidates are offered the same person, which is correct", () => {
  const e = board(BOARD, 20260911);
  const by = {};
  e.forEach((x) => { by[x.c.id] = x.sugg; });
  // Vivian 17-18, Andres 1-2 Oct: they overlap nobody and nobody else
  assert.equal(by.v.driName.value, by.g.driName.value,
    "a proposal elsewhere does not make somebody look recently used");
});

/* ========= committed, not completed: §2.3.3 as amended 11 Sep ========= */

test("a confirmed FUTURE booking ranks a partner below one with none", () => {
  // §2.3.3 originally said "already finished", which drew the line at past
  // versus future. A booking for next month is a fact about who is spoken for.
  const day = sp("2026-09-20", "2026-09-21");
  const booked = [{ span: sp("2026-10-01", "2026-10-02"), personId: "advait", name: "Andres" }];
  const r = partner({ role: "FDS", span: day, trials: booked });
  assert.notEqual(r.personId, "advait",
    "already booked for 1 Oct, so not the freshest choice for 20 Sep");
  assert.equal(partner({ role: "FDS", span: day }).personId, "advait",
    "and with no booking at all he is still top of the rotation");
});

test("the hole the 30-day tie-break could not reach", () => {
  // A confirmed booking AFTER the trial being scored counted for nothing: not
  // in lastDone because it had not finished, not in recent30 because it is not
  // trailing. So a partner booked for 1 Oct was offered for 17 Sep while the
  // reason said "has not partnered a recorded trial".
  const scoring = sp("2026-09-17", "2026-09-18");
  const after = [{ span: sp("2026-10-01", "2026-10-02"), personId: "advait", name: "Andres" }];
  const r = partner({ role: "FDS", span: scoring, trials: after });
  assert.notEqual(r.personId, "advait");
  assert.equal(/Has not partnered/.test(r.reason) && r.personId === "advait", false);
});

test("a PROPOSED future booking still ranks nobody down", () => {
  // The line is committed versus not, never past versus future.
  const day = sp("2026-09-20", "2026-09-21");
  const proposed = [{ span: sp("2026-10-01", "2026-10-02"), personId: "advait",
                      name: "Andres", proposal: true }];
  assert.equal(partner({ role: "FDS", span: day, trials: proposed }).personId, "advait",
    "nobody has agreed to it, so it is not a fact about anyone's time");
});

test("the wording matches which side of today the booking falls", () => {
  // "Last partnered" about something that has not happened would be false.
  const day = sp("2026-09-25");
  // Everyone else committed LATER than Advait, so Advait is the freshest and
  // his own commitment is still in the future.
  const advait = partner({ role: "FDS", span: day,
    trials: [{ span: sp("2026-10-05"), personId: "advait", name: "Later" }].concat(
      INV.PARTNER_ROLES.FDS.filter((e) => e.person !== "advait")
        .map((e) => ({ span: sp("2026-10-10"), personId: e.person })))});
  assert.equal(advait.personId, "advait");
  assert.match(advait.reason, /^Already booked through Oct 5\./,
    "not 'last partnered', which would be false about a future date");

  const past = partner({ role: "FDS", span: day,
    trials: INV.PARTNER_ROLES.FDS.filter((e) => e.person !== "advait")
      .map((e) => ({ span: sp("2026-09-24"), personId: e.person }))
      .concat([{ span: sp("2026-09-02"), personId: "advait" }]) });
  assert.equal(past.personId, "advait");
  assert.match(past.reason, /^Last partnered Sep 2\./, "past tense for a finished trial");
});

test("accepting a suggestion visibly moves the next one", () => {
  // The property that makes accept feel correct.
  const before = board(BOARD, 20260911);
  const firstPick = before.filter((x) => x.c.id === "v")[0].sugg.driName;
  assert.equal(firstPick.ok, true);

  // accept it for Vivian, exactly as the panel would
  const accepted = BOARD.map((c) => JSON.parse(JSON.stringify(c)));
  accepted[0].values.driName = firstPick.value;
  const after = board(accepted, 20260911);
  const anthony = after.filter((x) => x.c.id === "a")[0].sugg.driName;
  assert.notEqual(anthony.value, firstPick.value,
    "the rotation moved because a real booking now exists");
});

test("the partner reason cross-references another card's proposal", () => {
  const e = board(BOARD, 20260911);
  const by = {};
  e.forEach((x) => { by[x.c.id] = x.sugg; });
  // Anthony and Andres are both offered the person already proposed for Vivian
  const anthony = by.a.driName;
  assert.equal(anthony.value, by.v.driName.value, "same person, no clash");
  assert.match(anthony.reason, /Also proposed for Vivian \(Yiting\) G\. on Sep 17/);
  assert.match(anthony.reason, /which is only a proposal\.$/);
  // and Vivian, who is first, has nothing to cross-reference
  assert.equal(/Also proposed for/.test(by.v.driName.reason), false);
});

test("the cross-reference names several cards when there are several", () => {
  const day = sp("2026-09-25");
  const trials = [
    { span: sp("2026-09-20"), personId: "advait", name: "Vivian", proposal: true },
    { span: sp("2026-09-22"), personId: "advait", name: "Charlie", proposal: true },
  ];
  const r = partner({ role: "FDS", span: day, trials });
  assert.equal(r.personId, "advait");
  assert.match(r.reason, /Also proposed for Vivian and Charlie on Sep 20 and Sep 22, which are only proposals\./);
});

/* ========= the alias map and the inventory must agree (11 Sep) =========
   Nine of twenty-five candidates with a partner resolved to null, across eight
   distinct short forms, so a third of the recorded history did not exist as far
   as the rotation was concerned. personFor handled sheet labels and full
   canonical names; the sheet mostly holds short forms. */

test("every spelling the alias map knows resolves to a person id", () => {
  /* Derived, not a list written down here, which would go stale the moment a
     spelling is added. The alias map is the human-confirmed record of what the
     sheet actually contains, and it is the closest thing to production data
     this suite can read: I cannot query /api/state. If a spelling is added
     there and the inventory has no matching person, this fails. */
  const raw = [];
  for (const canonical of Object.keys(DRI.DRI_ALIASES)) raw.push(...DRI.DRI_ALIASES[canonical]);
  assert.equal(raw.length, 18, "sanity: the whole map is being walked");

  const unresolved = raw.filter((r) => !INV.personFor(r));
  assert.deepEqual(unresolved, [],
    "these appear in the sheet and resolve to nobody: " + unresolved.join(", "));
});

test("the eight short forms that were silently dropped now resolve", () => {
  // Named because each was a real trial that had disappeared.
  const observed = {
    "Advait": "advait",        // Laura C, 13 to 14 Aug
    "MZ": "mz",                // Sri Chebrolu, 13 Aug
    "Shashank": "shashank",    // Gar Walsh, 11 to 12 Aug
    "Shantam": "shantam",      // Gustavo Torres and Natnael Kassaw
    "Sam H": "samh",           // Shayaan Sultan, 31 Aug
    "Dillon": "dillon",        // Devansh Gupta, 31 Aug to 1 Sep
    "Dan K": "dan",            // Sam Lisowski, 1 Sep
    "Alex Morgan": "alex",     // Arush Mehrotra, 2 Sep
  };
  for (const [raw, id] of Object.entries(observed)) {
    assert.equal(INV.personFor(raw), id, raw + " must resolve to " + id);
  }
});

test("the alias map's canonical and the inventory's name are one spelling", () => {
  // Alex Morgan and Dan K were reconciled by NAME rather than by adding
  // aliases, so there is one spelling of each person and not two systems that
  // have to be kept in step.
  for (const canonical of Object.keys(DRI.DRI_ALIASES)) {
    const id = INV.personFor(canonical);
    assert.ok(id, "no person for canonical name " + canonical);
    assert.equal(INV.displayName(id), canonical,
      "the inventory calls " + id + " '" + INV.displayName(id) +
      "' while the alias map calls them '" + canonical + "'");
  }
});

test("personFor consults the alias map, it does not reimplement it", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "assignment-inventory.js"), "utf8");
  assert.match(src, /var r = DRI\.resolveDri\(value\);/);
  assert.match(src, /factory\(root\.DRI\)/, "and receives it in the browser too");
  assert.match(src, /factory\(require\("\.\/dri-aliases"\)\)/);
});

/* ---- a failed lookup must never read as an answer ---- */

test("an unresolvable name is REPORTED, not treated as no history", () => {
  /* THE DEFECT CLASS. A null became "Has not partnered a recorded trial" and
     was shown to a person as a fact about somebody who had. Same shape as the
     Runbook QA Debrief bug and the blank calendar: a lookup that failed read
     as an answer. */
  const clean = partner({ role: "FDS", span: sp("2026-09-20") });
  assert.equal(clean.reason.includes("may be incomplete"), false,
    "nothing unresolved, so no caveat");

  const dirty = partner({ role: "FDS", span: sp("2026-09-20"), unresolved: ["Pat Q"] });
  assert.match(dirty.reason, /One partner name on the board \(Pat Q\) does not match anybody/);
  assert.match(dirty.reason, /recorded history may be incomplete/);
});

test("several unresolvable names are all named", () => {
  const r = partner({ role: "FDS", span: sp("2026-09-20"), unresolved: ["Pat Q", "Sam Q", "Pat Q"] });
  assert.match(r.reason, /2 partner names on the board \(Pat Q and Sam Q\) do not match anybody/,
    "deduplicated and listed");
});

test("the card carrying the unmatched name says so", () => {
  assert.match(html, /if \(!INVENTORY\.personFor\(raw\)\) \{/);
  assert.match(html, /e\.unknownPartner = String\(raw\)\.trim\(\);/);
  assert.match(html, /if\(e\.unknownPartner\) flags\.push\("Partner name not recognised: "\+e\.unknownPartner\);/);
});

test("Advait ranks below a partner with no history, once his trial counts", () => {
  // Laura C, 13 to 14 Aug, recorded as the bare string "Advait". It resolved to
  // null, so it never happened as far as the rotation was concerned, and that
  // is why he was on three cards.
  const lauraC = [{ span: sp("2026-08-13", "2026-08-14"),
                    personId: INV.personFor("Advait"), name: "Laura C" }];
  assert.equal(lauraC[0].personId, "advait", "the string resolves now");
  const r = partner({ role: "FDS", span: sp("2026-09-20", "2026-09-21"), trials: lauraC });
  assert.notEqual(r.personId, "advait", "somebody with no history outranks him");
  assert.match(r.reason, /^No recorded trial for this person\./);
  // and he is still eligible, just not first
  const onlyHim = INV.PARTNER_ROLES.FDS.filter((e) => e.person !== "advait" && e.tier !== "trainee")
    .map((e) => ({ span: sp("2026-09-20"), personId: e.person }));
  assert.equal(partner({ role: "FDS", span: sp("2026-09-20"), trials: onlyHim.concat(lauraC) }).personId,
    "advait", "he is the only one free, so he is offered");
});
