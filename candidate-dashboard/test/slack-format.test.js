"use strict";
// The calendar-checked Slack format: hyperlinked Ashby link, dated schedule,
// plain interviewer names (the bot is in Carrara's workspace and interviewers
// are in the client's, so there are no profile links or mentions), the second
// time line and the small print.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSlack } = require("../src/scheduling/slack");

function slackApi() {
  const calls = [], posts = [];
  const request = async (url, init) => {
    const method = url.split("/").pop();
    calls.push(method);
    if (method !== "chat.postMessage") throw new Error("unexpected Slack call " + method);
    posts.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ ok: true, ts: "1.2", channel: "C1" }) };
  };
  return { request, calls, posts };
}
const plan = (extra = {}) => ({
  format: "calendar_checked", candidateId: "cand-1", candidateName: "TEST petrino", jobTitle: "Forward Deployed Engineer",
  timezone: "America/New_York", timezoneSource: "candidate_submitted", notes: "Full schedule option 1. Nothing has been booked and no invitations have been sent.",
  sessions: [
    { title: "Welcome", start: "2026-09-29T18:00:00.000Z", end: "2026-09-29T18:15:00.000Z", location: "Room / location to confirm", people: [{ name: "Gabby Struckell" }] },
    { title: "Technical deep dive", start: "2026-09-29T18:15:00.000Z", end: "2026-09-29T19:15:00.000Z", location: "Video link required", people: [{ name: "Aggelos Arvanitakis" }] },
  ], ...extra,
});
const meta = { channelId: "C1", proposalId: "draft-1", approver: "Luminai Scheduler" };
const allText = payload => payload.blocks.flatMap(b => b.text ? [b.text.text] : b.elements.map(e => e.text)).join("\n");
const post = async (p = plan()) => { const api = slackApi(); await createSlack("xoxb-test", api.request, { displayTimeZone: "America/Los_Angeles" })(p, meta); return api; };

test("calendar-checked posts lead with the Ashby link and a dated schedule", async () => {
  const { posts } = await post(), [p] = posts, text = allText(p);
  assert.equal(p.blocks[0].text.text, "<https://app.ashbyhq.com/candidate-searches/new/right-side/candidates/cand-1|Ashby Link>");
  assert.match(text, /\*Interview Schedule\*/);
  assert.match(text, /\*Tuesday, September 29, 2026\*/);
  assert.match(text, /^• 11:00 AM – 11:15 AM \(PDT\) – Welcome  Gabby Struckell$/m);
  assert.match(text, /^• 11:15 AM – 12:15 PM \(PDT\) – Technical deep dive \(video link required\)  Aggelos Arvanitakis$/m);
  assert.match(text, /Nothing has been booked/);
  assert.ok(p.blocks.every(b => (b.text ? [b.text] : b.elements).every(t => t.type === "mrkdwn" && t.verbatim === true)));
});

test("interviewer names are plain text: no profile links, no mentions, no lookups", async () => {
  const { posts, calls } = await post(), [p] = posts;
  assert.deepEqual(calls, ["chat.postMessage"]);
  assert.doesNotMatch(JSON.stringify(p), /<@[UW]|slack\.com\/team\//);
  // The only link in the message is the Ashby one.
  assert.deepEqual(allText(p).match(/<https?:[^>]+>/g), ["<https://app.ashbyhq.com/candidate-searches/new/right-side/candidates/cand-1|Ashby Link>"]);
  assert.doesNotMatch(p.text, /Gabby|Aggelos/);
});

test("a second time line appears when the candidate's zone differs, and collapses when it matches", async () => {
  assert.match(allText((await post()).posts[0]), /\n {6}Candidate time: 2:00 PM – 2:15 PM \(EDT\)/);
  assert.doesNotMatch(allText((await post(plan({ timezone: "America/Los_Angeles" }))).posts[0]), /Candidate time/);
  assert.match(allText((await post(plan({ timezoneSource: "coordinator_entered" }))).posts[0]), /Entered time: 2:00 PM/);
});

test("text from Ashby can't inject Slack markup", async () => {
  const text = allText((await post(plan({ candidateName: "Evil <https://x.test|click> & co", sessions: [{ ...plan().sessions[0], title: "<!channel> Welcome", people: [{ name: "Name <b>" }] }] }))).posts[0]);
  assert.match(text, /Evil &lt;https:\/\/x\.test\|click&gt; &amp; co/);
  assert.match(text, /&lt;!channel&gt; Welcome  Name &lt;b&gt;/);
  assert.doesNotMatch(text, /<!channel>|<https:\/\/x\.test/);
});

test("other discussion posts keep the plain-text format", async () => {
  const { format, ...plainPlan } = plan();
  const { posts } = await post({ ...plainPlan, sessions: plainPlan.sessions.map(({ people, ...s }) => ({ ...s, interviewers: "Someone" })) });
  const [p] = posts;
  assert.equal(p.blocks, undefined);
  assert.equal(p.mrkdwn, false);
  assert.match(p.text, /^INTERVIEW SCHEDULE DRAFT — FOR DISCUSSION/);
});
