"use strict";
// The daily digest: once every weekday at 8am Pacific, a short post in the
// client channel saying what scheduling is waiting on, so nobody has to read
// the dashboard to know. It posts every weekday, nothing wrong included: "all
// clear" is said, never left to silence. A check it couldn't make is said as
// such, and then the header can't read all clear.
//
// SCHEDULING_DIGEST: "on" posts; "log" builds the same digest from live data
// and writes it to the log only (once after startup, once the dashboard's
// first refresh has read Ashby, and at 8am each weekday); anything else is off.
//
// Sections, in this order:
//   1. Needs a person: refusals only a person can clear in Ashby, from
//      auto-post.json (needsPerson, kept with `since`; and give-ups from
//      before that existed whose error is one of auto-post's needs-a-person
//      refusals), while the schedule is still on the Ready list.
//   2. Waiting for approval: open posts, soonest first session first; and
//      approved posts whose draft is composed in Ashby but not sent. Either is
//      flagged when its first session is within FLAG_DAYS working days
//      (Monday to Friday; no holiday calendar). Open posts whose first
//      session has passed are listed apart, as expired: those the expiry sweep
//      closed since the last digest (post-expiry.js), with whether anything
//      was pressed on them, and any still open. Our records can't say whether
//      one was booked in Ashby another way, so it isn't guessed.
//   3. Eligible, not posted: Ready rows on the worker's compose list (job,
//      then current stage) with no post in play for their schedule, each with
//      what auto-post last did. Submissions for a stage the candidate has
//      since left are a count only: auto-post never handles them.
//   4. Not on the compose list: Ready rows whose job, or whose stage, isn't on
//      it, with the stage named.
//   5. Since the last digest: proposals posted, schedules booked through the
//      bot (our own records only: one booked by hand in Ashby isn't counted,
//      by choice), drafts composed, and auto-post's failures with Ashby's HTTP
//      status where there was one (auto-post-events.js).
// Counts and names go in the post; the detail (what's wrong, what to do,
// times) in one thread reply when any section has something in it.
//
// Nothing here writes to Ashby or the worker, or changes what auto-post does.
// What it reads: the dashboard's snapshot, the post records, auto-post's
// files, the worker's settings (one call), and one Ashby read per distinct
// current stage on the Ready list, for its title.
const fs = require("fs");
const path = require("path");
const { blocksRepost } = require("./store");
const { MAX_FAILED_ROUNDS, needsPerson, plainError } = require("./auto-post");
const { createEventLog } = require("./auto-post-events");

const ZONE = "America/Los_Angeles";
const POST_HOUR = 8, LAST_HOUR = 12;
const FLAG_DAYS = 2;
const NAMES = 5;
const DAY = 24 * 60 * 60 * 1000;
const BOOKED = new Set(["ashby_check_sent", "ashby_check_booked_invites_pending", "ashby_check_booked_invites_unknown"]);

