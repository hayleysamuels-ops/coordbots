"use strict";
// Discussion posts. Two formats:
//   - Calendar-checked Full schedule options (plan.format "calendar_checked"):
//     Block Kit mrkdwn with a hyperlinked Ashby link, a dated schedule and
//     interviewer names as plain text. verbatim: true keeps Slack from
//     auto-linking names or URLs while still rendering the explicit Ashby link.
//   - Everything else: the plain-text format below, unchanged.
// Each session is shown in the dashboard's DISPLAY_TIMEZONE first (the
// coordinators reading the channel), then in the plan's own timezone when it
// differs, labelled by where it came from.
const ASHBY_CANDIDATE = "https://app.ashbyhq.com/candidate-searches/new/right-side/candidates/";

// Slack's mrkdwn control characters; everything we didn't write is escaped.
const escape = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function createSlack(token, request = fetch, { displayTimeZone = "America/New_York" } = {}) {
  const post = async (channelId, payload) => {
    const response = await request("https://slack.com/api/chat.postMessage", { method: "POST", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channelId, unfurl_links: false, unfurl_media: false, ...payload }) });
    const body = await response.json();
    if (!response.ok || body.ok !== true) throw new Error("Slack delivery unconfirmed");
    return { ts: body.ts, channel: body.channel };
  };

  function plainText(plan, { proposalId, approver }) {
    const range = (tz, s) => new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).formatRange(new Date(s.start), new Date(s.end));
    const planLabel = plan.timezoneSource === "candidate_submitted" ? `Candidate time (${plan.timezone}, as submitted)` : `Entered time (${plan.timezone})`;
    const times = s => plan.timezone === displayTimeZone
      ? [`Coordinator time (${displayTimeZone}), same as the ${plan.timezoneSource === "candidate_submitted" ? "candidate's submitted" : "entered"} timezone: ${range(displayTimeZone, s)}`]
      : [`Coordinator time (${displayTimeZone}): ${range(displayTimeZone, s)}`, `${planLabel}: ${range(plan.timezone, s)}`];
    return ["INTERVIEW SCHEDULE DRAFT — FOR DISCUSSION", `${plan.candidateName} · ${plan.jobTitle}`,
      ...plan.sessions.map(s => [s.title, ...times(s), `Interviewers: ${s.interviewers}`, `Location: ${s.location}`].join("\n")),
      plan.notes, `Posted for discussion by ${approver}. Interviews have not been booked.`, `Draft reference: ${proposalId}`].filter(Boolean).join("\n\n");
  }

  // "11:00 AM – 11:15 AM (PDT)"
  const clock = (tz, s) => {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
    const zone = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(s.start)).find(p => p.type === "timeZoneName")?.value || tz;
    return `${f.format(new Date(s.start))} – ${f.format(new Date(s.end))} (${zone})`;
  };
  const dayOf = (tz, iso) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date(iso));

  async function calendarChecked(plan, { proposalId, approver }) {
    // Interviewer names are plain text on purpose. Interviewers belong to the
    // client's Slack workspace and this bot to Carrara's, where the channel is,
    // so profile links and mentions aren't available regardless of scopes:
    // users.lookupByEmail can never find them. That's a property of the
    // one-app-in-Carrara's-workspace design, not a missing permission.
    const name = p => escape(p.name);
    const secondLabel = plan.timezoneSource === "candidate_submitted" ? "Candidate time" : "Entered time";
    const lines = [];
    let day = null;
    for (const s of plan.sessions) {
      const d = dayOf(displayTimeZone, s.start);
      if (d !== day) { if (day) lines.push(""); lines.push(`*${escape(d)}*`, ""); day = d; }
      const video = s.location === "Video link required" ? " (video link required)" : "";
      lines.push(`• ${clock(displayTimeZone, s)} – ${escape(s.title)}${video}  ${(s.people || []).map(name).join(" ")}`);
      if (plan.timezone !== displayTimeZone) lines.push(`      ${secondLabel}: ${clock(plan.timezone, s)}`);
    }
    // Section text is capped at 3000 characters; split on line boundaries.
    const sections = [], body = lines.join("\n");
    let chunk = "";
    for (const line of body.split("\n")) { if ((chunk + "\n" + line).length > 2900) { sections.push(chunk); chunk = line; } else chunk = chunk ? chunk + "\n" + line : line; }
    if (chunk) sections.push(chunk);
    const mrkdwn = text => ({ type: "mrkdwn", text, verbatim: true });
    const blocks = [
      { type: "section", text: mrkdwn(`<${ASHBY_CANDIDATE}${encodeURIComponent(plan.candidateId)}|Ashby Link>`) },
      { type: "section", text: mrkdwn(`*Interview Schedule*\n${escape(plan.candidateName)} · ${escape(plan.jobTitle)}`) },
      ...sections.map(t => ({ type: "section", text: mrkdwn(t) })),
      { type: "context", elements: [mrkdwn(`${escape(plan.notes)} Posted for discussion by ${escape(approver)}. Draft reference: ${escape(proposalId)}`)] },
    ];
    // The fallback shows in notifications and has no names or links.
    const text = `Interview schedule draft for ${plan.candidateName} · ${plan.jobTitle}: for discussion, nothing booked.`;
    return { text, blocks, mrkdwn: false, parse: "none" };
  }

  return async (plan, meta) => post(meta.channelId, plan.format === "calendar_checked"
    ? await calendarChecked(plan, meta)
    : { text: plainText(plan, meta), mrkdwn: false, parse: "none" });
}
module.exports = { createSlack };
