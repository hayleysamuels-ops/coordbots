"use strict";
// Starts the real dashboard server with fictional credentials, requests every
// scheduling route and page plus a few unrelated ones, prints the results as
// JSON and exits. Run in a child process (see scheduling-flag.test.js) so each
// flag state gets a fresh config module and its own temporary data directory.
const { createServer } = require("../../src/server");

const auth = "Basic " + Buffer.from(process.env.DASHBOARD_USER + ":" + process.env.DASHBOARD_PASSWORD).toString("base64");
const json = { "Content-Type": "application/json", "X-Scheduling-Request": "1" };

const PROBES = [
  ["GET", "/"],
  ["GET", "/index.html"],
  ["GET", "/app.js"],
  ["GET", "/style.css"],
  ["GET", "/scheduling-flag.js"],
  ["GET", "/api/issues"],
  ["GET", "/api/scheduling-review"],
  ["POST", "/api/scheduling-review/drafts", {}],
  ["GET", "/api/scheduling-booking"],
  ["POST", "/api/ashby-connection/status", {}],
  ["GET", "/api/google-calendar/status"],
  ["GET", "/booking.html"],
  ["GET", "/booking.js"],
  ["GET", "/ashby-connection.html"],
  ["GET", "/google-calendar.html"],
  ["GET", "/google-calendar.js"],
  ["GET", "/scheduling-review.js"],
  ["GET", "/scheduling-review.css"],
  ["GET", "/ready-scheduling.js"],
  ["GET", "/scheduler-theme.css"],
];

const server = createServer().listen(0, "127.0.0.1", async () => {
  const base = "http://127.0.0.1:" + server.address().port;
  const out = {};
  for (const [method, path, body] of PROBES) {
    const response = await fetch(base + path, {
      method,
      headers: { Authorization: auth, ...(body ? json : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    out[method + " " + path] = { status: response.status, body: await response.text() };
  }
  // config.js logs to stdout at load, so the result goes on its own marked line.
  // Exit only after the write flushes; a pipe is asynchronous and exiting
  // early truncates the output.
  process.stdout.write("\nPROBE_RESULT " + JSON.stringify(out) + "\n", () => server.close(() => process.exit(0)));
});
