"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const pageGate = require("../src/scheduling/page-gate");

const INDEX = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

// The training tracker deploys from the same directory as five other clients'
// dashboards. These tests exist to make sure a Forus-only feature cannot leak
// into any of them, and that the tracker REPLACES the original Ashby-native
// section rather than appearing alongside it.

test("with the tracker off, the tracker's markup and scripts are gone and the original section remains", () => {
  const html = pageGate.stripBlocks(INDEX, "training");

  assert.ok(!html.includes("training.js"), "tracker script must not load");
  assert.ok(!html.includes("training.css"), "tracker stylesheet must not load");
  assert.ok(!html.includes("training-active"), "tracker markup must be gone");
  assert.ok(!html.includes('data-tab="training-history"'), "history tab must be gone");
  assert.ok(html.includes('id="cards-interviewerTraining"'), "the original Ashby-native section must remain");
  assert.ok(html.includes('id="interviewerTraining-toggle"'), "its paused toggle must remain");
});

test("with the tracker on, the original section is gone and the tracker's markup remains", () => {
  const html = pageGate.stripBlocks(INDEX, "training-legacy");

  assert.ok(!html.includes('id="cards-interviewerTraining"'), "the original section must be replaced, not duplicated");
  assert.ok(!html.includes('id="interviewerTraining-toggle"'), "its paused toggle must be gone");
  assert.ok(html.includes("training.js"), "tracker script must load");
  assert.ok(html.includes('id="training-active"'), "tracker markup must be present");
  assert.ok(html.includes('data-tab="training-history"'), "history tab must be present");
});

test("exactly one training section id survives either way, never two", () => {
  for (const name of ["training", "training-legacy"]) {
    const html = pageGate.stripBlocks(INDEX, name);
    const matches = html.match(/id="interviewerTraining"/g) || [];
    assert.strictEqual(matches.length, 1, `${name}: expected exactly one #interviewerTraining, found ${matches.length}`);
  }
});

test("the history tab follows the tab convention app.js relies on", () => {
  // app.js's tab handler is generic over id="tab-<data-tab value>", so a new
  // tab needs only a matching button and panel pair - no JS change. If that
  // pairing ever breaks, the tab silently does nothing when clicked.
  const html = pageGate.stripBlocks(INDEX, "training-legacy");
  assert.ok(html.includes('data-tab="training-history"'));
  assert.ok(html.includes('id="tab-training-history"'));
});

test("the scheduling gate still works alongside the training gate, in any order", () => {
  const a = pageGate.stripBlocks(pageGate.stripBlocks(INDEX, "scheduling"), "training");
  const b = pageGate.stripBlocks(pageGate.stripBlocks(INDEX, "training"), "scheduling");
  assert.strictEqual(a, b, "gates must be order-independent");
  assert.ok(!a.includes("scheduling-review.js"));
  assert.ok(!a.includes("training.js"));
  assert.ok(a.includes('id="cards-interviewerTraining"'), "a dashboard with neither feature keeps the original section");
});

test("stripSchedulingBlocks still behaves exactly as before the gate was generalized", () => {
  assert.strictEqual(pageGate.stripSchedulingBlocks(INDEX), pageGate.stripBlocks(INDEX, "scheduling"));
});

test("tracker-only assets are listed so they 404 where the tracker is off", () => {
  assert.ok(pageGate.TRAINING_ONLY_ASSETS.has("/training.js"));
  assert.ok(pageGate.TRAINING_ONLY_ASSETS.has("/training.css"));
});

test("an unbalanced training marker fails loudly rather than leaking a half-removed block", () => {
  assert.throws(() => pageGate.stripBlocks("<!-- training:start -->\n<div>x</div>\n", "training"), /without a matching end/);
  assert.throws(() => pageGate.stripBlocks("<div>x</div>\n<!-- training:end -->\n", "training"), /without a matching start/);
});
