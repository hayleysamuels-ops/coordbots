"use strict";

/**
 * Pre-onboarding compatibility check for a new client's Ashby org.
 *
 * This dashboard makes several assumptions that hold for January's Ashby
 * configuration but are NOT guaranteed by Ashby's API for every org —
 * source-type naming ("Referral"/"Agency"), interview stage naming
 * ("Final"/"Executive" for onsite rounds), hiring-team role naming
 * ("Recruiter"/"Recruiting Coordinator"), and whether interviewer weekly
 * limits or training paths are configured at all. Rather than silently
 * showing empty sections for a client whose Ashby doesn't match those
 * conventions (or doesn't use those Ashby features at all), run
 * this against their API key first and read the report.
 *
 * Usage:
 *   node scripts/check-ashby-compatibility.js --api-key=<key> [options]
 *   ASHBY_API_KEY=<key> node scripts/check-ashby-compatibility.js
 *
 * Options (all optional; defaults match this app's config.js defaults):
 *   --api-key=<key>              Ashby API key (Admin > Integrations > API Keys)
 *   --app-base-url=<url>         Custom Ashby app domain, default https://app.ashbyhq.com
 *   --lookback-days=<n>          Schedule lookback window, default 30
 *   --referral-keywords=<a,b>    Comma-separated, default "referr"
 *   --agency-keywords=<a,b>      Comma-separated, default "agenc"
 *   --onsite-keywords=<a,b>      Comma-separated, default "final,exec"
 *   --recruiter-role=<name>      Exact hiringTeamRole.list value, default "Recruiter"
 *   --coordinator-role=<name>    Exact hiringTeamRole.list value, default "Recruiting Coordinator"
 *
 * Read-only: only ever calls Ashby's `.list`/`.info` endpoints. Never
 * creates, updates, or deletes anything.
 */

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(raw);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

