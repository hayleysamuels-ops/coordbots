"use strict";
const { peopleOf } = require("./panel");
// Loads scheduling-rules/<clientId>.json (see schema.json there) for the
// dashboard's SCHEDULING_CLIENT_ID. Only the fields the dashboard reads are
// checked here, plus the cross-field rules JSON Schema can't express. A
// missing or invalid file never falls back to a guessed default: the problem
// is kept and reported (503) on first use, so an in-person default can't
// silently hide a video interviewer.
const fs = require("fs");
const path = require("path");

const RULES_DIR = path.join(__dirname, "..", "..", "scheduling-rules");
const MODES = ["in_person", "video"];
const EMAIL = /^[^@\sA-Z]+@[^@\sA-Z]+\.[^@\sA-Z]+$/;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function invalid(message) { throw Object.assign(new Error(message), { status: 503 }); }

function checkHours(hours, where) {
  if (hours === null) return;
  if (!hours || typeof hours !== "object") invalid(`${where} must be an hours object or null.`);
  if (!TIME.test(hours.start || "") || !TIME.test(hours.end || "") || hours.end <= hours.start) invalid(`${where} needs a start before its end.`);
  try { new Intl.DateTimeFormat("en", { timeZone: hours.timezone }); } catch (_) { invalid(`${where} has an invalid time zone.`); }
}

