"use strict";
/**
 * Bot 6 — weekly interviewer-pool health report for the work trial.
 *
 * Posts every Monday 07:00 PT whether or not anything is wrong: it is a
 * standing report, so silence would read as a broken bot rather than a clean
 * week. (Later event-driven bots are exceptions-only; this one is the
 * exception to that rule.)
 *
 * TWO FIELD RULES, both easy to get wrong:
 *  1. isPaused belongs to the POOL MEMBERSHIP, not the person. The same person
 *     can be paused in one pool and active in another, so everything here is
 *     keyed on (poolId, userId). isEnabled is separate and account-level.
 *  2. Load limits are NOT on the pool payload. dailyLimit/weeklyLimit come from
 *     interviewer.settings, fetched per userId and joined onto the member.
 */
const CONFIG = require("./pool-health.config");
const { mapLimit } = require("../lib/http");

const NAME = "pool-health";
// Ashby takes ~2s per call and this makes ~40 of them. Five at a time keeps the
// whole run around twenty seconds without leaning on the API.
const CONCURRENCY = 5;

/* ---------------- small helpers ---------------- */
const firstDefined = (...vals) => vals.find((v) => v !== undefined && v !== null);
const norm = (s) => String(s || "").trim().toLowerCase();
const numOrNull = (v) => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? null : Number(v));

