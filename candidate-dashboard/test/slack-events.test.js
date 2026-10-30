"use strict";
// Slack's Events API endpoint (slack-events.js): only a signed request from the
// configured workspace and app is read; only an @mention in a thread of this
// client's channel, from a person, reaches the amend handler, once per event;
// with SCHEDULING_AMEND off, the URL check still works and mentions are ignored.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const { createSlackEvents } = require("../src/scheduling/slack-events");

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const sign = (body, ts = Math.floor(Date.now() / 1000)) => ({ "x-slack-request-timestamp": String(ts), "x-slack-signature": "v0=" + crypto.createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex") });

async function fixture(t, { on = true } = {}) {
  const mentions = [], logs = [];
  const handler = createSlackEvents({ signingSecret: SECRET, teamId: "T0CARRARA", appId: "A0SCHED", channelId: "C0CONFIG", on,
    onMention: async m => { mentions.push(m); }, log: { log: m => logs.push(m), warn: m => logs.push(m) } });
  const app = express(); app.post("/e", express.raw({ type: "application/json" }), handler);
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const send = async (payload, { headers } = {}) => {
    const body = JSON.stringify(payload);
    const r = await fetch(`http://127.0.0.1:${server.address().port}/e`, { method: "POST", headers: { "Content-Type": "application/json", ...(headers || sign(body)) }, body });
    await new Promise(res => setTimeout(res, 20));
    return { status: r.status, text: await r.text() };
  };
  return { mentions, logs, send };
}
let n = 0;
const mention = (event = {}, outer = {}) => ({ type: "event_callback", team_id: "T0CARRARA", api_app_id: "A0SCHED", event_id: `Ev${++n}`,
  event: { type: "app_mention", user: "U0HAYLEY", text: "<@U0BOT> have Vamsi do Onsite 2 instead of Joe", channel: "C0CONFIG", ts: "1700000100.000200", thread_ts: "1700000000.000100", ...event }, ...outer });

test("Slack's URL check is answered, on or off, and only when signed", async t => {
  for (const on of [true, false]) {
    const f = await fixture(t, { on });
    const r = await f.send({ type: "url_verification", challenge: "abc123" });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { challenge: "abc123" });
  }
  const f = await fixture(t);
  assert.equal((await f.send({ type: "url_verification", challenge: "abc123" }, { headers: {} })).status, 401);
});

test("a mention in a proposal's thread reaches the handler once, with who, what and where", async t => {
  const f = await fixture(t);
  const payload = mention();
  assert.equal((await f.send(payload)).status, 200);
  // Slack resends an event it thinks went unanswered: new signature, same event_id.
  await new Promise(res => setTimeout(res, 1100));
  assert.equal((await f.send(payload)).status, 200);
  assert.deepEqual(f.mentions, [{ eventId: payload.event_id, user: "U0HAYLEY", text: "<@U0BOT> have Vamsi do Onsite 2 instead of Joe", channel: "C0CONFIG", threadTs: "1700000000.000100", ts: "1700000100.000200" }]);
});

test("wrong workspace or app, or a bad signature, is refused before anything is read", async t => {
  const f = await fixture(t);
  assert.equal((await f.send(mention({}, { team_id: "T0OTHER" }))).status, 403);
  assert.equal((await f.send(mention({}, { api_app_id: "A0OTHER" }))).status, 403);
  assert.equal((await f.send(mention(), { headers: { "x-slack-request-timestamp": "1", "x-slack-signature": "v0=" + "0".repeat(64) } })).status, 401);
  assert.equal(f.mentions.length, 0);
});

test("only a person's mention, in a thread of this client's channel, counts", async t => {
  const f = await fixture(t);
  for (const event of [
    { channel: "C0ELSEWHERE" },                       // another channel
    { thread_ts: undefined },                         // top level: not on a post
    { thread_ts: "1700000100.000200" },               // the thread's own first message
    { bot_id: "B0BOT" },                              // a bot
    { subtype: "message_changed" }, { edited: { user: "U0HAYLEY" } }, // edits
    { type: "message" },                              // anything but a mention
    { user: undefined },
  ]) assert.equal((await f.send(mention(event))).status, 200);
  assert.equal(f.mentions.length, 0);
});

test("SCHEDULING_AMEND off: mentions are acknowledged, logged and ignored", async t => {
  const f = await fixture(t, { on: false });
  assert.equal((await f.send(mention())).status, 200);
  assert.equal(f.mentions.length, 0);
  assert.ok(f.logs.some(l => /Mention ignored: SCHEDULING_AMEND is off/.test(l)));
});
