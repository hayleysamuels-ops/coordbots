"use strict";
// The usage log: who signed in, what they opened and what they did, for the
// emails in ADMIN_EMAILS to read at /usage (usage-page.js). On only where
// Google sign-in is on and ADMIN_EMAILS is set (server.js); elsewhere nothing
// is recorded and /usage doesn't exist.
//
// One file per day in DISPLAY_TIMEZONE, <dataDir>/usage/YYYY-MM-DD.jsonl, one
// event per line, only ever appended to. Files older than RETENTION_DAYS are
// deleted (prune()); the privacy page says 90 days, so keep them in step.
//
// An event: { at, who, via, session?, event, detail?, candidateId? }
//   who      the verified Google email, or null for the shared password
//            (shown as "dashboard password", never a typed name)
//   via      "google" | "password"
//   session  a random id per password sign-in, so two password sessions can
//            be told apart without saying whose they are
// Never recorded: note text, IP addresses, anything from Ashby beyond a
// candidate's name and id.

const fs = require("fs");
const path = require("path");

const RETENTION_DAYS = 90;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

// What each event is called on the page. The browser may only send the
// first four (server.js checks); the rest are recorded by the server itself.
const EVENTS = {
  tab: "Opened tab",
  queue: "Chose queue view",
  section: "Jumped to section",
  ashby: "Opened in Ashby",
  page: "Opened the dashboard",
  signin: "Signed in",
  signin_refused: "Sign-in refused",
  signout: "Signed out",
  hide: "Hid",
  snooze: "Snoozed",
  restore: "Restored",
  note_saved: "Saved a note",
  note_deleted: "Deleted a note",
  refresh: "Pressed refresh",
  usage_view: "Opened the usage log",
};
const BROWSER_EVENTS = new Set(["tab", "queue", "section", "ashby"]);

const clean = (v, max) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, max) : null);

function dayOf(ms, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

function createUsageLog({ dataDir, timeZone, admins = [], now = () => Date.now(), log = console }) {
  const dir = path.join(dataDir, "usage");
  const adminSet = new Set(admins);
  const people = new Set();

  const files = () => {
    try { return fs.readdirSync(dir).filter((f) => DAY_FILE.test(f)).sort().reverse(); } catch (_) { return []; }
  };
  const readDay = (file) => {
    let text = "";
    try { text = fs.readFileSync(path.join(dir, file), "utf8"); } catch (_) { return []; }
    const out = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { const e = JSON.parse(line); if (e && typeof e.at === "number" && EVENTS[e.event]) out.push(e); } catch (_) { /* a torn line: skip it */ }
    }
    return out;
  };
  const personOf = (e) => e.who || "password";

  // `viewer` is req.viewer (signin.js), or null for an event with nobody
  // signed in (a refused sign-in); `who` then names the account if known.
  function record(viewer, event, { detail = null, candidateId = null, who = null, via = null } = {}) {
    if (!EVENTS[event]) return;
    const entry = { at: now() };
    if (viewer && viewer.method === "google") Object.assign(entry, { who: viewer.email, via: "google" });
    else if (viewer && viewer.method === "password") Object.assign(entry, { who: null, via: "password" }, viewer.session ? { session: viewer.session } : {});
    else Object.assign(entry, { who: clean(who, 200), via: via || null });
    entry.event = event;
    if (clean(detail, 200)) entry.detail = clean(detail, 200);
    if (clean(candidateId, 80)) entry.candidateId = clean(candidateId, 80);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, dayOf(entry.at, timeZone) + ".jsonl"), JSON.stringify(entry) + "\n");
      people.add(personOf(entry));
    } catch (e) {
      // A usage entry is never worth failing the action it records.
      log.warn(`[usage] Couldn't record ${event}: ${e.message}`);
    }
  }

  // Newest first. `day` (YYYY-MM-DD) limits it to one day; `person` is an
  // email or "password"; admins' own events are left out unless
  // includeAdmins. `offset`/`limit` page through what's left.
  function list({ day = null, person = null, includeAdmins = false, offset = 0, limit = 500 } = {}) {
    const rows = [];
    let skipped = 0, more = false;
    for (const file of files()) {
      if (day && file !== day + ".jsonl") continue;
      const entries = readDay(file).sort((a, b) => b.at - a.at);
      for (const e of entries) {
        if (person && personOf(e) !== person) continue;
        if (!includeAdmins && e.who && adminSet.has(e.who)) continue;
        if (skipped < offset) { skipped++; continue; }
        if (rows.length === limit) { more = true; break; }
        rows.push(e);
      }
      if (more) break;
    }
    return { rows, more };
  }

  // Everyone with an event still on file, for the person filter.
  function listPeople() {
    return [...people].sort((a, b) => (a === "password") - (b === "password") || a.localeCompare(b));
  }

  // Delete day files older than RETENTION_DAYS. Only this log's own files,
  // in its own folder.
  function prune() {
    const cutoff = dayOf(now() - RETENTION_DAYS * 86400000, timeZone);
    let removed = 0;
    for (const file of files()) {
      if (file.slice(0, 10) >= cutoff) continue;
      try { fs.unlinkSync(path.join(dir, file)); removed++; } catch (e) { log.warn(`[usage] Couldn't delete ${file}: ${e.message}`); }
    }
    if (removed) log.log(`[usage] Deleted ${removed} day file${removed === 1 ? "" : "s"} older than ${RETENTION_DAYS} days.`);
    people.clear();
    for (const file of files()) for (const e of readDay(file)) people.add(personOf(e));
    return removed;
  }

  function start() {
    prune();
    setInterval(prune, 6 * 3600000).unref();
  }

  return { record, list, listPeople, prune, start, days: () => files().map((f) => f.slice(0, 10)), isAdmin: (email) => adminSet.has(email) };
}

module.exports = { createUsageLog, EVENTS, BROWSER_EVENTS, RETENTION_DAYS, dayOf };