/** Ashby shapes vary a little by account; read defensively rather than crash. */
function normalizeMembers(poolInfo) {
  const raw =
    // What Ashby actually returns from interviewerPool.info.
    (Array.isArray(poolInfo && poolInfo.qualifiedMembers) && poolInfo.qualifiedMembers) ||
    (Array.isArray(poolInfo && poolInfo.members) && poolInfo.members) ||
    (Array.isArray(poolInfo && poolInfo.interviewers) && poolInfo.interviewers) ||
    (Array.isArray(poolInfo && poolInfo.poolMembers) && poolInfo.poolMembers) ||
    (Array.isArray(poolInfo && poolInfo.users) && poolInfo.users) ||
    [];
  return raw
    .map((m) => {
      const user = m.user || m.interviewer || m;
      const userId = firstDefined(user.id, m.userId, m.interviewerId);
      const userName =
        firstDefined(
          user.name,
          [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined,
          user.email,
          m.name
        ) || "Unknown";
      return {
        userId: userId ? String(userId) : null,
        userName,
        // Per-pool membership state. Never read this off a user-level record.
        isPaused: Boolean(firstDefined(m.isPaused, m.paused, m.membership && m.membership.isPaused, false)),
        // Account-level, and Ashby includes it on the member payload.
        isEnabled: firstDefined(m.isEnabled, user.isEnabled),
      };
    })
    .filter((m) => m.userId);
}

function normalizeSettings(s) {
  const v = s || {};
  return {
    isEnabled: Boolean(firstDefined(v.isEnabled, v.enabled, true)),
    weeklyLimit: numOrNull(firstDefined(v.weeklyInterviewLimit, v.weeklyLimit, v.maxWeeklyInterviews)),
    dailyLimit: numOrNull(firstDefined(v.dailyInterviewLimit, v.dailyLimit, v.maxDailyInterviews)),
  };
}

/** A member counts toward staffing only if not paused here and enabled overall. */
const isEffective = (m) => !m.isPaused && m.isEnabled !== false;

/* ---------------- acknowledged exceptions ---------------- */
function monthsBetween(fromISO, now) {
  const then = new Date(fromISO + "T00:00:00Z");
  if (isNaN(then.getTime())) return null;
  return (now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
}

function humanizeAge(decidedOn, now) {
  const then = new Date(String(decidedOn) + "T00:00:00Z");
  if (!decidedOn || isNaN(then.getTime())) return null;
  const days = Math.floor((now.getTime() - then.getTime()) / 86400000);
  if (days < 0) return "dated in the future";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return days + " days ago";
  if (days < 60) return Math.round(days / 7) + " weeks ago";
  if (days < 365) return Math.round(days / 30.44) + " months ago";
  const years = days / 365.25;
  return years < 2 ? "over a year ago" : Math.floor(years) + " years ago";
}

const s2check = (sup) => sup && sup.check;

function suppressionMatches(sup, finding) {
  if (norm(sup.check) !== norm(finding.check)) return false;
  if (!sup.pool && !sup.person) return false; // must target something
  if (sup.pool && norm(sup.pool) !== norm(finding.pool)) return false;
  if (sup.person && norm(sup.person) !== norm(finding.person)) return false;
  return true;
}

/**
 * Splits findings into what to report and what is already acknowledged, and
 * reports back which suppressions matched nothing — a suppression for a pool
 * that was renamed would otherwise hide a real problem forever, silently.
 */
function applySuppressions(findings, suppressions, now) {
  const used = new Set();
  const kept = [];
  const suppressed = [];
  for (const f of findings) {
    const idx = suppressions.findIndex((s) => suppressionMatches(s, f));
    if (idx === -1) {
      kept.push(f);
    } else {
      used.add(idx);
      const sup = suppressions[idx];
      const months = monthsBetween(sup.decidedOn, now);
      suppressed.push({
        finding: f,
        reason: sup.reason || "no reason recorded",
        decidedBy: sup.decidedBy || "not recorded",
        decidedOn: sup.decidedOn || null,
        age: humanizeAge(sup.decidedOn, now),
        stale: months !== null && months >= (CONFIG.staleSuppressionMonths || 6),
      });
    }
  }
  const off = disabledChecks();
  const unmatched = suppressions.filter((_, i) => !used.has(i) && !off.has(norm(s2check(suppressions[i]))));
  return { kept, suppressed, unmatched };
}

const CHECK_LABELS = {
  unstaffable: "Unstaffable",
  spof: "Single point of failure",
  concentration: "Concentration",
  "newly-paused": "Newly paused",
  capacity: "Capacity",
};

/** Entries may be a bare string (older config) or an object with a note. */
function disabledList() {
  return (CONFIG.disabledChecks || [])
    .map((d) => (typeof d === "string" ? { check: d } : d))
    .filter((d) => d && d.check);
}
const disabledChecks = () => new Set(disabledList().map((d) => norm(d.check)));

/* ---------------- the report ---------------- */
async function gather({ ashby, log }) {
  const allPools = await ashby.listInterviewerPools();
  const excludes = (CONFIG.excludes || []).map(norm);
  const extra = (CONFIG.extraIncludes || []).map(norm);
  const contains = norm(CONFIG.titleContains);

  const pools = allPools.filter((p) => {
    if (p.isArchived) return false;
    const title = norm(p.title || p.name);
    if (excludes.includes(title)) return false;
    return (contains && title.includes(contains)) || extra.includes(title);
  });
  log("[" + NAME + "] " + pools.length + " of " + allPools.length + " pools matched");

  // Pool memberships first.
  const poolSummaries = await mapLimit(pools, CONCURRENCY, async (pool) => {
    const poolId = String(pool.id);
    const poolTitle = pool.title || pool.name || "(untitled)";
    try {
      return { poolId, poolTitle, members: normalizeMembers(await ashby.getInterviewerPool(poolId)) };
    } catch (e) {
      log("[" + NAME + "] pool " + poolTitle + " info failed: " + e.message);
      return { poolId, poolTitle, error: e.message, members: [] };
    }
  });

  // Then load limits, once per person rather than once per membership. This is
  // the only place a userId key is correct: account settings really are per
  // person. Membership state never is, and is already attached above.
  const userIds = [...new Set(poolSummaries.flatMap((p) => p.members.map((m) => m.userId)))];
  const settingsPairs = await mapLimit(userIds, CONCURRENCY, async (userId) => {
    try {
      return [userId, normalizeSettings(await ashby.getInterviewerSettings(userId))];
    } catch (e) {
      log("[" + NAME + "] settings for " + userId + " failed: " + e.message);
      return [userId, { isEnabled: undefined, weeklyLimit: null, dailyLimit: null, error: e.message }];
    }
  });
  const settings = new Map(settingsPairs);
  log("[" + NAME + "] " + poolSummaries.length + " pools, " + userIds.length + " interviewers");

  const rows = [];
  for (const p of poolSummaries) {
    p.members = p.members.map((m) => {
      const s = settings.get(m.userId) || {};
      const row = {
        poolId: p.poolId,
        poolTitle: p.poolTitle,
        userId: m.userId,
        userName: m.userName,
        isPaused: m.isPaused,
        isEnabled: firstDefined(m.isEnabled, s.isEnabled),
        weeklyLimit: s.weeklyLimit === undefined ? null : s.weeklyLimit,
        dailyLimit: s.dailyLimit === undefined ? null : s.dailyLimit,
      };
      rows.push(row);
      return row;
    });
  }

  return { pools: poolSummaries, rows, poolCount: pools.length, totalPools: allPools.length };
}

function buildFindings({ pools, rows, previous }) {
  const findings = { unstaffable: [], spof: [], concentration: [], newlyPaused: [], capacity: [] };

  for (const p of pools) {
    const effective = (p.members || []).filter(isEffective);
    if (p.error) continue;
    if (effective.length === 0) {
      findings.unstaffable.push({ check: "unstaffable", pool: p.poolTitle, detail: (p.members || []).length + " member(s), none available" });
    } else if (effective.length === 1) {
      findings.spof.push({ check: "spof", pool: p.poolTitle, person: effective[0].userName, detail: "only " + effective[0].userName });
    }
    const capped = effective.filter((m) => typeof m.weeklyLimit === "number");
    const weekly = capped.reduce((sum, m) => sum + m.weeklyLimit, 0);
    findings.capacity.push({
      check: "capacity",
      pool: p.poolTitle,
      weeklyCapacity: weekly,
      effective: effective.length,
      // Ashby leaves weeklyLimit null when no cap is set. That is unlimited,
      // not zero — reporting it as zero would make a healthy pool look empty.
      uncapped: effective.length - capped.length,
    });
  }

  // Concentration — how many of THESE pools each person is effective in.
  const byPerson = new Map();
  for (const r of rows) {
    if (!isEffective(r)) continue;
    if (!byPerson.has(r.userId)) byPerson.set(r.userId, { name: r.userName, pools: [] });
    byPerson.get(r.userId).pools.push(r.poolTitle);
  }
  const threshold = CONFIG.concentrationThreshold || 3;
  findings.concentration = [...byPerson.values()]
    .filter((p) => p.pools.length >= threshold)
    .sort((a, b) => b.pools.length - a.pools.length)
    .map((p) => ({ check: "concentration", person: p.name, count: p.pools.length, pools: p.pools }));

  // Newly paused — diff against the previous run's snapshot, keyed (pool,user).
  if (previous && previous.length) {
    const before = new Map(previous.map((r) => [r.poolId + "|" + r.userId, r]));
    for (const r of rows) {
      const was = before.get(r.poolId + "|" + r.userId);
      if (!was) continue;
      if (!was.isPaused && r.isPaused) {
        findings.newlyPaused.push({ check: "newly-paused", pool: r.poolTitle, person: r.userName });
      }
    }
  }

  return findings;
}

/* ---------------- Block Kit ---------------- */
const section = (text) => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });

