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

test("calendar-checked posts open with what to do and who it's for, then the Ashby link and a dated schedule", async () => {
  const { posts } = await post(), [p] = posts, text = allText(p);
  // No client name configured and no Schedule button here: neither is mentioned.
  assert.equal(p.blocks[0].text.text, "This is the proposed interview schedule. Please review it, then post to the client channel for discussion.");
  assert.equal(p.blocks[1].text.text, "*TEST petrino* · Forward Deployed Engineer");
  // The SOP header line; this candidate has no LinkedIn in Ashby, and it says so.
  assert.equal(p.blocks[2].text.text, "LinkedIn (not in Ashby) - <https://app.ashbyhq.com/candidate-searches/new/right-side/candidates/cand-1|Ashby>");
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
  assert.deepEqual(allText(p).match(/<https?:[^>]+>/g), ["<https://app.ashbyhq.com/candidate-searches/new/right-side/candidates/cand-1|Ashby>"]);
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

// The Luminai SOP format: LinkedIn - Ashby header, "---- H:MM Break -----"
// between sessions with a gap, and the checklist block after the schedule.
test("SOP format: LinkedIn and Ashby on one line, break separators, and the checklist", async () => {
  const p0 = plan({ linkedinUrl: "https://www.linkedin.com/in/example", sessions: [
    { title: "Welcome", start: "2026-09-29T18:00:00.000Z", end: "2026-09-29T18:15:00.000Z", location: "Room / location to confirm", people: [{ name: "Gabby Struckell" }] },
    { title: "Technical deep dive", start: "2026-09-29T18:30:00.000Z", end: "2026-09-29T19:30:00.000Z", location: "Room / location to confirm", people: [{ name: "Aggelos Arvanitakis" }] },
    { title: "Lunch", start: "2026-09-29T19:30:00.000Z", end: "2026-09-29T20:00:00.000Z", location: "Room / location to confirm", people: [{ name: "Kathryn Wicks" }] },
  ] });
  const { posts } = await post(p0), [p] = posts, text = allText(p);
  assert.equal(p.blocks[2].text.text, "<https://www.linkedin.com/in/example|LinkedIn> - <https://app.ashbyhq.com/candidate-searches/new/right-side/candidates/cand-1|Ashby>");
  // A 15-minute gap gets a separator; back to back (Technical deep dive -> Lunch) doesn't.
  assert.match(text, /Welcome  Gabby Struckell\n.*\n---- 0:15 Break -----\n• 11:30 AM/);
  assert.equal((text.match(/Break -----/g) || []).length, 1);
  assert.match(text, /\*Interview Plan:\* to add\n\*Shared Prompt:\* to add\n\*Shared Interview Prep:\* to add\n\*NDA Sent:\* to confirm/);
});

// Slack refuses a whole message (invalid_blocks) over any one Block Kit limit.
// The confirmation dialog went to 374 characters of a 300 limit and every
// calendar-checked post with the Schedule button was refused (October 2026).
const { blockProblems } = require("../src/scheduling/slack");
const longOption = (flagged = true) => plan({ timezone: "America/Denver", sessions: [0, 1, 2, 3, 4, 6].map((n, i) => ({
  title: i === 5 ? "Lunch" : "Onsite", start: new Date(Date.parse("2026-10-22T16:00:00Z") + n * 1800000).toISOString(), end: new Date(Date.parse("2026-10-22T16:30:00Z") + n * 1800000).toISOString(),
  location: "Room / location to confirm", people: [{ name: "Hayley Samuels" }],
  ...(flagged && i === 0 ? { flags: [{ kind: "busy", name: "Hayley Samuels", start: "2026-10-22T16:00:00.000Z", end: "2026-10-22T16:30:00.000Z", minutes: 30 }] } : {}) })) });

test("a six-session flagged option with a break and the Schedule button passes Slack's limits", async () => {
  const api = slackApi(), send = createSlack("xoxb-test", api.request, { displayTimeZone: "America/Los_Angeles", interactive: true, clientName: "Luminai" });
  assert.deepEqual(await send.check(longOption(), { ...meta, digest: "g1" }), []);
  await send(longOption(), { ...meta, digest: "g1" });
  assert.equal(api.posts.length, 1);
  assert.deepEqual(blockProblems(api.posts[0]), []);
  assert.match(allText(api.posts[0]), /---- 0:30 Break -----/);
});

test("the check names each limit a message breaks", () => {
  const button = text => ({ type: "actions", elements: [{ type: "button", action_id: "a", text: { type: "plain_text", text: "Schedule" }, value: "v",
    confirm: { title: { type: "plain_text", text: "t" }, text: { type: "mrkdwn", text }, confirm: { type: "plain_text", text: "Approve" }, deny: { type: "plain_text", text: "Cancel" } } }] });
  const section = text => ({ type: "section", text: { type: "mrkdwn", text } });
  assert.deepEqual(blockProblems({ text: "x", blocks: [section("ok <https://a.example/x|Ashby>"), button("y".repeat(300))] }), []);
  assert.deepEqual(blockProblems({ text: "x", blocks: [button("y".repeat(374))] }), ["Block 1 (actions), button 1's confirmation text is 374 characters (Slack allows 300)"]);
  assert.deepEqual(blockProblems({ text: "x", blocks: Array.from({ length: 51 }, () => section("a")) }), ["The message has 51 blocks (Slack allows 50)"]);
  assert.deepEqual(blockProblems({ text: "x", blocks: [section(""), section("  \n"), section("z".repeat(3001))] }),
    ["Block 1 (section) is empty", "Block 2 (section) is empty", "Block 3 (section) is 3001 characters (Slack allows 3000)"]);
  assert.deepEqual(blockProblems({ text: "x", blocks: [section("a < b"), section("<javascript:x|y>")] }),
    ["Block 1 (section) has a < or > that isn't a link", "Block 2 (section) has a < or > that isn't a link"]);
  assert.deepEqual(blockProblems({ text: "x", blocks: [{ type: "header", text: { type: "plain_text", text: "h" } }] }), ["Block 1 (header) is a block type this check doesn't know"]);
});

test("an invalid message is never sent: the post and the approval update both stop before Slack", async () => {
  const api = slackApi(), send = createSlack("xoxb-test", api.request, { displayTimeZone: "America/Los_Angeles" });
  // One line over Slack's 3000 can't be split onto its own section.
  const bad = plan({ sessions: [{ title: "x".repeat(3100), start: "2026-09-29T18:00:00.000Z", end: "2026-09-29T18:30:00.000Z", location: "Room / location to confirm", people: [] }] });
  const problems = await send.check(bad, meta);
  assert.ok(problems.length && problems.every(p => /characters \(Slack allows 3000\)/.test(p)), problems.join("; "));
  await assert.rejects(send(bad, meta), { invalid: true, message: /wasn't sent: .*Slack allows 3000/ });
  const row = { id: "d", plan: bad, slackApproval: { name: "A", email: "a@example.com", at: "2026-09-29T10:00:00Z" }, ashbyCheck: null };
  await assert.rejects(send.markApproved({ channel: "C1", ts: "1.2", row }), { invalid: true });
  assert.deepEqual(api.calls, []);
});
