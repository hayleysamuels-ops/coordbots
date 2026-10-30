"use strict";
// The scheduling pilot is on only where SCHEDULING_CLIENT_ID is set (today:
// Luminai). These tests start the real server in both states through
// helpers/probe-server.js, in a child process with fictional credentials and
// a temporary data directory, so each state gets a fresh config module.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { stripSchedulingBlocks, SCHEDULING_ONLY_ASSETS, START, END, stripBlocks } = require("../src/scheduling/page-gate");

const PUBLIC = path.join(__dirname, "..", "public");
const indexFile = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");

function probe(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-flag-"));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, "helpers", "probe-server.js")], {
      cwd: dir, // keeps dotenv from picking up a developer's local .env
      encoding: "utf8",
      timeout: 30000,
      env: {
        PATH: process.env.PATH,
        DASHBOARD_USER: "shared",
        DASHBOARD_PASSWORD: "fictional-shared-secret",
        ASHBY_API_KEY: "fictional-ashby-key",
        DATA_DIR: dir,
        ...extraEnv,
      },
    });
    const line = result.stdout.split("\n").find(l => l.startsWith("PROBE_RESULT "));
    assert.ok(line, "probe produced no result: " + result.stderr);
    return JSON.parse(line.slice("PROBE_RESULT ".length));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const off = probe({});
const on = probe({ SCHEDULING_CLIENT_ID: "luminai" });

const API_ROUTES = [
  "GET /api/scheduling-review",
  "POST /api/scheduling-review/drafts",
  "GET /api/scheduling-booking",
  "POST /api/scheduling-booking/post-full-schedule-option",
  "POST /api/ashby-connection/status",
  "GET /api/google-calendar/status",
];
const ASSETS = [...SCHEDULING_ONLY_ASSETS].map(p => "GET " + p);
const appConfig = r => JSON.parse(r["GET /api/issues"].body).appConfig;

// ---- flag off -------------------------------------------------------------

test("flag off: every scheduling API route returns 404", () => {
  for (const route of API_ROUTES) assert.equal(off[route].status, 404, route);
});

test("flag off: every scheduling page and asset returns 404", () => {
  for (const asset of ASSETS) assert.equal(off[asset].status, 404, asset);
});

test("flag off: the dashboard page has no scheduling tab, section, styles or scripts", () => {
  for (const route of ["GET /", "GET /index.html"]) {
    const { status, body } = off[route];
    assert.equal(status, 200, route);
    for (const absent of ['id="readyToSchedule"', 'data-tab="scheduling"', 'id="tab-scheduling"',
      "ready-scheduling.js", "scheduling-review.js", "scheduling-review.css", START, END]) {
      assert.ok(!body.includes(absent), route + " still contains " + absent);
    }
    for (const present of ['id="actionQueue"', 'data-tab="offers"', '<script src="app.js"></script>']) {
      assert.ok(body.includes(present), route + " lost shared markup " + present);
    }
  }
});

test("flag off: the queue keeps its original \"Needs scheduling\" name", () => {
  assert.equal(appConfig(off).schedulingEnabled, false);
  assert.equal(appConfig(off).needsSchedulingLabel, "Needs scheduling");
  assert.ok(!off["GET /"].body.includes("Scheduling not started"));
});

test("flag off: shared dashboard files are still served unchanged", () => {
  assert.equal(off["GET /app.js"].status, 200);
  assert.equal(off["GET /app.js"].body, fs.readFileSync(path.join(PUBLIC, "app.js"), "utf8"));
  assert.equal(off["GET /style.css"].status, 200);
});

// ---- flag on: identical to Luminai before the flag existed ----------------
// Expected statuses and bodies were recorded from the unflagged code (commit
// 531dacf) with the same fictional shared login, so these hold the flagged
// code to exactly that behaviour.

test("the Slack interactivity and events routes are 404s without interactivity configured, with or without the flag", () => {
  // They're the routes outside Basic Auth, so they must not ask for credentials
  // or say anything else until the signing secret, workspace, app and approvers are set.
  for (const state of [off, on]) {
    for (const route of ["/api/slack/interactions", "/api/slack/events"]) {
      assert.equal(state["POST " + route].status, 404, route);
      assert.equal(state["NOAUTH POST " + route].status, 404, route);
    }
    // Every other route still demands a login.
    assert.equal(state["NOAUTH POST /api/scheduling-booking"].status, 401);
  }
});

test("flag on: the privacy page is public at exactly /privacy.html", () => {
  // Google fetches it for the OAuth consent screen, without credentials.
  const page = fs.readFileSync(path.join(PUBLIC, "privacy.html"), "utf8");
  for (const route of ["NOAUTH GET /privacy.html", "NOAUTH GET /privacy.html?from=google"]) {
    assert.equal(on[route].status, 200, route);
    assert.match(on[route].type, /^text\/html/, route);
    assert.equal(on[route].body, page, route);
  }
  assert.equal(on["NOAUTH HEAD /privacy.html"].status, 200);
  // It can't link anything on this server, which is behind auth: only
  // external https: pages and mailto: links.
  assert.doesNotMatch(page, /(href|src)="(?!https:\/\/|mailto:)[^"]*"/);
});

test("flag off: the privacy page isn't served, with or without credentials", () => {
  // It names the Luminai Google app. Without credentials it gets the same login
  // demand as any other page; with them, the same 404 as the other
  // scheduling-only pages (covered by the asset check above too).
  for (const route of ["NOAUTH GET /privacy.html", "NOAUTH HEAD /privacy.html", "NOAUTH GET /privacy.html?from=google"]) {
    assert.equal(off[route].status, 401, route);
    assert.doesNotMatch(off[route].body, /Luminai/, route);
  }
  assert.equal(off["GET /privacy.html"].status, 404);
  assert.doesNotMatch(off["GET /privacy.html"].body, /Luminai/);
});

