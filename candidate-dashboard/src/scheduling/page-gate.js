"use strict";
// Keeps the scheduling pilot out of dashboards that have not been set up for
// it. The flag is config.schedulingEnabled (SCHEDULING_CLIENT_ID is set).
// When it is off, the scheduling-only static files return 404 and the
// scheduling blocks in index.html (between the markers below) are removed
// before the page is sent, so no scheduling script ever loads or calls an API.

const START = "<!-- scheduling:start -->";
const END = "<!-- scheduling:end -->";

// Static files only the training tracker uses. Like SCHEDULING_ONLY_ASSETS
// below, these 404 on a dashboard without TRAINING_TRACKER_CLIENT_ID so no
// tracker script ever loads or calls an API there.
const TRAINING_ONLY_ASSETS = new Set(["/training.js", "/training.css"]);

// Pages and assets that only the scheduling pilot uses. Everything else in
// public/ is shared by all dashboards.
const SCHEDULING_ONLY_ASSETS = new Set([
  "/booking.html",
  "/booking.js",
  "/ashby-connection.html",
  "/google-calendar.html",
  "/google-calendar.js",
  "/scheduling-review.js",
  "/scheduling-review.css",
  "/ready-scheduling.js",
  "/scheduling-pages.css",
]);

// Removes every marked block, including the marker lines. Unbalanced or
// nested markers throw, so a bad edit to index.html fails at startup instead
// of silently leaking a half-removed block.
//
// `name` selects the marker pair, so one mechanism serves several features:
// "scheduling" (the pilot), "training" (the tracker's UI, removed when the
// tracker is off) and "training-legacy" (the original Ashby-native training
// section, removed when the tracker is ON). The training pair is used in both
// directions because the tracker REPLACES that section rather than adding
// alongside it - exactly one of the two blocks survives on any deployment.
function stripBlocks(html, name = "scheduling") {
  const START = `<!-- ${name}:start -->`;
  const END = `<!-- ${name}:end -->`;
  let out = "", index = 0;
  for (;;) {
    const start = html.indexOf(START, index);
    const end = html.indexOf(END, index);
    if (start === -1 && end === -1) return out + html.slice(index);
    if (end === -1) throw new Error(`index.html has a ${name}:start marker without a matching end`);
    if (start === -1 || end < start) throw new Error(`index.html has a ${name}:end marker without a matching start`);
    const nested = html.indexOf(START, start + START.length);
    if (nested !== -1 && nested < end) throw new Error(`index.html has nested ${name} markers`);
    const lineStart = html.lastIndexOf("\n", start) + 1;
    const lineEnd = html.indexOf("\n", end);
    out += html.slice(index, lineStart);
    index = lineEnd === -1 ? html.length : lineEnd + 1;
  }
}

// Preserved so existing callers and tests keep working unchanged.
function stripSchedulingBlocks(html) {
  return stripBlocks(html, "scheduling");
}

module.exports = { SCHEDULING_ONLY_ASSETS, TRAINING_ONLY_ASSETS, stripBlocks, stripSchedulingBlocks, START, END };
