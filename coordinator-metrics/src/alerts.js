"use strict";

/**
 * Alerts: flags significant slowdowns and changes against each metric's own
 * recent history, then surfaces them two ways — a banner on the dashboard
 * and a once-a-day Slack DM listing anything new.
 *
 * The comparison model matches the rest of the dashboard: no targets, no
 * invented quotas. Every alert is "the last 7 complete days against the
 * average of the 4 weeks before", fired at ALERT_THRESHOLD_PCT (15%).
 *
 * Today is always excluded from the current window. It is only partly
 * elapsed, and counting it would make every morning look like a collapse.
 *
 * Two kinds of metric:
 *
 *   flow   — things that happen over time (interviews held, reschedules,
 *            booking turnaround). Fully computable from history, so these
 *            alert from the first run.
 *   stock  — things that are true right now (scorecards overdue, candidates
 *            waiting on a next step). Ashby keeps no history of either, so
 *            each evaluation records a daily snapshot and the baseline is
 *            the average of those. They stay quiet until a week of
 *            snapshots exists.
 */

const config = require("./config");
const store = require("./db");
const metrics = require("./metrics");

const { db } = store;
const A = config.alerts;
const DAY = 86400000;

db.exec(`
CREATE TABLE IF NOT EXISTS alerts (
  key          TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,      -- 'client' | 'coordinator' | 'system'
  client_id    TEXT,
  subject      TEXT NOT NULL,      -- client name or coordinator name
  metric       TEXT NOT NULL,
  direction    TEXT NOT NULL,      -- 'up' | 'down'
  severity     TEXT NOT NULL,      -- 'notable' | 'major'
  message      TEXT NOT NULL,
  detail       TEXT,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  notified_at  TEXT,
  resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts (resolved_at);

CREATE TABLE IF NOT EXISTS alert_snapshots (
  client_id  TEXT NOT NULL,
  metric     TEXT NOT NULL,
  day        TEXT NOT NULL,
  value      REAL NOT NULL,
  PRIMARY KEY (client_id, metric, day)
);

CREATE TABLE IF NOT EXISTS alert_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT
);
`);

// --- Windows ---------------------------------------------------------------

function dayKey(daysAgo, timeZone, now = Date.now()) {
  return metrics.localBuckets(new Date(now - daysAgo * DAY).toISOString(), timeZone).day;
}

/**
 * The current window and the baseline windows, as half-open [from, to)
 * local day keys. Current is the last 7 complete days; each baseline week
 * is the 7 days before the one after it.
 */
function windows(timeZone, now = Date.now()) {
  const current = { from: dayKey(7, timeZone, now), to: dayKey(0, timeZone, now) };
  const baseline = [];
  for (let k = 1; k <= A.baselineWeeks; k += 1) {
    baseline.push({ from: dayKey(7 * (k + 1), timeZone, now), to: dayKey(7 * k, timeZone, now) });
  }
  return { current, baseline, earliest: baseline[baseline.length - 1].from };
}

const inWindow = (key, w) => key >= w.from && key < w.to;

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round1 = (n) => Math.round(n * 10) / 10;

// --- The rule --------------------------------------------------------------

/**
 * Whether `current` is a significant move from `baseline`.
 *
 * watch: 'both' | 'up' | 'down' — which direction is worth an alert.
 * kind:  'count' applies the small-number guards; 'hours' needs at least
 *        an hour of movement instead.
 */
function significant(current, baseline, { watch = "both", kind = "count" } = {}) {
  if (current == null || baseline == null) return null;
  const diff = current - baseline;
  if (diff === 0) return null;

  const direction = diff > 0 ? "up" : "down";
  if (watch !== "both" && watch !== direction) return null;

  const pct = baseline > 0 ? (diff / baseline) * 100 : Infinity;
  if (Math.abs(pct) < A.thresholdPct) return null;

  if (kind === "count") {
    if (Math.abs(diff) < A.minChange) return null;
    // A drop needs something real to drop from; a rise needs to land on
    // something real. Either way one side clears the minimum.
    if (Math.max(current, baseline) < A.minBaseline) return null;
  } else if (kind === "hours") {
    if (Math.abs(diff) < 1) return null;
  }

  return {
    direction,
    pct: Number.isFinite(pct) ? Math.round(pct) : null,
    severity: Math.abs(pct) >= A.thresholdPct * 2 ? "major" : "notable",
  };
}

