"use strict";
/**
 * lib/sheets.js — the failure paths, which are the whole point of the module:
 * it must never let "could not read" look like "nothing there".
 *
 * fetch is stubbed by URL, so nothing here touches the network or Google.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const sheets = require("../lib/sheets");

/** A real RSA key, generated locally, so the JWT actually signs. */
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = {
  type: "service_account",
  project_id: "test",
  private_key_id: "abc",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  client_email: "test@test.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
};

const realFetch = global.fetch;
function withStub(routes, fn) {
  return async () => {
    process.env.GOOGLE_SA_KEY_B64 = Buffer.from(JSON.stringify(KEY)).toString("base64");
    process.env.POETIC_SHEET_ID = "sheet-123";
    sheets.resetCache();
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 3600 }) };
      }
      for (const [match, res] of routes) if (u.includes(match)) return res();
      throw new Error("unstubbed url: " + u);
    };
    try { await fn(); } finally { global.fetch = realFetch; sheets.resetCache(); }
  };
}
const json = (status, body) => () => ({
  ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body),
});

/* ------------------------------------------------------------- readRange */

test("readRange: 403 explains the Drive share, not the HTTP code", withStub(
  [["/values/", json(403, { error: { message: "The caller does not have permission" } })]],
  async () => {
    const r = await sheets.readRange("'T'!A:B");
    assert.equal(r.ok, false);
    assert.match(r.reason, /Drive share on poetic-sheet-reader/);
  }
));

test("readRange: 403 for a disabled API says so instead", withStub(
  [["/values/", json(403, { error: { message: "Google Sheets API has not been used in project 1 before" } })]],
  async () => {
    const r = await sheets.readRange("'T'!A:B");
    assert.equal(r.ok, false);
    assert.match(r.reason, /Sheets API is not enabled/);
  }
));

test("readRange: an empty sheet is ok with no rows, not a failure", withStub(
  [["/values/", json(200, {})]],
  async () => {
    const r = await sheets.readRange("'T'!A:B");
    assert.equal(r.ok, true);
    assert.deepEqual(r.rows, [], "no rows is an answer");
  }
));

/* -------------------------------------------------------- readVisibility */

test("readVisibility: returns one entry per row, flags normalised to booleans", withStub(
  [["?includeGridData", json(200, { sheets: [{ properties: { title: "WT Tracker" },
      data: [{ startRow: 0, rowMetadata: [{}, { hiddenByUser: true }, { hiddenByFilter: true }] }] }] })]],
  async () => {
    const r = await sheets.readVisibility({ tab: "WT Tracker", rowCount: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.startRow, 0);
    assert.deepEqual(r.rows, [
      { hiddenByUser: false, hiddenByFilter: false },
      { hiddenByUser: true, hiddenByFilter: false },
      { hiddenByUser: false, hiddenByFilter: true },
    ]);
  }
));

test("readVisibility: no row metadata is a failure, never an all-visible answer", withStub(
  [["?includeGridData", json(200, { sheets: [{ properties: { title: "WT Tracker" }, data: [{}] }] })]],
  async () => {
    const r = await sheets.readVisibility({ tab: "WT Tracker", rowCount: 3 });
    assert.equal(r.ok, false, "this must not come back as ok with zero hidden rows");
    assert.match(r.reason, /visibility is unknown/);
  }
));

test("readVisibility: a missing tab is named, not guessed at", withStub(
  [["?includeGridData", json(200, { sheets: [{ properties: { title: "Other" }, data: [] }] })]],
  async () => {
    const r = await sheets.readVisibility({ tab: "WT Tracker", rowCount: 3 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /"WT Tracker" not found/);
  }
));

test("readVisibility: shares readRange's auth wording", withStub(
  [["?includeGridData", json(403, { error: { message: "The caller does not have permission" } })]],
  async () => {
    const r = await sheets.readVisibility({ tab: "WT Tracker", rowCount: 3 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /Drive share on poetic-sheet-reader/);
  }
));

test("readVisibility: 404 points at the sheet id", withStub(
  [["?includeGridData", json(404, {})]],
  async () => {
    const r = await sheets.readVisibility({ tab: "WT Tracker", rowCount: 3 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /POETIC_SHEET_ID may be wrong/);
  }
));

test("readVisibility: needs a tab, and says so rather than reading the wrong one", withStub(
  [], async () => {
    const r = await sheets.readVisibility({ rowCount: 3 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /needs a tab name/);
  }
));
