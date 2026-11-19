"use strict";

// POST /api/remind: the Action queue's Remind button on a Feedback Overdue
// row. The dashboard never messages anyone itself; it asks the scorecard
// reminder bot (ashby-scorecard-bot/, POST /remind) over Railway's private
// network, so there is one place that sends reminders.
//
// - Only someone signed in with Google can send one: the message names them,
//   so it must be a verified name, never "dashboard password".
// - Who gets it comes from the dashboard's own snapshot (the row's
//   `interviewers`, exactly who still owes a scorecard), never from the
//   browser. The bot re-checks Ashby and can only drop people.
// - The bot enforces one reminder per person per interview per cooldown.
function createReminderRoute({ botUrl, botSecret, findEntry, history, fetchImpl = fetch, timeoutMs = 20000, log = console }) {
  async function send(interviewEventId, viewer) {
    if (!viewer || viewer.method !== "google" || !viewer.email) {
      return { status: 403, body: { error: "Sign in with Google to send reminders." } };
    }
    if (typeof interviewEventId !== "string" || !interviewEventId) return { status: 400, body: { error: "interviewEventId required" } };
    const entry = findEntry(interviewEventId);
    if (!entry) return { status: 404, body: { error: "That interview isn't waiting on feedback any more." } };
    const interviewers = (entry.interviewers || []).filter((i) => i && i.email);
    if (!interviewers.length) return { status: 409, body: { error: "Nobody on this interview has an email address in Ashby to remind." } };

    let res;
    try {
      res = await fetchImpl(`${botUrl}/remind`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${botSecret}` },
        body: JSON.stringify({
          interviewEventId,
          applicationId: entry.applicationId,
          candidateName: entry.candidateName || null,
          candidateUrl: entry.ashbyProfileUrl || null,
          jobTitle: entry.jobTitle || null,
          interviewers: interviewers.map((i) => ({ userId: i.id || null, email: i.email, name: i.name })),
          requestedBy: { name: viewer.name || viewer.email, email: viewer.email },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      log.warn(`[reminders] Reminder bot unreachable: ${err.message}`);
      return { status: 502, body: { error: "The reminder bot didn't answer. Nothing was sent." } };
    }
    let out = null;
    try { out = await res.json(); } catch (_) { out = null; }
    if (!res.ok || !out || !Array.isArray(out.sent) || !Array.isArray(out.skipped)) {
      log.warn(`[reminders] Reminder bot answered HTTP ${res.status}`);
      return { status: 502, body: { error: "The reminder bot couldn't send this. Nothing was sent." } };
    }
    if (out.sent.length) {
      history.record(interviewEventId, { byName: viewer.name, byEmail: viewer.email, sent: out.sent.map((s) => s.name) });
    }
    return { status: 200, body: { sent: out.sent, skipped: out.skipped, candidateName: entry.candidateName || null, candidateId: entry.candidateId || null } };
  }
  return { send };
}

module.exports = { createReminderRoute };