function parseRules(doc, clientId) {
  if (!doc || doc.schemaVersion !== 2) invalid("Scheduling rules must be schema version 2.");
  if (doc.clientId !== clientId) invalid(`Scheduling rules are for "${doc.clientId}", not "${clientId}".`);
  if (!Number.isInteger(doc.rulesRevision) || doc.rulesRevision < 1) invalid("Scheduling rules need a rulesRevision.");
  const { minBreakMinutes, maxGapMinutes, maxGapCount = 0 } = doc.agenda || {};
  if (!Number.isInteger(minBreakMinutes) || !Number.isInteger(maxGapMinutes) || maxGapMinutes < minBreakMinutes) invalid("agenda.maxGapMinutes must be at least minBreakMinutes.");
  if (!Number.isInteger(maxGapCount) || maxGapCount < 0 || maxGapCount > 29) invalid("agenda.maxGapCount must be a whole number from 0 to 29.");
  if (maxGapCount > 0 && maxGapMinutes < 5) invalid("agenda.maxGapMinutes must be at least 5 when breaks are allowed.");
  const hours = doc.meetingHours || {};
  checkHours(hours.default ?? null, "meetingHours.default");
  for (const [email, h] of Object.entries(hours.overrides || {})) { if (!EMAIL.test(email)) invalid(`meetingHours override "${email}" must be a lowercase email.`); checkHours(h, `meetingHours override for ${email}`); }
  const attendance = doc.attendance || {};
  if (!MODES.includes(attendance.default)) invalid("attendance.default must be in_person or video.");
  const overrides = attendance.overrides || {};
  for (const [email, mode] of Object.entries(overrides)) {
    if (!EMAIL.test(email)) invalid(`attendance override "${email}" must be a lowercase email.`);
    if (!MODES.includes(mode)) invalid(`attendance override for ${email} must be in_person or video.`);
  }
  const limitsPolicy = doc.limits?.ashbyInterviewerLimits;
  if (!["ignore", "zero_only", "enforce"].includes(limitsPolicy)) invalid("limits.ashbyInterviewerLimits must be ignore, zero_only or enforce.");
  const busy = doc.busy || {};
  if (!["none", "google_freebusy"].includes(busy.source) || !Array.isArray(busy.calendars)) invalid("busy.source and busy.calendars are required.");
  const hourOverrides = hours.overrides || {};
  const placement = doc.sessions?.placementWindows ?? [];
  if (!Array.isArray(placement)) invalid("sessions.placementWindows must be a list.");
  for (const w of placement) {
    if (!["exact", "contains"].includes(w.match) || typeof w.value !== "string" || !w.value.trim()) invalid("Each placement window needs match (exact or contains) and a session name.");
    if (!TIME.test(w.earliestStart || "") || !TIME.test(w.latestStart || "") || w.latestStart < w.earliestStart) invalid(`The placement window for "${w.value}" needs an earliest start no later than its latest start.`);
    if (w.latestEnd !== undefined && (!TIME.test(w.latestEnd) || w.latestEnd <= w.earliestStart)) invalid(`The placement window for "${w.value}" needs a latest end later than its earliest start.`);
    try { new Intl.DateTimeFormat("en", { timeZone: w.timezone }); } catch (_) { invalid(`The placement window for "${w.value}" has an invalid time zone.`); }
  }
  // No agenda on these weekdays, judged in their own time zone (Luminai: WFH Wednesdays).
  const ex = doc.agenda.excludedWeekdays;
  const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  if (ex !== undefined) {
    if (!ex || !Array.isArray(ex.days) || !ex.days.length || ex.days.length > 6 || ex.days.some(d => !WEEKDAYS.includes(d)) || new Set(ex.days).size !== ex.days.length) invalid("agenda.excludedWeekdays.days must list 1–6 distinct weekdays (sun–sat).");
    try { new Intl.DateTimeFormat("en", { timeZone: ex.timezone }); } catch (_) { invalid("agenda.excludedWeekdays needs a valid time zone."); }
  }
  // An ordered interviewer preference for named sessions (Luminai: Gabrielle
  // hosts Welcome): `emails` tried first, in order; `lastResort` only when
  // everyone else is busy; one job's sessions only, with `jobId`.
  const preferred = doc.sessions?.preferredInterviewers ?? [];
  if (!Array.isArray(preferred)) invalid("sessions.preferredInterviewers must be a list.");
  for (const p of preferred) {
    if (!["exact", "contains"].includes(p.match) || typeof p.value !== "string" || !p.value.trim()) invalid("Each preferred-interviewer rule needs match (exact or contains) and a session name.");
    if (p.jobId !== undefined && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(p.jobId)) invalid(`The preferred interviewers for "${p.value}" name a job that isn't a lowercase Ashby job ID.`);
    const first = p.emails ?? [], last = p.lastResort ?? [];
    if (!Array.isArray(first) || !Array.isArray(last) || !first.length && !last.length || [...first, ...last].some(e => !EMAIL.test(e))) invalid(`The preferred interviewers for "${p.value}" must be lowercase emails, first or last resort.`);
    if (new Set([...first, ...last]).size !== first.length + last.length) invalid(`The preferred interviewers for "${p.value}" list someone twice.`);
  }
  // Interviewer load (Luminai): among the free people for a session, one with
  // `overrideGap` or more interviews that week than the lightest is passed
  // over, whatever the preference order; the post says so. Weeks run Monday to
  // Sunday in `timezone`. Only sessions the person gives feedback on count,
  // and never those matching `notCounted` (Lunch). Optional: none without it.
  const loadDoc = doc.interviewerLoad;
  if (loadDoc !== undefined) {
    try { new Intl.DateTimeFormat("en", { timeZone: loadDoc?.timezone }); } catch (_) { invalid("interviewerLoad needs a valid time zone."); }
    if (!Number.isInteger(loadDoc.overrideGap) || loadDoc.overrideGap < 1 || loadDoc.overrideGap > 20) invalid("interviewerLoad.overrideGap must be a whole number from 1 to 20.");
    if (!Array.isArray(loadDoc.notCounted) || loadDoc.notCounted.some(w => !["exact", "contains"].includes(w?.match) || typeof w.value !== "string" || !w.value.trim())) invalid("interviewerLoad.notCounted must list session names, each with match (exact or contains).");
    if (typeof loadDoc.reason !== "string" || !loadDoc.reason.trim()) invalid("interviewerLoad needs a reason.");
  }
  // Interviews in one activity of which only one runs per candidate (the FDE
  // onsites' two coding exercises), per job. Names match whatever dash is used,
  // ignoring case and spacing, as worker/plan-reader.js matches them.
  const titleKey = t => String(t || "").replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
  const alternatives = doc.sessions?.alternatives ?? [];
  if (!Array.isArray(alternatives)) invalid("sessions.alternatives must be a list.");
  const alternativeTitles = new Map();
  for (const a of alternatives) {
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(a?.jobId || "")) invalid("Each alternatives rule needs a lowercase Ashby job ID.");
    if (typeof a.label !== "string" || !a.label.trim()) invalid(`The alternatives rule for job ${a.jobId} needs a label (what the interviews are, e.g. "coding interviews").`);
    if (!Array.isArray(a.interviews) || a.interviews.some(t => typeof t !== "string" || !t.trim()) || new Set(a.interviews.map(titleKey)).size !== a.interviews.length || a.interviews.length < 2) invalid(`The alternatives rule for job ${a.jobId} needs two or more different interview names.`);
    if (typeof a.reason !== "string" || !a.reason.trim()) invalid(`The alternatives rule for job ${a.jobId} needs a reason.`);
    const seen = alternativeTitles.get(a.jobId) || new Set();
    for (const t of a.interviews) { if (seen.has(titleKey(t))) invalid(`"${t}" is in two alternatives rules for job ${a.jobId}.`); seen.add(titleKey(t)); }
    alternativeTitles.set(a.jobId, seen);
  }
  const debriefs = doc.debriefs;
  if (debriefs !== undefined && (typeof debriefs?.afterOnsiteConfirmed !== "boolean" || typeof debriefs?.meetingHoursExempt !== "boolean")) invalid("debriefs needs afterOnsiteConfirmed and meetingHoursExempt, each true or false.");
  // The Ashby account an ambiguous interviewer name means. Keys are matched
  // the way booking-facts.js matches names: spaces collapsed, case ignored.
  const nameKey = v => String(v || "").replace(/\s+/g, " ").trim().toLowerCase();
  const identities = new Map();
  const identityDoc = doc.interviewerIdentities;
  if (identityDoc !== undefined) {
    if (!identityDoc || typeof identityDoc.overrides !== "object" || Array.isArray(identityDoc.overrides) || !identityDoc.overrides) invalid("interviewerIdentities.overrides must map names to an email and a reason.");
    for (const [name, o] of Object.entries(identityDoc.overrides)) {
      const key = nameKey(name);
      if (!key) invalid("An interviewer identity override needs a name.");
      if (identities.has(key)) invalid(`There are two interviewer identity overrides for "${name}".`);
      if (!EMAIL.test(o?.email || "")) invalid(`The interviewer identity override for "${name}" must give a lowercase email.`);
      if (typeof o.reason !== "string" || !o.reason.trim()) invalid(`The interviewer identity override for "${name}" needs a reason.`);
      identities.set(key, o.email);
    }
  }
  const norm = v => String(v || "").trim().toLowerCase();
  const matches = (w, title) => w.match === "exact" ? norm(title) === norm(w.value) : norm(title).includes(norm(w.value));
  return {
    clientId, rulesRevision: doc.rulesRevision,
    // Every rule that names something in Ashby (a job, a session, a person),
    // as validated above, for the drift audit (audit.js) to check against
    // Ashby with the matchers below rather than its own copies of them.
    entries: {
      alternatives: alternatives.map(a => ({ jobId: a.jobId, label: a.label.trim(), interviews: [...a.interviews] })),
      preferredInterviewers: preferred.map(p => ({ match: p.match, value: p.value, ...(p.jobId ? { jobId: p.jobId } : {}), emails: [...(p.emails ?? [])], lastResort: [...(p.lastResort ?? [])] })),
      placementWindows: placement.map(w => ({ match: w.match, value: w.value })),
      notCounted: loadDoc ? loadDoc.notCounted.map(w => ({ match: w.match, value: w.value })) : [],
      identities: Object.entries(identityDoc?.overrides || {}).map(([name, o]) => ({ name, email: o.email })),
      hourOverrides: Object.keys(hourOverrides),
      attendanceOverrides: Object.keys(overrides),
    },
    // Whether a session-name rule ({ match, value }) applies to this title, as
    // preferenceFor, placementFor and loadCounts decide it.
    sessionMatches: (rule, title) => matches(rule, title),
    agenda: { singleDay: doc.agenda.singleDay === true, minBreakMinutes, maxGapMinutes, maxGapCount, excludedWeekdays: ex ? { days: [...ex.days], timezone: ex.timezone, reason: ex.reason || null } : null },
    // This job's alternatives, as the template reader takes them: [] when none.
    alternativesFor: jobId => alternatives.filter(a => a.jobId === String(jobId || "").toLowerCase()).map(a => ({ label: a.label.trim(), titles: [...a.interviews] })),
    alternativeKey: titleKey,
    // Emails to try first, in order, and last, for this session name on this
    // job. A rule for the job replaces any rule for every job on that session.
    preferenceFor: (title, jobId) => {
      const all = preferred.filter(p => matches(p, title) && (p.jobId === undefined || p.jobId === String(jobId || "").toLowerCase()));
      const own = all.filter(p => p.jobId !== undefined), use = own.length ? own : all;
      const first = [...new Set(use.flatMap(p => p.emails ?? []))];
      return { first, last: [...new Set(use.flatMap(p => p.lastResort ?? []))].filter(e => !first.includes(e)) };
    },
    interviewerLoad: loadDoc ? { timezone: loadDoc.timezone, overrideGap: loadDoc.overrideGap, notCounted: loadDoc.notCounted.map(w => ({ match: w.match, value: w.value })), reason: loadDoc.reason } : null,
    loadCounts: title => !loadDoc || !loadDoc.notCounted.some(w => matches(w, title)),
    debriefs: debriefs ? { afterOnsiteConfirmed: debriefs.afterOnsiteConfirmed, meetingHoursExempt: debriefs.meetingHoursExempt } : { afterOnsiteConfirmed: false, meetingHoursExempt: false },
    limitsPolicy, busy: { source: busy.source, calendars: [...busy.calendars] },
    // The overriding email for this interviewer name, or null.
    identityFor: name => identities.get(nameKey(name)) || null,
    hasAttendanceOverrides: Object.keys(overrides).length > 0,
    attendanceFor: email => overrides[String(email || "").toLowerCase()] || attendance.default,
    // Every placement window whose pattern matches this Ashby interview name
    // (case-insensitive, surrounding spaces ignored); a session must satisfy all.
    placementFor: title => placement.filter(w => w.match === "exact" ? norm(title) === norm(w.value) : norm(title).includes(norm(w.value)))
      .map(w => ({ match: w.match, value: w.value, timezone: w.timezone, earliestStart: w.earliestStart, latestStart: w.latestStart, ...(w.latestEnd !== undefined ? { latestEnd: w.latestEnd } : {}) })),
    // Always an assumption (schema: meetingHours). `source` says which rule
    // applied; null hours means the interviewer has none and can't be scheduled.
    meetingHoursFor: email => {
      const key = String(email || "").toLowerCase();
      if (Object.hasOwn(hourOverrides, key)) return { hours: hourOverrides[key], source: "override" };
      return hours.default ? { hours: hours.default, source: "default" } : { hours: null, source: null };
    },
  };
}

