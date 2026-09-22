"use strict";
/**
 * Suggests candidates who have reached the Work Trial stage in Ashby but have
 * no tracker row.
 *
 * It does NOT create rows. Creating a tracker row is a write, and writes belong
 * to people: this returns proposals, and the browser creates the row through the
 * ordinary candidate save path when a coordinator clicks. Same rule as linking.
 *
 * Manual adds stay a first-class path. Poetic skips stages, so a candidate can
 * be scheduled without ever sitting at Work Trial; this strip is an addition to
 * the "New candidate" button, never a replacement for it.
 */
const CONFIG = require("./ashby-panel.config");
const PRE_TRIAL = require("./pre-trial-sessions.config");
const { mapLimit } = require("../lib/http");
const { deriveTrialWindow } = require("../lib/trialwindow");
const { createTitleResolver } = require("../lib/interviewtitles");

const NAME = "work-trial-suggestions";
const CONCURRENCY = 5;
const CACHE_KEY = "work-trial";

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const tokens = (s) => norm(s).split(" ").filter(Boolean);

function mapPosition(jobTitle) {
  for (const rule of CONFIG.positions || []) {
    if (norm(jobTitle).includes(norm(rule.jobTitleContains))) return rule.position;
  }
  return null;
}

/**
 * How a tracker row's name relates to an Ashby name.
 *   "exact"    — same name once case and punctuation are ignored
 *   "possible" — one contains the other, or they share a surname
 *                ("Shayaan" vs "Shayaan Sultan", "Rob Smith" vs "Robert Smith")
 *   null       — unrelated. "John Smith" and "John Doe" are NOT a match: a
 *                shared first name alone would suggest linking strangers.
 */
function nameRelation(rowName, ashbyName) {
  const a = norm(rowName), b = norm(ashbyName);
  if (!a || !b) return null;
  if (a === b) return "exact";
  if (a.includes(b) || b.includes(a)) return "possible";
  const ta = tokens(a), tb = tokens(b);
  const lastA = ta[ta.length - 1], lastB = tb[tb.length - 1];
  if (lastA && lastA === lastB && lastA.length >= 3) return "possible";
  return null;
}

/* ---------------- fetching ---------------- */
async function fetchFromAshby({ ashby, botStore, log = () => {} }) {
  const apps = await ashby.listActiveApplications();
  const atWorkTrial = apps.filter((a) =>
    norm((a.currentInterviewStage || {}).title).includes(norm(CONFIG.workTrialStageContains))
  );

  const inScope = [];
  let otherRoles = 0;
  for (const a of atWorkTrial) {
    const position = mapPosition((a.job || {}).title);
    if (position) inScope.push({ app: a, position });
    else otherRoles++;
  }
  log("[" + NAME + "] " + apps.length + " active, " + atWorkTrial.length +
      " at Work Trial, " + inScope.length + " in scope, " + otherRoles + " other roles");

  // Trial dates. Three phases, because classifying sessions by identity needs
  // interview titles, and fetching them per candidate mid-loop would re-fetch
  // the same shared ids ("Agent Shadowing" is one id on every FDE row).
  //
  // This strip used to derive its own trial window by flattening every event on
  // the stage — the same bug bot 1 had, in a second copy. It now calls the same
  // lib/trialwindow.js, so the strip and the card cannot disagree.

  // Phase 1 — schedules, one read per candidate.
  const withSchedules = await mapLimit(inScope, CONCURRENCY, async ({ app, position }) => {
    const stageId = (app.currentInterviewStage || {}).id;
    let onStage = [], failed = false;
    try {
      const schedules = await ashby.listSchedulesForApplication(app.id);
      onStage = schedules.filter((s) => s.status !== "Cancelled" && s.interviewStageId === stageId);
    } catch (e) {
      failed = true;
      log("[" + NAME + "] schedule read failed for " + app.id + ": " + e.message);
    }
    return { app, position, onStage, failed };
  });

  // Phase 2 — every title this run needs, in one cached batch.
  const titles = createTitleResolver({ ashby, botStore, concurrency: CONCURRENCY });
  await titles.load(
    withSchedules.flatMap((r) =>
      r.onStage.flatMap((s) => (s.interviewEvents || []).map((e) => e.interviewId))
    )
  );

  // Phase 3 — derive. Local, no I/O.
  const rows = withSchedules.map(({ app, position, onStage, failed }) => {
    const derived = failed
      ? null
      : deriveTrialWindow({
          schedules: onStage,
          titleOf: (id) => titles.get(id),
          preTrialSessions: PRE_TRIAL.sessions,
        });
    const c = app.candidate || {};
    return {
      ashbyCandidateId: String(c.id),
      name: c.name || "(unnamed)",
      email: (c.primaryEmailAddress && (c.primaryEmailAddress.value || c.primaryEmailAddress)) || null,
      position,
      jobTitle: (app.job || {}).title || null,
      applicationId: app.id,
      trialStart: derived ? derived.trial.start : null,
      trialEnd: derived ? derived.trial.end : null,
      preTrial: derived ? derived.preTrial : [],
      dataFlags: derived ? derived.flags : [],
    };
  });

  return { fetchedAt: new Date().toISOString(), candidates: rows, otherRoles };
}

