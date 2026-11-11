"use strict";
// The usage log store (usage-log.js): what an entry holds, the filters, and
// the 90-day deletion. Fictional people throughout.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUsageLog, RETENTION_DAYS } = require("../src/usage-log");

const quiet = { log() {}, warn() {} };
function setup(start = Date.UTC(2026, 10, 11, 18)) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-log-"));
  let t = start;
  const usage = createUsageLog({ dataDir, timeZone: "America/Los_Angeles", admins: ["admin@example-agency.com"], now: () => t, log: quiet });
  return { usage, dataDir, at: (ms) => { t = ms; }, tick: (ms = 1000) => { t += ms; }, done: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}
const google = (email) => ({ method: "google", email, name: "Fictional" });

test("an entry: verified email for Google; 'password' with a session id and no name for the shared password", (t) => {
  const s = setup(); t.after(s.done);
  s.usage.record(google("ana@example-client.com"), "hide", { detail: "Fictional Candidate", candidateId: "c-1" });
  s.tick();
  s.usage.record({ method: "password", email: null, name: "Typed Name", session: "abc123" }, "snooze", { detail: "Other Candidate" });
  const { rows } = s.usage.list();
  assert.deepEqual(rows.map((r) => [r.who, r.via, r.session, r.event, r.detail]), [
    [null, "password", "abc123", "snooze", "Other Candidate"],
    ["ana@example-client.com", "google", undefined, "hide", "Fictional Candidate"],
  ]);
  assert.equal(JSON.stringify(rows).includes("Typed Name"), false);
  assert.equal(rows[1].candidateId, "c-1");
});

test("one file per day in DISPLAY_TIMEZONE, appended to", (t) => {
  const s = setup(Date.UTC(2026, 10, 12, 7, 30)); t.after(s.done); // 11:30pm Nov 11 in Los Angeles
  s.usage.record(google("ana@example-client.com"), "page");
  s.at(Date.UTC(2026, 10, 12, 8, 30)); // 12:30am Nov 12
  s.usage.record(google("ana@example-client.com"), "page");
  s.usage.record(google("ana@example-client.com"), "refresh");
  assert.deepEqual(fs.readdirSync(path.join(s.dataDir, "usage")).sort(), ["2026-11-11.jsonl", "2026-11-12.jsonl"]);
  assert.equal(fs.readFileSync(path.join(s.dataDir, "usage", "2026-11-12.jsonl"), "utf8").trim().split("\n").length, 2);
  assert.deepEqual(s.usage.days(), ["2026-11-12", "2026-11-11"]);
  assert.deepEqual(s.usage.list({ day: "2026-11-11" }).rows.map((r) => r.event), ["page"]);
});

test("filters: by person (an email or 'password'); admins left out unless asked for, but always recorded", (t) => {
  const s = setup(); t.after(s.done);
  s.usage.record(google("ana@example-client.com"), "tab", { detail: "Offers" }); s.tick();
  s.usage.record(google("admin@example-agency.com"), "hide", { detail: "Fictional Candidate" }); s.tick();
  s.usage.record({ method: "password", session: "abc123" }, "tab", { detail: "Dashboard" });
  assert.deepEqual(s.usage.list().rows.map((r) => r.who), [null, "ana@example-client.com"]);
  assert.deepEqual(s.usage.list({ includeAdmins: true }).rows.map((r) => r.who), [null, "admin@example-agency.com", "ana@example-client.com"]);
  assert.deepEqual(s.usage.list({ person: "password" }).rows.map((r) => r.detail), ["Dashboard"]);
  assert.deepEqual(s.usage.list({ person: "ana@example-client.com" }).rows.map((r) => r.detail), ["Offers"]);
  assert.deepEqual(s.usage.listPeople(), ["admin@example-agency.com", "ana@example-client.com", "password"]);
  assert.equal(s.usage.isAdmin("admin@example-agency.com"), true);
  assert.equal(s.usage.isAdmin("ana@example-client.com"), false);
});

test("paging: newest first, `more` when there's another page", (t) => {
  const s = setup(); t.after(s.done);
  for (let i = 0; i < 5; i++) { s.usage.record(google("ana@example-client.com"), "tab", { detail: `T${i}` }); s.tick(); }
  const first = s.usage.list({ limit: 2 });
  assert.deepEqual(first.rows.map((r) => r.detail), ["T4", "T3"]);
  assert.equal(first.more, true);
  const last = s.usage.list({ limit: 2, offset: 4 });
  assert.deepEqual(last.rows.map((r) => r.detail), ["T0"]);
  assert.equal(last.more, false);
});

test("a torn or unknown line is skipped, not fatal; unknown events aren't recorded", (t) => {
  const s = setup(); t.after(s.done);
  s.usage.record(google("ana@example-client.com"), "page");
  s.usage.record(google("ana@example-client.com"), "made_up");
  fs.appendFileSync(path.join(s.dataDir, "usage", "2026-11-11.jsonl"), '{"at":1,"event":"pa');
  assert.deepEqual(s.usage.list().rows.map((r) => r.event), ["page"]);
});

test(`retention: day files older than ${RETENTION_DAYS} days are deleted, nothing else in the folder`, (t) => {
  const s = setup(); t.after(s.done);
  const dir = path.join(s.dataDir, "usage");
  s.usage.record(google("old@example-client.com"), "page");
  s.at(Date.UTC(2026, 10, 11, 18) + 89 * 86400000);
  s.usage.record(google("ana@example-client.com"), "page");
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a day file");
  assert.equal(s.usage.prune(), 0);
  s.at(Date.UTC(2026, 10, 11, 18) + 92 * 86400000);
  assert.equal(s.usage.prune(), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["2027-02-08.jsonl", "notes.txt"]);
  assert.deepEqual(s.usage.listPeople(), ["ana@example-client.com"]);
});
