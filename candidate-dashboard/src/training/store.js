"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");

// Persisted state for the interviewer training tracker. Ashby owns none of
// this: `interviewerPool.addUser` is the only interviewer-pool write endpoint
// Ashby exposes, so there is no API to enrol someone in a training path, set
// their stage, pause them, or change a required count. This app therefore
// keeps its own enrolment list and derives progress from scheduled
// interviews (see progress.js), writing nothing back to Ashby.
//
// Lives alongside dismissals.json / reschedule-tracking.json under
// config.dataDir — point DATA_DIR (or attach a Railway volume) at persistent
// storage or every enrolment is lost on redeploy.
const FILE = path.join(config.dataDir, "interviewer-training.json");

// {
//   paths:      { [pathId]: Path },
//   enrolments: { [`${userId}:${pathId}`]: Enrolment },
// }
//
// A Path is one Ashby interview title scoped to one job ("Coding Interview —
// Backend Engineer"). It stores resolved interviewIds rather than matching on
// the title string at read time, so renaming an interview in Ashby can't
// silently orphan a path — but it keeps interviewTitle too, so a NEW Ashby
// interview record sharing that title/job can be surfaced as a suggestion
// rather than silently absorbed or silently ignored (see progress.js).
//
// Why title+job and not the interview id alone: confirmed against Forus's
// live org, neither is unique on its own. One record can serve two jobs
// (`[Forus] Portfolio Prioritization Work Time` covered both Strategic
// Accounts Lead and Enterprise CSM), and one job can be split across two
// same-titled records (`[Tandem - Software Engineer] Technical Phone Screen`
// exists twice, both used for Security Operations Lead). Keying on the id
// alone would merge two roles' training in the first case and split one
// role's in half in the second, where neither half ever reaches its required
// count.
let store = { paths: {}, enrolments: {} };

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    store = {
      paths: (parsed && parsed.paths) || {},
      enrolments: (parsed && parsed.enrolments) || {},
    };
  } catch (err) {
    store = { paths: {}, enrolments: {} }; // missing/corrupt file -> start empty
  }
}

function save() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.warn("[training] save failed:", err.message);
  }
}

function enrolmentKey(userId, pathId) {
  return `${userId}:${pathId}`;
}

// ---------------------------------------------------------------- paths

function listPaths() {
  return Object.values(store.paths);
}

function getPath(pathId) {
  return store.paths[pathId] || null;
}

// interviewIds is the resolved set at creation time; jobId scopes it to one
// role. requiredShadows/requiredReverseShadows default to 2 + 2 — this app's
// own default, NOT Ashby's. Forus's single enabled Ashby training path is
// configured Shadow:1 + Shadow:1 + ReverseShadow:1 and every trainee on it
// sits at 0 of 1, so there was no existing configuration worth inheriting.
function upsertPath({ id, label, interviewTitle, interviewIds, jobId, jobTitle, requiredShadows, requiredReverseShadows }) {
  const pathId = id || crypto.randomUUID();
  const existing = store.paths[pathId];
  store.paths[pathId] = {
    id: pathId,
    label: label || `${interviewTitle} — ${jobTitle}`,
    interviewTitle,
    interviewIds: [...new Set(interviewIds || [])],
    jobId,
    jobTitle,
    requiredShadows: Number.isFinite(requiredShadows) ? requiredShadows : (existing ? existing.requiredShadows : 2),
    requiredReverseShadows: Number.isFinite(requiredReverseShadows) ? requiredReverseShadows : (existing ? existing.requiredReverseShadows : 2),
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
  };
  save();
  return store.paths[pathId];
}

// Adds an interview id to an existing path — used when progress.js spots a
// new Ashby interview record matching this path's title and job and someone
// accepts the suggestion.
function addInterviewIdToPath(pathId, interviewId) {
  const p = store.paths[pathId];
  if (!p || p.interviewIds.includes(interviewId)) return p || null;
  p.interviewIds = [...p.interviewIds, interviewId];
  save();
  return p;
}

// Removing a path removes its enrolments too — an enrolment with no path is
// unreachable in the UI and would silently accumulate.
function removePath(pathId) {
  if (!store.paths[pathId]) return;
  delete store.paths[pathId];
  for (const key of Object.keys(store.enrolments)) {
    if (store.enrolments[key].pathId === pathId) delete store.enrolments[key];
  }
  save();
}

// ----------------------------------------------------------- enrolments

function listEnrolments() {
  return Object.values(store.enrolments);
}

function getEnrolment(userId, pathId) {
  return store.enrolments[enrolmentKey(userId, pathId)] || null;
}