async function load({ ashby, botStore, force, log }) {
  const ttlMs = (CONFIG.cacheMinutes || 15) * 60 * 1000;
  const cached = await botStore.lookupGet("suggestions", CACHE_KEY);
  const fresh = cached && cached.fetchedAt && Date.now() - new Date(cached.fetchedAt).getTime() < ttlMs;
  if (fresh && !force) return { ...cached, fromCache: true };
  try {
    const data = await fetchFromAshby({ ashby, botStore, log });
    await botStore.lookupPut("suggestions", CACHE_KEY, data);
    return data;
  } catch (e) {
    // Never blank: an unreachable Ashby shows the last known set with its age.
    if (cached) return { ...cached, stale: true, error: String(e.message || e) };
    return { fetchedAt: null, candidates: [], otherRoles: 0, stale: true, error: String(e.message || e) };
  }
}

/**
 * Is this candidate live work, or someone parked at the stage?
 *
 *   "unscheduled" — at Work Trial with no trial booked yet. Needs action.
 *   "upcoming"    — trial is ahead of us.
 *   "recent"      — trial ended within suggestRecentDays; the debrief and
 *                   feedback are still live.
 *   "past"        — ended longer ago. Kept, counted, and moved out of the way.
 */
function timing(c, now) {
  if (!c.trialStart) return "unscheduled";
  const endIso = c.trialEnd || c.trialStart;
  const end = new Date(endIso).getTime();
  if (isNaN(end)) return "unscheduled";
  if (end >= now.getTime()) return "upcoming";
  const days = (now.getTime() - end) / 86400000;
  return days <= (CONFIG.suggestRecentDays || 7) ? "recent" : "past";
}

// Needs-action first, then soonest trial, then most recently finished.
const TIMING_ORDER = { unscheduled: 0, upcoming: 1, recent: 2, past: 3 };
function bySuggestionOrder(a, b) {
  const d = TIMING_ORDER[a.timing] - TIMING_ORDER[b.timing];
  if (d) return d;
  const av = a.trialStart || "", bv = b.trialStart || "";
  return a.timing === "recent" ? bv.localeCompare(av) : av.localeCompare(bv);
}

/* ---------------- classification against the tracker ---------------- */
/**
 * Splits the Work Trial set into what to propose. Order matters: an already
 * linked row wins over everything, so a row added by hand and later linked is
 * never suggested again.
 */
function classify({ data, trackerRows, dismissals, now = new Date() }) {
  const linked = new Set(
    trackerRows.map((r) => r.values && r.values.ashbyCandidateId).filter(Boolean).map(String)
  );
  const dismissed = new Map(dismissals.map((d) => [String(d.ashbyCandidateId), d]));
  const unlinkedRows = trackerRows.filter((r) => !(r.values && r.values.ashbyCandidateId));

  const add = [], link = [], possible = [], hidden = [], past = [];
  for (const raw of data.candidates || []) {
    const c = { ...raw, timing: timing(raw, now) };
    if (linked.has(c.ashbyCandidateId)) continue;          // already in the tracker
    if (dismissed.has(c.ashbyCandidateId)) {
      hidden.push({ ...c, dismissal: dismissed.get(c.ashbyCandidateId) });
      continue;
    }
    let exact = null, near = null;
    for (const row of unlinkedRows) {
      const rel = nameRelation(row.name, c.name);
      if (rel === "exact" && !exact) exact = row;
      else if (rel === "possible" && !near) near = row;
    }
    // An unlinked row with this name means link it, never add a second row.
    const entry = exact
      ? { ...c, kind: "link", row: { id: exact.id, name: exact.name } }
      : near
      ? { ...c, kind: "possible", row: { id: near.id, name: near.name } }
      : { ...c, kind: "add" };

    // Only "add" suggestions age out. An unlinked row that matches an Ashby
    // candidate is a defect in data we already hold, not work someone is
    // choosing to take on, so it stays visible however old the trial is.
    if (entry.kind === "link") link.push(entry);
    else if (entry.kind === "possible") possible.push(entry);
    else if (entry.timing === "past") past.push(entry);
    else add.push(entry);
  }
  add.sort(bySuggestionOrder); link.sort(bySuggestionOrder); possible.sort(bySuggestionOrder);
  past.sort(bySuggestionOrder);
  return {
    add, link, possible, past, recentDays: CONFIG.suggestRecentDays || 7,
    dismissed: hidden,
    otherRoles: data.otherRoles || 0,
    fetchedAt: data.fetchedAt || null,
    stale: !!data.stale,
    error: data.error || null,
  };
}

module.exports = { name: NAME, load, classify, _internal: { nameRelation, mapPosition, timing } };
