"use strict";
/**
 * The rules that decide whether a webhook closes a channel, and the guard that
 * keeps the bot off every channel that is not a candidate channel.
 */
process.env.CANDIDATE_CHANNEL_PREFIX = process.env.CANDIDATE_CHANNEL_PREFIX || "cand-";
process.env.ASHBY_WEBHOOK_SECRET = "test-secret";
process.env.SLACK_BOT_TOKEN = "xoxb-test";

const { test } = require("node:test");
const assert = require("node:assert");

const { parseWebhook } = require("../src/ashby");
const { decide } = require("../src/handler");

const neverHandled = () => false;
const bothOutcomes = new Set(["archived", "hired"]);
const deps = (over = {}) => ({
  wasHandled: neverHandled,
  archiveOn: bothOutcomes,
  channelPrefix: "cand-",
  ...over,
});

function applicationUpdate(status, extra = {}) {
  return {
    action: "applicationUpdate",
    data: {
      application: {
        id: "app-1",
        status,
        candidate: { id: "cand-1", name: "Jane Smith" },
        job: { id: "job-1", title: "Product Engineer" },
        ...extra,
      },
    },
  };
}

/* ------------------------------------------------------------- parsing */

test("an archived application parses as the archived outcome, with its reason", () => {
  const event = parseWebhook(
    applicationUpdate("Archived", { archiveReason: { text: "Rejected after onsite" } })
  );
  assert.equal(event.outcome, "archived");
  assert.equal(event.candidateName, "Jane Smith");
  assert.equal(event.jobTitle, "Product Engineer");
  assert.equal(event.archiveReasonText, "Rejected after onsite");
});

test("a hired application parses as the hired outcome", () => {
  assert.equal(parseWebhook(applicationUpdate("Hired")).outcome, "hired");
});

test("candidateHire counts as hired even without a status field", () => {
  const event = parseWebhook({
    action: "candidateHire",
    data: {
      application: {
        id: "app-1",
        candidate: { id: "cand-1", name: "Jane Smith" },
        job: { title: "Product Engineer" },
      },
    },
  });
  assert.equal(event.outcome, "hired");
});

test("active and lead applications are not terminal", () => {
  assert.equal(parseWebhook(applicationUpdate("Active")).outcome, null);
  assert.equal(parseWebhook(applicationUpdate("Lead")).outcome, null);
});

/* ------------------------------------------------------------ decisions */

test("a terminal event acts", () => {
  assert.equal(decide(parseWebhook(applicationUpdate("Archived")), deps()).act, true);
});

test("a non-terminal event does not act", () => {
  assert.equal(decide(parseWebhook(applicationUpdate("Active")), deps()).act, false);
});

test("ARCHIVE_ON gates each outcome independently", () => {
  const archivedOnly = deps({ archiveOn: new Set(["archived"]) });
  assert.equal(decide(parseWebhook(applicationUpdate("Hired")), archivedOnly).act, false);
  assert.equal(decide(parseWebhook(applicationUpdate("Archived")), archivedOnly).act, true);
});

test("an already handled application and outcome does not act twice", () => {
  const seen = deps({ wasHandled: () => true });
  assert.equal(decide(parseWebhook(applicationUpdate("Hired")), seen).act, false);
});

test("the same application acts once per outcome, so a hire after an archive still fires", () => {
  const handled = new Set(["app-1:archived"]);
  const d = deps({ wasHandled: (id, outcome) => handled.has(`${id}:${outcome}`) });
  assert.equal(decide(parseWebhook(applicationUpdate("Archived")), d).act, false);
  assert.equal(decide(parseWebhook(applicationUpdate("Hired")), d).act, true);
});

test("no prefix configured means nothing is ever eligible", () => {
  const unset = deps({ channelPrefix: "" });
  assert.equal(decide(parseWebhook(applicationUpdate("Archived")), unset).act, false);
});

test("a payload with no candidate name cannot resolve a channel", () => {
  const event = parseWebhook({
    action: "applicationUpdate",
    data: { application: { id: "app-1", status: "Archived", candidate: { id: "c" }, job: {} } },
  });
  assert.equal(decide(event, deps()).act, false);
});

test("a payload with no application object is ignored rather than throwing", () => {
  const event = parseWebhook({ action: "applicationUpdate", data: {} });
  assert.equal(event.outcome, null);
  assert.equal(decide(event, deps()).act, false);
});