function pctText(hit) {
  return hit.pct == null ? "up from ~0" : `${hit.direction} ${Math.abs(hit.pct)}%`;
}

// --- Queries ---------------------------------------------------------------

// Events booked in the window, by who booked them.
const selectBookingsByScheduler = db.prepare(`
  SELECT e.created_at, s.scheduled_by_name, i.title AS interview_title
  FROM events e
  JOIN schedules s       ON s.client_id = e.client_id AND s.id = e.schedule_id
  LEFT JOIN interviews i ON i.client_id = e.client_id AND i.id = e.interview_id
  WHERE e.client_id = ? AND e.created_at >= ? AND s.scheduled_by_name IS NOT NULL
`);

// Scorecards still missing for interviews that ended between 30 days ago
// and FEEDBACK_OVERDUE_HOURS ago. Debriefs have no scorecard. The 30-day
// floor stops a handful of never-coming scorecards from growing forever.
const selectOverdueFeedback = db.prepare(`
  SELECT i.title AS interview_title, s.scheduled_by_name
  FROM events e
  JOIN schedules s       ON s.client_id = e.client_id AND s.id = e.schedule_id
  LEFT JOIN interviews i ON i.client_id = e.client_id AND i.id = e.interview_id
  WHERE e.client_id = ? AND e.has_feedback = 0
    AND e.end_time >= ? AND e.end_time < ?
    AND COALESCE(i.is_debrief, 0) = 0
    AND COALESCE(s.status, '') != 'Cancelled'
`);

// Active candidates whose most recent interview ended NEXT_STEP_WAIT_DAYS
// to 30 days ago and who have nothing booked since — interviewed, then
// left waiting. MAX(end_time) being in the past also rules out anything
// already on the calendar. The scheduler of that last interview decides
// whether the candidate is ours.
const selectWaitingOnNextStep = db.prepare(`
  SELECT a.id, MAX(e.end_time) AS last_end,
         (SELECT s2.scheduled_by_name
            FROM schedules s2 JOIN events e2 ON e2.client_id = s2.client_id AND e2.schedule_id = s2.id
           WHERE s2.client_id = a.client_id AND s2.application_id = a.id
           ORDER BY e2.end_time DESC LIMIT 1) AS last_scheduler
  FROM applications a
  JOIN schedules s ON s.client_id = a.client_id AND s.application_id = a.id AND COALESCE(s.status, '') != 'Cancelled'
  JOIN events e    ON e.client_id = s.client_id AND e.schedule_id = s.id
  WHERE a.client_id = ? AND a.status = 'Active'
  GROUP BY a.id
  HAVING MAX(e.end_time) >= ? AND MAX(e.end_time) < ?
`);

const upsertSnapshot = db.prepare(`
  INSERT INTO alert_snapshots (client_id, metric, day, value) VALUES (?, ?, ?, ?)
  ON CONFLICT (client_id, metric, day) DO UPDATE SET value = excluded.value
`);

const selectSnapshots = db.prepare(`
  SELECT day, value FROM alert_snapshots WHERE client_id = ? AND metric = ? AND day >= ? AND day < ?
`);

const selectLastGoodSync = db.prepare(`
  SELECT MAX(finished_at) AS at FROM sync_runs WHERE client_id = ? AND ok = 1
`);

// --- Metric checks ---------------------------------------------------------

function sumSeries(series, w, field) {
  return series.filter((r) => inWindow(r.key, w)).reduce((acc, r) => acc + (r[field] || 0), 0);
}

function averageOverBaseline(series, win, field) {
  const totals = win.baseline.map((w) => sumSeries(series, w, field));
  return totals.reduce((a, b) => a + b, 0) / totals.length;
}

// Rows of { day, hours }: median of the current week against the median
// of the four weeks before, pooled.
function turnaroundCheck(rows, win) {
  const current = rows.filter((r) => inWindow(r.day, win.current)).map((r) => r.hours);
  const base = rows
    .filter((r) => r.day >= win.earliest && r.day < win.current.from)
    .map((r) => r.hours);
  if (current.length < A.minSample || base.length < A.minSample) return null;
  const cur = median(current);
  const bas = median(base);
  const hit = significant(cur, bas, { watch: "up", kind: "hours" });
  return hit ? { hit, current: round1(cur), baseline: round1(bas), sample: current.length } : null;
}

