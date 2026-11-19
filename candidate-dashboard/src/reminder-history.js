"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");

// The last scorecard reminder sent from the dashboard for each interview
// (<DATA_DIR>/reminders-sent.json), so a Feedback Overdue row can say
// "Reminded 10:42 by Kitty Qu" to everyone, not just whoever pressed the
// button. Display only: the reminder bot enforces the cooldown itself.
// Entries go after 14 days, which is longer than any row stays overdue in
// practice; the privacy page says so.
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

function createReminderHistory({ dataDir = config.dataDir, now = () => Date.now(), log = console } = {}) {
  const file = path.join(dataDir, "reminders-sent.json");
  let store = {}; // interviewEventId -> { at, byName, byEmail, sent: [name] }
  try { store = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch (_) { store = {}; }

  const prune = () => {
    const t = now();
    for (const [k, v] of Object.entries(store)) if (!v || typeof v.at !== "number" || t - v.at > KEEP_MS) delete store[k];
  };
  const save = () => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, file);
    } catch (err) {
      log.warn(`[reminders] Couldn't save reminders-sent.json: ${err.message}`);
    }
  };

  return {
    record(interviewEventId, { byName, byEmail, sent }) {
      prune();
      store[interviewEventId] = { at: now(), byName: byName || byEmail, byEmail, sent };
      save();
    },
    get(interviewEventId) {
      const v = store[interviewEventId];
      return v && now() - v.at <= KEEP_MS ? v : null;
    },
    // Feedback Overdue rows get `reminder` ({ at, byName, sent }) where one
    // was sent. Never the sender's email: the page only needs the name.
    apply(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.feedbackOverdue)) return snapshot;
      return {
        ...snapshot,
        feedbackOverdue: snapshot.feedbackOverdue.map((item) => {
          const r = this.get(item.interviewEventId);
          return r ? { ...item, reminder: { at: r.at, byName: r.byName, sent: r.sent } } : item;
        }),
      };
    },
  };
}

module.exports = { createReminderHistory };