// enrolledAt is the cutoff for counting: only sessions at or after it count
// automatically ("start from today"), so enrolling someone mid-training
// doesn't retroactively complete them from history. Anything they'd already
// done is added deliberately via addManualCredit below.
function enrol({ userId, userName, userEmail, pathId }) {
  const key = enrolmentKey(userId, pathId);
  if (store.enrolments[key]) return store.enrolments[key];
  store.enrolments[key] = {
    userId,
    userName: userName || "",
    userEmail: userEmail || "",
    pathId,
    enrolledAt: new Date().toISOString(),
    // null means "inherit the path's requirement" — an explicit number is a
    // per-person override.
    requiredShadows: null,
    requiredReverseShadows: null,
    state: "active", // "active" | "paused" | "archived"
    pause: null,
    archivedAt: null,
    sessionOverrides: {}, // eventId -> { role, discounted, note }
    manualCredits: [],
  };
  save();
  return store.enrolments[key];
}

function unenrol(userId, pathId) {
  delete store.enrolments[enrolmentKey(userId, pathId)];
  save();
}

function mutate(userId, pathId, fn) {
  const e = store.enrolments[enrolmentKey(userId, pathId)];
  if (!e) return null;
  fn(e);
  save();
  return e;
}

// Pausing records when, why, and when they're expected back. Ashby's own
// isPaused flag is read-only to this app and is a separate concept — it is
// surfaced as a disagreement, never merged with this one (see progress.js).
function pause(userId, pathId, { reason, expectedReturn } = {}) {
  return mutate(userId, pathId, (e) => {
    e.state = "paused";
    e.pause = {
      at: new Date().toISOString(),
      reason: reason || "",
      expectedReturn: expectedReturn || null,
    };
  });
}

function unpause(userId, pathId) {
  return mutate(userId, pathId, (e) => {
    e.state = "active";
    e.pause = null;
  });
}

function archive(userId, pathId) {
  return mutate(userId, pathId, (e) => {
    e.state = "archived";
    e.archivedAt = new Date().toISOString();
  });
}

function unarchive(userId, pathId) {
  return mutate(userId, pathId, (e) => {
    e.state = "active";
    e.archivedAt = null;
  });
}

// Per-person requirement override. null on either field restores the path's
// own requirement rather than pinning the current value.
function setRequirements(userId, pathId, { shadows, reverseShadows }) {
  return mutate(userId, pathId, (e) => {
    e.requiredShadows = Number.isFinite(shadows) ? shadows : null;
    e.requiredReverseShadows = Number.isFinite(reverseShadows) ? reverseShadows : null;
  });
}

// Per-session override. `role` reclassifies a session the sequence rule got
// wrong; `discounted` excludes it entirely — the manual answer to Ashby
// having no RSVP data, so a trainee who no-showed an interview that went
// ahead anyway can be discounted by hand (see progress.js).
function setSessionOverride(userId, pathId, eventId, { role, discounted, note }) {
  return mutate(userId, pathId, (e) => {
    const current = e.sessionOverrides[eventId] || {};
    const next = {
      role: role === undefined ? current.role : role,
      discounted: discounted === undefined ? current.discounted : Boolean(discounted),
      note: note === undefined ? current.note : note,
    };
    if (!next.role && !next.discounted && !next.note) delete e.sessionOverrides[eventId];
    else e.sessionOverrides[eventId] = next;
  });
}

// Credit for a session that happened before enrolment, or outside Ashby
// entirely. Counted exactly like a derived session but carries no event id.
function addManualCredit(userId, pathId, { role, at, note }) {
  return mutate(userId, pathId, (e) => {
    e.manualCredits.push({
      id: crypto.randomUUID(),
      role: role === "ReverseShadow" ? "ReverseShadow" : "Shadow",
      at: at || new Date().toISOString(),
      note: note || "",
    });
  });
}

function removeManualCredit(userId, pathId, creditId) {
  return mutate(userId, pathId, (e) => {
    e.manualCredits = e.manualCredits.filter((c) => c.id !== creditId);
  });
}

load();

module.exports = {
  listPaths,
  getPath,
  upsertPath,
  addInterviewIdToPath,
  removePath,
  listEnrolments,
  getEnrolment,
  enrol,
  unenrol,
  pause,
  unpause,
  archive,
  unarchive,
  setRequirements,
  setSessionOverride,
  addManualCredit,
  removeManualCredit,
  // Test seam: reload from disk after a fixture writes the file directly.
  _reload: load,
  _file: FILE,
};