function buildBlocks({ findings, suppressedCount, unmatched, meta, bookedNote, failedPools }) {
  const blocks = [
    { type: "header", text: { type: "plain_text", text: "Work trial pool health", emoji: true } },
    context(meta.dateLabel + " · " + meta.poolCount + " pools checked"),
    { type: "divider" },
  ];

  const off = new Set(meta.disabledChecks || []);
  const live = (check, list) => (off.has(check) ? [] : list);

  findings = {
    unstaffable: live("unstaffable", findings.unstaffable),
    spof: live("spof", findings.spof),
    newlyPaused: live("newly-paused", findings.newlyPaused),
    concentration: live("concentration", findings.concentration),
    capacity: live("capacity", findings.capacity),
  };

  // Only the checks that actually ran can say anything about a clean week.
  const staffingChecksOn = ["unstaffable", "spof", "newly-paused"].filter((c) => !off.has(c));
  const problems =
    findings.unstaffable.length + findings.spof.length + findings.newlyPaused.length;

  if (findings.unstaffable.length) {
    blocks.push(
      section(
        "*:red_circle: Unstaffable. Nobody available*\n" +
          findings.unstaffable.map((f) => "• *" + f.pool + "*: " + f.detail).join("\n")
      )
    );
  }
  if (findings.spof.length) {
    blocks.push(
      section(
        "*:warning: Single point of failure*\n" +
          findings.spof.map((f) => "• *" + f.pool + "*: " + f.person + " only").join("\n")
      )
    );
  }
  if (findings.newlyPaused.length) {
    blocks.push(
      section(
        "*:pause_button: Newly paused since last week*\n" +
          findings.newlyPaused.map((f) => "• " + f.person + ": *" + f.pool + "*").join("\n")
      )
    );
  } else if (meta.noBaseline && !off.has("newly-paused")) {
    blocks.push(context(":pause_button: Newly paused. Baseline established this run; changes appear from next week."));
  }

  if (staffingChecksOn.length && !problems && !meta.noBaseline) {
    // Only claim a clean week for the checks that actually ran. With a staffing
    // check switched off, "every pool has cover" would be a claim nothing
    // verified this week.
    const allOn = staffingChecksOn.length === 3;
    blocks.push(
      section(
        allOn
          ? ":white_check_mark: *No staffing problems found.* Every pool has cover and nobody paused this week."
          : ":white_check_mark: *Nothing flagged by the checks that ran.* See the footer for what was not checked."
      )
    );
  }

  if (findings.concentration.length) {
    // Deliberately short. This is a trend to record week after week, not a table
    // to read: the argument is that the same names are still here in three
    // months, which only works if the line stays glanceable.
    const SHOWN = 3;
    const top = findings.concentration.slice(0, SHOWN);
    const rest = findings.concentration.length - top.length;
    blocks.push({ type: "divider" });
    blocks.push(
      section(
        "*:busts_in_silhouette: Concentration*: " +
          findings.concentration.length + " people in " +
          (CONFIG.concentrationThreshold || 3) + "+ pools\n" +
          top.map((f) => "• *" + f.person + "*: " + f.count + " pools").join("\n") +
          (rest > 0 ? "\n_+ " + rest + " more_" : "")
      )
    );
  }

  if (findings.capacity.length) {
    blocks.push({ type: "divider" });
    const CAP_SHOWN = 8;
    // Genuinely empty pools first; pools with no caps set are not "zero".
    const ranked = findings.capacity
      .slice()
      .sort((a, b) => a.effective - b.effective || a.weeklyCapacity - b.weeklyCapacity);
    const lines = ranked
      .slice(0, CAP_SHOWN)
      .map((f) => {
        const cap =
          f.uncapped === f.effective && f.effective > 0
            ? "no caps set"
            : f.weeklyCapacity + "/wk" + (f.uncapped ? " + " + f.uncapped + " uncapped" : "");
        return "• *" + f.pool + "*: " + cap + " across " + f.effective + " available";
      });
    const hidden = ranked.length - lines.length;
    const total = ranked.reduce((sum, f) => sum + f.weeklyCapacity, 0);
    blocks.push(
      section(
        "*:bar_chart: Weekly capacity*, thinnest first\n" +
          lines.join("\n") +
          (hidden > 0 ? "\n_+ " + hidden + " more pools, " + total + "/wk across all " + ranked.length + "_" : "")
      )
    );
    blocks.push(context(bookedNote));
  }

  if (failedPools && failedPools.length) {
    blocks.push({ type: "divider" });
    blocks.push(
      section(
        "*:grey_exclamation: Could not read " + failedPools.length + " pool(s)*\n" +
          failedPools.map((f) => "• " + f.poolTitle + ": " + f.error).join("\n") +
          "\n_These are not included in the checks above._"
      )
    );
  }

  const footer = [];
  if (off.size) {
    footer.push(
      ":no_bell: not checked: " +
        [...off].map((c) => CHECK_LABELS[c] || c).join(", ")
    );
  }
  if (suppressedCount) {
    footer.push(":mute: " + suppressedCount + " acknowledged, see thread");
  }
  if (unmatched.length) {
    footer.push(
      ":grey_question: " + unmatched.length + " acknowledgement" + (unmatched.length > 1 ? "s" : "") +
        " no longer match anything, may be stale"
    );
  }
  if (footer.length) {
    blocks.push({ type: "divider" });
    blocks.push(context(footer.join("  ·  ")));
  }

  return blocks;
}

