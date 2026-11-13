"use strict";
// The weekly scheduling audit (audit.js), so a rename nobody mentions is found
// without anyone remembering to run a script. Mondays from 9am Pacific (after
// the 8am digest), once a week: Ashby is read, and checked against this
// client's rules file (the loaded rules, as the scheduler has them) and the
// worker's own parsed job lists (worker "booking-settings").
//
// SCHEDULING_AUDIT: "on" posts in the scheduling channel when anything has
// drifted, and only then: the drift lines, marked "still" when last week's
// post had them too. "log" writes the full report to the log instead. A
// week without drift posts nothing and logs one line.
//
// Lists the worker can't give are a finding, not a skip: the post says they
// weren't checked. A failed Ashby read is tried again each hour; the third
// failure in a week is said in the channel once, since an audit that silently
// stops is the failure it exists to catch.
//
// <DATA_DIR>/scheduling-audit.json keeps the week last done, the titles
// snapshot (renames are found against it; Ashby keeps no rename history),
// the drift lines last posted, and failures this week.
const fs = require("fs");
const path = require("path");
const { readAshby, audit, renderReport, renderDrift, ITEM } = require("./audit");

const ZONE = "America/Los_Angeles";
const local = (ms, zone) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
    .formatToParts(ms).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: p.weekday };
};
// The Monday that starts this week, as a date: the week's key.
const weekOf = (ms, zone) => { let t = ms; while (local(t, zone).weekday !== "Mon") t -= 86400000; return local(t, zone).date; };
const MAX_FAILURES = 3;

function createAuditWatch({ mode = "off", apiKey, rules, worker, dataDir, channelId, slackApi, now = () => Date.now(), log = console, zone = ZONE, tickMs = 3600000, read = readAshby }) {
  const file = path.join(dataDir, "scheduling-audit.json");
  const load = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return {}; } };
  const save = s => { fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(file + ".tmp", JSON.stringify(s, null, 2)); fs.renameSync(file + ".tmp", file); };

  // The worker's lists, parsed by the worker itself; a failure is a finding.
  async function workerLists() {
    try {
      const s = await worker();
      return { lists: { compose: s.composeJobs, send: s.sendJobs } };
    } catch (e) { return { listsError: String(e.message || e).slice(0, 160) }; }
  }

  async function run({ post = mode === "on" } = {}) {
    const state = load(), t = now(), week = weekOf(t, zone);
    let loadedRules = null, rulesError = null;
    try { loadedRules = rules?.get() || null; } catch (e) { rulesError = e.message; }
    const { lists, listsError } = await workerLists();
    let data;
    try { data = await read({ apiKey, now: t, log }); }
    catch (e) {
      const failures = (state.failuresWeek === week ? state.failures || 0 : 0) + 1;
      log.warn(`[audit] Ashby couldn't be read (${e.message}); try ${failures} of ${MAX_FAILURES} this week.`);
      const next = { ...state, failuresWeek: week, failures };
      if (failures >= MAX_FAILURES) {
        next.week = week;
        if (post) await slackApi.notice({ channel: channelId, text: `The weekly scheduling audit couldn't read Ashby (${e.message}) after ${failures} tries, so nothing was checked this week. Run scripts/scheduling-audit.js by hand.` })
          .catch(err => log.warn(`[audit] The failure couldn't be posted: ${err.message}`));
      }
      save(next);
      return null;
    }
    const report = await audit({ data, rules: loadedRules, lists, previous: state.snapshot || null });
    // What couldn't be checked is drift too: a silent skip is the failure.
    if (listsError) report.drift.unshift({ kind: "lists_unread", job: null, text: `The worker's job lists couldn't be read (${listsError}), so BOOKING_COMPOSE_JOBS and BOOKING_SEND_JOBS weren't checked this week.` });
    if (rulesError) report.drift.unshift({ kind: "rules_unread", job: null, text: `The scheduling rules couldn't be loaded (${rulesError}), so they weren't checked this week.` });
    const text = renderDrift(report, { seen: new Set(state.driftLines || []) });
    if (mode === "log" || !post) log.warn(`[audit] Weekly audit (not posted, SCHEDULING_AUDIT is "${mode}"):\n${renderReport(report)}`);
    else if (text) {
      await slackApi.notice({ channel: channelId, text });
      log.warn(`[audit] Posted ${report.drift.length} drift finding${report.drift.length === 1 ? "" : "s"}.`);
    }
    if (!text) log.warn(`[audit] Weekly audit: nothing drifted (${report.blocking.length} onboarding blocker${report.blocking.length === 1 ? "" : "s"}, ${report.notices.length} notes; run the script for the full report).`);
    save({ week, at: new Date(t).toISOString(), snapshot: report.snapshot, driftLines: report.drift.map(ITEM) });
    return report;
  }

  let busy = false;
  async function tick() {
    if (mode !== "on" && mode !== "log") return;
    if (busy) return;
    busy = true;
    try {
      const t = now(), here = local(t, zone), state = load();
      if (here.weekday !== "Mon" || here.hour < 9) return;
      if (state.week === weekOf(t, zone)) return;
      await run();
    } catch (e) { log.warn(`[audit] The weekly audit failed: ${e.message}`); }
    finally { busy = false; }
  }
  function start() {
    if (mode !== "on" && mode !== "log") { log.log?.('[audit] off (SCHEDULING_AUDIT isn\'t "on" or "log")'); return () => {}; }
    log.warn(`[audit] ${mode}: weekly on Mondays from 9am Pacific; ${mode === "on" ? "posts in the channel when anything drifted" : "logs the report, posts nothing"}`);
    const first = setTimeout(tick, 60000), timer = setInterval(tick, tickMs);
    first.unref?.(); timer.unref?.();
    return () => { clearTimeout(first); clearInterval(timer); };
  }
  return { run, tick, start };
}

module.exports = { createAuditWatch, weekOf };
