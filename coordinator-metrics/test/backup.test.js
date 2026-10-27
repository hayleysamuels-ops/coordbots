"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "coordmetrics-backup-"));
process.env.CLIENTS = "";

const { signV4, escapePath } = require("../src/backup-sinks");

// --- SigV4 -----------------------------------------------------------------
//
// The worked example from the AWS Signature Version 4 documentation
// ("GET Object" from examplebucket). Fixed credentials, fixed date,
// published expected signature. Hand-rolled signing is only acceptable
// if it is pinned to a known-good vector — otherwise the first time it
// is exercised is against a live bucket at 3am, and a wrong signature
// looks exactly like a credentials problem.
test("SigV4 reproduces the signature from the AWS worked example", () => {
  const headers = signV4({
    method: "GET",
    host: "examplebucket.s3.amazonaws.com",
    canonicalUri: "/test.txt",
    query: "",
    headers: { Range: "bytes=0-9" },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
    now: new Date("2013-05-24T00:00:00Z"),
  });

  assert.match(headers.Authorization, /^AWS4-HMAC-SHA256 /);
  assert.ok(
    headers.Authorization.includes("Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request"),
    `scope wrong: ${headers.Authorization}`
  );
  assert.ok(
    headers.Authorization.includes("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date"),
    `signed headers wrong: ${headers.Authorization}`
  );
  assert.ok(
    headers.Authorization.includes("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"),
    `signature does not match the AWS worked example: ${headers.Authorization}`
  );
});

test("path segments are escaped individually so slashes survive", () => {
  assert.strictEqual(escapePath("/bucket/a b/c.gz"), "/bucket/a%20b/c.gz");
  assert.strictEqual(escapePath("/bucket/pre(1)/x.gz"), "/bucket/pre%281%29/x.gz");
});

// --- Snapshots -------------------------------------------------------------

function seedDatabase() {
  const store = require("../src/db");
  store.db.exec(`
    INSERT INTO schedules (client_id, id, status, created_at, updated_at)
      VALUES ('t', 's1', 'Complete', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO events (client_id, id, schedule_id, start_time, end_time, created_at, updated_at, interviewer_count)
      VALUES ('t', 'e1', 's1', '2026-01-02T15:00:00Z', '2026-01-02T16:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1);
  `);
  return store;
}

test("a snapshot is consistent, integrity-checked and gzipped", () => {
  seedDatabase();
  const backup = require("../src/backup");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coordmetrics-snap-"));

  const snap = backup.snapshot(dir);

  assert.ok(snap.file.endsWith(".sqlite.gz"), "the snapshot is compressed");
  assert.strictEqual(snap.checks.integrity, "ok");
  assert.strictEqual(snap.checks.events, 1);
  assert.ok(snap.bytes > 0);

  // The real assurance: ungzip it and open it as a database. A backup
  // nothing has ever opened is a guess.
  const restored = path.join(dir, "restored.sqlite");
  fs.writeFileSync(restored, zlib.gunzipSync(fs.readFileSync(snap.file)));
  const db = new DatabaseSync(restored, { readOnly: true });
  assert.strictEqual(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.strictEqual(Number(db.prepare("SELECT COUNT(*) n FROM events").get().n), 1);
  // The table this whole mechanism exists for must be present, even
  // when empty — an restore that silently lacks it is the failure.
  assert.strictEqual(Number(db.prepare("SELECT COUNT(*) n FROM reschedules").get().n), 0);
  db.close();

  // No stray uncompressed copy left behind on the volume.
  assert.deepStrictEqual(
    fs.readdirSync(dir).filter((f) => f.endsWith(".sqlite") && f !== "restored.sqlite"),
    []
  );
});

test("retention keeps the recent dailies and the first snapshot of each month", () => {
  const backup = require("../src/backup");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coordmetrics-prune-"));

  const names = [
    "metrics-2026-01-01T03-00-00Z.sqlite.gz", // first of January — monthly
    "metrics-2026-01-20T03-00-00Z.sqlite.gz", // mid-January — droppable
    "metrics-2026-02-01T03-00-00Z.sqlite.gz", // first of February — monthly
    "metrics-2026-03-01T03-00-00Z.sqlite.gz",
    "metrics-2026-03-02T03-00-00Z.sqlite.gz",
    "metrics-2026-03-03T03-00-00Z.sqlite.gz",
  ];
  for (const n of names) fs.writeFileSync(path.join(dir, n), "x");

  const { removed } = backup.prune(dir, { keepDaily: 2, keepMonthly: 12 });

  const left = fs.readdirSync(dir).sort();
  assert.ok(left.includes("metrics-2026-03-02T03-00-00Z.sqlite.gz"), "recent daily kept");
  assert.ok(left.includes("metrics-2026-03-03T03-00-00Z.sqlite.gz"), "recent daily kept");
  assert.ok(left.includes("metrics-2026-01-01T03-00-00Z.sqlite.gz"), "January's monthly kept");
  assert.ok(left.includes("metrics-2026-02-01T03-00-00Z.sqlite.gz"), "February's monthly kept");
  // Corruption noticed three weeks late is the case monthlies exist
  // for, so a mid-month snapshot outside the daily window is the only
  // thing that may go.
  assert.deepStrictEqual(removed, ["metrics-2026-01-20T03-00-00Z.sqlite.gz"]);
});

test("an empty database is refused rather than written over good backups", () => {
  const os2 = require("node:os");
  const emptyDir = fs.mkdtempSync(path.join(os2.tmpdir(), "coordmetrics-empty-"));
  const emptyFile = path.join(emptyDir, "empty.sqlite");
  // Same schema, no rows — what a wiped volume or a failed first sync
  // looks like. Backing that up on schedule would roll a good snapshot
  // out of the retention window with a useless one.
  const fresh = new DatabaseSync(emptyFile);
  fresh.exec("CREATE TABLE events (id TEXT); CREATE TABLE schedules (id TEXT); CREATE TABLE reschedules (id TEXT);");
  fresh.close();

  const store = require("../src/db");
  const realFile = store.FILE;
  try {
    Object.defineProperty(store, "FILE", { value: emptyFile, configurable: true });
    const backup = require("../src/backup");
    const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "coordmetrics-refuse-"));
    assert.throws(() => backup.snapshot(dir), /looks empty/);
    assert.deepStrictEqual(fs.readdirSync(dir), [], "nothing left behind when a snapshot is refused");
  } finally {
    Object.defineProperty(store, "FILE", { value: realFile, configurable: true });
  }
});
