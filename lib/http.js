"use strict";
/**
 * Shared outbound HTTP for the bots: JSON in, JSON out, with a timeout and a
 * few retries. Uses Node's built-in fetch, the same as the Google token
 * exchange in server.js — no HTTP library needed.
 */

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => Math.min(500 * Math.pow(2, attempt - 1), 4000);
const snippet = (s) => String(s || "").replace(/\s+/g, " ").slice(0, 300);

async function postJson(url, options) {
  const {
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    attempts = DEFAULT_ATTEMPTS,
    label = "request",
  } = options || {};

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res, text;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      // Network failure or timeout — worth retrying.
      lastError = new Error(
        label + " failed: " + (e.name === "TimeoutError" ? "timed out after " + timeoutMs + "ms" : e.message)
      );
      if (attempt < attempts) {
        await sleep(backoff(attempt));
        continue;
      }
      throw lastError;
    }

    // Rate limited or the far end is unwell — back off and try again.
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(label + " failed: HTTP " + res.status + " " + snippet(text));
      if (attempt < attempts) {
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        await sleep(retryAfter ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      throw lastError;
    }

    // 4xx means we asked wrongly; retrying would just fail again.
    if (!res.ok) throw new Error(label + " failed: HTTP " + res.status + " " + snippet(text));

    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(label + " returned non-JSON: " + snippet(text));
    }
  }
  throw lastError;
}

/**
 * Run an async function over a list, a few at a time.
 *
 * Ashby answers in roughly two seconds, so doing forty calls one after another
 * takes over a minute. A small amount of concurrency brings that down without
 * hammering the API.
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

module.exports = { postJson, mapLimit };
