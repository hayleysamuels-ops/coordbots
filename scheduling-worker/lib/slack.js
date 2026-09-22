"use strict";
/**
 * Slack client — chat.postMessage with Block Kit.
 *
 * `text` is required even when sending blocks: Slack uses it for the
 * notification preview and for screen readers.
 */
const { postJson } = require("./http");

function createSlackClient(token) {
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set");

  async function api(method, body) {
    const json = await postJson("https://slack.com/api/" + method, {
      headers: { Authorization: "Bearer " + token },
      body,
      label: "slack " + method,
    });
    // Slack answers 200 OK even when it refused; the truth is in ok/error.
    if (!json.ok) throw new Error("slack " + method + ": " + (json.error || "unknown error"));
    return json;
  }

  return {
    // Returns { ts } — the message timestamp, needed to reply in its thread.
    postMessage: ({ channel, text, blocks }) =>
      api("chat.postMessage", { channel, text, blocks, unfurl_links: false, unfurl_media: false }),

    // Editing in place is what makes a checklist burn down instead of the
    // channel filling with three copies of the same list.
    updateMessage: ({ channel, ts, text, blocks }) =>
      api("chat.update", { channel, ts, text, blocks }),

    postThreadReply: ({ channel, threadTs, text, blocks }) =>
      api("chat.postMessage", {
        channel,
        thread_ts: threadTs,
        text,
        blocks,
        unfurl_links: false,
        unfurl_media: false,
      }),
  };
}

module.exports = { createSlackClient };