test("nothing else is public: the exemption doesn't widen past /privacy.html and the Slack POST", () => {
  const stillLocked = [
    "POST /privacy.html", "GET /privacy.html/", "GET /PRIVACY.HTML", "GET /privacy%2Ehtml",
    "GET /privacy.htm", "GET /privacy", "GET /", "GET /index.html", "GET /style.css", "GET /app.js",
    "GET /booking.html", "GET /google-calendar.html", "GET /api/issues", "GET /api/google-calendar/status",
    // Only POST is exempt on the Slack routes.
    "GET /api/slack/interactions", "GET /api/slack/events",
  ];
  for (const state of [off, on]) {
    for (const route of stillLocked) assert.equal(state["NOAUTH " + route].status, 401, route);
  }
});

test("flag on: scheduling API routes respond exactly as before the flag", () => {
  const expected = {
    "POST /api/scheduling-review/drafts": [403, { error: "Sign in with an individual scheduling approver account." }],
    "GET /api/scheduling-booking": [403, { error: "Sign in with your coordinator account to review and approve bookings." }],
    // Added after the flag: the post-to-Slack route sits behind the same coordinator guard.
    "POST /api/scheduling-booking/post-full-schedule-option": [403, { error: "Sign in with your coordinator account to review and approve bookings." }],
    "POST /api/ashby-connection/status": [403, { error: "Sign in with an individual coordinator account to connect Ashby. The shared dashboard login cannot manage connections." }],
    "GET /api/google-calendar/status": [403, { error: "Sign in with your coordinator account to manage Google Calendar." }],
    "GET /api/scheduling-review": [200, { status: { canApprove: false, clientId: "luminai", channelName: "Not configured", slackReady: false, routing: "candidate", bookingReady: false, bookingMessage: "The Ashby booking connection is not ready. No invitations can be sent." }, proposals: [], sources: [] }],
  };
  for (const [route, [status, body]] of Object.entries(expected)) {
    assert.equal(on[route].status, status, route);
    assert.deepEqual(JSON.parse(on[route].body), body, route);
  }
});

test("flag on: every scheduling page and asset is served unchanged", () => {
  for (const asset of SCHEDULING_ONLY_ASSETS) {
    assert.equal(on["GET " + asset].status, 200, asset);
    assert.equal(on["GET " + asset].body, fs.readFileSync(path.join(PUBLIC, asset), "utf8"), asset);
  }
});

test("flag on: the dashboard page keeps every scheduling block, with the scheduling tab and section", () => {
  // This used to assert the served body was index.html byte-for-byte. That
  // stopped being true when the training tracker added a SECOND, independent
  // gate: the training markers are always resolved (one of the two blocks is
  // always stripped), regardless of the scheduling flag. These fixtures run
  // with TRAINING_TRACKER_CLIENT_ID unset, so the expected page is index.html
  // with the tracker's own blocks removed and the original Ashby-native
  // training section left in place.
  //
  // The assertion this test actually exists to make - that the scheduling
  // flag being on strips nothing of scheduling's - is now checked directly
  // against the served body rather than against the source file, which is
  // stronger than the byte-equality proxy it replaces.
  const expectedPage = stripBlocks(indexFile, "training");
  for (const route of ["GET /", "GET /index.html"]) {
    assert.equal(on[route].status, 200, route);
    assert.equal(on[route].body, expectedPage, route);
  }
  for (const present of ['id="readyToSchedule"', "<h2>Ready to schedule</h2>", 'data-tab="scheduling"', 'id="tab-scheduling"',
    '<script src="ready-scheduling.js"></script>', '<script src="scheduling-review.js"></script>']) {
    assert.ok(on["GET /"].body.includes(present), "the served page is missing " + present);
  }
});

test("flag on: the older queue is renamed \"Scheduling not started\"", () => {
  assert.equal(appConfig(on).schedulingEnabled, true);
  assert.equal(appConfig(on).needsSchedulingLabel, "Scheduling not started");
});

// ---- the markup gate itself -------------------------------------------------

test("stripSchedulingBlocks removes exactly the marked blocks and their marker lines", () => {
  const html = ["<a>", `  ${START}`, "  <b>", `  ${END}`, "<c>", `${START}`, "<d>", `${END}`, "<e>"].join("\n");
  assert.equal(stripSchedulingBlocks(html), ["<a>", "<c>", "<e>"].join("\n"));
  assert.equal(stripSchedulingBlocks("<a>\n<b>"), "<a>\n<b>");
});

test("stripSchedulingBlocks rejects unbalanced or nested markers", () => {
  assert.throws(() => stripSchedulingBlocks(`${START}\n<b>`), /without a matching end/);
  assert.throws(() => stripSchedulingBlocks(`<b>\n${END}`), /without a matching start/);
  assert.throws(() => stripSchedulingBlocks(`${START}\n${START}\n${END}\n${END}`), /nested/);
});

test("index.html marks every scheduling-only block, and leaves nothing else out", () => {
  const stripped = stripSchedulingBlocks(indexFile);
  const markerLines = indexFile.split("\n").filter(l => l.includes(START) || l.includes(END));
  assert.equal(markerLines.length, 12, "expected six marked blocks");
  const removed = indexFile.split("\n").length - stripped.split("\n").length;
  // Six blocks: CSS link, tab button, section (6 lines), tab panel, two scripts.
  assert.equal(removed, 12 + 1 + 1 + 6 + 1 + 1 + 1);
});
