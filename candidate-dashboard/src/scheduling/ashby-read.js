"use strict";
// One read from Ashby's API for the scheduling pilot (availability-source.js,
// booking-facts.js): the HTTP status is kept, and a transient failure is
// retried within seconds instead of costing a five-minute auto-post round.
//
// Transient: no answer (network error, timeout), HTTP 429 or 5xx, or an answer
// that isn't JSON (a gateway's error page; seen on October 31 to November 2,
// four times, each fine five minutes later, logged then only as "Unexpected
// token '<'" because the body was parsed before the status was looked at).
// Each is logged with its status and, for a page, its <title>; it's tried
// again after RETRY_DELAYS (Retry-After when Ashby gives one, up to 30 s).
// Anything else (a JSON answer with success false, a 4xx) is Ashby's actual
// answer and is returned to the caller at once to word as before.
//
// Nothing from a body is logged except an HTML page's title; never the key.
const RETRY_DELAYS = [3000, 15000];
const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// What came back, for the log and the final error: "HTTP 502, a web page
// titled "502 Bad Gateway"" or "no answer (timed out)".
function describe({ status, text, error, json }) {
  if (json) return `HTTP ${status}`;
  if (error) return `no answer (${error.name === "TimeoutError" ? "timed out" : String(error.message || error).slice(0, 80)})`;
  const title = /<title[^>]*>([^<]{0,120})/i.exec(text || "")?.[1]?.replace(/\s+/g, " ").trim();
  const page = /^\s*</.test(text || "") ? `a web page${title ? ` titled "${title.slice(0, 80)}"` : ""}` : text ? "an answer that isn't JSON" : "an empty answer";
  return `HTTP ${status}, ${page}`;
}

async function attempt(request, url, init) {
  let r;
  try { r = await request(url, init); } catch (error) { return { transient: true, error }; }
  const status = r.status;
  const retryAfter = Number.parseInt(r.headers?.get?.("retry-after"), 10);
  let text = null, data;
  try {
    if (typeof r.text === "function") { text = await r.text(); data = JSON.parse(text); }
    else data = await r.json();
  } catch (_) { return { transient: true, status, text, retryAfter }; }
  if (status === 429 || status >= 500) return { transient: true, status, json: true, retryAfter };
  return { r, data };
}

// Returns { ok, data }: ok is the HTTP answer's ok, data its JSON. Throws (503,
// with `ashby` = { endpoint, status, described }) only after every try came
// back transient.
async function ashbyRead({ key, endpoint, body, request = fetch, sleep = realSleep, delays = RETRY_DELAYS, log = console }) {
  const url = "https://api.ashbyhq.com/" + endpoint;
  const init = () => ({ method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { Authorization: "Basic " + Buffer.from(key + ":").toString("base64"), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let last;
  for (let i = 0; i <= delays.length; i++) {
    last = await attempt(request, url, init());
    if (!last.transient) return { ok: last.r.ok !== false, data: last.data };
    const what = describe(last);
    if (i === delays.length) {
      log.warn(`[ashby] ${endpoint}: ${what}; gave up after ${i + 1} tries.`);
      throw Object.assign(new Error(`Ashby didn't answer properly (${what}) after ${i + 1} tries`), { status: 503, ashby: { endpoint, status: last.status ?? null, described: what } });
    }
    const wait = Number.isFinite(last.retryAfter) && last.retryAfter >= 0 ? Math.min(last.retryAfter * 1000, 30000) : delays[i];
    log.warn(`[ashby] ${endpoint}: ${what}; trying again in ${Math.round(wait / 1000)} s (try ${i + 1} of ${delays.length + 1}).`);
    await sleep(wait);
  }
}

module.exports = { ashbyRead, describe, RETRY_DELAYS };