function snapshotCheck(client, metric, value, today, timeZone, now) {
  upsertSnapshot.run(client.id, metric, today, value);
  const from = dayKey(7 * A.baselineWeeks, timeZone, now);
  const rows = selectSnapshots.all(client.id, metric, from, today);
  if (rows.length < 7) return { warmingUp: true, days: rows.length };
  const baseline = rows.reduce((a, r) => a + r.value, 0) / rows.length;
  const hit = significant(value, baseline, { watch: "up" });
  return hit ? { hit, current: value, baseline: round1(baseline), days: rows.length } : null;
}

function rosterSetOf(client) {
  return new Set((client.coordinators || []).map(config.normalizeName));
}

/**
 * Client alerts watch the Carrara-coordinated scope only: our team's work,
 * booked by someone on that client's roster. At a client-scheduled account
 * like Forus the client's own volume is theirs to watch, not ours.
 */
function evaluateClient(client, sinceIso, now) {
  const out = [];
  const payload = metrics.getClient(client.id);
  if (!payload || !payload.scopes || !payload.scopes.coordinated) return out;

  const tz = client.timeZone;
  const win = windows(tz, now);
  const daily = payload.scopes.coordinated.series.daily;
  const base = { scope: "client", clientId: client.id, subject: client.name };
  const roster = rosterSetOf(client);
  const ours = (name) => roster.has(config.normalizeName(name));

  // 1. Interview volume — a drop or a spike both matter.
  {
    const cur = sumSeries(daily, win.current, "events");
    const bas = averageOverBaseline(daily, win, "events");
    const hit = significant(cur, bas);
    if (hit) {
      out.push({
        ...base, metric: "volume", ...hit,
        message: `${client.name}: interviews we coordinated ${pctText(hit)}`,
        detail: `${cur} in the last 7 days vs a 4-week average of ${round1(bas)}/week`,
      });
    }
  }

  // 2. Reschedules + cancellations — rework, only a rise is a problem.
  {
    const cur = sumSeries(daily, win.current, "reschedules") + sumSeries(daily, win.current, "cancellations");
    const bas = averageOverBaseline(daily, win, "reschedules") + averageOverBaseline(daily, win, "cancellations");
    const hit = significant(cur, bas, { watch: "up" });
    if (hit) {
      out.push({
        ...base, metric: "rework", ...hit,
        message: `${client.name}: reschedules + cancellations ${pctText(hit)}`,
        detail: `${cur} in the last 7 days vs a 4-week average of ${round1(bas)}/week`,
      });
    }
  }

  // 3. Booking turnaround — slowdowns only. Same definition as the
  // Results tile: stage entered → booked, in business hours.
  const samples = metrics.turnaroundSamples(client, sinceIso);
  {
    const rows = samples
      .filter((s) => ours(s.name))
      .map((s) => ({ day: metrics.localBuckets(s.at, tz).day, hours: s.hours }));
    const t = turnaroundCheck(rows, win);
    if (t) {
      out.push({
        ...base, metric: "turnaround", ...t.hit,
        message: `${client.name}: booking turnaround slowed ${Math.abs(t.hit.pct)}%`,
        detail: `median ${t.current} business hours from stage entered to booked over the last 7 days (${t.sample} bookings) vs ${t.baseline} over the 4 weeks before`,
      });
    }
  }

  // 4 & 5. Stocks, measured against their own daily snapshots.
  const today = dayKey(0, tz, now);
  const overdue = selectOverdueFeedback
    .all(
      client.id,
      new Date(now - 30 * DAY).toISOString(),
      new Date(now - A.feedbackOverdueHours * 3600000).toISOString()
    )
    .filter((r) => ours(r.scheduled_by_name) && !metrics.isExcludedTitle(r.interview_title, client.excludedTitleKeywords)).length;
  const fb = snapshotCheck(client, "overdue_feedback", overdue, today, tz, now);
  if (fb && fb.hit) {
    out.push({
      ...base, metric: "overdue_feedback", ...fb.hit,
      message: `${client.name}: overdue scorecards ${pctText(fb.hit)}`,
      detail: `${overdue} interviews we booked are more than ${A.feedbackOverdueHours}h past with no scorecard vs a recent average of ${fb.baseline}`,
    });
  }

  const waiting = selectWaitingOnNextStep
    .all(client.id, new Date(now - 30 * DAY).toISOString(), new Date(now - A.nextStepWaitDays * DAY).toISOString())
    .filter((r) => ours(r.last_scheduler)).length;
  const ns = snapshotCheck(client, "waiting_next_step", waiting, today, tz, now);
  if (ns && ns.hit) {
    out.push({
      ...base, metric: "waiting_next_step", ...ns.hit,
      message: `${client.name}: candidates waiting on a next step ${pctText(ns.hit)}`,
      detail: `${waiting} active candidates last interviewed ${A.nextStepWaitDays}+ days ago with nothing booked since vs a recent average of ${ns.baseline}`,
    });
  }

  return { alerts: out, samples };
}

