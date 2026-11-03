"use strict";
// Every time a declared alternatives pair (scheduling-rules
// sessions.alternatives) appears in full in a schedule's template, one JSON
// line in <DATA_DIR>/alternatives-both.jsonl, so how often it happens can be
// counted. Anna declared the FDE coding exercises as alternatives, and the
// first real candidate took both (Hayley, 2026-11-03): if that keeps
// happening, the declaration is the wrong model and should be dropped rather
// than flagged on every post.
//
// A plan is read many times for one candidate (each preview, auto-post round
// and Suggest), so each read is a line, but `count` is distinct schedules:
// that's the number of candidates. Kept indefinitely; one short line a read.
//
// An entry: { at, jobId, applicationId, scheduleId, label, titles }.
const fs = require("fs");
const path = require("path");

function createAlternativesLog(dataDir, { now = () => Date.now(), log = console } = {}) {
  const file = path.join(dataDir, "alternatives-both.jsonl");
  function read() {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
    return text.split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch (_) { return []; } });
  }
  const pairKey = e => `${e.jobId}|${e.label}`;
  return {
    // Never throws: a failure to record must not stop a plan read.
    record({ jobId, jobTitle, applicationId, scheduleId, label, titles }) {
      try {
        const before = read(), entry = { at: new Date(now()).toISOString(), jobId, applicationId, scheduleId, label, titles };
        const same = before.filter(e => pairKey(e) === pairKey(entry));
        const seen = same.some(e => e.scheduleId === scheduleId);
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        fs.appendFileSync(file, JSON.stringify(entry) + "\n");
        const schedules = new Set([...same.map(e => e.scheduleId), scheduleId]).size;
        log.log(`[alternatives] Both ${label} in the template (${titles.map(t => `"${t}"`).join(" and ")}) on ${jobTitle || jobId}, schedule ${scheduleId}: ${seen ? "seen before for this schedule" : "first time for this schedule"}; ${schedules} schedule${schedules === 1 ? "" : "s"} so far with this pair in full on this job.`);
        return { first: !seen, schedules };
      } catch (e) {
        log.warn(`[alternatives] Couldn't record a pair in full: ${e.message}`);
        return null;
      }
    },
    // Distinct schedules per job and pair, for a quick count.
    counts() {
      const by = new Map();
      for (const e of read()) {
        const k = pairKey(e);
        if (!by.has(k)) by.set(k, { jobId: e.jobId, label: e.label, schedules: new Set(), first: e.at, last: e.at });
        const c = by.get(k); c.schedules.add(e.scheduleId); c.last = e.at;
      }
      return [...by.values()].map(c => ({ ...c, schedules: c.schedules.size }));
    },
  };
}

module.exports = { createAlternativesLog };
