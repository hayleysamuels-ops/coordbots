"use strict";

/**
 * End-to-end smoke test against a running deployment.
 *
 * Unit tests assert what functions return. This asserts what a browser
 * actually receives: that the page is served, the stylesheet is
 * structurally valid, the script parses, every payload matches the
 * contract public/app.js reads, and the headline numbers are present and
 * non-zero.
 *
 * Both failures that reached the user would have been caught here:
 * the discarded stylesheet (unbalanced braces, 3 rules out of 488 lines)
 * and the crashed overview (503 on /api/overview).
 *
 *   npm run smoke
 *   SMOKE_URL=http://localhost:3000 npm run smoke
 *
 * Credentials come from SMOKE_USER/SMOKE_PASSWORD, falling back to
 * DASHBOARD_USER/DASHBOARD_PASSWORD. Exits non-zero on any failure, so it
 * can gate a deploy.
 */

const {
  CLIENT_PATHS,
  OVERVIEW_PATHS,
  BY_CLIENT_ROW_KEYS,
  dynamicClientPaths,
  dynamicOverviewPaths,
  missingPaths,
  resolve,
} = require("../src/payload-contract");

const BASE = (process.env.SMOKE_URL || "https://coordinator-metrics-production.up.railway.app").replace(/\/+$/, "");
const USER = process.env.SMOKE_USER || process.env.DASHBOARD_USER || "";
const PASSWORD = process.env.SMOKE_PASSWORD || process.env.DASHBOARD_PASSWORD || "";
const TIMEOUT_MS = 60000;

const failures = [];
const notes = [];

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}

async function get(path, { auth = true } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;
  const res = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  return { status: res.status, text };
}

// Same structural check as test/assets.test.js, run against what the
// server actually serves rather than what is on disk.
function braceDepth(css) {
  const stripped = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
  let depth = 0;
  for (const ch of stripped) {
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
  }
  return depth;
}