// --- Per coordinator --------------------------------------------------------

/**
 * Workload signals per rostered coordinator, pooled across every active
 * client and bucketed in ALERT_TIMEZONE. Names come from the roster and
 * match EXACTLY (see CLAUDE.md on the roster) — never a substring.
 *
 * These are not performance measures: Ashby records who created a
 * booking, not who chased or re-planned it. They are a heads-up that
 * someone's load or pace changed, which is why they go to Slack only.
 */
function evaluateCoordinators(activeClients, samplesByClient, sinceIso, now) {
  const tz = A.timeZone;
  const win = windows(tz, now);

  const excluded = new Set(A.excludeCoordinators.map(config.normalizeName));

  const display = new Map(); // normalised -> roster spelling
  for (const c of activeClients) for (const n of c.coordinators || []) display.set(config.normalizeName(n), n);

  const bookings = new Map();
  const turnaround = new Map();
  const push = (map, key, row) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  };

  for (const client of activeClients) {
    const roster = rosterSetOf(client);
    for (const row of selectBookingsByScheduler.all(client.id, sinceIso)) {
      const key = config.normalizeName(row.scheduled_by_name);
      if (!roster.has(key) || excluded.has(key)) continue;
      if (metrics.isExcludedTitle(row.interview_title, client.excludedTitleKeywords)) continue;
      push(bookings, key, { key: metrics.localBuckets(row.created_at, tz).day, events: 1 });
    }
    for (const s of samplesByClient.get(client.id) || []) {
      const key = config.normalizeName(s.name);
      if (!roster.has(key) || excluded.has(key)) continue;
      push(turnaround, key, { day: metrics.localBuckets(s.at, tz).day, hours: s.hours });
    }
  }

  const out = [];
  for (const [key, rows] of bookings) {
    const name = display.get(key) || key;
    const cur = sumSeries(rows, win.current, "events");
    const bas = averageOverBaseline(rows, win, "events");
    const hit = significant(cur, bas);
    if (hit) {
      out.push({
        scope: "coordinator", clientId: null, subject: name, metric: "volume", ...hit,
        message: `${name}: interviews booked ${pctText(hit)}`,
        detail: `${cur} booked in the last 7 days across all clients vs a 4-week average of ${round1(bas)}/week`,
      });
    }
  }
  for (const [key, rows] of turnaround) {
    const name = display.get(key) || key;
    const t = turnaroundCheck(rows, win);
    if (t) {
      out.push({
        scope: "coordinator", clientId: null, subject: name, metric: "turnaround", ...t.hit,
        message: `${name}: booking turnaround slowed ${Math.abs(t.hit.pct)}%`,
        detail: `median ${t.current} business hours over the last 7 days (${t.sample} bookings) vs ${t.baseline} over the 4 weeks before`,
      });
    }
  }
  return out;
}

// --- State -----------------------------------------------------------------

const selectOpen = db.prepare(`SELECT * FROM alerts WHERE resolved_at IS NULL`);
const selectByKey = db.prepare(`SELECT * FROM alerts WHERE key = ?`);
const insertAlert = db.prepare(`
  INSERT INTO alerts (key, scope, client_id, subject, metric, direction, severity, message, detail, first_seen, last_seen, notified_at, resolved_at)
  VALUES (@key, @scope, @client_id, @subject, @metric, @direction, @severity, @message, @detail, @now, @now, NULL, NULL)
  ON CONFLICT (key) DO UPDATE SET
    severity = excluded.severity, message = excluded.message, detail = excluded.detail,
    first_seen = excluded.first_seen, last_seen = excluded.last_seen, notified_at = NULL, resolved_at = NULL
`);
const refreshAlert = db.prepare(`
  UPDATE alerts SET severity = @severity, message = @message, detail = @detail, last_seen = @now WHERE key = @key
`);
const resolveAlert = db.prepare(`UPDATE alerts SET resolved_at = ? WHERE key = ?`);
const getMeta = db.prepare(`SELECT value FROM alert_meta WHERE key = ?`);
const setMeta = db.prepare(`
  INSERT INTO alert_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value
`);

