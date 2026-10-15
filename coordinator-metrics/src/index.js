"use strict";

const config = require("./config");
const { createServer } = require("./server");
const metrics = require("./metrics");
const sync = require("./sync");

const app = createServer();

app.listen(config.port, () => {
  console.log(`[server] coordinator-metrics listening on :${config.port}`);
  console.log(`[server] clients: ${config.clients.map((c) => `${c.id}${c.apiKey ? "" : " (NO KEY)"}`).join(", ") || "none"}`);

  // Serve whatever is already in the database immediately, so a restart
  // isn't a blank dashboard for the length of a sync.
  metrics.rebuild();

  sync.startScheduler();

  if (config.syncOnBoot) {
    // Incremental on boot: a fresh deployment with an empty volume gets
    // caught up by the overnight full sync, or by POST /api/sync?kind=full
    // if someone wants it now. Doing a 30-minute full sync on every
    // restart would make routine redeploys painful.
    sync.syncAll("incremental").catch((err) => console.error("[server] boot sync failed:", err.message));
  }
});