(async () => {
  console.log(`Smoke test against ${BASE}\n`);

  if (!USER || !PASSWORD) {
    console.error("Set SMOKE_USER and SMOKE_PASSWORD (or DASHBOARD_USER/DASHBOARD_PASSWORD) first.");
    process.exit(2);
  }

  console.log("Serving");
  const health = await get("/healthz", { auth: false });
  check("/healthz responds 200", health.status === 200, `got ${health.status}`);

  const unauth = await get("/api/overview", { auth: false });
  check("/api/overview refuses unauthenticated requests", unauth.status === 401, `got ${unauth.status}`);

  const page = await get("/");
  check("/ serves the page", page.status === 200, `got ${page.status}`);
  check("page references style.css", page.text.includes('href="style.css"'));
  check("page references app.js", page.text.includes('src="app.js"'));

  console.log("\nAssets");
  const css = await get("/style.css");
  check("style.css is served", css.status === 200, `got ${css.status}`);
  const depth = braceDepth(css.text);
  check(
    "style.css braces are balanced",
    depth === 0,
    `net depth ${depth} — an unclosed block makes the browser discard every rule after it`
  );
  for (const selector of [".stat-number", ".tab", ".chart", "table"]) {
    check(`style.css defines ${selector}`, css.text.includes(selector));
  }

  const js = await get("/app.js");
  check("app.js is served", js.status === 200, `got ${js.status}`);
  let parses = true;
  try {
    new Function(js.text);
  } catch (err) {
    parses = false;
    notes.push(`app.js parse error: ${err.message}`);
  }
  check("app.js parses", parses);

  console.log("\nConfig");
  const configRes = await get("/api/config");
  check("/api/config responds 200", configRes.status === 200, `got ${configRes.status}`);
  let clients = [];
  let periodKeys = [];
  let scopeKeys = [];
  let defaultPeriod = null;
  let defaultScope = null;
  try {
    const cfg = JSON.parse(configRes.text);
    clients = cfg.clients || [];
    periodKeys = (cfg.periods || []).map((p) => p.key);
    scopeKeys = (cfg.scopes || []).map((s) => s.key);
    defaultPeriod = cfg.defaultPeriod;
    defaultScope = cfg.defaultScope;
  } catch (_) {
    /* reported by the check below */
  }

  // The UI builds its controls from these, so an empty list means no
  // buttons and a null default means the first render reads undefined.
  check("config declares period options", periodKeys.length > 0, periodKeys.join(","));
  check("config declares scope options", scopeKeys.length > 0, scopeKeys.join(","));
  check(`config default period "${defaultPeriod}" is one of the options`, periodKeys.includes(defaultPeriod));
  check(`config default scope "${defaultScope}" is one of the options`, scopeKeys.includes(defaultScope));
  check("at least one client is configured", clients.length > 0);
  check(
    "every configured client has an API key",
    clients.every((c) => c.configured),
    clients.filter((c) => !c.configured).map((c) => c.id).join(", ")
  );

  console.log("\nOverview");
  const overviewRes = await get("/api/overview");
  check("/api/overview responds 200", overviewRes.status === 200, `got ${overviewRes.status}`);
  let overview = null;
  try {
    overview = JSON.parse(overviewRes.text);
  } catch (_) {
    /* reported below */
  }

  if (overview) {
    const missing = missingPaths(overview, OVERVIEW_PATHS);
    check("overview matches the payload contract app.js reads", missing.length === 0, missing.slice(0, 6).join(", "));

    // Every combination the toggles can reach, not just the static paths.
    const dynamicMissing = missingPaths(overview, dynamicOverviewPaths({ scopes: scopeKeys, periods: periodKeys }));
    check(
      "overview resolves for every scope x period the UI can select",
      dynamicMissing.length === 0,
      dynamicMissing.slice(0, 6).join(", ")
    );

    // And specifically the state the page loads in — the exact lookup
    // that rendered an error for two and a half hours.
    const onLoad = resolve(overview, `scopes.${defaultScope}.periods.${defaultPeriod}.current.events`);
    check(
      `overview renders in its DEFAULT state (scope=${defaultScope}, period=${defaultPeriod})`,
      Number.isFinite(onLoad),
      "payload.periods[state.period] is undefined on first paint"
    );

    for (const scope of ["all", "coordinated"]) {
      const events = resolve(overview, `scopes.${scope}.totals.events`);
      const hours = resolve(overview, `scopes.${scope}.totals.hours`);
      check(`overview ${scope}: headline interviews is a non-zero number (${events})`, Number.isFinite(events) && events > 0);
      check(`overview ${scope}: headline hours is a non-zero number (${hours})`, Number.isFinite(hours) && hours > 0);
      const byClient = resolve(overview, `scopes.${scope}.byClient`) || [];
      check(`overview ${scope}: by-client table has a row per client`, byClient.length === clients.length);
      const badRow = byClient.find((row) => BY_CLIENT_ROW_KEYS.some((k) => row[k] === undefined));
      check(`overview ${scope}: every by-client row has every column`, !badRow, badRow ? badRow.clientName : "");
    }
  }

  console.log("\nClients");
  for (const client of clients) {
    const res = await get(`/api/client/${encodeURIComponent(client.id)}`);
    check(`${client.id}: responds 200`, res.status === 200, `got ${res.status}`);
    if (res.status !== 200) continue;

    let payload = null;
    try {
      payload = JSON.parse(res.text);
    } catch (_) {
      check(`${client.id}: payload is valid JSON`, false);
      continue;
    }

    const missing = missingPaths(payload, CLIENT_PATHS);
    check(`${client.id}: matches the payload contract`, missing.length === 0, missing.slice(0, 6).join(", "));

    const dynamicMissing = missingPaths(payload, dynamicClientPaths({ scopes: scopeKeys, periods: periodKeys }));
    check(
      `${client.id}: resolves for every scope x period the UI can select`,
      dynamicMissing.length === 0,
      dynamicMissing.slice(0, 6).join(", ")
    );

    const onLoad = resolve(payload, `scopes.${defaultScope}.periods.${defaultPeriod}.current.events`);
    check(`${client.id}: renders in its DEFAULT state`, Number.isFinite(onLoad), "undefined on first paint");

    const all = resolve(payload, "scopes.all.totals.events");
    check(`${client.id}: all-activity interviews non-zero (${all})`, Number.isFinite(all) && all > 0);

    // The coordinated scope is legitimately allowed to be zero — a client
    // we genuinely did not schedule for — so this reports rather than
    // fails, to avoid a smoke test that cries wolf.
    const coordinated = resolve(payload, "scopes.coordinated.totals.events");
    if (!(coordinated > 0)) notes.push(`${client.id}: coordinated scope is 0 — check the roster if that is unexpected`);

    const roles = resolve(payload, "scopes.all.byRole.all") || [];
    check(`${client.id}: by-role table is populated`, roles.length > 0);

    // A handful of permanently unresolvable records (an anonymised
    // candidate, a deleted req) is normal and would make a strict check
    // fail forever — the fastest way to get a smoke test ignored. A
    // threshold still catches the regression this guards against, which
    // was 132 of Runlayer's 730 events (18%) sitting under Unknown role.
    const unknown = roles.find((r) => r.title === "Unknown role");
    const unknownEvents = unknown ? unknown.events : 0;
    const share = all ? unknownEvents / all : 0;
    if (unknownEvents > 0 && share <= 0.005) {
      notes.push(`${client.id}: ${unknownEvents} event(s) under "Unknown role" (${(share * 100).toFixed(2)}%) — within tolerance`);
    }
    check(
      `${client.id}: events resolving to no job stay under 0.5% (${unknownEvents})`,
      share <= 0.005,
      `${(share * 100).toFixed(1)}% of events have no job — job.list omits Draft jobs, so check syncJobGaps ran`
    );
  }

  console.log("");
  for (const note of notes) console.log(`  note ${note}`);

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
})().catch((err) => {
  console.error("\nSmoke test could not run:", err.message);
  process.exit(2);
});
