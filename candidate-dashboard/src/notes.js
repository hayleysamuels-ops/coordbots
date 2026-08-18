"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");

// Persisted alongside dismissals.json in the same DATA_DIR, but in its own
// file — a note's lifecycle is deliberately independent of a dismissal's
// (see set()/remove() below): snoozing a candidate, unsnoozing them, or a
// snooze simply expiring must never touch their note. Never written back to
// Ashby — this is local-only, coordinator-facing context.
const DATA_DIR = config.dataDir;
const FILE = path.join(DATA_DIR, "notes.json");

// candidateId -> { text, updatedAt }. This dashboard sits behind one shared
// basic-auth login (see auth.js) — there's no per-coordinator identity to
// attribute a note to, so a note is one shared value per candidate, not a
// per-author thread. Whoever edits it last simply overwrites it, same as a
// shared doc.
let store = {};

function load() {
  try {
    store = JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
  } catch (err) {
    store = {}; // missing/corrupt file -> start empty
  }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.warn("[notes] save failed:", err.message);
  }
}

function get(candidateId) {
  const entry = store[candidateId];
  return entry ? entry.text : null;
}

// Empty/whitespace-only text is treated as "clear the note" rather than
// persisting a blank entry — a coordinator clearing a text field and hitting
// Save means "no note," same as clicking Delete.
function set(candidateId, text) {
  if (!candidateId) return;
  const trimmed = (text || "").trim();
  if (!trimmed) {
    remove(candidateId);
    return;
  }
  store[candidateId] = { text: trimmed, updatedAt: Date.now() };
  save();
}

function remove(candidateId) {
  if (store[candidateId]) {
    delete store[candidateId];
    save();
  }
}

load();

module.exports = { get, set, remove };