function alertKey(a) {
  return [a.scope, a.clientId || a.subject.toLowerCase(), a.metric, a.direction].join(":");
}

// Someone newly excluded shouldn't reappear as "back to normal" in the next
// DM: their alerts are removed outright rather than resolved.
function dropExcluded() {
  const excluded = new Set(A.excludeCoordinators.map(config.normalizeName));
  const remove = db.prepare(`DELETE FROM alerts WHERE key = ?`);
  for (const row of db.prepare(`SELECT key, subject FROM alerts WHERE scope = 'coordinator'`).all()) {
    if (excluded.has(config.normalizeName(row.subject))) remove.run(row.key);
  }
}

const applyState = store.transaction((found, nowIso) => {
  const seen = new Set();
  for (const a of found) {
    const key = alertKey(a);
    seen.add(key);
    const params = {
      key, scope: a.scope, client_id: a.clientId || null, subject: a.subject, metric: a.metric,
      direction: a.direction, severity: a.severity, message: a.message, detail: a.detail || null, now: nowIso,
    };
    const existing = selectByKey.get(key);
    if (existing && existing.resolved_at == null) {
      // node:sqlite rejects named parameters a statement doesn't use.
      refreshAlert.run({ key, severity: params.severity, message: params.message, detail: params.detail, now: nowIso });
    }
    else insertAlert.run(params); // new, or back after having cleared
  }
  for (const open of selectOpen.all()) {
    if (!seen.has(open.key)) resolveAlert.run(nowIso, open.key);
  }
});

// --- Evaluate --------------------------------------------------------------

function evaluate(now = Date.now()) {
  const found = [];
  const samplesByClient = new Map();
  const healthy = [];
  const sinceIso = new Date(now - (7 * (A.baselineWeeks + 1) + 2) * DAY).toISOString();

  // Ended engagements are synced once and never again, and must never
  // reach a current-period figure — so they never alert either.
  const active = config.clients.filter((c) => c.apiKey && !c.isEnded);

  for (const client of active) {
    // A sync that has quietly stopped makes a client look like it fell off
    // a cliff. Say that instead of raising a set of false volume alarms.
    const last = selectLastGoodSync.get(client.id);
    const ageHours = last && last.at ? (now - new Date(last.at).getTime()) / 3600000 : Infinity;
    if (ageHours > A.staleSyncHours) {
      found.push({
        scope: "system", clientId: client.id, subject: client.name, metric: "stale_sync",
        direction: "down", severity: "major", pct: null,
        message: `${client.name}: data is stale, so its alerts are paused`,
        detail: last && last.at ? `last successful sync ${Math.round(ageHours)}h ago` : "no successful sync recorded yet",
      });
      continue;
    }

    try {
      const result = evaluateClient(client, sinceIso, now);
      if (Array.isArray(result)) continue; // no payload yet
      found.push(...result.alerts);
      samplesByClient.set(client.id, result.samples);
      healthy.push(client);
    } catch (err) {
      console.error(`[alerts:${client.id}] evaluate failed: ${err.message}`);
    }
  }

  try {
    found.push(...evaluateCoordinators(healthy, samplesByClient, sinceIso, now));
  } catch (err) {
    console.error(`[alerts] coordinator evaluate failed: ${err.message}`);
  }

  dropExcluded();
  applyState(found, new Date(now).toISOString());
  return found;
}

