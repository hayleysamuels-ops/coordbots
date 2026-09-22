"use strict";
/**
 * What pushCandidate does with each kind of failure.
 *
 * Changing it touched every save, not just reversed dates, so the transient path
 * is tested here alongside the 400 path. A blip is the common case and must not
 * start reading as a hard failure.
 *
 * pushCandidate is sliced out of public/index.html and run against a stubbed
 * fetch, so each status code can be driven directly.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function pusher(response) {
  const start = html.indexOf("  function pushCandidate(c){");
  assert.ok(start >= 0, "pushCandidate moved");
  // Ends at the line that is only a closing brace at the function's indent.
  const lines = html.slice(start).split("\n");
  const ind = lines[0].match(/^ */)[0].length;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === " ".repeat(ind) + "}") { end = i; break; }
  }
  assert.ok(end > 0, "could not find the end of pushCandidate");
  const src = lines.slice(0, end + 1).join("\n");

  const log = { sync: [], toasts: [], renders: 0, signedOut: 0 };
  const sandbox = new Function("RESPONSE", "LOG", `
    var API="/api";
    var dirty={}, online=null, fieldError={}, rejectedSaves={};
    function headers(){ return {}; }
    function signedOut(){ LOG.signedOut++; }
    function setSync(state,text){ LOG.sync.push(state+":"+text); }
    function toast(t){ LOG.toasts.push(t); }
    function render(){ LOG.renders++; }
    function fmtDate(s){ return s || "not set"; }
    function fetch(){ return RESPONSE(); }
    ${src}
    return { pushCandidate, state: function(){ return { dirty, online, fieldError, rejectedSaves }; } };
  `)(response, log);
  return { M: sandbox, log };
}

const ok = () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ ok: true }) });
const status = (code, body) => () => Promise.resolve({
  status: code, ok: code >= 200 && code < 300,
  json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
});
const networkFailure = () => Promise.reject(new TypeError("Failed to fetch"));

const settle = () => new Promise((r) => setTimeout(r, 5));
const card = { id: "c1", name: "A Person" };

test("a successful save clears dirty and reports synced", async () => {
  const { M, log } = pusher(ok);
  M.pushCandidate(card);
  await settle();
  assert.deepEqual(log.sync, ["ok:Synced"]);
  assert.deepEqual(M.state().dirty, {}, "no longer dirty");
  assert.deepEqual(M.state().rejectedSaves, {});
});

test("a 502 from Railway still takes the transient path", async () => {
  // The common case. It must not start reading as a hard failure.
  const { M, log } = pusher(status(502));
  M.pushCandidate(card);
  await settle();
  assert.deepEqual(log.sync, ["err:Offline, not saved"]);
  assert.equal(M.state().online, false);
  assert.deepEqual(M.state().rejectedSaves, {}, "not recorded as a refusal");
  assert.deepEqual(log.toasts, [], "and no hard-error toast");
});

test("a dropped connection still takes the transient path", async () => {
  const { M, log } = pusher(networkFailure);
  M.pushCandidate(card);
  await settle();
  assert.deepEqual(log.sync, ["err:Offline, not saved"]);
  assert.equal(M.state().online, false);
  assert.deepEqual(M.state().rejectedSaves, {});
});

test("500, 503 and 404 all take the transient path too", async () => {
  for (const code of [500, 503, 404, 409]) {
    const { M, log } = pusher(status(code));
    M.pushCandidate(card);
    await settle();
    assert.deepEqual(log.sync, ["err:Offline, not saved"], code + " should be transient");
    assert.deepEqual(M.state().rejectedSaves, {}, code + " is not a refusal");
  }
});

test("401 still signs the viewer out, unchanged", async () => {
  const { M, log } = pusher(status(401));
  M.pushCandidate(card);
  await settle();
  assert.equal(log.signedOut, 1);
  assert.deepEqual(M.state().rejectedSaves, {}, "not a data refusal");
});

test("400 is the ONLY code that surfaces as a hard error", async () => {
  const { M, log } = pusher(status(400, {
    error: "end date 2026-09-17 is before start date 2026-09-18",
    field: "endDate", startDate: "2026-09-18", endDate: "2026-09-17",
  }));
  M.pushCandidate(card);
  await settle();
  assert.deepEqual(M.state().rejectedSaves, {
    c1: { error: "end date 2026-09-17 is before start date 2026-09-18",
          field: "endDate", startDate: "2026-09-18", endDate: "2026-09-17" },
  });
  assert.match(log.toasts[0], /end date is before start date/);
  assert.match(M.state().fieldError["c1|endDate"], /2026-09-17.*2026-09-18/);
  // The connection is fine, so the sync pill must not claim otherwise.
  assert.deepEqual(log.sync, ["ok:Synced"]);
  assert.notEqual(M.state().online, false);
  assert.equal(log.renders, 1, "the card is re-rendered to show the message");
});

test("a 400 with no readable body still refuses rather than going offline", async () => {
  // The server always sends a body, but a proxy could strip it.
  const { M, log } = pusher(status(400));
  M.pushCandidate(card);
  await settle();
  assert.ok(M.state().rejectedSaves.c1, "still treated as a refusal");
  assert.equal(log.sync[0], "ok:Synced", "and not as a network problem");
});

test("a refused row stays dirty, so nothing is lost", async () => {
  const { M } = pusher(status(400, { field: "endDate", startDate: "2026-09-18", endDate: "2026-09-17" }));
  M.state().dirty.c1 = true;
  M.pushCandidate(card);
  await settle();
  assert.equal(M.state().dirty.c1, true, "dirty is only cleared on a successful save");
});

test("the sync pill wording is the only claim of retrying, and nothing retries", () => {
  // Recorded rather than asserted as correct: there is no retry anywhere.
  // pushCandidate is called from persist()'s 450ms debounce, pull()'s heal path
  // and the import, and none of them re-send on failure. A failed row stays
  // dirty, which keeps pull() from culling it, but it is only re-sent if
  // somebody edits the field again.
  const calls = [...html.matchAll(/pushCandidate\(/g)].length;
  // 4: the definition, the 450ms save debounce, pull()'s heal path, and the import.
  assert.equal(calls, 4, "call sites changed, re-check whether a retry now exists: " + calls);
  assert.equal(/setTimeout\([^)]*pushCandidate/.test(html.replace(/saveTimers\[c\.id\]=setTimeout\(function\(\)\{ pushCandidate\(c\); \}, 450\);/, "")), false,
    "no retry timer beyond the save debounce");
});

test("the read and write paths say different things, for the right reason", () => {
  // pull() is on a 4s setInterval, so a failed read really is retried and
  // "retrying" is true there. Nothing re-sends a failed save, so the write path
  // must not claim it.
  assert.match(html, /setInterval\(pull, POLL_MS\)/, "the read path is on an interval");

  const push = html.slice(html.indexOf("function pushCandidate(c){"),
                          html.indexOf("function removeRemote(id){"));
  assert.match(push, /setSync\("err","Offline, not saved"\)/);
  assert.equal(/setSync\("err","Offline, retrying"\)/.test(push), false,
    "the write path must not claim a retry it does not do");

  const pull = html.slice(html.indexOf("function pull(){"),
                          html.indexOf("function signedOut(){"));
  assert.match(pull, /setSync\("err","Offline, retrying"\)/,
    "the read path does retry, so its wording stands");
});