function buildThreadBlocks({ suppressed, unmatched, disabled, now }) {
  const blocks = [];
  if (disabled && disabled.length) {
    blocks.push(
      section(
        "*Checks switched off*\n" +
          disabled
            .map((d) => {
              const age = humanizeAge(d.decidedOn, now);
              const who = d.decidedBy || "not recorded";
              return "• *" + (CHECK_LABELS[norm(d.check)] || d.check) + "*: " +
                (d.reason || "no reason recorded") + "\n  _switched off " +
                (age ? age : "at an unrecorded date") + " by " + who +
                (d.decidedOn ? " (" + d.decidedOn + ")" : "") + "_";
            })
            .join("\n")
      )
    );
  }
  if (suppressed && suppressed.length) blocks.push(section("*Acknowledged exceptions*"));
  for (const s of suppressed) {
    const who = s.decidedBy;
    const when = s.age ? "Acknowledged " + s.age + " by " + who : "Acknowledged by " + who + " (date not recorded)";
    const dateSuffix = s.decidedOn ? " (" + s.decidedOn + ")" : "";
    blocks.push(
      section(
        (s.stale ? ":warning: " : "") +
          "*" + (s.finding.pool || s.finding.person) + "*: " + s.finding.check + "\n" +
          when + dateSuffix + (s.stale ? ", _worth revisiting_" : "") + "\n" +
          "_" + s.reason + "_"
      )
    );
  }
  if (unmatched.length) {
    blocks.push({ type: "divider" });
    blocks.push(
      section(
        "*Acknowledgements that matched nothing this run*\n" +
          unmatched
            .map((u) => "• " + (u.pool || u.person || "(no target)") + ": " + u.check + ", check whether it was renamed")
            .join("\n")
      )
    );
  }
  return blocks;
}