function parseKeywordList(value, fallback) {
  if (value == null) return fallback;
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const args = parseArgs(process.argv.slice(2));
const apiKey = args["api-key"] || process.env.ASHBY_API_KEY;
const appBaseUrl = (args["app-base-url"] || process.env.ASHBY_APP_BASE_URL || "https://app.ashbyhq.com").replace(
  /\/+$/,
  ""
);
const lookbackDays = parseInt(args["lookback-days"], 10) || 30;
const referralKeywords = parseKeywordList(args["referral-keywords"], ["referr"]);
const agencyKeywords = parseKeywordList(args["agency-keywords"], ["agenc"]);
const onsiteKeywords = parseKeywordList(args["onsite-keywords"], ["final", "exec"]);
const recruiterRole = args["recruiter-role"] || "Recruiter";
const coordinatorRole = args["coordinator-role"] || "Recruiting Coordinator";

if (!apiKey) {
  console.error("Usage: node scripts/check-ashby-compatibility.js --api-key=<key>");
  console.error("   or: ASHBY_API_KEY=<key> node scripts/check-ashby-compatibility.js");
  process.exit(1);
}

function authHeader() {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

// Deliberately minimal — no retry/backoff, no pagination-callback plumbing.
// This is a one-shot diagnostic tool, not the always-on server; a single
// run failing loudly and telling you to re-run is fine here.
async function ashbyPost(endpoint, body) {
  const res = await fetch(`https://api.ashbyhq.com/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: authHeader() },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const detail = (json.errors && json.errors.join(", ")) || (json.errorInfo && json.errorInfo.message) || res.status;
    throw new Error(`${endpoint} -> ${detail}`);
  }
  return json;
}

async function fetchAllPages(endpoint, baseBody, maxPages = 50) {
  const all = [];
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    const json = await ashbyPost(endpoint, cursor ? { ...baseBody, cursor } : baseBody);
    all.push(...(json.results || []));
    if (!json.moreDataAvailable || !json.nextCursor) break;
    cursor = json.nextCursor;
  }
  return all;
}

// Bounded concurrency for per-item lookups (stage titles, interviewer
// settings) — same shape as src/concurrency.js, duplicated here so this
// script has zero dependency on the rest of the app.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function line(char = "-", n = 70) {
  return char.repeat(n);
}

function section(title) {
  console.log("");
  console.log(title);
  console.log(line("="));
}

function verdict(ok, label) {
  console.log(`  ${ok ? "✓ WILL WORK" : "✗ WILL BE EMPTY / NEEDS CONFIG"} — ${label}`);
}

async function main() {
  console.log(line("="));
  console.log("Ashby compatibility check");
  console.log(line("="));
  console.log(`API base:        https://api.ashbyhq.com`);
  console.log(`App base:        ${appBaseUrl}`);
  console.log(`Lookback:        ${lookbackDays} days`);
  console.log(`Referral kws:    ${referralKeywords.join(", ")}`);
  console.log(`Agency kws:      ${agencyKeywords.join(", ")}`);
  console.log(`Onsite kws:      ${onsiteKeywords.length ? onsiteKeywords.join(", ") : "(disabled)"}`);

  // --- Auth ---
  section("Authentication");
  let departments;
  try {
    const json = await ashbyPost("department.list", { includeArchived: true });
    departments = json.results || [];
    console.log(`  ✓ API key is valid (department.list succeeded)`);
  } catch (err) {
    console.log(`  ✗ Authentication failed: ${err.message}`);
    console.log("");
    console.log("Cannot continue without a working API key. Stopping.");
    process.exitCode = 1;
    return;
  }

  // --- Department / Job filter ---
  section("Department / Job filter");
  console.log(`  ${departments.length} departments found (${departments.filter((d) => !d.isArchived).length} active, ${departments.filter((d) => d.isArchived).length} archived).`);
  let jobs = [];
  try {
    jobs = await fetchAllPages("job.list", { limit: 100 }, 5);
  } catch (err) {
    console.log(`  Warning: job.list failed: ${err.message}`);
  }
  console.log(`  ${jobs.length}+ jobs found (sampled up to 500).`);
  verdict(departments.length > 0, "Department filter has real options");
  verdict(jobs.length > 0, "Job filter will have options (derived from candidates on screen, not this count directly)");

  // --- Interview schedules (feeds Feedback Overdue / Needs Scheduling /
  // Availability Submitted / Interviewer Weekly Limits / Onsite Today) ---
  section("Interview schedules (last " + lookbackDays + " days)");
  const createdAfter = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  let schedules = [];
  try {
    schedules = await fetchAllPages("interviewSchedule.list", { limit: 100, createdAfter });
  } catch (err) {
    console.log(`  ✗ interviewSchedule.list failed: ${err.message}`);
  }
  console.log(`  ${schedules.length} schedules found.`);

  const statusCounts = new Map();
  let eventsWithFeedbackData = 0;
  let totalEvents = 0;
  for (const s of schedules) {
    statusCounts.set(s.status, (statusCounts.get(s.status) || 0) + 1);
    for (const e of s.interviewEvents || []) {
      totalEvents++;
      if (e.endTime != null && typeof e.hasSubmittedFeedback === "boolean") eventsWithFeedbackData++;
    }
  }
  console.log(`  Status breakdown: ${[...statusCounts.entries()].map(([k, v]) => `${k} (${v})`).join(", ") || "none"}`);
  console.log(`  ${totalEvents} interview events found, ${eventsWithFeedbackData} carry endTime + hasSubmittedFeedback.`);

  verdict(eventsWithFeedbackData > 0, "Feedback Overdue (needs completed interview events with feedback status)");
  verdict((statusCounts.get("NeedsScheduling") || 0) > 0, 'Needs Scheduling (needs schedules in "NeedsScheduling" status)');
  verdict(
    (statusCounts.get("CandidateAvailabilitySubmitted") || 0) > 0,
    'Availability Submitted (needs schedules in "CandidateAvailabilitySubmitted" status)'
  );
  if (schedules.length > 0 && totalEvents === 0) {
    console.log("  Note: schedules exist but carry no interviewEvents — check whether this org actually books interviews through Ashby scheduling, or via an external calendar tool Ashby doesn't see.");
  }

  // --- Interviewer Weekly Limits ---
  section("Interviewer Weekly Limits");
  const interviewerIds = new Set();
  for (const s of schedules) {
    for (const e of s.interviewEvents || []) {
      for (const i of e.interviewers || []) {
        if (i.id) interviewerIds.add(i.id);
      }
    }
  }
  const sampledInterviewerIds = [...interviewerIds].slice(0, 50);
  const settingsResults = await mapWithConcurrency(sampledInterviewerIds, 8, (userId) =>
    ashbyPost("user.interviewerSettings", { userId }).then((json) => json.results)
  );
  const withLimit = settingsResults.filter((s) => s && s.weeklyLimit != null).length;
  console.log(
    `  ${interviewerIds.size} unique interviewers seen in recent schedules (sampled ${sampledInterviewerIds.length}).`
  );
  console.log(`  ${withLimit} of ${sampledInterviewerIds.length} sampled interviewers have a weeklyLimit configured in Ashby.`);
  verdict(withLimit > 0, "Interviewer Weekly Limits (needs at least some interviewers with weeklyLimit set in Ashby — this is an org configuration choice, not something this dashboard can detect further)");

  // --- Interviewer Training ---
  section("Interviewer Training");
  let pools = [];
  try {
    pools = await fetchAllPages("interviewerPool.list", { limit: 100 }, 5);
  } catch (err) {
    console.log(`  Warning: interviewerPool.list failed: ${err.message}`);
  }
  const trainablePools = pools.filter((p) => p.trainingPath && p.trainingPath.enabled);
  console.log(`  ${pools.length} interviewer pools found, ${trainablePools.length} with an enabled training path.`);
  let totalTrainees = 0;
  if (trainablePools.length) {
    const poolDetails = (
      await mapWithConcurrency(trainablePools.slice(0, 50), 8, (pool) =>
        ashbyPost("interviewerPool.info", { interviewerPoolId: pool.id }).then((json) => json.results)
      )
    ).filter(Boolean);
    totalTrainees = poolDetails.reduce((sum, p) => sum + (p.trainees || []).length, 0);
    console.log(`  ${totalTrainees} total trainees currently enrolled across those pools.`);
  }
  console.log(
    "  Note: this section uses real Ashby Shadow/ReverseShadow enum values, not a naming-convention guess — no keyword tuning needed here, unlike Onsite Interviews Today or Recently Sourced below."
  );
  verdict(
    trainablePools.length > 0,
    "Interviewer Training (needs at least one interviewer pool with an enabled training path — this is an org configuration choice, not something this dashboard can detect further)"
  );

  // --- Onsite Interviews Today ---
  section("Onsite Interviews Today");
  const stageIds = [...new Set(schedules.map((s) => s.interviewStageId).filter(Boolean))];
  const stageResults = await mapWithConcurrency(stageIds.slice(0, 100), 8, (interviewStageId) =>
    ashbyPost("interviewStage.info", { interviewStageId }).then((json) => json.results && json.results.title)
  );
  const distinctStageTitles = [...new Set(stageResults.filter(Boolean))].sort();
  console.log(`  ${distinctStageTitles.length} distinct interview stage titles found in recent schedules:`);
  for (const t of distinctStageTitles) console.log(`    - ${t}`);

  const matchingOnsiteStages = onsiteKeywords.length
    ? distinctStageTitles.filter((t) => onsiteKeywords.some((k) => t.toLowerCase().includes(k)))
    : [];
  if (!onsiteKeywords.length) {
    console.log(`  ONSITE_STAGE_KEYWORDS is empty — section is disabled by config, not a compatibility problem.`);
  } else if (matchingOnsiteStages.length) {
    console.log(`  Stage titles matching configured keywords: ${matchingOnsiteStages.join(", ")}`);
  } else {
    console.log(`  NONE of the stage titles above match keywords [${onsiteKeywords.join(", ")}].`);
    console.log(`  If any of the titles listed above represent this client's onsite/in-person round,`);
    console.log(`  set ONSITE_STAGE_KEYWORDS to a substring that matches it (comma-separated, case-insensitive).`);
  }
  if (onsiteKeywords.length) {
    verdict(matchingOnsiteStages.length > 0, "Onsite Interviews Today (needs a stage title matching ONSITE_STAGE_KEYWORDS)");
  } else {
    console.log("  ○ DISABLED — Onsite Interviews Today (ONSITE_STAGE_KEYWORDS explicitly empty, by choice)");
  }

  // --- Recently Sourced / source classification ---
  section("Recently Sourced (source classification)");
  let recentApps = [];
  try {
    recentApps = await fetchAllPages("application.list", { limit: 100, createdAfter: Date.now() - 30 * 24 * 60 * 60 * 1000 }, 5);
  } catch (err) {
    console.log(`  Warning: application.list failed: ${err.message}`);
  }
  const distinctSourceTitles = [
    ...new Set(recentApps.map((a) => ((a.source || {}).sourceType || {}).title).filter(Boolean)),
  ].sort();
  console.log(`  ${recentApps.length} applications created in the last 30 days (sampled up to 500).`);
  console.log(`  ${distinctSourceTitles.length} distinct source-type titles found:`);
  for (const t of distinctSourceTitles) console.log(`    - ${t}`);

  const matchingReferral = distinctSourceTitles.filter((t) => referralKeywords.some((k) => t.toLowerCase().includes(k)));
  const matchingAgency = distinctSourceTitles.filter((t) => agencyKeywords.some((k) => t.toLowerCase().includes(k)));
  console.log(`  Matching "referral" keywords [${referralKeywords.join(", ")}]: ${matchingReferral.join(", ") || "none"}`);
  console.log(`  Matching "agency" keywords [${agencyKeywords.join(", ")}]: ${matchingAgency.join(", ") || "none"}`);
  if (!matchingReferral.length && !matchingAgency.length && distinctSourceTitles.length) {
    console.log(`  If any of the titles above represent this client's referral/agency sources,`);
    console.log(`  set SOURCE_REFERRAL_KEYWORDS / SOURCE_AGENCY_KEYWORDS to match (comma-separated, case-insensitive).`);
  }
  verdict(matchingReferral.length > 0 || matchingAgency.length > 0, "Recently Sourced (needs at least one matching source type)");

  // --- Recruiter / Coordinator filter ---
  section("Recruiter / Coordinator filter");
  let hiringTeamRoles = [];
  try {
    const json = await ashbyPost("hiringTeamRole.list", {});
    hiringTeamRoles = json.results || [];
  } catch (err) {
    console.log(`  Warning: hiringTeamRole.list failed: ${err.message}`);
  }
  console.log(`  This org's hiringTeamRole.list: ${hiringTeamRoles.join(", ") || "none"}`);
  console.log(`  Configured RECRUITER_ROLE_NAME: "${recruiterRole}" — ${hiringTeamRoles.includes(recruiterRole) ? "matches a real role" : "NO MATCH"}`);
  console.log(`  Configured COORDINATOR_ROLE_NAME: "${coordinatorRole}" — ${hiringTeamRoles.includes(coordinatorRole) ? "matches a real role" : "NO MATCH"}`);
  const appsWithRecruiter = recentApps.filter((a) => (a.hiringTeam || []).some((m) => m.role === recruiterRole)).length;
  const appsWithCoordinator = recentApps.filter((a) => (a.hiringTeam || []).some((m) => m.role === coordinatorRole)).length;
  console.log(`  ${appsWithRecruiter} of ${recentApps.length} sampled recent applications have a "${recruiterRole}" on the hiring team.`);
  console.log(`  ${appsWithCoordinator} of ${recentApps.length} sampled recent applications have a "${coordinatorRole}" on the hiring team.`);
  if (!hiringTeamRoles.includes(recruiterRole) || !hiringTeamRoles.includes(coordinatorRole)) {
    console.log(`  If neither role name matches, set RECRUITER_ROLE_NAME / COORDINATOR_ROLE_NAME to one of the`);
    console.log(`  role names listed above.`);
  }
  verdict(appsWithRecruiter > 0, "Recruiter filter (needs applications with a matching hiring-team role)");
  verdict(appsWithCoordinator > 0, "Coordinator filter (needs applications with a matching hiring-team role)");

  // --- Active Referrals report link ---
  section("Active Referrals report link");
  console.log("  This is a static link to an Ashby saved report, not a query this app runs.");
  console.log("  Have this client create (or share) a saved Active Referrals report in Ashby,");
  console.log("  then set ACTIVE_REFERRALS_REPORT_URL to its URL. The button stays hidden until set.");

  section("Summary");
  console.log("Review any ✗ lines above before onboarding this client — each points at either");
  console.log("a config value to set (env vars printed above) or a section that will be");
  console.log("empty until this client configures something on the Ashby side (e.g. interviewer");
  console.log("weekly limits).");
}

main().catch((err) => {
  console.error("");
  console.error("Compatibility check failed unexpectedly:", err.message);
  process.exitCode = 1;
});
