"use strict";

const fs = require("fs");
const path = require("path");

// POST /remind: a reminder someone asked for from the dashboard, for one
// interview. The dashboard says who it shows as missing; this re-checks
// Ashby and only ever drops people from that list (someone who has submitted
// since), never adds anyone, so the bot can't disagree with the dashboard
// about who owes a scorecard. One reminder per person per interview within
// the cooldown, kept in <DATA_DIR>/manual-reminders.json.

const UUIDISH = /^[0-9a-f-]{8,64}$/i;
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

// The request body, checked. Returns { request } or { error }.
function parseRequest(body) {
  const b = body || {};
  const interviewEventId = str(b.interviewEventId, 64);
  const applicationId = str(b.applicationId, 64);
  if (!interviewEventId || !UUIDISH.test(interviewEventId)) return { error: "interviewEventId required" };
  if (!applicationId || !UUIDISH.test(applicationId)) return { error: "applicationId required" };
  if (!Array.isArray(b.interviewers) || !b.interviewers.length || b.interviewers.length > 20) return { error: "interviewers required (1 to 20)" };
  const interviewers = [];
  for (const i of b.interviewers) {
    const email = str(i && i.email, 200);
    if (!email || !email.includes("@")) return { error: "each interviewer needs an email" };
    interviewers.push({ userId: str(i.userId, 64), email, name: str(i.name, 200) || email });
  }
  const requestedBy = b.requestedBy || {};
  const requestedByName = str(requestedBy.name, 200);
  const requestedByEmail = str(requestedBy.email, 200);
  if (!requestedByEmail) return { error: "requestedBy.email required" };
  return {
    request: {
      interviewEventId, applicationId, interviewers,
      candidateName: str(b.candidateName, 200), jobTitle: str(b.jobTitle, 200),
      candidateUrl: /^https:\/\//.test(str(b.candidateUrl, 600) || "") ? str(b.candidateUrl, 600) : null,
      // When the interview ended, for "It's been 3 days since the interview!".
      interviewEndedAt: Number.isFinite(Date.parse(str(b.interviewEndedAt, 40) || "")) ? str(b.interviewEndedAt, 40) : null,
      requestedByName: requestedByName || requestedByEmail, requestedByEmail,
    },
  };
}

function createRemindNow({ filterAlreadySubmitted, sendManualReminder, interviewLinks, dataDir, cooldownHours, now = () => Date.now(), log = console }) {
  const file = path.join(dataDir, "manual-reminders.json");
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  let sentLog = {}; // "<eventId>:<userId or email>" -> { at, by }
  try { sentLog = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch (_) { sentLog = {}; }

  const save = () => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(sentLog));
      fs.renameSync(tmp, file);
    } catch (err) {
      log.warn(`[remind] Couldn't save ${path.basename(file)}: ${err.message}`);
    }
  };
  const keyFor = (eventId, i) => `${eventId}:${(i.userId || i.email).toLowerCase()}`;

  // Sends are one at a time per interview, so two clicks a second apart
  // can't both pass the cooldown check before either is recorded.
  const inFlight = new Map();

  async function remind(request) {
    const prior = inFlight.get(request.interviewEventId) || Promise.resolve();
    const run = prior.catch(() => {}).then(() => remindOnce(request));
    inFlight.set(request.interviewEventId, run);
    try { return await run; } finally { if (inFlight.get(request.interviewEventId) === run) inFlight.delete(request.interviewEventId); }
  }

  async function remindOnce(request) {
    const t = now();
    for (const [k, v] of Object.entries(sentLog)) if (!v || t - v.at > KEEP_MS) delete sentLog[k];

    const sent = [];
    const skipped = [];
    const { recipients, verified } = await filterAlreadySubmitted({
      applicationId: request.applicationId,
      interviewEventId: request.interviewEventId,
      interviewers: request.interviewers,
    });
    const stillOwe = new Set(recipients);
    for (const i of request.interviewers) if (!stillOwe.has(i)) skipped.push({ name: i.name, reason: "already submitted" });

    const { scorecardUrl } = interviewLinks(request.interviewEventId, null);
    for (const i of recipients) {
      const prev = sentLog[keyFor(request.interviewEventId, i)];
      if (prev && t - prev.at < cooldownMs) {
        skipped.push({ name: i.name, reason: "reminded too recently", lastAt: prev.at, lastBy: prev.by });
        continue;
      }
      let result;
      try {
        result = await sendManualReminder(i, {
          candidateName: request.candidateName, jobTitle: request.jobTitle,
          // The candidate's Ashby page, or the scorecard if the dashboard had none.
          candidateUrl: request.candidateUrl || scorecardUrl,
          requestedByName: request.requestedByName,
          interviewEndedAt: request.interviewEndedAt,
          now: t,
        });
      } catch (err) {
        log.warn(`[remind] Slack refused the message to ${i.email}: ${err.message}`);
        result = { sent: false, reason: "Slack refused the message" };
      }
      if (result.sent) {
        sentLog[keyFor(request.interviewEventId, i)] = { at: t, by: request.requestedByEmail };
        sent.push({ name: i.name });
      } else {
        skipped.push({ name: i.name, reason: result.reason });
      }
    }
    save();
    log.log(`[remind] ${request.requestedByEmail} asked for event ${request.interviewEventId}: sent ${sent.length}, skipped ${skipped.length}${verified ? "" : " (couldn't re-check Ashby; used the dashboard's list)"}.`);
    return { sent, skipped, rechecked: verified };
  }

  return { remind };
}

module.exports = { createRemindNow, parseRequest };