function local(ms, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
    .formatToParts(ms).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: p.weekday };
}
const isWeekend = weekday => weekday === "Sat" || weekday === "Sun";
// The instant it is `hour`:00 on `date` (YYYY-MM-DD) in `zone`.
function atHour(date, hour, zone) {
  const [y, m, d] = date.split("-").map(Number);
  for (let off = -14; off <= 14; off++) {
    const t = Date.UTC(y, m - 1, d, hour - off);
    const here = local(t, zone);
    if (here.date === date && here.hour === hour) return t;
  }
  return Date.UTC(y, m - 1, d, hour);
}
// The weekday before the one `ms` falls on, at POST_HOUR, in `zone`.
function previousWeekdayStart(ms, zone) {
  let t = ms - DAY;
  while (isWeekend(local(t, zone).weekday)) t -= DAY;
  return atHour(local(t, zone).date, POST_HOUR, zone);
}
// Working days after today up to the session's day: Monday to Tuesday is 1,
// Thursday to Monday 2, the same day (or a passed one) 0.
function workingDaysUntil(nowMs, startMs, zone) {
  const day = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  const from = day(local(nowMs, zone).date), to = day(local(startMs, zone).date);
  let n = 0;
  for (let t = from + DAY; t <= to; t += DAY) if (![0, 6].includes(new Date(t).getUTCDay())) n++;
  return n;
}
const when = (ms, zone) => new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(ms);
const dayOf = (ms, zone) => new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric" }).format(ms);
function ago(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}
// Ashby titles can carry stray spaces and tabs ("Marketing Lead\t").
const tidy = v => String(v ?? "").replace(/\s+/g, " ").trim();
// A stored error cut at a length limit, kept to its last whole sentence.
const wholeSentences = text => {
  const t = tidy(text);
  if (/[.!?)]$/.test(t)) return t.replace(/[.\s]+$/, "");
  const end = Math.max(t.lastIndexOf(". "), t.lastIndexOf("? "), t.lastIndexOf("! "));
  return end > 0 ? t.slice(0, end) : t;
};
const firstStart = row => Math.min(...(row.plan?.sessions || []).map(s => Date.parse(s.start)).filter(Number.isFinite));
const inPlay = r => ["sharing", "shared", "discussion_uncertain"].includes(r.state) || (r.state === "discussion_approved" && blocksRepost(r));

