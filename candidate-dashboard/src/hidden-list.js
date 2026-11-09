"use strict";
// The Action queue's Hidden & snoozed tab: every dismissal still in force
// (dismissals.list()), matched against the snapshot BEFORE dismissals are
// applied, so each entry can say what it is hiding right now.
//
// - candidate:<id> hides that candidate from every candidate section;
//   `sections` names the ones they'd appear in now.
// - interviewer:<userId> hides an interviewer card (Weekly limits, and
//   Ashby-native training when the tracker is off).
// - schedule:<id>:<updatedAt> hides one Ready to schedule submission. One
//   that matches nothing is left out: the submission has changed in Ashby
//   (which brings it back on its own) or is gone, so it hides nothing.
//
// A candidate or interviewer hidden but not on the dashboard right now is
// still listed (onDashboard: false), so a Hide can always be found and
// restored. Its name is the one saved when it was hidden; entries from
// before names were saved have none.

function hiddenEntries(dismissed, snap, { candidateKeys, interviewerKeys, disabledSections = [] }) {
  const off = new Set(disabledSections);
  const rowsIn = (keys, match) => {
    const sections = [], rows = [];
    for (const key of keys) {
      if (off.has(key)) continue;
      const hits = (snap[key] || []).filter(match);
      if (hits.length) { sections.push(key); rows.push(...hits); }
    }
    return { sections, row: rows[0] || null };
  };
  const out = [];
  for (const d of dismissed) {
    const [kind, ...rest] = d.key.split(":");
    const id = rest.join(":");
    let found, name, url = null, jobTitle = null;
    if (kind === "candidate") {
      found = rowsIn(candidateKeys, (x) => x.candidateId === id);
      name = found.row && found.row.candidateName;
      url = found.row && found.row.ashbyProfileUrl;
      jobTitle = found.row && found.row.jobTitle;
    } else if (kind === "interviewer") {
      found = rowsIn(interviewerKeys, (x) => x.userId === id);
      name = found.row && (found.row.name || found.row.interviewerName);
    } else if (kind === "schedule") {
      found = rowsIn(["readyToSchedule"], (x) => x.dismissKey === d.key);
      if (!found.row) continue;
      name = found.row.candidateName;
      jobTitle = found.row.jobTitle;
    } else continue;
    out.push({
      key: d.key,
      kind,
      name: name || d.label || null,
      jobTitle: jobTitle || null,
      ashbyProfileUrl: url || null,
      sections: found.sections,
      onDashboard: found.sections.length > 0,
      scope: d.scope,
      expiresAt: d.expiresAt,
      hiddenAt: d.hiddenAt,
      by: d.by,
      byVerified: d.byVerified === true,
    });
  }
  // On the dashboard first, then most recently hidden; entries with no
  // hiddenAt (from before it was saved) last.
  return out.sort((a, b) => (b.onDashboard - a.onDashboard) || ((b.hiddenAt || 0) - (a.hiddenAt || 0)));
}

module.exports = { hiddenEntries };
