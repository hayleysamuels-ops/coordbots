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

// Slack's Block Kit limits, for the block types these messages use. Slack
// refuses a whole message over any one of them ("invalid_blocks"), so each is
// checked before sending; returns what's wrong, [] when nothing is.
function blockProblems({ text, blocks = [] }) {
  const problems = [];
  const over = (where, value, max, min = 1) => {
    const n = String(value ?? "").length;
    if (n > max) problems.push(`${where} is ${n} characters (Slack allows ${max})`);
    else if (n < min || !String(value ?? "").trim()) problems.push(`${where} is empty`);
  };
  // mrkdwn: everything we didn't write is escaped, so the only < and > left
  // must be links we wrote, "<https://…|label>".
  const mrkdwnText = (where, t) => {
    over(where, t?.text, 3000);
    if (t?.type === "mrkdwn" && /[<>]/.test(String(t.text ?? "").replace(/<https?:\/\/[^\s<>|]+(\|[^<>]+)?>/g, ""))) problems.push(`${where} has a < or > that isn't a link`);
  };
  if (text !== undefined) over("The notification text", text, 40000);
  if (blocks.length > 50) problems.push(`The message has ${blocks.length} blocks (Slack allows 50)`);
  blocks.forEach((b, i) => {
    const where = `Block ${i + 1} (${b.type})`;
    if (b.block_id !== undefined) over(`${where}'s block_id`, b.block_id, 255);
    if (b.type === "section") mrkdwnText(where, b.text);
    else if (b.type === "context") {
      if (!b.elements?.length || b.elements.length > 10) problems.push(`${where} has ${b.elements?.length || 0} elements (Slack allows 1 to 10)`);
      (b.elements || []).forEach((e, j) => mrkdwnText(`${where}, element ${j + 1}`, e));
    } else if (b.type === "actions") {
      if (!b.elements?.length || b.elements.length > 25) problems.push(`${where} has ${b.elements?.length || 0} elements (Slack allows 1 to 25)`);
      (b.elements || []).forEach((e, j) => {
        const at = `${where}, button ${j + 1}`;
        over(`${at}'s label`, e.text?.text, 75);
        over(`${at}'s action_id`, e.action_id, 255);
        if (e.value !== undefined) over(`${at}'s value`, e.value, 2000);
        if (e.confirm) {
          over(`${at}'s confirmation title`, e.confirm.title?.text, 100);
          mrkdwnText(`${at}'s confirmation text`, e.confirm.text);
          if (String(e.confirm.text?.text ?? "").length > 300) problems.push(`${at}'s confirmation text is ${e.confirm.text.text.length} characters (Slack allows 300)`);
          over(`${at}'s confirm label`, e.confirm.confirm?.text, 30);
          over(`${at}'s deny label`, e.confirm.deny?.text, 30);
        }
      });
    } else problems.push(`${where} is a block type this check doesn't know`);
  });
  return problems;
}
const invalid = problems => Object.assign(new Error(`The Slack message failed its check before sending, so it wasn't sent: ${problems.join("; ")}.`), { invalid: true });

