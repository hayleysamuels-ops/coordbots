"use strict";
/**
 * Wires the bots together: config, run log, scheduling, and running one.
 *
 * server.js only talks to this module, so a new scheduled bot usually means
 * adding it to the BOTS list below and nothing else. A bot the tracker UI also
 * talks to (bot 1's panel, bot 10's sheet suggestions) needs a method here too.
 */
const { createBotStore } = require("./botstore");
const { createAshbyClient } = require("./ashby");
const { createSlackClient } = require("./slack");
const { startScheduler } = require("./scheduler");
const sheets = require("./sheets");

const BOTS = [
  require("../bots/pool-health"),
  require("../bots/readiness-sweep"),
  require("../bots/housekeeping"),
  require("../bots/sheet-sync"),
  require("../bots/declines-watch"),
];
// Bot 1 is not scheduled — it answers requests from the tracker UI.
const panel = require("../bots/ashby-panel");
const suggestions = require("../bots/work-trial-suggestions");
const sheetSync = require("../bots/sheet-sync");

// What a bot needs before it may run. A bot may declare its own `requires`;
// these are the defaults the Ashby-and-Slack bots have always run under.
const DEFAULT_REQUIRES = ["ASHBY_READ_KEY", "SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID"];
// Dry runs still read real data, but nothing is posted, so Slack is not needed.
const DEFAULT_DRY_REQUIRES = ["ASHBY_READ_KEY"];