// Everything the digest says, as data. `snapshot`: the dashboard's
// getSnapshot(). `autoPostState`: auto-post.json's contents. `settings()`:
// the worker's booking settings. `stageTitle(applicationId)`: the current
// stage's title. `since`: the start of section 5's window (ms).
async function buildDigest({ now, zone = ZONE, since, sinceDigest, clientId, rows: allRows, snapshot, autoPostState: state = {}, autoPost = { on: false, wide: false },
  settings, stageTitle, events = [] }) {
  const problems = [];
  const status = snapshot?.sectionStatus?.readyToSchedule;
  const readyKnown = !!status?.lastUpdated;
  if (!readyKnown) problems.push(`the Ready to schedule list (the dashboard hasn't read Ashby's schedules since it started${status?.lastError ? `: ${status.lastError}` : ""})`);
  const readyAsOf = readyKnown && now - Date.parse(status.lastUpdated) > 30 * 60 * 1000
    ? `The Ready to schedule list is from ${when(Date.parse(status.lastUpdated), zone)}${status.lastError ? ` (the latest refresh failed: ${plainError({ message: status.lastError })})` : ""}.` : null;
  const ready = readyKnown ? [...(snapshot.readyToSchedule || []).map(r => ({ ...r, hidden: false })), ...(snapshot.readyToScheduleHidden || []).map(r => ({ ...r, hidden: true }))] : [];
  const readyBySchedule = new Map(ready.filter(r => r.scheduleId).map(r => [r.scheduleId, r]));
  const rows = allRows.filter(r => r.clientId === clientId);

  // 1. Needs a person.
  const person = [];
  for (const [scheduleId, seen] of Object.entries(state)) {
    if (scheduleId.startsWith("_") || !readyBySchedule.has(scheduleId)) continue;
    const legacy = !seen.needsPerson && seen.failedRounds >= MAX_FAILED_ROUNDS && needsPerson({ message: seen.lastError });
    if (!seen.needsPerson && !legacy) continue;
    const r = readyBySchedule.get(scheduleId);
    // A give-up from before needs-a-person existed records only when it gave
    // up (`at`), not when the wait began: said as "given up on", not as a wait.
    person.push({ scheduleId, name: tidy(r.candidateName || seen.candidateName) || "a candidate", job: tidy(r.jobTitle) || null,
      since: Date.parse(seen.needsPerson?.since || seen.needsPerson?.at || seen.at), why: wholeSentences(seen.needsPerson?.why || seen.lastError), legacy });
  }
  person.sort((a, b) => a.since - b.since);
  const personIds = new Set(person.map(p => p.scheduleId));

  // 2. Waiting for approval, and approved but not sent.
  const waitingItem = (r, at) => {
    const start = firstStart(r), days = workingDaysUntil(now, start, zone);
    return { id: r.id, name: tidy(r.plan.candidateName), job: tidy(r.plan.jobTitle), start, at, days, passed: !(start > now), flag: !(start > now) || days <= FLAG_DAYS,
      draftUrl: r.ashbyCheck?.draftUrl || null };
  };
  // An open post whose first session has passed can no longer be approved
  // (service.js refuses it): listed apart, as expired, so it can't bury one
  // that's still due. Whether it was booked some other way isn't in our
  // records, so it isn't guessed.
  const shared = rows.filter(r => r.state === "shared" && Number.isFinite(firstStart(r))).map(r => waitingItem(r, Number(r.slack?.ts) * 1000 || null)).sort((a, b) => a.start - b.start);
  // Closed by the expiry sweep (post-expiry.js) since the last digest, with
  // what was pressed; and any passed post still open (the sweep off, or not
  // yet run), until it's closed.
  const pressed = sentence => !sentence ? null : /^Nobody pressed/.test(sentence) ? "nothing pressed" : /^Pressed/.test(sentence) ? "pressed, not approved" : "presses not recorded";
  const swept = rows.filter(r => r.state === "rejected" && r.expired && Date.parse(r.expired.at) >= since && Date.parse(r.expired.at) <= now && Number.isFinite(firstStart(r)))
    .map(r => ({ ...waitingItem(r, Number(r.slack?.ts) * 1000 || null), pressed: pressed(r.expired.presses), presses: r.expired.presses || null }));
  const open = shared.filter(i => !i.passed);
  const expired = [...shared.filter(i => i.passed).map(i => ({ ...i, pressed: "still open" })), ...swept].sort((a, b) => a.start - b.start);
  const composed = rows.filter(r => r.state === "discussion_approved" && r.ashbyCheck?.state === "composed" && Number.isFinite(firstStart(r)))
    .map(r => waitingItem(r, Date.parse(r.ashbyCheck.at) || null)).sort((a, b) => a.start - b.start);

  // 3 and 4: the Ready list against the compose list.
  let jobs = null;
  if (readyKnown) {
    try {
      const current = await settings();
      if (current?.composeJobs?.problem) throw new Error(`it's invalid (${current.composeJobs.problem})`);
      jobs = current?.composeJobs?.jobs;
      if (!jobs || typeof jobs !== "object") throw new Error("the worker didn't say which jobs it may compose for");
    } catch (e) { problems.push(`the worker's compose list (${plainError(e)})`); }
  }
  const unposted = [], offList = [], unreadable = [];
  let old = 0;
  if (jobs) {
    const titles = new Map();
    for (const r of ready) {
      if (!r.stageMatches) { old++; continue; }
      let title = r.currentStageId ? titles.get(r.currentStageId) : undefined;
      if (title === undefined) {
        try { title = String(await stageTitle(r.applicationId) || "").trim(); if (r.currentStageId) titles.set(r.currentStageId, title); }
        catch (e) { unreadable.push(`${r.candidateName || "a candidate"}'s stage (${plainError(e)})`); continue; }
      }
      const stages = jobs[String(r.jobId || "").toLowerCase()];
      const base = { scheduleId: r.scheduleId, name: tidy(r.candidateName) || "a candidate", job: tidy(r.jobTitle) || "an unnamed job", stage: tidy(title) || "an unnamed stage", hidden: r.hidden, submittedAt: Date.parse(r.submittedAt) };
      if (!stages) { offList.push({ ...base, off: "job" }); continue; }
      if (stages !== "all" && !stages.includes(title.toLowerCase())) { offList.push({ ...base, off: "stage" }); continue; }
      if (personIds.has(r.scheduleId) || rows.some(p => p.plan?.bookingPlan?.interviewScheduleId === r.scheduleId && inPlay(p))) continue;
      unposted.push({ ...base, why: unpostedWhy(r, state, rows, autoPost, now) });
    }
    if (unreadable.length) problems.push(...unreadable);
  }

  // 5. Since the last digest.
  const inWindow = at => { const ms = Date.parse(at); return ms >= since && ms <= now; };
  const posted = rows.filter(r => { const ms = Number(r.slack?.ts) * 1000; return ms >= since && ms <= now; }).length;
  const booked = rows.filter(r => (r.audit || []).some(a => BOOKED.has(a.action) && inWindow(a.at))).length;
  const drafted = rows.filter(r => (r.audit || []).some(a => a.action === "ashby_check_composed" && inWindow(a.at))).length;
  const failures = failureSummary(events.filter(e => e.kind !== "needs_person"), state);

  return { now, zone, since, sinceDigest, problems, readyAsOf, autoPost,
    person, open, expired, composed, unposted, old, offList, jobsKnown: !!jobs,
    numbers: { posted, booked, drafted, failures } };
}