function activeAlerts({ includeCoordinators = true } = {}) {
  const order = { system: 0, client: 1, coordinator: 2 };
  return selectOpen
    .all()
    .filter((a) => includeCoordinators || a.scope !== "coordinator")
    .sort(
      (a, b) =>
        (order[a.scope] - order[b.scope]) ||
        (a.severity === b.severity ? 0 : a.severity === "major" ? -1 : 1) ||
        a.message.localeCompare(b.message)
    )
    .map((a) => ({
      key: a.key, scope: a.scope, clientId: a.client_id, subject: a.subject, metric: a.metric,
      direction: a.direction, severity: a.severity, message: a.message, detail: a.detail, since: a.first_seen,
    }));
}

// --- Slack digest ------------------------------------------------------------

async function slack(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${A.slackBotToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  // Slack answers 200 even when it refused; the truth is in ok/error.
  if (!json.ok) throw new Error(`slack ${method}: ${json.error || "unknown error"}`);
  return json;
}

async function slackRecipient() {
  if (A.slackUserId) return A.slackUserId;
  const cached = getMeta.get("slack_user_id");
  if (cached && cached.value) return cached.value;
  const res = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(A.slackEmail)}`, {
    headers: { Authorization: `Bearer ${A.slackBotToken}` },
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`slack users.lookupByEmail: ${json.error || "unknown error"}`);
  setMeta.run("slack_user_id", json.user.id);
  return json.user.id;
}

function digestText(fresh, cleared) {
  const lines = [];
  const icon = (a) => (a.scope === "system" ? ":warning:" : a.severity === "major" ? ":red_circle:" : ":large_orange_circle:");
  if (fresh.length) {
    lines.push(`*Coordinator metrics: ${fresh.length} new alert${fresh.length === 1 ? "" : "s"}*`);
    for (const a of fresh) lines.push(`${icon(a)} *${a.message}*\n      ${a.detail || ""}`);
  }
  if (cleared.length) {
    lines.push(fresh.length ? "\n*Back to normal*" : "*Coordinator metrics: back to normal*");
    for (const a of cleared) lines.push(`:white_check_mark: ${a.message}`);
  }
  if (A.dashboardUrl) lines.push(`\n<${A.dashboardUrl}|Open the dashboard>`);
  return lines.join("\n");
}

/**
 * Once a day, after ALERT_DIGEST_HOUR in ALERT_TIMEZONE, DM anything that
 * has started since the last digest, plus anything that has cleared. An
 * alert that stays open is not repeated. A failed send is retried on the
 * next evaluation rather than marked as delivered.
 */
async function maybeSendDigest(now = Date.now()) {
  if (!A.slackBotToken || (!A.slackUserId && !A.slackEmail)) return { skipped: "slack not configured" };

  const local = metrics.localBuckets(new Date(now).toISOString(), A.timeZone);
  if (local.hour < A.digestHour) return { skipped: "before digest hour" };
  const last = getMeta.get("last_digest_day");
  if (last && last.value === local.day) return { skipped: "already sent today" };
  const lastAt = getMeta.get("last_digest_at");

  const fresh = db.prepare(`SELECT * FROM alerts WHERE resolved_at IS NULL AND notified_at IS NULL`).all();
  const cleared = db
    .prepare(`SELECT * FROM alerts WHERE resolved_at IS NOT NULL AND notified_at IS NOT NULL AND resolved_at > ?`)
    .all(lastAt ? lastAt.value : "");

  const nowIso = new Date(now).toISOString();
  if (fresh.length || cleared.length) {
    const channel = await slackRecipient();
    await slack("chat.postMessage", {
      channel,
      text: digestText(fresh, cleared),
      unfurl_links: false,
      unfurl_media: false,
    });
    const mark = db.prepare(`UPDATE alerts SET notified_at = ? WHERE key = ?`);
    for (const a of fresh) mark.run(nowIso, a.key);
  }
  setMeta.run("last_digest_day", local.day);
  setMeta.run("last_digest_at", nowIso);
  return { sent: fresh.length + cleared.length };
}

/** Called by metrics.rebuild() after every sync. Never throws. */
function run() {
  try {
    const found = evaluate();
    console.log(`[alerts] ${found.length} active`);
  } catch (err) {
    console.error(`[alerts] evaluate failed: ${err.message}`);
    return;
  }
  maybeSendDigest()
    .then((r) => r.sent != null && console.log(`[alerts] digest sent (${r.sent} items)`))
    .catch((err) => console.error(`[alerts] digest failed: ${err.message}`));
}

module.exports = { run, evaluate, activeAlerts, maybeSendDigest, significant, windows, digestText };
