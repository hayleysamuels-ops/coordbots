"use strict";
function createSlack(token, request = fetch) {
  return async (plan, { channelId, proposalId, approver }) => {
    const fmt = value => new Intl.DateTimeFormat("en-US", { timeZone: plan.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
    const content = ["ONSITE DRAFT — FOR DISCUSSION", `${plan.candidateName} · ${plan.jobTitle}`, `Timezone: ${plan.timezone}`,
      ...plan.sessions.map(s => `${fmt(s.start)} – ${fmt(s.end)} | ${s.title}\nInterviewers: ${s.interviewers}\nLocation: ${s.location}`),
      plan.notes, `Approved for discussion by ${approver}. Interviews have not been booked.`, `Draft reference: ${proposalId}`].filter(Boolean).join("\n\n");
    const response = await request("https://slack.com/api/chat.postMessage", { method: "POST", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channelId, text: content, mrkdwn: false, parse: "none", unfurl_links: false, unfurl_media: false }) });
    const body = await response.json();
    if (!response.ok || body.ok !== true) throw new Error("Slack delivery unconfirmed");
    return { ts: body.ts, channel: body.channel };
  };
}
module.exports = { createSlack };