// What auto-post last did with an eligible submission nobody has posted.
function unpostedWhy(r, state, rows, autoPost, now) {
  if (!autoPost.on || !autoPost.wide) return "auto-post isn't on for compose-list jobs, so this waits on a post from booking review";
  const seen = state[r.scheduleId], read = state._reads?.[r.scheduleId];
  const same = seen && seen.updatedAt === r.submittedAt;
  if (same && seen.failedRounds >= MAX_FAILED_ROUNDS) return `auto-post gave up (${plainError({ message: seen.lastError })})`;
  if (read?.gaveUp && read.submittedAt === (r.submittedAt || null)) return `auto-post gave up (${read.why})`;
  if (same && seen.failedRounds > 0) return `auto-post is retrying (${plainError({ message: seen.lastError })})`;
  if (read?.rounds) return `auto-post is retrying (${read.why})`;
  if (same && seen.outcome === "no_clean_option") return "auto-post found no option it could post and said why in the channel";
  const last = rows.filter(p => p.plan?.bookingPlan?.interviewScheduleId === r.scheduleId).sort((a, b) => Number(b.slack?.ts || 0) - Number(a.slack?.ts || 0))[0];
  if (last?.state === "rejected") return "its last post was rejected";
  const waited = now - Date.parse(r.submittedAt);
  return waited < 20 * 60 * 1000 ? `submitted ${ago(waited)} ago; auto-post hasn't reached it yet` : `submitted ${ago(waited)} ago and auto-post hasn't picked it up`;
}

