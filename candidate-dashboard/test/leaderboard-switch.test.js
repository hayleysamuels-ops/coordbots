'use strict';
// DISABLED_SECTIONS=feedbackLeaderboard switches the leaderboard off on the
// server, not just the page: it ranks named people, so it must never be
// computed or reach /api/issues where it's off (small clients, e.g. LiteLLM,
// 18 November 2026). Each case runs in a fresh process because config is
// read once at load.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function probe(disabled) {
  const env = { ...process.env, ASHBY_API_KEY: 'test', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'lb-switch-')), DISABLED_SECTIONS: disabled };
  delete env.RAILWAY_VOLUME_MOUNT_PATH;
  const out = execFileSync(process.execPath, ['-e', `
    const config = require("./src/config");
    const issues = require("./src/issues");
    const snap = issues.getSnapshot();
    console.log("RESULT " + JSON.stringify({ enabled: config.feedbackLeaderboardEnabled, status: Object.keys(snap.sectionStatus || {}).includes("feedbackLeaderboard"), board: snap.feedbackLeaderboard }));
  `], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT ')).slice(7));
}

test('off: never a refresh group, never in the snapshot', () => {
  const r = probe('feedbackLeaderboard,offersSigned');
  assert.equal(r.enabled, false);
  assert.equal(r.status, false, 'no section status: the group does not exist');
  assert.equal(r.board, null);
});

test('on by default', () => {
  const r = probe('');
  assert.equal(r.enabled, true);
  assert.equal(r.status, true);
});