function loadRules({ clientId, dir = RULES_DIR, log = console }) {
  let rules = null, error = null;
  try {
    if (!clientId || !/^[a-z0-9-]+$/.test(clientId)) invalid("SCHEDULING_CLIENT_ID is not a valid rules file name.");
    const file = path.join(dir, `${clientId}.json`);
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { invalid(`Scheduling rules could not be read from scheduling-rules/${clientId}.json.`); }
    rules = parseRules(doc, clientId);
    log.log(`[rules] Loaded scheduling-rules/${clientId}.json revision ${rules.rulesRevision}`);
  } catch (e) {
    error = e;
    log.warn(`[rules] ${e.message} Posting agenda options will refuse until this is fixed.`);
  }
  return { get: () => { if (error) throw error; return rules; } };
}

// One attendance mode per agenda event, from its chosen interviewer. Names
// are resolved to Ashby emails (the rules' key) only when an override exists;
// otherwise everyone takes the default and no lookup is needed. Only the
// chosen interviewers are resolved, not every eligible one.
// A panel (panel.js) is one session: video when anyone on it joins by video,
// since the room then needs a link, else in person.
async function attendanceForEvents(rules, events, resolveInterviewers) {
  if (!rules.hasAttendanceOverrides) return events.map(() => rules.attendanceFor(null));
  const session = list => list.some(a => a === "video") ? "video" : list[0];
  // Calendar-checked options already carry each interviewer's resolved email.
  if (events.every(e => peopleOf(e).length && peopleOf(e).every(p => p?.email))) return events.map(e => session(peopleOf(e).map(p => rules.attendanceFor(p.email))));
  if (!resolveInterviewers) invalid("Interviewer identities can't be resolved, so attendance can't be confirmed.");
  const flat = events.flatMap((e, i) => peopleOf(e).map(p => ({ i, name: p.name })));
  const { sessions } = await resolveInterviewers(flat.map(x => ({ assignmentVerified: true, title: events[x.i].title, eligibleInterviewers: [{ name: x.name }] })));
  return events.map((e, i) => session(sessions.filter((_, k) => flat[k].i === i).map(s => rules.attendanceFor(s.eligibleInterviewers[0].email))));
}

module.exports = { loadRules, parseRules, attendanceForEvents, RULES_DIR };