// Auto-post's failures, per candidate: how many, Ashby's HTTP statuses, and
// how it stands now. A whole round that failed is counted on its own.
function failureSummary(events, state) {
  const by = new Map();
  let rounds = 0;
  const roundWhy = new Set();
  for (const e of events) {
    if (e.kind === "round") { rounds++; roundWhy.add(e.why); continue; }
    const key = e.scheduleId || e.name || "unknown";
    const f = by.get(key) || { name: e.name || "a candidate", scheduleId: e.scheduleId, count: 0, statuses: new Set(), gaveUp: false, last: null };
    f.count++; if (e.status) f.statuses.add(e.status); if (e.kind === "gave_up") f.gaveUp = true; f.last = e.why;
    by.set(key, f);
  }
  const people = [...by.values()].map(f => {
    const seen = f.scheduleId && state[f.scheduleId];
    const now = f.gaveUp ? "gave up" : seen?.done ? "recovered" : seen?.needsPerson ? "now needs a person" : "still retrying, or no longer waiting";
    return { name: f.name, count: f.count, statuses: [...f.statuses].sort(), outcome: now, why: f.last };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { total: people.reduce((n, p) => n + p.count, 0), people, rounds, roundWhy: [...roundWhy] };
}

const statusText = statuses => statuses.length ? statuses.map(s => `HTTP ${s}`).join(", ") : "no HTTP status";
const names = (items, label) => {
  const shown = items.slice(0, NAMES).map(label);
  return shown.join(", ") + (items.length > NAMES ? `, and ${items.length - NAMES} more` : "");
};

// The post (`text`) and its thread reply (`thread`, null when there's no detail).
function renderDigest(d) {
  const { zone, now } = d;
  const due = i => i.passed ? "first session passed" : i.days === 0 ? "today" : `${i.days} working day${i.days === 1 ? "" : "s"}`;
  const outstanding = d.person.length + d.open.length + d.composed.length + d.unposted.length + d.offList.length;
  const expiredText = d.expired.length ? `${d.expired.length} expired post${d.expired.length === 1 ? "" : "s"}` : "";
  const head = `Scheduling digest, ${dayOf(now, zone)}: ${d.problems.length ? "some checks couldn't be made, see below"
    : outstanding ? `${outstanding} waiting on someone${expiredText ? `, and ${expiredText}` : ""}` : expiredText || "all clear"}`;
  const gaveUpOn = p => `given up on ${new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(p.since)}`;
  const lines = [head];
  lines.push(`• Needs a person: ${d.person.length ? `${d.person.length}: ${names(d.person, p => `${p.name} (${p.legacy ? gaveUpOn(p) : ago(now - p.since)})`)}` : "none"}`);
  lines.push(`• Waiting for approval: ${d.open.length ? `${d.open.length}: ${names(d.open, i => `${i.flag ? "⚠️ " : ""}${i.name} (${dayOf(i.start, zone)}, ${due(i)})`)}` : "none"}`);
  lines.push(`• Expired, never approved: ${d.expired.length ? `${d.expired.length}: ${names(d.expired, i => `${i.name} (${dayOf(i.start, zone)}${i.pressed ? `; ${i.pressed}` : ""})`)}` : "none"}`);
  lines.push(`• Approved, draft not sent in Ashby: ${d.composed.length ? `${d.composed.length}: ${names(d.composed, i => `${i.flag ? "⚠️ " : ""}${i.name} (${dayOf(i.start, zone)}, ${due(i)})`)}` : "none"}`);
  const oldNote = d.old ? ` (${d.old} older submission${d.old === 1 ? "" : "s"} for a stage the candidate has left not counted)` : "";
  lines.push(`• Eligible, not posted: ${!d.jobsKnown ? "couldn't check" : d.unposted.length ? `${d.unposted.length}: ${names(d.unposted, u => u.name)}` : "none"}${d.jobsKnown ? oldNote : ""}`);
  lines.push(`• Not on the compose list: ${!d.jobsKnown ? "couldn't check" : d.offList.length ? `${d.offList.length}: ${names(d.offList, o => `${o.name} (${o.job} / ${o.stage})`)}` : "none"}`);
  const f = d.numbers.failures;
  const failText = !f.total && !f.rounds ? "none"
    : [f.total ? `${f.total} for ${f.people.length} candidate${f.people.length === 1 ? "" : "s"} (${statusText([...new Set(f.people.flatMap(p => p.statuses))].sort())})` : null,
      f.rounds ? `${f.rounds} whole round${f.rounds === 1 ? "" : "s"}` : null].filter(Boolean).join("; ");
  const window = d.sinceDigest ? `Since ${new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(d.since)}'s digest` : `Since ${when(d.since, zone)}`;
  lines.push(`• ${window}: ${d.numbers.posted} posted, ${d.numbers.booked} booked through the bot, ${d.numbers.drafted} draft${d.numbers.drafted === 1 ? "" : "s"} composed; auto-post failures: ${failText}`);
  if (d.problems.length) lines.push(`Couldn't check: ${d.problems.join("; ")}.`);
  if (d.readyAsOf) lines.push(d.readyAsOf);

  const detail = [];
  if (d.person.length) {
    detail.push("Needs a person");
    for (const p of d.person) {
      // The refusal's own words say what to change when they name Ashby.
      const fix = /\bin Ashby\b/.test(p.why) ? "" : "Fix it in Ashby (the schedule's template or the job's interview plan). ";
      detail.push(`• ${p.name}${p.job ? ` (${p.job})` : ""}, ${p.legacy ? `${gaveUpOn(p)}, ${dayOf(p.since, zone).replace(/^\w+, /, "")}` : `waiting ${ago(now - p.since)}`}: ${p.why}. ${fix}${p.legacy
        ? "Auto-post won't try this one again until the schedule changes in Ashby; once it's fixed, post from booking review."
        : "Auto-post checks again within the hour, or post from booking review once it's fixed."}`);
    }
  }
  if (d.open.length) {
    detail.push("Waiting for approval, soonest first");
    for (const i of d.open) detail.push(`• ${i.flag ? "⚠️ " : ""}${i.name} · ${i.job}: first session ${when(i.start, zone)} (${due(i)}); posted ${i.at ? `${ago(now - i.at)} ago` : "at an unknown time"}.`);
  }
  if (d.expired.length) {
    // Nothing clears these yet: Schedule and the Suggest buttons refuse a post
    // whose first session has passed, and Reject takes only unposted drafts.
    detail.push("Expired, never approved (first session passed; whether it was booked in Ashby another way isn't in these records)");
    for (const i of d.expired) detail.push(`• ${i.name} · ${i.job}: first session ${when(i.start, zone)} passed; posted ${i.at ? `${ago(now - i.at)} ago` : "at an unknown time"}${i.pressed === "still open" ? "; the post is still open" : ""}.${i.presses ? ` ${i.presses}` : ""}`);
  }
  if (d.composed.length) {
    detail.push("Approved, draft composed in Ashby but not sent");
    for (const i of d.composed) detail.push(`• ${i.flag ? "⚠️ " : ""}${i.name} · ${i.job}: first session ${when(i.start, zone)} (${due(i)}); composed ${i.at ? `${ago(now - i.at)} ago` : "at an unknown time"}. Send it from Drafts in the left sidebar under SCHEDULES${i.draftUrl ? `: ${i.draftUrl}` : ""}.`);
  }
  if (d.unposted.length) {
    detail.push("Eligible, not posted");
    for (const u of d.unposted) detail.push(`• ${u.name} · ${u.job} / ${u.stage}${u.hidden ? " (hidden on the dashboard)" : ""}: ${u.why}.`);
  }
  if (d.offList.length) {
    detail.push("Not on the compose list (auto-post leaves these alone; someone schedules them by hand)");
    for (const o of d.offList) detail.push(`• ${o.name} · ${o.job} / ${o.stage}${o.hidden ? " (hidden on the dashboard)" : ""}: ${o.off === "job" ? "the job isn't on the compose list" : "the job is, but this stage isn't"}; submitted ${ago(now - o.submittedAt)} ago.`);
  }
  if (f.people.length || f.rounds) {
    detail.push("Auto-post failures since the last digest");
    for (const p of f.people) detail.push(`• ${p.name}: ${p.count} failed ${p.count === 1 ? "try" : "tries"} (${statusText(p.statuses)}), ${p.outcome}. Last: ${p.why}.`);
    if (f.rounds) detail.push(`• Whole rounds that failed: ${f.rounds} (${f.roundWhy.join("; ")}).`);
  }
  return { text: lines.join("\n"), thread: detail.length ? detail.join("\n") : null };
}

// Slack's limit on a message is far above this; kept well under it, split by line.
function chunks(text, max = 2800) {
  const out = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur && cur.length + line.length + 1 > max) { out.push(cur); cur = ""; }
    cur = cur ? `${cur}\n${line}` : line.slice(0, max);
  }
  if (cur) out.push(cur);
  return out;
}