module.exports = function createBots({ databaseUrl, dir, ashbyReadKey, slackBotToken,
                                      slackChannelId, getCandidates, putCandidate }) {
  const botStore = createBotStore({ databaseUrl, dir });
  const byName = new Map(BOTS.map((b) => [b.name, b]));

  // What is missing, in words a coordinator can act on.
  function readiness() {
    const missing = [];
    if (!ashbyReadKey) missing.push("ASHBY_READ_KEY");
    if (!slackBotToken) missing.push("SLACK_BOT_TOKEN");
    if (!slackChannelId) missing.push("SLACK_CHANNEL_ID");
    if (!process.env.GOOGLE_SA_KEY_B64) missing.push("GOOGLE_SA_KEY_B64");
    if (!process.env.POETIC_SHEET_ID) missing.push("POETIC_SHEET_ID");
    return { ok: missing.length === 0, missing };
  }

  async function runJob(bot, { trigger, slotKey }) {
    // Tracked outside the try so that anything throwing after the claim — not
    // just inside the job body — still finishes the row with the error. A bot
    // that fails silently is worse than one that fails loudly.
    let runId = null;
    try {
      const cfg = await botStore.getConfig(bot.name, bot.defaults);
      // A disabled bot writes no row on purpose: the Bots panel already tells
      // enabled-and-quiet apart from never-run, and a row every tick would be
      // ~96 a day of noise.
      if (!cfg.enabled && trigger === "schedule") return { skipped: "disabled" };

      const ready = readiness();
      // Each bot is gated on what IT needs: the sheet sync does not care that
      // Slack is unset, and the Slack bots do not care that the sheet is.
      // Dry runs still read real data; only posting needs Slack.
      const needed = cfg.dryRun
        ? bot.dryRequires || bot.requires || DEFAULT_DRY_REQUIRES
        : bot.requires || DEFAULT_REQUIRES;
      const blocking = ready.missing.filter((m) => needed.includes(m));
      if (blocking.length) {
        runId = await botStore.claimRun(bot.name, slotKey, trigger);
        if (runId) {
          // Not an error: it is a skip with a reason, and the run log should say
          // which, so a missing variable is not mistaken for a crash.
          await botStore.finishRun(runId, {
            outcome: "skipped_unconfigured",
            error: "Not configured: " + blocking.join(", ") + " missing",
          });
        }
        return { skipped: "unconfigured", missing: blocking };
      }

      runId = await botStore.claimRun(bot.name, slotKey, trigger);
      if (!runId) return { skipped: "already ran for this slot" }; // another instance won

      // Built only when there is a key. Bot 10 needs the sheet, not Ashby, and
      // createAshbyClient throws on a missing key — which used to take down a
      // bot that had already passed its own readiness gate.
      const ashby = ashbyReadKey ? createAshbyClient(ashbyReadKey) : null;
      const result = await bot.run({
        ashby,
        slack: slackBotToken ? createSlackClient(slackBotToken) : null,
        channelId: slackChannelId,
        botStore,
        runId,
        dryRun: cfg.dryRun,
        log: console.log,
        now: new Date(),
        // For bots that need tracker rows and their panels (the readiness
        // sweep, and the declines watch for the candidate name and deep link).
        getCandidates: getCandidates || (async () => []),
        // Bot 10 only. Saves one row through the same store the browser writes
        // to; there is deliberately no delete counterpart to pass.
        putCandidate: putCandidate || (async () => {}),
        sheets,
        panelFor: (ashbyCandidateId) =>
          panel.getPanel({ ashby, botStore, ashbyCandidateId }),
      });
      await botStore.finishRun(runId, result);
      return { runId, outcome: result.outcome, summary: result.summary, message: result.message };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (runId) {
        // The row exists, so the failure is recorded where anyone looks for it.
        try {
          await botStore.finishRun(runId, { outcome: "error", error: msg });
        } catch (e2) {
          console.error("[bots] " + bot.name + " could not record its own failure: " + e2.message);
        }
      } else {
        // Nothing was claimed — getConfig or claimRun itself failed, so storage
        // is the thing that is broken and there is nowhere to write it.
        console.error("[bots] " + bot.name + " FAILED BEFORE CLAIM (no run_log row possible): " + msg);
      }
      console.error("[bots] " + bot.name + " failed", e);
      return { runId, outcome: "error", error: msg };
    }
  }

  return {
    start() {
      const r = readiness();
      if (!r.ok) console.log("[bots] not configured. Missing " + r.missing.join(", ") + "; bots idle");
      startScheduler({ jobs: BOTS, runJob });
    },

    readiness,

    async status() {
      const out = [];
      for (const b of BOTS) {
        const cfg = await botStore.getConfig(b.name, b.defaults);
        const runs = await botStore.recentRuns(b.name, 6);
        out.push({
          name: b.name,
          title: b.title,
          description: b.description,
          enabled: cfg.enabled,
          dryRun: cfg.dryRun,
          // The rendered message rides along on the most recent run only. It is
          // what dry-run exists to let people read, and it is the largest field,
          // so older runs carry just their summary.
          runs: runs.map((r, i) => ({
            id: r.id,
            trigger: r.trigger,
            startedAt: r.started_at,
            finishedAt: r.finished_at,
            outcome: r.outcome,
            summary: r.summary,
            error: r.error,
            message: i === 0 ? r.message || null : undefined,
          })),
        });
      }
      return out;
    },

    async setConfig(name, patch, who) {
      const bot = byName.get(name);
      if (!bot) throw new Error("unknown bot: " + name);
      // Make sure the row exists with this bot's own defaults first, otherwise
      // flipping one switch on a never-read bot would blank out the other.
      await botStore.getConfig(name, bot.defaults);
      return botStore.setConfig(name, patch, who);
    },

    // Starts the run and returns straight away. A full run makes around forty
    // Ashby calls, which is far too long to hold an HTTP request open; the Bots
    // panel polls the run log instead and shows the outcome when it lands.
    /* ---- bot 1: live Ashby panel (read-only, on demand) ---- */
    async panelFor(ashbyCandidateId, { force } = {}) {
      if (!ashbyReadKey) return { state: "unconfigured", missing: ["ASHBY_READ_KEY"] };
      return panel.getPanel({
        ashby: createAshbyClient(ashbyReadKey),
        botStore,
        ashbyCandidateId,
        force,
      });
    },

    /* ---- suggestions: who is at Work Trial and not in the tracker ---- */
    async suggestionsFor(trackerRows, { force } = {}) {
      if (!ashbyReadKey) return { unconfigured: ["ASHBY_READ_KEY"], add: [], link: [], possible: [], dismissed: [] };
      const data = await suggestions.load({
        ashby: createAshbyClient(ashbyReadKey), botStore, force, log: console.log,
      });
      const dismissals = await botStore.listDismissals();
      return suggestions.classify({ data, trackerRows, dismissals });
    },
    /* ---- bot 10: which sheet row is this person? Proposals only. ---- */
    async sheetSuggest(name, trackerRows) {
      if (!sheets.isConfigured()) return { suggestions: [], error: sheets.configError() };
      if (!name || !String(name).trim()) return { suggestions: [] };
      const CFG = require("../bots/sheet-sync.config");
      const read = await sheets.readRange(CFG.RANGE);
      if (!read.ok) return { suggestions: [], error: read.reason };
      // Which rows are archived. A second call, and a failure here is NOT fatal:
      // the proposals are still worth showing, they just cannot be marked. That
      // is the opposite of the sync path, where not knowing means not writing.
      const vis = await sheets.readVisibility({
        tab: CFG.SHEET_TAB, rowCount: (read.rows || []).length,
      });
      // Keys already spoken for, so one sheet row cannot feed two tracker rows.
      const linkedKeys = (trackerRows || [])
        .map((r) => r.values && r.values.sheetRowKey)
        .filter(Boolean);
      return {
        suggestions: sheetSync.suggest({
          rows: read.rows, name, linkedKeys, visibility: vis.ok ? vis : null,
        }),
        visibilityError: vis.ok ? null : vis.reason,
        cachedAt: read.cachedAt || null,
      };
    },

    dismissSuggestion(ashbyCandidateId, name, by) {
      return botStore.dismiss(ashbyCandidateId, name, by);
    },
    undismissSuggestion(ashbyCandidateId) {
      return botStore.undismiss(ashbyCandidateId);
    },

    async panelSuggest(name) {
      if (!ashbyReadKey) return { missing: ["ASHBY_READ_KEY"], suggestions: [] };
      if (!name || !String(name).trim()) return { suggestions: [] };
      try {
        return { suggestions: await panel.suggest({ ashby: createAshbyClient(ashbyReadKey), name }) };
      } catch (e) {
        return { suggestions: [], error: String(e.message || e) };
      }
    },

    async runNow(name, who) {
      const bot = byName.get(name);
      if (!bot) throw new Error("unknown bot: " + name);
      // A unique slot so a manual run never collides with the Monday slot.
      const slotKey = "manual-" + new Date().toISOString() + "-" + (who || "unknown");
      runJob(bot, { trigger: "manual", slotKey }).catch((e) =>
        console.error("[bots] " + name + " manual run failed", e)
      );
      return { started: true, bot: name };
    },
  };
};
