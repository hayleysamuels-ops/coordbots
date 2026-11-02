"use strict";
// ashby-read.js: Ashby's HTTP status is kept, a gateway's error page or a 5xx
// or 429 is retried within seconds (Retry-After honoured), and Ashby's own
// JSON refusals come back at once for the caller to word.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ashbyRead } = require("../src/scheduling/ashby-read");

const page = (status, title) => ({ ok: false, status, headers: new Map(), text: async () => `<!DOCTYPE html><html><head><title>${title}</title></head><body>…</body></html>` });
const json = (status, body, headers = new Map()) => ({ ok: status < 400, status, headers, text: async () => JSON.stringify(body) });
const run = answers => {
  const logs = [], waits = [];
  let i = 0;
  const p = ashbyRead({ key: "k", endpoint: "application.info", body: {}, request: async () => { const a = answers[i++]; if (a instanceof Error) throw a; return a; },
    sleep: async ms => waits.push(ms), log: { warn: m => logs.push(m) } });
  return { p, logs, waits, tries: () => i };
};

test("a gateway's error page is retried after 3 and 15 seconds, logged with its status and title, and then succeeds", async () => {
  const r = run([page(502, "502 Bad Gateway"), page(503, "Service Unavailable"), json(200, { success: true, results: { id: "a" } })]);
  assert.deepEqual(await r.p, { ok: true, data: { success: true, results: { id: "a" } } });
  assert.deepEqual(r.waits, [3000, 15000]);
  assert.deepEqual(r.logs, ['[ashby] application.info: HTTP 502, a web page titled "502 Bad Gateway"; trying again in 3 s (try 1 of 3).',
    '[ashby] application.info: HTTP 503, a web page titled "Service Unavailable"; trying again in 15 s (try 2 of 3).']);
});

test("after three transient failures it gives up, saying what came back", async () => {
  const r = run([page(502, "x"), Object.assign(new Error("t"), { name: "TimeoutError" }), json(500, { success: false })]);
  await assert.rejects(r.p, e => e.status === 503 && e.message === "Ashby didn't answer properly (HTTP 500) after 3 tries" && e.ashby.status === 500);
  assert.match(r.logs[1], /no answer \(timed out\); trying again in 15 s/);
  assert.match(r.logs.at(-1), /gave up after 3 tries\.$/);
});

test("429 honours Retry-After (capped); Ashby's own JSON refusals aren't retried", async () => {
  const r = run([json(429, { success: false }, new Map([["retry-after", "7"]])), json(200, { success: true })]);
  await r.p;
  assert.deepEqual(r.waits, [7000]);
  const no = run([json(200, { success: false, errors: ["application_not_found"] })]);
  assert.deepEqual(await no.p, { ok: true, data: { success: false, errors: ["application_not_found"] } });
  assert.equal(no.tries(), 1);
  const unauth = run([json(401, { success: false })]);
  assert.equal((await unauth.p).ok, false);
  assert.equal(unauth.tries(), 1);
});