function createDigest({ mode = "off", dataDir, clientId, channelId, slackApi, store, snapshot, settings, stageTitle, autoPost, zone = ZONE,
  now = () => Date.now(), log = console, events, tickMs = 60000 }) {
  const file = path.join(dataDir, "digest.json");
  events ||= createEventLog(dataDir, { now, log });
  const load = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return {}; } };
  const save = s => { fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(file + ".tmp", JSON.stringify(s, null, 2)); fs.renameSync(file + ".tmp", file); };
  const autoPostState = () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, "auto-post.json"), "utf8")); } catch (_) { return {}; } };

  // Section 5's window: from the last posted digest, else from 8am on the
  // previous weekday (Monday reaches back to Friday).
  function windowStart(state) {
    if (state.lastAt) return { since: Date.parse(state.lastAt), sinceDigest: true };
    return { since: previousWeekdayStart(now(), zone), sinceDigest: false };
  }
  async function build(state = load()) {
    const { since, sinceDigest } = windowStart(state);
    const d = await buildDigest({ now: now(), zone, since, sinceDigest, clientId, rows: await store.list(), snapshot: snapshot(), autoPostState: autoPostState(),
      autoPost, settings, stageTitle, events: events.since(since) });
    return renderDigest(d);
  }
  async function post() {
    const { text, thread } = await build();
    const sent = await slackApi.notice({ channel: channelId, text });
    log.warn(`[digest] Posted:\n${text}`);
    if (thread) for (const part of chunks(thread)) await slackApi.threadReply({ channel: channelId, threadTs: sent.ts, text: part })
      .catch(e => log.warn(`[digest] The detail couldn't be posted in the thread: ${e.message}`));
  }
  async function logOnly(why) {
    const { text, thread } = await build();
    log.warn(`[digest] ${why}; not posted (SCHEDULING_DIGEST is "log"):\n${text}${thread ? `\n--- thread ---\n${thread}` : ""}`);
  }

  let busy = false, startupLogged = false;
  async function tick() {
    if (mode !== "on" && mode !== "log") return;
    if (busy) return;
    busy = true;
    try {
      const t = now(), here = local(t, zone), state = load();
      // In log mode, once after startup, as soon as the dashboard has read Ashby.
      if (mode === "log" && !startupLogged && snapshot()?.sectionStatus?.readyToSchedule?.lastUpdated) {
        startupLogged = true;
        await logOnly("Built after startup");
      }
      if (isWeekend(here.weekday) || here.hour < POST_HOUR) return;
      if (here.hour >= LAST_HOUR) {
        if (mode === "on" && state.lastDate !== here.date && state.missed !== here.date) { log.warn(`[digest] Today's digest wasn't posted by ${LAST_HOUR}:00; it's skipped.`); save({ ...state, missed: here.date }); }
        return;
      }
      if (mode === "log") {
        if (state.logDate === here.date) return;
        save({ ...state, logDate: here.date });
        return await logOnly("Today's digest");
      }
      if (state.lastDate === here.date) return;
      // Claimed before posting, so a restart can't post it twice; given back
      // if the post fails, so the next minute tries again (until noon).
      save({ ...state, lastDate: here.date });
      try { await post(); save({ ...load(), lastDate: here.date, lastAt: new Date(t).toISOString() }); }
      catch (e) { log.warn(`[digest] Couldn't post today's digest (tries again in a minute): ${e.message}`); save({ ...load(), lastDate: state.lastDate || null }); }
    } catch (e) { log.warn(`[digest] ${e.message}`); }
    finally { busy = false; }
  }

  function start() {
    log.warn(`[digest] ${mode === "on" ? `on: posts at ${POST_HOUR}:00 Pacific every weekday` : mode === "log" ? `log only: built at ${POST_HOUR}:00 Pacific every weekday and once after startup, never posted` : "off (SCHEDULING_DIGEST isn't \"on\" or \"log\")"}`);
    if (mode !== "on" && mode !== "log") return () => {};
    const timer = setInterval(tick, tickMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
  return { tick, build, start };
}

module.exports = { createDigest, buildDigest, renderDigest, workingDaysUntil, chunks, ZONE };
