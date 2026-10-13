"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Remembers which (application, outcome) pairs have already been handled, so a
 * replayed or duplicated webhook cannot archive a channel twice or re-post a
 * notice into a channel someone deliberately unarchived.
 *
 * Ashby sends applicationUpdate and candidateHire for the same hire, which is
 * exactly the case this prevents.
 *
 * Point DATA_DIR at a mounted volume so the record survives redeploys. Without
 * one, a restart forgets the history. The worst case is one duplicate notice in
 * a channel that is already archived, which Slack rejects anyway.
 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "handled.json");

let handled = {};

function load() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      handled = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) || {};
      console.log(`[store] Loaded ${Object.keys(handled).length} handled events from ${STORE_PATH}.`);
    }
  } catch (err) {
    console.warn(`[store] Could not read ${STORE_PATH}: ${err.message}. Starting empty.`);
    handled = {};
  }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(handled, null, 2));
  } catch (err) {
    console.warn(`[store] Could not write ${STORE_PATH}: ${err.message}`);
  }
}

function key(applicationId, outcome) {
  return `${applicationId}:${outcome}`;
}

function wasHandled(applicationId, outcome) {
  return Boolean(handled[key(applicationId, outcome)]);
}

function markHandled(applicationId, outcome, detail) {
  handled[key(applicationId, outcome)] = {
    at: new Date().toISOString(),
    ...detail,
  };
  save();
}

load();

module.exports = { wasHandled, markHandled, STORE_PATH };