/* ---------------- entry point ---------------- */
async function run(ctx) {
  const { ashby, slack, channelId, botStore, runId, dryRun, log = console.log, now = new Date() } = ctx;

  const data = await gather({ ashby, log });
  const previous = await botStore.previousSnapshot(NAME, runId);
  const findings = buildFindings({ pools: data.pools, rows: data.rows, previous });

  /* Capacity is supply-only for now.
   *
   * The intended denominator was work trials booked this week, but Ashby's
   * interviewSchedule.list ignores startDate/endDate and returns results
   * oldest-first, so the only way to reach the current week is to page through
   * the entire history — every Monday, growing forever. Rather than ship a
   * number that is quietly wrong, the report says the figure is not included
   * and why. See the README for the options if this is wanted.
   */
  const { start, end } = ptWeekWindow(now);
  const bookedNote =
    "Supply only. Booked-vs-capacity for " +
    start.toISOString().slice(0, 10) + " → " + end.toISOString().slice(0, 10) +
    " is not included: Ashby's schedule list cannot be filtered by date.";

  const flat = [
    ...findings.unstaffable,
    ...findings.spof,
    ...findings.newlyPaused,
    ...findings.concentration,
    ...findings.capacity,
  ];
  const { kept, suppressed, unmatched } = applySuppressions(flat, CONFIG.suppressions || [], now);

  const keptBy = (check) => kept.filter((f) => f.check === check);
  const visible = {
    unstaffable: keptBy("unstaffable"),
    spof: keptBy("spof"),
    newlyPaused: keptBy("newly-paused"),
    concentration: keptBy("concentration"),
    capacity: keptBy("capacity"),
  };

  const off = disabledChecks();
  const meta = {
    disabledChecks: [...off],
    dateLabel: new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Los_Angeles",
      weekday: "long",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(now),
    poolCount: data.poolCount,
    noBaseline: !previous || previous.length === 0,
  };

  const failedPools = data.pools.filter((p) => p.error).map((p) => ({ poolTitle: p.poolTitle, error: p.error }));
  const blocks = buildBlocks({
    findings: visible,
    suppressedCount: suppressed.length,
    unmatched,
    meta,
    bookedNote,
    failedPools,
  });
  const disabledNotes = disabledList();
  const threadBlocks =
    suppressed.length || unmatched.length || disabledNotes.length
      ? buildThreadBlocks({ suppressed, unmatched, disabled: disabledNotes, now })
      : null;
  const liveIssues =
    (off.has("unstaffable") ? 0 : visible.unstaffable.length) +
    (off.has("spof") ? 0 : visible.spof.length) +
    (off.has("newly-paused") ? 0 : visible.newlyPaused.length);
  const text = "Work trial pool health: " + liveIssues + " issue(s) across " + data.poolCount + " pools";

  // A switched-off check is not recorded either — "off" means off, not "hidden
  // from Slack but kept in the log". Removing it from disabledChecks brings both
  // the section and this record back.
  const record = (check, value) => (off.has(check) ? undefined : value);
  const summary = {
    poolsChecked: data.poolCount,
    poolsSeen: data.totalPools,
    memberships: data.rows.length,
    unstaffable: record("unstaffable", visible.unstaffable.map((f) => f.pool)),
    spof: record("spof", visible.spof.map((f) => f.pool)),
    newlyPaused: record("newly-paused", visible.newlyPaused.map((f) => f.person + " @ " + f.pool)),
    concentration: record("concentration", visible.concentration.map((f) => f.person + " ×" + f.count)),
    suppressed: suppressed.map((s) => (s.finding.pool || s.finding.person) + " / " + s.finding.check),
    disabledChecks: disabledList().map((d) => d.check + " (" + (d.decidedBy || "unrecorded") + ")"),
    unmatchedSuppressions: unmatched.length,
    unreadablePools: failedPools.map((f) => f.poolTitle + ": " + f.error),
    bookedNote,
  };

  if (dryRun) {
    // Same rule as the readiness sweep's notices: a dry run must not change
    // what a live run would later do. The snapshot is the baseline the "newly
    // paused" check diffs against, so saving one here would make the next live
    // report diff against a preview instead of against the last thing anyone
    // was told — quietly swallowing every pause that happened in between.
    return { outcome: "dry_run", summary, message: { text, blocks, threadBlocks } };
  }

  await botStore.saveSnapshot(runId, data.rows);

  const posted = await slack.postMessage({ channel: channelId, text, blocks });
  if (threadBlocks) {
    await slack.postThreadReply({
      channel: channelId,
      threadTs: posted.ts,
      text: "Acknowledged exceptions",
      blocks: threadBlocks,
    });
  }
  return { outcome: "ok", summary, message: { text, blocks, threadBlocks, ts: posted.ts } };
}

/** Monday 00:00 PT through Sunday 23:59 PT containing `now`. */
function ptWeekWindow(now) {
  const { partsIn } = require("../lib/scheduler");
  const p = partsIn("America/Los_Angeles", now);
  const start = new Date(now);
  const daysSinceMonday = (p.weekday + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start, end };
}

module.exports = {
  name: NAME,
  title: "Pool health report",
  description: "Weekly interviewer-pool health for the work trial. Posts Mondays 07:00 PT.",
  schedule: { timeZone: "America/Los_Angeles", weekday: 1, hour: 7, minute: 0, graceMinutes: 60 },
  defaults: { enabled: true, dryRun: true },
  run,
  // exported for tests
  _internal: { applySuppressions, humanizeAge, buildFindings, normalizeMembers, isEffective },
};
