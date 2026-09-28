"use strict";
// One plain-text format for every discussion post. Each session is shown in
// the dashboard's DISPLAY_TIMEZONE first (the coordinators reading the
// channel), then in the plan's own timezone, labelled by where it came from:
// the candidate's submission for a Full schedule option built from Ashby,
// otherwise the timezone the times were entered in.
function createSlack(token, request = fetch, { displayTimeZone = "America/New_York" } = {}) {
  return async (plan, { channelId, proposalId, approver }) => {
    const range = (tz, s) => new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).formatRange(new Date(s.start), new Date(s.end));
    const planLabel = plan.timezoneSource === "candidate_submitted" ? `Candidate time (${plan.timezone}, as submitted)` : `Entered time (${plan.timezone})`;
    const times = s => plan.timezone === displayTimeZone
      ? [`Coordinator time (${displayTimeZone}), same as the ${plan.timezoneSource === "candidate_submitted" ? "candidate's submitted" : "entered"} timezone: ${range(displayTimeZone, s)}`]
      : [`Coordinator time (${displayTimeZone}): ${range(displayTimeZone, s)}`, `${planLabel}: ${range(plan.timezone, s)}`];
    const content = ["INTERVIEW SCHEDULE DRAFT — FOR DISCUSSION", `${plan.candidateName} · ${plan.jobTitle}`,
      ...plan.sessions.map(s => [s.title, ...times(s), `Interviewers: ${s.interviewers}`, `Location: ${s.location}`].join("\n")),
      plan.notes, `Posted for discussion by ${approver}. Interviews have not been booked.`, `Draft reference: ${proposalId}`].filter(Boolean).join("\n\n");
    const response = await request("https://slack.com/api/chat.postMessage", { method: "POST", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channelId, text: content, mrkdwn: false, parse: "none", unfurl_links: false, unfurl_media: false }) });
    const body = await response.json();
    if (!response.ok || body.ok !== true) throw new Error("Slack delivery unconfirmed");
    return { ts: body.ts, channel: body.channel };
  };
}
module.exports = { createSlack };
