"use strict";
// Presses on a Slack post that left it open, one JSON line each, in
// <DATA_DIR>/post-presses.jsonl: Schedule refused (not an approver, the start
// had passed, the post changed) or failed, and Suggest another time or
// interviewer finding nothing or failing. A press that changes the post
// (approval, replacement) is on the post's own record already.
//
// Kept out of the post's record on purpose: writing there bumps its
// revision, and a replacement or approval already under way holds the old
// revision and would then be refused.
//
// The first line, { kind: "started", at }, is written when the file is made,
// so a post made before then can be told apart from one nobody pressed: its
// presses weren't recorded at all. Amend @mentions aren't recorded here.
const fs = require("fs");
const path = require("path");

function createPressLog(dataDir, { now = () => Date.now(), log = console } = {}) {
  const file = path.join(dataDir, "post-presses.jsonl");
  const iso = () => new Date(now()).toISOString();
  function read() {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
    return text.split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch (_) { return []; } });
  }
  function start() {
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ kind: "started", at: iso() }) + "\n", { flag: "wx" });
    } catch (e) { if (e.code !== "EEXIST") log.warn(`[presses] The press log couldn't be started: ${e.message}`); }
  }
  start();
  return {
    // { draftId, action: "schedule" | "suggest_time" | "suggest_interviewer", by, outcome }. Never throws.
    record(press) {
      try { fs.appendFileSync(file, JSON.stringify({ at: iso(), ...press, outcome: String(press.outcome || "").slice(0, 200) }) + "\n"); }
      catch (e) { log.warn(`[presses] A press couldn't be recorded: ${e.message}`); }
    },
    // When recording began (ms), or null if it can't be told.
    since() { const first = read().find(e => e.kind === "started"); return first ? Date.parse(first.at) : null; },
    forDraft: id => read().filter(e => e.draftId === id),
  };
}

const ACTIONS = { schedule: "Schedule", suggest_time: "Suggest another time", suggest_interviewer: "Suggest different interviewer" };

// What was pressed on a post, as one sentence for its expiry. `postedAt` (ms)
// against `since` (ms, when recording began) tells "not recorded" from "none".
function pressesSentence(presses, { postedAt, since, when }) {
  if (!since || !(postedAt >= since)) return "Presses on this post weren't recorded (it was posted before recording began), so whether anyone pressed anything isn't known.";
  if (!presses.length) return "Nobody pressed Schedule or Suggest on it.";
  return `Pressed, without changing it: ${presses.map(p => `${ACTIONS[p.action] || p.action} by ${p.by || "someone"}, ${when(Date.parse(p.at))}${p.outcome ? ` (${p.outcome.replace(/[.\s]+$/, "")})` : ""}`).join("; ")}.`;
}

module.exports = { createPressLog, pressesSentence, ACTIONS };
