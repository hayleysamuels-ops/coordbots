"use strict";
// The scheduling worker's booking settings, posted in the channel when they
// change. Which jobs the robot may compose and send for live in the worker's
// variables (BOOKING_COMPOSE_JOBS, BOOKING_SEND_JOBS), changed by whoever has
// Railway access with no commit; this is the record of each change people
// see. Every five minutes the worker is asked (read-only); a description
// different from the last one posted is posted, once. The first one read is
// posted too, as the starting point.
//
// What was last posted is kept in <DATA_DIR>/booking-settings.json. A worker
// that can't be asked is skipped until the next round: nothing is posted.
const fs = require("fs"), path = require("path");

// One line per setting, in a fixed order, with job titles where Ashby gives
// them. Jobs and stages are sorted so the same settings always read the same.
function describe(settings, titles = {}) {
  const job = id => titles[id] ? `${titles[id]} (${id})` : id;
  const jobs = list => list?.problem ? `unreadable: ${list.problem}` : Object.keys(list?.jobs || {}).length
    ? Object.keys(list.jobs).sort().map(id => `${job(id)}: ${list.jobs[id] === "all" ? "all stages" : [...list.jobs[id]].sort().join(", ")}`).join("; ")
    : "none";
  return [
    `Ashby check (BOOKING_COMPOSE): ${settings.compose ? "on" : "off"}`,
    `Send (BOOKING_SEND): ${settings.send ? "on" : "off"}`,
    `Jobs it may compose for (BOOKING_COMPOSE_JOBS): ${jobs(settings.composeJobs)}`,
    `Jobs it may send for (BOOKING_SEND_JOBS): ${jobs(settings.sendJobs)}${settings.sendListProblem ? ` (nothing is sent: ${settings.sendListProblem})` : ""}`,
    `Interviewer domains (BOOKING_INTERVIEWER_DOMAINS): ${settings.domains?.length ? [...settings.domains].sort().join(", ") : "none (nothing is sent)"}`,
    `Daily send cap (BOOKING_SEND_DAILY_CAP): ${settings.dailyCap ?? "not set (nothing is sent)"}`,
    `Ashby read key (ASHBY_READ_API_KEY): ${settings.readKey ? "set" : "not set (nothing is composed or sent)"}`,
  ].join("\n");
}

function createBookingSettingsWatch({ worker, dataDir, channelId, slackApi, jobTitle = async () => null, log = console, intervalMs = 300000 }) {
  const file = path.join(dataDir, "booking-settings.json");
  const load = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return {}; } };
  const save = state => { fs.writeFileSync(file + ".tmp", JSON.stringify(state, null, 2)); fs.renameSync(file + ".tmp", file); };
  const titles = {};

  async function round() {
    let settings;
    try { settings = await worker.call("booking-settings"); }
    catch (e) { log.warn(`[booking-settings] The worker couldn't be asked: ${e.message}`); return null; }
    // Titles are compared by job ID, so a title Ashby can't give never reads
    // as a change.
    const ids = [...new Set([settings.composeJobs, settings.sendJobs].flatMap(l => Object.keys(l?.jobs || {})))];
    for (const id of ids) if (!(id in titles)) titles[id] = await jobTitle(id).catch(() => null);
    const key = describe(settings), last = load();
    if (last.key === key) return null;
    const text = describe(settings, titles);
    try { await slackApi.notice({ channel: channelId, text: `${last.key ? "The scheduling worker's booking settings changed. Now:" : "The scheduling worker's booking settings:"}\n${text}` }); }
    catch (e) { log.warn(`[booking-settings] The change couldn't be posted: ${e.message}`); return null; }
    save({ key, postedAt: new Date().toISOString() });
    return text;
  }

  let timer = null;
  return {
    round,
    start() { if (timer) return; const tick = () => round().catch(e => log.warn(`[booking-settings] ${e.message}`)); setTimeout(tick, 30000).unref?.(); timer = setInterval(tick, intervalMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = { createBookingSettingsWatch, describe };
