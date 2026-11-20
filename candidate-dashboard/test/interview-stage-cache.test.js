"use strict";
// interviewStageCache: which stages to look up, and what's kept on disk.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createInterviewStageCache } = require("../src/interviewStageCache");

const DAY = 864e5;
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stages-")), "interview-stages.json");

test("never-read stages first, then week-old ones oldest first; fresh ones not at all", () => {
  let t = 0;
  const cache = createInterviewStageCache({ file: tmpFile(), now: () => t, log: { warn() {} } });
  t = 0; cache.set("old", { groupId: "g" });
  t = 2 * DAY; cache.set("older-ish", { groupId: "g" });
  t = 9 * DAY; cache.set("fresh", { groupId: "g" });
  t = 10 * DAY;
  assert.deepEqual(cache.due(["new", "fresh", "older-ish", "old"]), { never: ["new"], stale: ["old", "older-ish"] });
});

test("a stage Ashby won't read is remembered with no group (Other), and saved", () => {
  const file = tmpFile();
  const cache = createInterviewStageCache({ file, log: { warn() {} } });
  cache.set("gone", {});
  cache.set("live", { groupId: "g1", title: "Onsite" });
  cache.prune(new Set(["gone", "live"]));
  cache.flush();
  const again = createInterviewStageCache({ file, log: { warn() {} } });
  assert.equal(again.get("gone").groupId, null);
  assert.equal(again.get("live").groupId, "g1");
  again.prune(new Set(["live"]));
  assert.equal(again.has("gone"), false);
});
