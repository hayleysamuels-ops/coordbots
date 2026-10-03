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
const { describeFlag } = require("./flags");
const ASHBY_CANDIDATE = "https://app.ashbyhq.com/candidate-searches/new/right-side/candidates/";

// Slack's mrkdwn control characters; everything we didn't write is escaped.
const escape = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// `interactive` (the signing secret, workspace, app and approvers are all
// configured) adds the "Schedule" button to calendar-checked posts; without it
// there's no endpoint to receive a click, so no button is shown.
function createSlack(token, request = fetch, { displayTimeZone = "America/New_York", interactive = false, clientName = "" } = {}) {
  const api = async (method, payload) => {
    const response = await request(`https://slack.com/api/${method}`, { method: "POST", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(payload) });
    return { ok: response.ok, body: await response.json() };
  };
  const post = async (channelId, payload) => {
    const { ok, body } = await api("chat.postMessage", { channel: channelId, unfurl_links: false, unfurl_media: false, ...payload });
    if (!ok || body.ok !== true) throw new Error("Slack delivery unconfirmed");
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

  // The confirmation dialog is Slack's own: the click is only sent after
  // "Approve", so an approval is never recorded by a stray tap. Its wording is
  // deliberate: once booking is live, approving will book, so it says so now.
  const scheduleButton = (proposalId, draftDigest) => ({ type: "actions", block_id: "schedule", elements: [{
    type: "button", action_id: "schedule_option", style: "primary", text: { type: "plain_text", text: "Schedule" },
    value: JSON.stringify({ d: proposalId, g: draftDigest }),
    confirm: { title: { type: "plain_text", text: "Approve this schedule?" },
      text: { type: "mrkdwn", text: "This records your approval of this exact schedule. *Nothing will be booked:* booking in Ashby is blocked on IT permissions, so no interviews are scheduled and no invitations or candidate email are sent.\n\nOnce booking is live, approving will book it, so only approve a schedule you mean to book." },
      confirm: { type: "plain_text", text: "Approve" }, deny: { type: "plain_text", text: "Cancel" } } }] });

  async function calendarChecked(plan, { proposalId, approver, digest: draftDigest }, approval = null) {
    // Interviewer names are plain text on purpose. Interviewers belong to the
    // client's Slack workspace and this bot to Carrara's, where the channel is,
    // so profile links and mentions aren't available regardless of scopes:
    // users.lookupByEmail can never find them. That's a property of the
    // one-app-in-Carrara's-workspace design, not a missing permission.
    const name = p => escape(p.name);
    const clashes = plan.sessions.reduce((n, s) => n + (s.flags || []).length, 0);
    const secondLabel = plan.timezoneSource === "candidate_submitted" ? "Candidate time" : "Entered time";
    const lines = [];
    let day = null, previous = null;
    for (const s of plan.sessions) {
      const d = dayOf(displayTimeZone, s.start);
      if (d !== day) { if (day) lines.push(""); lines.push(`*${escape(d)}*`, ""); day = d; previous = null; }
      // The SOP's break separator between sessions with a gap: "---- 0:15 Break -----".
      const gap = previous ? Math.round((Date.parse(s.start) - Date.parse(previous.end)) / 60000) : 0;
      if (gap > 0) lines.push(`---- ${Math.floor(gap / 60)}:${String(gap % 60).padStart(2, "0")} Break -----`);
      previous = s;
      const video = s.location === "Video link required" ? " (video link required)" : "";
      lines.push(`• ${clock(displayTimeZone, s)} – ${escape(s.title)}${video}  ${(s.people || []).map(name).join(" ")}`);
      if (plan.timezone !== displayTimeZone) lines.push(`      ${secondLabel}: ${clock(plan.timezone, s)}`);
      // Advisory clashes from the calendar check, under the session they affect.
      for (const f of s.flags || []) lines.push(`      ⚠️ ${escape(describeFlag(f, displayTimeZone))}`);
    }
    // Section text is capped at 3000 characters; split on line boundaries.
    const sections = [], body = lines.join("\n");
    let chunk = "";
    for (const line of body.split("\n")) { if ((chunk + "\n" + line).length > 2900) { sections.push(chunk); chunk = line; } else chunk = chunk ? chunk + "\n" + line : line; }
    if (chunk) sections.push(chunk);
    const mrkdwn = text => ({ type: "mrkdwn", text, verbatim: true });
    // What to do first, then who it's for: the two things a coordinator needs
    // before reading any time. "Schedule" is only mentioned when the button is
    // on the post, and "flags" only when there are any.
    const forClient = clientName ? ` for ${escape(clientName)}` : "", button = interactive && draftDigest && !approval;
    const instruction = `This is the proposed interview schedule${forClient}. Please review ${clashes ? "all flags" : "it"}, then post to the client channel for discussion${button ? " or press Schedule" : ""}.`;
    const blocks = [
      { type: "section", text: mrkdwn(instruction) },
      { type: "section", text: mrkdwn(`*${escape(plan.candidateName)}* · ${escape(plan.jobTitle)}`) },
      // A flagged agenda says so before any time is read as settled.
      ...(clashes ? [{ type: "section", text: mrkdwn(`⚠️ *Needs attention: ${clashes} calendar clash${clashes === 1 ? "" : "es"}.* This schedule is not ready to send. Each flagged session needs the interviewer to move the clash, or to accept booking over it.`) }] : []),
      // The SOP's header line. LinkedIn comes from the candidate's Ashby profile
      // and is never guessed; without one the line says so.
      { type: "section", text: mrkdwn(`${plan.linkedinUrl ? `<${plan.linkedinUrl}|LinkedIn>` : "LinkedIn (not in Ashby)"} - <${ASHBY_CANDIDATE}${encodeURIComponent(plan.candidateId)}|Ashby>`) },
      { type: "section", text: mrkdwn(`*Interview Schedule${clashes ? " — needs attention" : ""}*`) },
      ...sections.map(t => ({ type: "section", text: mrkdwn(t) })),
      // The SOP's checklist. Nothing here is known to the dashboard, so each is
      // left for the coordinator to complete rather than claimed.
      { type: "section", text: mrkdwn("*Interview Plan:* to add\n*Shared Prompt:* to add\n*Shared Interview Prep:* to add\n*NDA Sent:* to confirm") },
      { type: "context", elements: [mrkdwn(`${escape(plan.notes)} Posted for discussion by ${escape(approver)}. Draft reference: ${escape(proposalId)}`)] },
    ];
    if (approval) blocks.push({ type: "section", text: mrkdwn(`*Approved* by ${escape(approval.name || approval.email)} (${escape(approval.email)}) at ${escape(new Intl.DateTimeFormat("en-US", { timeZone: displayTimeZone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(approval.at)))}.\n*Not booked.* Booking in Ashby is blocked on IT permissions: no interviews are scheduled and no invitations or candidate email have been sent. Book this schedule in Ashby by hand.`) });
    else if (interactive && draftDigest) blocks.push(scheduleButton(proposalId, draftDigest));
    // The fallback shows in notifications and has no names or links.
    const text = `Interview schedule draft for ${plan.candidateName} · ${plan.jobTitle}: ${clashes ? `needs attention (${clashes} calendar clash${clashes === 1 ? "" : "es"}), ` : ""}for discussion, nothing booked.`;
    return { text, blocks, mrkdwn: false, parse: "none" };
  }

  const send = async (plan, meta) => post(meta.channelId, plan.format === "calendar_checked"
    ? await calendarChecked(plan, meta)
    : { text: plainText(plan, meta), mrkdwn: false, parse: "none" });

  // After an approval: the same message, button removed, approval shown.
  send.markApproved = async ({ channel, ts, row }) => {
    const { blocks, text } = await calendarChecked(row.plan, { proposalId: row.id, approver: row.discussionApproval?.by || "a coordinator" }, row.slackApproval);
    const { ok, body } = await api("chat.update", { channel, ts, blocks, text: `${text} Approved by ${row.slackApproval.name || row.slackApproval.email}; not booked.` });
    if (!ok || body.ok !== true) throw new Error("The Slack message couldn't be updated");
  };
  // Refusals and problems are answered in the post's thread, visible to the channel.
  send.threadReply = async ({ channel, threadTs, text }) => {
    const { ok, body } = await api("chat.postMessage", { channel, thread_ts: threadTs, text, mrkdwn: false, parse: "none", unfurl_links: false });
    if (!ok || body.ok !== true) throw new Error("The Slack reply couldn't be posted");
  };
  // The clicking user's email comes from Slack, never from the payload. Needs
  // users:read and users:read.email. This works because approvers click from
  // Carrara's own workspace, where the bot is (unlike interviewers).
  send.userInfo = async userId => {
    // Form-encoded: Slack accepts it on every method, JSON only on some.
    const response = await request("https://slack.com/api/users.info", { method: "POST", signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ user: userId }).toString() });
    const body = await response.json();
    if (body.ok !== true || body.user?.deleted || body.user?.is_bot) return null;
    return { email: body.user.profile?.email || null, name: body.user.profile?.real_name || body.user.real_name || body.user.name || null };
  };
  return send;
}
module.exports = { createSlack };