// `interactive` (the signing secret, workspace, app and approvers are all
// configured) adds the "Schedule" button to calendar-checked posts; without it
// there's no endpoint to receive a click, so no button is shown.
function createSlack(token, request = fetch, { displayTimeZone = "America/New_York", interactive = false, clientName = "" } = {}) {
  // Failures say which kind they were, so an unconfirmed post can be told
  // apart: Slack refusing it (not delivered), or no clear answer (maybe).
  const api = async (method, payload) => {
    let response;
    try {
      response = await request(`https://slack.com/api/${method}`, { method: "POST", signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(payload) });
    } catch (e) {
      throw new Error(e.name === "TimeoutError" || e.name === "AbortError" ? `Slack didn't answer ${method} within 15 seconds` : `Slack couldn't be reached for ${method} (${e.message})`);
    }
    let body = null;
    try { body = await response.json(); } catch (_) { /* reported below */ }
    return { ok: response.ok, status: response.status, body: body || {} };
  };
  const post = async (channelId, payload) => {
    const problems = blockProblems(payload);
    if (problems.length) throw invalid(problems);
    const { ok, status, body } = await api("chat.postMessage", { channel: channelId, unfurl_links: false, unfurl_media: false, ...payload });
    if (!ok) throw new Error(`Slack answered chat.postMessage with HTTP ${status}${body.error ? ` (${body.error})` : ""}`);
    if (body.ok !== true) throw Object.assign(new Error(`Slack refused the post: ${body.error || "no reason given"}`), { refused: true });
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
  // Who a robot Send goes out as: the worker's Ashby account ("Anna Jones
  // Luminai" on its header button), without the client name.
  const sendsAs = plan => escape(String(plan.bookingPlan?.sendAs || "the connected Ashby account").replace(new RegExp(` ${clientName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "") || "the connected Ashby account");
  const sends = plan => plan.bookingPlan?.send === true;
  // Where the post announced Send (plan.bookingPlan.send, set at posting only
  // when every lock was open): approving sends, and the dialog says so.
  const sendText = plan => `Approving *sends this schedule now*: Ashby's invitations to the candidate and interviewers, and the candidate's confirmation email if it's on, all from ${sendsAs(plan)}'s account. Nothing is retried.\n\nOnly approve a schedule you mean to book.`;
  const scheduleButton = (proposalId, draftDigest, plan) => ({ type: "actions", block_id: "schedule", elements: [{
    type: "button", action_id: "schedule_option", style: "primary", text: { type: "plain_text", text: "Schedule" },
    value: JSON.stringify({ d: proposalId, g: draftDigest }),
    confirm: { title: { type: "plain_text", text: "Approve this schedule?" },
      // Slack caps this text at 300 characters (blockProblems checks it).
      text: { type: "mrkdwn", text: sends(plan) ? sendText(plan) : "With the Ashby check on, this schedule is then composed in Ashby, stopping before Send; otherwise, book it by hand. *Nothing is sent automatically:* no invitations or candidate email go out until someone clicks Send in Ashby.\n\nOnly approve a schedule you mean to book." },
      confirm: { type: "plain_text", text: "Approve" }, deny: { type: "plain_text", text: "Cancel" } } }] });

  const when = at => new Intl.DateTimeFormat("en-US", { timeZone: displayTimeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(at));
  // Where a left draft is, and how to delete one by hand: never "Delete
  // Activity", which cancels the whole scheduling activity.
  const scheduleIn = plan => `${escape(plan.candidateName)}'s ${escape(plan.bookingPlan?.activityTitle || "interview schedule")} in Ashby`;
  const deleteByHand = plan => `Delete it from the Drafts tab of ${scheduleIn(plan)}, with the button beside the draft (never "Delete Activity").`;
  // The Ashby check's state, under the approval (ashby-check.js). Every line
  // says plainly whether anything is booked or sent.
  function checkText(plan, check) {
    const byHand = "*Not booked:* book this schedule in Ashby by hand.";
    switch (check?.state) {
      case "queued": return sends(plan)
        ? `*Waiting to be checked and sent in Ashby,* after the schedules approved before it, from ${sendsAs(plan)}'s account. Nothing is sent yet.`
        : "*Waiting to be checked in Ashby,* after the schedules approved before it. Nothing is booked or sent.";
      case "running": return sends(plan)
        ? `*Checking and sending in Ashby* (started ${escape(when(check.startedAt))}) from ${sendsAs(plan)}'s account: once every check passes, Schedule is clicked once, which sends the invitations and the candidate's confirmation email. Nothing is retried.`
        : `*Checking in Ashby* (started ${escape(when(check.startedAt))}): composing this schedule as the connected Ashby account, stopping before Send. Nothing will be booked or sent.`;
      // A confirmation email that's off is said first and plainly: the SOP
      // expects one, and nothing else would tell the sender it won't go.
      case "composed": return `${check.sendSkipped ? `*Not sent automatically:* ${escape(check.sendSkipped)} A person needs to send it.\n` : ""}${check.confirmationEmail === "off" ? "⚠️ *No candidate confirmation email will be sent:* it's turned off for this schedule in Ashby. If the candidate needs one, turn it on in the draft before sending and check it there.\n" : ""}*Composed and waiting in Ashby* (checked ${escape(when(check.composedAt))}): open ${scheduleIn(plan)}, go to its Drafts tab, open the draft and click Send.${check.from ? ` The candidate's confirmation email will come from ${escape(check.from)}.` : ""}\n*Not sent yet.* If it isn't sent by ${escape(when(check.deleteBy))}, the draft is deleted and this needs booking by hand. If you change it in Ashby, or send it much later, check calendars again first.`;
      // Sent by the robot's one click: only with Ashby's own evidence that the
      // invitations went out (ashby-check.js). The confirmation email isn't
      // claimed delivered, only whether it was on.
      case "sent": if (check.sentBy === "robot") {
        const email = check.confirmationEmail === "off" ? " No candidate confirmation email: it's off for this schedule." : " The candidate's confirmation email was on for this schedule.";
        return check.differences?.length
          ? `*Sent from ${sendsAs(plan)}'s account* at ${escape(when(check.attemptedAt || check.sentSeenAt))}: Ashby shows the invitations sent, *but what it booked differs from this approval:* ${escape(check.differences.join("; "))}. Check it in Ashby.${email}`
          : `*Sent from ${sendsAs(plan)}'s account* at ${escape(when(check.attemptedAt || check.sentSeenAt))}: Ashby shows it Scheduled, matching this approval, and its invitations sent.${email}`;
      }
      return check.differences?.length
        ? `*Sent in Ashby* (seen ${escape(when(check.sentSeenAt))}), *but what was booked differs from this approval:* ${escape(check.differences.join("; "))}. Check it in Ashby.`
        : `*Sent in Ashby* (seen ${escape(when(check.sentSeenAt))}): what was booked matches this approval.`;
      case "deleted": return `*Draft deleted unsent* at ${escape(when(check.deletedAt))}. *Not booked:* this needs booking in Ashby by hand.`;
      case "gone": return `*The draft is no longer in Ashby* (seen ${escape(when(check.goneSeenAt))}), and the schedule hasn't been sent. ${byHand}`;
      case "delete_failed": return `*The unsent draft couldn't be deleted* at ${escape(when(check.failedAt))} (${escape(check.reason)}). ${deleteByHand(plan)} ${byHand}`;
      case "superseded": return `*Superseded* at ${escape(when(check.supersededAt))} by a later approval for this schedule${check.draftDeleted ? "; its draft was deleted" : ""}. Nothing from this message was sent.`;
      case "refused": return `*The Ashby check stopped*${check.step ? ` at "${escape(check.step)}"` : ""}: ${escape(check.reason || "no reason was given")}\nNothing was sent. ${!check.draftId ? "No draft was made." : check.cleanup?.deleted ? "The draft it made was deleted." : `The draft it made may still be in Ashby. ${deleteByHand(plan)}`} ${byHand}`;
      case "not_started": return `*The Ashby check didn't start:* ${escape(check.reason)} Nothing was sent and no draft was made. ${byHand}`;
      case "booked_invites_pending": return `⚠️ *Booked, but the invitations were not sent.* Schedule was clicked once${check.attemptedAt ? ` at ${escape(when(check.attemptedAt))}` : ""} and Ashby shows ${scheduleIn(plan)} Scheduled${check.differences?.length ? ` (differing from this approval: ${escape(check.differences.join("; "))})` : ", matching this approval"}, with its invites *pending*. Send them by hand from the schedule's page in Ashby ("Send to Candidate" and "Send to Interviewers"); nothing will be retried.`;
      case "booked_invites_unknown": return `⚠️ *Booked; whether the invitations went out is unknown.* Ashby shows ${scheduleIn(plan)} Scheduled${check.differences?.length ? ` (differing from this approval: ${escape(check.differences.join("; "))})` : ", matching this approval"}, but its page didn't show the invites as sent. Check it in Ashby, and send them by hand if they're pending; nothing will be retried.`;
      case "send_uncertain": return `⚠️ *The send may have gone:* Schedule was clicked once${check.attemptedAt ? ` at ${escape(when(check.attemptedAt))}` : ""} (${escape(check.reason || "Ashby's answer wasn't a clear acceptance")}), and Ashby doesn't show the schedule as Scheduled yet. Check ${scheduleIn(plan)}: if it isn't Scheduled, book it by hand. Nothing will be retried.`;
      case "uncertain": return `*The Ashby check didn't finish* (${escape(check.reason)}). Nothing was sent, but a draft may be left in Ashby. ${deleteByHand(plan)} ${byHand}`;
      case "too_close": return "*Not booked:* too close to the first interview — book this in Ashby by hand. Nothing has been scheduled in Ashby, and no invitations or candidate email have been sent.";
      case "skipped": return `*Not booked yet.* Nothing has been scheduled in Ashby, and no invitations or candidate email have been sent. Book this schedule in Ashby by hand for now.\nNot checked in Ashby: ${/booking robot may use/.test(check.reason || "") ? "the check is only on for test candidates so far." : escape(check.reason || "the check is off.")}`;
      default: return "*Not booked yet.* Nothing has been scheduled in Ashby, and no invitations or candidate email have been sent. Book this schedule in Ashby by hand for now.";
    }
  }

  async function calendarChecked(plan, { proposalId, approver, digest: draftDigest }, approval = null, check = null) {
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
    const instruction = `This is the proposed interview schedule${forClient}. Please review ${clashes ? "all flags" : "it"}, then post to the client channel for discussion${button ? (sends(plan) ? ` or press Schedule, which *sends it from ${sendsAs(plan)}'s account*` : " or press Schedule") : ""}.`;
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
    if (approval) blocks.push({ type: "section", text: mrkdwn(`*Approved* by ${escape(approval.name || approval.email)} (${escape(approval.email)}) at ${escape(new Intl.DateTimeFormat("en-US", { timeZone: displayTimeZone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(approval.at)))}.\n${checkText(plan, check)}`) });
    else if (interactive && draftDigest) blocks.push(scheduleButton(proposalId, draftDigest, plan));
    // The fallback shows in notifications and has no names or links.
    const text = `Interview schedule draft for ${plan.candidateName} · ${plan.jobTitle}: ${clashes ? `needs attention (${clashes} calendar clash${clashes === 1 ? "" : "es"}), ` : ""}for discussion, nothing booked.`;
    return { text, blocks, mrkdwn: false, parse: "none" };
  }

  const message = async (plan, meta) => plan.format === "calendar_checked"
    ? calendarChecked(plan, meta)
    : { text: plainText(plan, meta), mrkdwn: false, parse: "none" };
  const send = async (plan, meta) => post(meta.channelId, await message(plan, meta));
  // The same check, without sending: share() runs it before claiming the
  // draft, so a message Slack would refuse is reported and nothing is posted.
  send.check = async (plan, meta) => blockProblems(await message(plan, meta));

  // After an approval: the same message, button removed, approval shown.
  send.markApproved = async ({ channel, ts, row }) => {
    const { blocks } = await calendarChecked(row.plan, { proposalId: row.id, approver: row.discussionApproval?.by || "a coordinator" }, row.slackApproval, row.ashbyCheck);
    // The notification text: no names beyond the approver's, and the state.
    const status = { queued: "waiting to be checked in Ashby; not booked", running: "being checked in Ashby; not booked", composed: `composed in Ashby, not sent yet${row.ashbyCheck?.confirmationEmail === "off" ? "; no candidate confirmation email will be sent" : ""}`, sent: "sent in Ashby", booked_invites_pending: "booked, but invitations NOT sent; send them by hand", booked_invites_unknown: "booked; invitations unknown, check Ashby", send_uncertain: "the send may have gone; check Ashby" }[row.ashbyCheck?.state] || "not booked";
    const text = `Interview schedule for ${row.plan.candidateName} · ${row.plan.jobTitle}: approved by ${row.slackApproval.name || row.slackApproval.email}; ${status}.`;
    const problems = blockProblems({ text, blocks });
    if (problems.length) throw invalid(problems);
    const { ok, body } = await api("chat.update", { channel, ts, blocks, text });
    if (!ok || body.ok !== true) throw new Error(`The Slack message couldn't be updated${body.error ? ` (${body.error})` : ""}`);
  };
  // Whether a message exists in a channel, for reconciling an unconfirmed
  // post from the link a coordinator pastes. chat.getPermalink needs no scope
  // beyond the bot's own; it doesn't read the message's content.
  send.messageExists = async ({ channel, ts }) => {
    let response;
    try {
      response = await request("https://slack.com/api/chat.getPermalink", { method: "POST", signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ channel, message_ts: ts }).toString() });
    } catch (_) { throw new Error("Slack couldn't be reached to check that message."); }
    const body = await response.json().catch(() => ({}));
    if (body.ok === true) return true;
    if (body.error === "message_not_found") return false;
    throw new Error(`Slack couldn't check that message (${body.error || `HTTP ${response.status}`}).`);
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
module.exports = { createSlack, blockProblems };
