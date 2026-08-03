"use strict";

const { WebClient } = require("@slack/web-api");
const config = require("./config");

const slack = new WebClient(config.slackBotToken);

// Small cache so we don't hit users.lookupByEmail repeatedly for the same person.
const emailToUserId = new Map();

async function findUserIdByEmail(email) {
  if (!email) return null;
  if (emailToUserId.has(email)) return emailToUserId.get(email);
  try {
    const res = await slack.users.lookupByEmail({ email });
    const id = res.user && res.user.id ? res.user.id : null;
    emailToUserId.set(email, id);
    return id;
  } catch (err) {
    // users_not_found is expected for people whose Slack email differs from Ashby.
    if (err.data && err.data.error === "users_not_found") {
      emailToUserId.set(email, null);
      return null;
    }
    console.error(`[slack] lookupByEmail failed for ${email}:`, err.message);
    return null;
  }
}

function buildMessage({
  interviewerName,
  candidateName,
  jobTitle,
  scorecardUrl,
  briefingUrl,
  reminderNumber = 1,
  totalReminders = 1,
  hoursSinceEnd = 0,
}) {
  const who = candidateName ? `*${candidateName}*` : "your candidate";
  const role = jobTitle ? ` for *${jobTitle}*` : "";
  const first = interviewerName ? interviewerName.split(" ")[0] : "there";
  const isFinal = reminderNumber >= totalReminders && totalReminders > 1;

  let lines;
  if (reminderNumber === 1) {
    // First nudge, right when the interview ends.
    lines = [
      `Hi ${first}! Your interview with ${who}${role} just wrapped. :wave:`,
      "",
      "When you have a moment, please submit your scorecard while it's fresh.",
    ];
  } else if (isFinal) {
    // Final reminder — the SLA deadline.
    lines = [
      `Hi ${first} — final reminder on your scorecard for ${who}${role}. :rotating_light:`,
      "",
      `This is now at the ${hoursSinceEnd}-hour SLA deadline, and your feedback is still outstanding. Please submit it as soon as you can.`,
    ];
  } else {
    // Middle follow-up.
    lines = [
      `Hi ${first} — following up: your scorecard for ${who}${role} is still outstanding. :hourglass_flowing_sand:`,
      "",
      `It's been about ${hoursSinceEnd} hours since the interview. A quick submission keeps the process moving.`,
    ];
  }
  if (scorecardUrl) {
    lines.push(`\n:memo: <${scorecardUrl}|Submit your scorecard>`);
  } else {
    lines.push("\n:memo: You can submit it from the candidate's page in Ashby.");
  }
  if (briefingUrl) {
    lines.push(`\n:clipboard: <${briefingUrl}|Open the interview brief>`);
  }
  lines.push(
    "\n:speech_balloon: Prefer Slack? You can submit your feedback right from Slack with the *Ashby* app."
  );
  return lines.join("\n");
}

/**
 * DM a single interviewer their scorecard reminder.
 * Returns true if a message was sent.
 */
async function sendScorecardReminder(interviewer, context) {
  const userId = await findUserIdByEmail(interviewer.email);

  const text = buildMessage({
    interviewerName: interviewer.name,
    candidateName: context.candidateName,
    jobTitle: context.jobTitle,
    scorecardUrl: context.scorecardUrl,
    briefingUrl: context.briefingUrl,
    reminderNumber: context.reminderNumber,
    totalReminders: context.totalReminders,
    hoursSinceEnd: context.hoursSinceEnd,
  });

  if (userId) {
    await slack.chat.postMessage({
      channel: userId, // passing a user ID opens/uses the DM channel
      text,
      unfurl_links: false,
    });
    console.log(`[slack] Reminder sent to ${interviewer.email} (${userId}).`);
    return true;
  }

  // Couldn't map the interviewer to a Slack user.
  console.warn(`[slack] No Slack user for ${interviewer.email}; DM skipped.`);
  if (config.fallbackSlackChannel) {
    await slack.chat.postMessage({
      channel: config.fallbackSlackChannel,
      text: `:warning: Could not DM *${interviewer.name || interviewer.email}* a scorecard reminder (no matching Slack account for ${interviewer.email}).`,
      unfurl_links: false,
    });
  }
  return false;
}

module.exports = { sendScorecardReminder, findUserIdByEmail };
