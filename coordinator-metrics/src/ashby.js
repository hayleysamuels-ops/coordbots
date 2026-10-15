"use strict";

/**
 * Multi-org Ashby client.
 *
 * The retry/backoff and pagination behaviour here is lifted from
 * candidate-dashboard/src/ashby.js, which earned it against real orgs — see
 * the comment on RETRYABLE_STATUS_CODES. The one structural difference is
 * that nothing here reads a single global API key: every call takes the
 * client's own key, because this process talks to five separate Ashby orgs.
 *
 * Read-only. Every endpoint used is a `.list`; nothing is ever created,
 * updated or deleted.
 */

// 500/502/503/504 are Ashby-side blips, not bad requests: mid-pagination
// they used to abort a whole sync over something that succeeds a moment
// later. 429 is the documented rate limit. Anything else is a real error
// and throws immediately.
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_MAX_TOTAL_BACKOFF_MS = 4 * 60 * 1000;
const RETRYABLE_INITIAL_DELAY_MS = 1000;

const apiCallCountByClient = {};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeader(apiKey) {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

function getApiCallCounts() {
  return { ...apiCallCountByClient };
}

async function ashbyPost(client, endpoint, body) {
  if (!client.apiKey) throw new Error(`Client "${client.id}" has no Ashby API key configured`);

  let attempt = 0;
  let totalWaitedMs = 0;

  for (;;) {
    apiCallCountByClient[client.id] = (apiCallCountByClient[client.id] || 0) + 1;

    const res = await fetch(`https://api.ashbyhq.com/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: authHeader(client.apiKey),
      },
      body: JSON.stringify(body || {}),
    });

    if (RETRYABLE_STATUS_CODES.has(res.status)) {
      const retryAfterSeconds = parseInt(res.headers.get("retry-after"), 10);
      const backoffMs =
        !Number.isNaN(retryAfterSeconds) && retryAfterSeconds >= 0
          ? Math.max(retryAfterSeconds * 1000, 250)
          : RETRYABLE_INITIAL_DELAY_MS * 2 ** attempt;

      if (totalWaitedMs + backoffMs > RETRYABLE_MAX_TOTAL_BACKOFF_MS) {
        throw new Error(
          `[${client.id}] ${endpoint} -> HTTP ${res.status} (gave up after ${Math.round(totalWaitedMs / 1000)}s of retries)`
        );
      }

      attempt += 1;
      totalWaitedMs += backoffMs;
      const reason = res.status === 429 ? "rate-limited (429)" : `upstream error (${res.status})`;
      console.warn(`[ashby:${client.id}] ${endpoint} ${reason}, waiting ${Math.round(backoffMs / 1000)}s before retry ${attempt}`);
      await sleep(backoffMs);
      continue;
    }

    if (!res.ok) throw new Error(`[${client.id}] ${endpoint} -> HTTP ${res.status}`);
    const json = await res.json();
    if (json.success === false) throw new Error(`[${client.id}] ${endpoint} -> ${JSON.stringify(json.errors || json)}`);
    return json;
  }
}

/**
 * Walks every page of a `.list` endpoint. `onPage` is called with each
 * page as it arrives rather than accumulating everything in memory first —
 * a 12-month `interviewSchedule.list` on a busy org is ~21,000 schedules
 * with their events inlined, which is worth streaming into SQLite page by
 * page instead of holding whole.
 */
async function fetchAllPages(client, endpoint, baseBody, onPage) {
  const all = onPage ? null : [];
  let cursor;
  let pages = 0;

  for (;;) {
    const json = await ashbyPost(client, endpoint, cursor ? { ...baseBody, cursor } : baseBody);
    const results = json.results || [];
    pages += 1;

    if (onPage) await onPage(results, pages);
    else all.push(...results);

    if (!json.moreDataAvailable || !json.nextCursor) break;
    cursor = json.nextCursor;
  }

  return all ?? pages;
}

// --- The endpoints this app reads -----------------------------------------

// Interview *definitions* (not events): the title shown on a calendar
// invite, and Ashby's own structured `isDebrief` flag. Small — 114 records
// on Forus. The title is what the excluded-keywords rule matches against,
// and isDebrief is how debriefs are counted separately without guessing
// from a name.
async function listInterviews(client) {
  return fetchAllPages(client, "interview.list", { limit: 100 });
}

// Jobs are the "role" every volume metric is broken down by. Includes
// departmentId, status and openedAt/closedAt.
async function listJobs(client) {
  return fetchAllPages(client, "job.list", { limit: 100, includeArchived: true });
}

async function listDepartments(client) {
  const json = await ashbyPost(client, "department.list", { includeArchived: true });
  return json.results || [];
}

// NOTE: there is deliberately no listApplications() here. `application.list`
// returns every application an org has ever received (242,611 on Forus),
// almost none of which reached an interview — sync.js resolves the few
// thousand that did by id through `application.info` instead. See the
// comment on syncApplications().

// The core volume call. Schedules carry their interviewEvents inline, so
// one sweep gets both. `createdAfter` is the only time filter Ashby offers
// here — there is no updatedAfter, which is why the incremental top-up
// re-reads a rolling window rather than only brand-new rows.
async function listInterviewSchedules(client, onPage, createdAfter) {
  const body = { limit: 100 };
  if (createdAfter) body.createdAfter = createdAfter;
  return fetchAllPages(client, "interviewSchedule.list", body, onPage);
}

// Stage titles are needed to break volume down by stage, but
// `interviewStage.list` rejects a call with no interviewPlanId
// (`invalid_input`, confirmed live) — so plans are listed first and stages
// are read per plan. Both are small.
async function listInterviewStages(client) {
  const plans = await fetchAllPages(client, "interviewPlan.list", { limit: 100 });
  const stages = [];

  for (const plan of plans) {
    try {
      const planStages = await fetchAllPages(client, "interviewStage.list", {
        limit: 100,
        interviewPlanId: plan.id,
      });
      stages.push(...planStages);
    } catch (err) {
      // One unreadable plan shouldn't cost the whole sync its stage names —
      // schedules for that plan just fall back to "Unknown stage".
      console.warn(`[ashby:${client.id}] interviewStage.list failed for plan ${plan.id}: ${err.message}`);
    }
  }

  return stages;
}

module.exports = {
  ashbyPost,
  fetchAllPages,
  listInterviews,
  listJobs,
  listDepartments,
  listInterviewSchedules,
  listInterviewStages,
  getApiCallCounts,
};
