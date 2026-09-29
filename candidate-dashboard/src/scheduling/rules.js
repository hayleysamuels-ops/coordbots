"use strict";
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
  const { minBreakMinutes, maxGapMinutes } = doc.agenda || {};
  if (!Number.isInteger(minBreakMinutes) || !Number.isInteger(maxGapMinutes) || maxGapMinutes < minBreakMinutes) invalid("agenda.maxGapMinutes must be at least minBreakMinutes.");
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
  return {
    clientId, rulesRevision: doc.rulesRevision,
    agenda: { singleDay: doc.agenda.singleDay === true, minBreakMinutes, maxGapMinutes },
    limitsPolicy, busy: { source: busy.source, calendars: [...busy.calendars] },
    hasAttendanceOverrides: Object.keys(overrides).length > 0,
    attendanceFor: email => overrides[String(email || "").toLowerCase()] || attendance.default,
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
async function attendanceForEvents(rules, events, resolveInterviewers) {
  if (!rules.hasAttendanceOverrides) return events.map(() => rules.attendanceFor(null));
  // Calendar-checked options already carry each interviewer's resolved email.
  if (events.every(e => e.interviewer?.email)) return events.map(e => rules.attendanceFor(e.interviewer.email));
  if (!resolveInterviewers) invalid("Interviewer identities can't be resolved, so attendance can't be confirmed.");
  const { sessions } = await resolveInterviewers(events.map(e => ({ assignmentVerified: true, eligibleInterviewers: [{ name: e.interviewer.name }] })));
  return sessions.map(s => rules.attendanceFor(s.eligibleInterviewers[0].email));
}

module.exports = { loadRules, parseRules, attendanceForEvents, RULES_DIR };
