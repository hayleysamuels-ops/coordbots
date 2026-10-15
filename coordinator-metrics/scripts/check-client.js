"use strict";

/**
 * Pre-onboarding check for a client you're about to add a tab for.
 *
 * Two of this dashboard's counting rules depend on how a particular org
 * names things, and neither fails loudly on its own — they just quietly
 * produce a wrong number. This prints what the org actually contains so
 * you can set the per-client config before trusting any of it:
 *
 *   1. Which interview titles look like holds or logistics rather than
 *      interviews (EXCLUDED_TITLE_KEYWORDS_<ID>). Confirmed real: Forus
 *      has "External Hold", "Arrival + Set Up", "Work Time" and "Dinner
 *      with Forus" sitting alongside genuine interviews.
 *   2. Whether debriefs are flagged with Ashby's structured isDebrief at
 *      all, or whether this org just names them in the title.
 *
 * It also reports 12-month volume so you know what the first backfill
 * will cost, and whether hiring-team roles match the usual names.
 *
 * Usage:
 *   npm run check-client -- --client=forus
 *   ASHBY_API_KEY=<key> npm run check-client -- --name="New Client"
 *
 * Read-only: only ever calls `.list` endpoints.
 */

require("dotenv").config();

const config = require("../src/config");
const ashby = require("../src/ashby");

function arg(name, fallback) {
  const match = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

function heading(text) {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

(async () => {
  const clientId = arg("client", null);
  let client;

  if (clientId) {
    client = config.clients.find((c) => c.id === clientId);
    if (!client) {
      console.error(`Unknown client "${clientId}". Configured: ${config.clientIds.join(", ") || "none"}`);
      process.exit(1);
    }
  } else if (process.env.ASHBY_API_KEY) {
    client = {
      id: "adhoc",
      name: arg("name", "Ad-hoc client"),
      apiKey: process.env.ASHBY_API_KEY,
      timeZone: "America/New_York",
      excludedTitleKeywords: config.clients[0]
        ? config.clients[0].excludedTitleKeywords
        : ["hold", "work time", "arrival", "set up", "break", "lunch", "dinner", "buffer", "placeholder"],
    };
  } else {
    console.error("Pass --client=<id> for a configured client, or set ASHBY_API_KEY for one that isn't configured yet.");
    process.exit(1);
  }

  console.log(`Checking ${client.name} (${client.id})`);

  const [interviews, jobs, stages] = await Promise.all([
    ashby.listInterviews(client),
    ashby.listJobs(client),
    ashby.listInterviewStages(client),
  ]);

  heading("Interview titles");
  const excluded = interviews.filter((i) => {
    const title = (i.title || "").toLowerCase();
    return client.excludedTitleKeywords.some((k) => title.includes(k));
  });
  const debriefs = interviews.filter((i) => i.isDebrief);

  console.log(`${interviews.length} interview definitions.`);
  console.log(`${debriefs.length} flagged isDebrief by Ashby${debriefs.length === 0 ? " — WARNING: this org may not use the flag, so debriefs will be counted as ordinary interviews." : "."}`);
  console.log(`${excluded.length} would be EXCLUDED by the current keywords (${client.excludedTitleKeywords.join(", ") || "none"}):`);
  for (const i of excluded) console.log(`  - ${i.title}`);

  console.log("\nTitles that would be COUNTED — scan for holds or internal blocks the keywords miss:");
  for (const i of interviews.filter((x) => !excluded.includes(x)).slice(0, 60)) {
    console.log(`  ${i.isDebrief ? "[debrief] " : "          "}${i.title}`);
  }
  if (interviews.length > 60) console.log(`  … and ${interviews.length - 60} more`);

  heading("Roles and stages");
  console.log(`${jobs.length} jobs (${jobs.filter((j) => j.status === "Open").length} open), ${stages.length} interview stages.`);

  heading("Hiring team roles");
  try {
    const roles = await ashby.ashbyPost(client, "hiringTeamRole.list", {});
    console.log((roles.results || []).map((r) => r.title || r.name).join(", "));
  } catch (err) {
    console.log(`could not read: ${err.message}`);
  }

  heading("12-month volume (what the first backfill will cost)");
  const createdAfter = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const t0 = Date.now();
  let schedules = 0;
  let events = 0;
  let cancelled = 0;

  await ashby.listInterviewSchedules(
    client,
    (page) => {
      schedules += page.length;
      events += page.reduce((n, s) => n + (s.interviewEvents || []).length, 0);
      cancelled += page.filter((s) => s.status === "Cancelled").length;
    },
    createdAfter
  );

  const seconds = Math.round((Date.now() - t0) / 1000);
  console.log(`${schedules} schedules, ${events} events, ${cancelled} cancelled, pulled in ${seconds}s.`);
  console.log(`Ashby API calls made by this check: ${ashby.getApiCallCounts()[client.id] || 0}`);
  process.exit(0);
})().catch((err) => {
  console.error("check-client failed:", err.message);
  process.exit(1);
});
