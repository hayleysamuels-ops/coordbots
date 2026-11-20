"use strict";

/**
 * The Friday summary: the work week so far, in one Slack DM that can be
 * forwarded as-is, plus a thread reply with per-coordinator lines that is
 * for Hayley only.
 *
 * Scope is the same as alerts: Carrara-coordinated work at active clients.
 * Every figure compares Monday through today against the SAME weekdays of
 * each of the previous 4 weeks, averaged — Mon–Fri against Mon–Fri, never
 * against whole weeks, or every Friday would read as a drop.
 *
 * Interviews are counted by the day they are scheduled to run, so today's
 * later interviews are already in. At 3pm Denver that is close to a full
 * Friday; the message says "through Friday" and does not pretend otherwise.
 *
 * Flags reuse the alert rule (15% with the same small-number guards), so
 * the Friday message and the daily alerts never disagree about what is
 * significant.
 */

const config = require("./config");
const store = require("./db");
const metrics = require("./metrics");
const alerts = require("./alerts");

const { db } = store;
const A = config.alerts;
const W = config.weekly;
const DAY = 86400000;

// --- Day keys --------------------------------------------------------------

function addDays(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function localNow(timeZone, now) {
  return metrics.localBuckets(new Date(now).toISOString(), timeZone);
}

/**
 * This week so far and the same span in each baseline week, as half-open
 * [from, to) day keys in one zone. `to` is tomorrow, so today counts.
 */
function weekSpans(timeZone, now) {
  const today = localNow(timeZone, now);
  const monday = today.week;
  const to = addDays(today.day, 1);
  const current = { from: monday, to };
  const baseline = [];
  for (let k = 1; k <= A.baselineWeeks; k += 1) baseline.push({ from: addDays(monday, -7 * k), to: addDays(to, -7 * k) });
  return { current, baseline, monday, today: today.day };
}

const within = (key, span) => key >= span.from && key < span.to;
const round1 = (n) => Math.round(n * 10) / 10;
const hoursText = (n) => `${round1(n)} business hour${round1(n) === 1 ? "" : "s"}`;

function sumSpan(series, span, field) {
  return series.filter((r) => within(r.key, span)).reduce((acc, r) => acc + (r[field] || 0), 0);
}

function avgSpans(series, spans, field) {
  return spans.reduce((acc, s) => acc + sumSpan(series, s, field), 0) / spans.length;
}

// --- Queries ---------------------------------------------------------------

// Interviews on the calendar for a future window, as known at a moment in
// time: created on or before `asOf`, starting inside [from, to). Cancelled
// schedules are left out on both sides of the comparison.
const selectBookedAhead = db.prepare(`
  SELECT e.start_time, e.created_at, s.scheduled_by_name, i.title AS interview_title
  FROM events e
  JOIN schedules s       ON s.client_id = e.client_id AND s.id = e.schedule_id
  LEFT JOIN interviews i ON i.client_id = e.client_id AND i.id = e.interview_id
  WHERE e.client_id = ? AND e.start_time >= ? AND e.start_time < ?
    AND COALESCE(s.status, '') != 'Cancelled'
`);

const selectBookingsByScheduler = db.prepare(`
  SELECT e.created_at, s.scheduled_by_name, i.title AS interview_title
  FROM events e
  JOIN schedules s       ON s.client_id = e.client_id AND s.id = e.schedule_id
  LEFT JOIN interviews i ON i.client_id = e.client_id AND i.id = e.interview_id
  WHERE e.client_id = ? AND e.created_at >= ? AND s.scheduled_by_name IS NOT NULL
`);

// --- Formatting ------------------------------------------------------------

function changeText(current, baseline, { slowerIsUp = false } = {}) {
  if (!baseline) return current ? "new this week" : "no change";
  const pct = Math.round(((current - baseline) / baseline) * 100);
  if (pct === 0) return "level with usual";
  const arrow = pct > 0 ? "▲" : "▼";
  const word = slowerIsUp ? (pct > 0 ? " slower" : " faster") : "";
  return `${arrow} ${Math.abs(pct)}%${word}`;
}

function flag(hit) {
  if (!hit) return "";
  return hit.severity === "major" ? " :red_circle:" : " :large_orange_circle:";
}

function shortDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// --- Build -----------------------------------------------------------------

/**
 * Computes the summary. Returns { main, coordinators, data } where `main`
 * and `coordinators` are Slack mrkdwn strings and `data` is the raw
 * figures (used by the preview route and the tests).
 */
function build(now = Date.now()) {
  const active = config.clients.filter((c) => c.apiKey && !c.isEnded);
  const sinceIso = new Date(now - (7 * (A.baselineWeeks + 2)) * DAY).toISOString();

  const team = { events: 0, eventsBase: 0, hours: 0, hoursBase: 0 };
  const turnCurrent = [];
  const turnBase = [];
  const ahead = { current: 0, base: 0 };
  const clients = [];
  const skipped = [];

  for (const client of active) {
    const payload = metrics.getClient(client.id);
    if (!payload || !payload.scopes || !payload.scopes.coordinated) {
      skipped.push(client.name);
      continue;
    }
    const tz = client.timeZone;
    const spans = weekSpans(tz, now);
    const daily = payload.scopes.coordinated.series.daily;
    const roster = alerts.rosterSetOf(client);
    const ours = (name) => roster.has(config.normalizeName(name));

    // Volume and hours.
    const events = sumSpan(daily, spans.current, "events");
    const eventsBase = avgSpans(daily, spans.baseline, "events");
    team.events += events;
    team.eventsBase += eventsBase;
    team.hours += sumSpan(daily, spans.current, "hours");
    team.hoursBase += avgSpans(daily, spans.baseline, "hours");
    clients.push({ name: client.name, events, eventsBase, hit: alerts.significant(events, eventsBase) });

    // Booking turnaround, pooled across clients: the team's typical wait.
    for (const s of metrics.turnaroundSamples(client, sinceIso)) {
      if (!ours(s.name)) continue;
      const day = metrics.localBuckets(s.at, tz).day;
      if (within(day, spans.current)) turnCurrent.push(s.hours);
      else if (spans.baseline.some((b) => within(day, b))) turnBase.push(s.hours);
    }

    // Next week's load: what is on the calendar for next Mon–Sun now,
    // against what was on the calendar for the week after each baseline
    // week at the same moment. Comparing against whole finished weeks
    // would always read as low, since next week is still being booked.
    const nextMonday = addDays(spans.monday, 7);
    const countAhead = (asOfMs, mondayKey) => {
      // Day keys are local; widen the instant range by a day either side
      // and filter on the local key, so zones can't shift a boundary.
      const fromIso = new Date(Date.parse(`${mondayKey}T00:00:00Z`) - DAY).toISOString();
      const toIso = new Date(Date.parse(`${addDays(mondayKey, 7)}T00:00:00Z`) + DAY).toISOString();
      const asOf = new Date(asOfMs).toISOString();
      const span = { from: mondayKey, to: addDays(mondayKey, 7) };
      return selectBookedAhead
        .all(client.id, fromIso, toIso)
        .filter(
          (r) =>
            r.created_at && r.created_at <= asOf && ours(r.scheduled_by_name) &&
            !metrics.isExcludedTitle(r.interview_title, client.excludedTitleKeywords) &&
            within(metrics.localBuckets(r.start_time, tz).day, span)
        ).length;
    };
    ahead.current += countAhead(now, nextMonday);
    let baseAhead = 0;
    for (let k = 1; k <= A.baselineWeeks; k += 1) baseAhead += countAhead(now - 7 * k * DAY, addDays(nextMonday, -7 * k));
    ahead.base += baseAhead / A.baselineWeeks;
  }

  const turn = {
    current: turnCurrent.length ? alerts.median(turnCurrent) : null,
    base: turnBase.length ? alerts.median(turnBase) : null,
    sample: turnCurrent.length,
  };
  const turnEnough = turnCurrent.length >= A.minSample && turnBase.length >= A.minSample;

  const volumeHit = alerts.significant(team.events, team.eventsBase);
  const hoursHit = alerts.significant(team.hours, team.hoursBase);
  // Only a slowdown is flagged; faster is shown, not flagged.
  const turnHit = turnEnough ? alerts.significant(turn.current, turn.base, { kind: "hours", watch: "up" }) : null;
  const aheadHit = alerts.significant(ahead.current, ahead.base);

  const spans = weekSpans(A.timeZone, now);
  const label = `${shortDate(spans.monday)}–${shortDate(spans.today)}`;
  const openAlerts = alerts.activeAlerts({ includeCoordinators: false });

  const lines = [];
  lines.push(`*Coordinator metrics: week of ${shortDate(spans.monday)}* (Mon–${localNow(A.timeZone, now).dow === 5 ? "Fri" : "today"}, ${label})`);
  lines.push(`_Carrara-coordinated work at active clients, compared with the same days in each of the previous ${A.baselineWeeks} weeks._`);
  lines.push("");
  lines.push("*Overall*");
  lines.push(`• Interviews coordinated: *${team.events}* (${changeText(team.events, team.eventsBase)} vs ${round1(team.eventsBase)} usual)${flag(volumeHit)}`);
  lines.push(`• Interview hours: *${Math.round(team.hours)}h* (${changeText(team.hours, team.hoursBase)})${flag(hoursHit)}`);
  if (turnEnough) {
    lines.push(
      `• Booking speed: median *${hoursText(turn.current)}* from stage entered to booked ` +
        `(${changeText(turn.current, turn.base, { slowerIsUp: true })} vs ${round1(turn.base)}, ${turn.sample} bookings)${flag(turnHit)}`
    );
  } else {
    lines.push(`• Booking speed: too few bookings this week to compare (${turn.sample})`);
  }
  lines.push(
    `• Next week already booked: *${ahead.current}* interviews (${changeText(ahead.current, ahead.base)} vs ${round1(ahead.base)} ` +
      `booked by this point in a typical week)${flag(aheadHit)}`
  );

  const shown = clients.filter((c) => c.events > 0 || c.eventsBase >= 1).sort((a, b) => b.events - a.events);
  if (shown.length) {
    lines.push("");
    lines.push("*By client* (interviews coordinated)");
    for (const c of shown) lines.push(`• ${c.name}: ${c.events} (${changeText(c.events, c.eventsBase)} vs ${round1(c.eventsBase)})${flag(c.hit)}`);
  }

  lines.push("");
  if (openAlerts.length) {
    lines.push(`*Open alerts* (${openAlerts.length}, last 7 full days vs the 4 weeks before)`);
    for (const a of openAlerts) lines.push(`• ${a.message}`);
  } else {
    lines.push("*Open alerts*: none");
  }
  if (skipped.length) lines.push(`_Not included yet (no data computed): ${skipped.join(", ")}_`);
  lines.push("");
  lines.push(":red_circle: / :large_orange_circle: = a 15%+ change worth a look (red is 30%+).");
  if (A.dashboardUrl) lines.push(`<${A.dashboardUrl}|Open the dashboard>`);

  const coordinators = buildCoordinators(active, sinceIso, now);

  return {
    main: lines.join("\n"),
    coordinators,
    data: { team, turn, ahead, clients, openAlerts: openAlerts.length, flags: { volumeHit, hoursHit, turnHit, aheadHit } },
  };
}

/**
 * Per-coordinator lines, for the thread reply. Same rules as the alerts:
 * roster names matched exactly, pooled across clients, bucketed in
 * ALERT_TIMEZONE, excluded people left out. Workload, not performance.
 */
function buildCoordinators(active, sinceIso, now) {
  const tz = A.timeZone;
  const spans = weekSpans(tz, now);
  const excluded = new Set(A.excludeCoordinators.map(config.normalizeName));
  const display = new Map();
  const people = new Map(); // key -> { booked: rows, turn: rows }
  const get = (key) => {
    if (!people.has(key)) people.set(key, { booked: [], turn: [] });
    return people.get(key);
  };

  for (const client of active) {
    const roster = alerts.rosterSetOf(client);
    for (const n of client.coordinators || []) display.set(config.normalizeName(n), n);
    for (const row of selectBookingsByScheduler.all(client.id, sinceIso)) {
      const key = config.normalizeName(row.scheduled_by_name);
      if (!roster.has(key) || excluded.has(key)) continue;
      if (metrics.isExcludedTitle(row.interview_title, client.excludedTitleKeywords)) continue;
      get(key).booked.push({ key: metrics.localBuckets(row.created_at, tz).day, events: 1 });
    }
    for (const s of metrics.turnaroundSamples(client, sinceIso)) {
      const key = config.normalizeName(s.name);
      if (!roster.has(key) || excluded.has(key)) continue;
      get(key).turn.push({ day: metrics.localBuckets(s.at, tz).day, hours: s.hours });
    }
  }

  const rows = [...people.entries()]
    .map(([key, p]) => {
      const booked = sumSpan(p.booked, spans.current, "events");
      const bookedBase = avgSpans(p.booked, spans.baseline, "events");
      const cur = p.turn.filter((r) => within(r.day, spans.current)).map((r) => r.hours);
      const base = p.turn.filter((r) => spans.baseline.some((b) => within(r.day, b))).map((r) => r.hours);
      const turnOk = cur.length >= A.minSample && base.length >= A.minSample;
      return {
        name: display.get(key) || key,
        booked, bookedBase,
        bookedHit: alerts.significant(booked, bookedBase),
        turn: turnOk ? { current: alerts.median(cur), base: alerts.median(base) } : null,
      };
    })
    .filter((r) => r.booked > 0 || r.bookedBase >= 1)
    // Alphabetical, like the roster panel: ordered by volume it reads as a
    // leaderboard whatever the heading says.
    .sort((a, b) => a.name.localeCompare(b.name));

  const lines = ["*Coordinators — for you, not for forwarding*"];
  lines.push("_Interviews each person booked this week, across all clients. Workload signals, not performance: Ashby records who created a booking, not who chased or re-planned it._");
  if (!rows.length) lines.push("No rostered bookings this week.");
  for (const r of rows) {
    let line = `• ${r.name}: ${r.booked} booked (${changeText(r.booked, r.bookedBase)} vs ${round1(r.bookedBase)})${flag(r.bookedHit)}`;
    if (r.turn) line += `; median ${hoursText(r.turn.current)} to book (vs ${round1(r.turn.base)})`;
    lines.push(line);
  }
  return lines.join("\n");
}

// --- Send ------------------------------------------------------------------

/**
 * Sends once per week, on the first check at or after WEEKLY_SUMMARY_HOUR
 * on WEEKLY_SUMMARY_DAY in ALERT_TIMEZONE. Checked on a 5-minute timer so
 * it lands on time rather than waiting for the next hourly sync. A failed
 * send is retried on the next check.
 */
async function maybeSend(now = Date.now()) {
  if (!W.enabled) return { skipped: "disabled" };
  if (!A.slackBotToken || (!A.slackUserId && !A.slackEmail)) return { skipped: "slack not configured" };
  const local = localNow(A.timeZone, now);
  if (local.dow !== W.day || local.hour < W.hour) return { skipped: "not time yet" };
  const last = alerts.getMeta.get("last_weekly_day");
  if (last && last.value === local.day) return { skipped: "already sent" };
  if (!metrics.getOverview()) return { skipped: "metrics not ready" };

  const summary = build(now);
  const channel = await alerts.slackRecipient();
  const posted = await alerts.slack("chat.postMessage", { channel, text: summary.main, unfurl_links: false, unfurl_media: false });
  // The per-person section goes in the thread, so the main message can be
  // forwarded without editing.
  await alerts.slack("chat.postMessage", {
    channel: posted.channel,
    thread_ts: posted.ts,
    text: summary.coordinators,
    unfurl_links: false,
    unfurl_media: false,
  });
  alerts.setMeta.run("last_weekly_day", local.day);
  return { sent: true };
}

let timer = null;
function start() {
  if (timer || !W.enabled) return;
  const tick = () =>
    maybeSend()
      .then((r) => r.sent && console.log("[weekly] Friday summary sent"))
      .catch((err) => console.error(`[weekly] send failed: ${err.message}`));
  timer = setInterval(tick, 5 * 60 * 1000);
  timer.unref();
  console.log(`[weekly] summary scheduled for day ${W.day} after ${W.hour}:00 ${A.timeZone}`);
}

module.exports = { build, maybeSend, start, weekSpans, addDays };
