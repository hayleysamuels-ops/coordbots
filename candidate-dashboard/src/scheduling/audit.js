"use strict";
// The scheduling audit: one read of a client's Ashby instance, reported
// against what the scheduler assumes, in three parts:
//
//   Drifted since configured: the worker's BOOKING_COMPOSE_JOBS and
//     BOOKING_SEND_JOBS, and scheduling-rules/<client>.json, naming jobs,
//     stages, interviews or people Ashby no longer has. This is the main
//     event: a rename nobody mentions silently stops the bot (FDE's "Agency
//     Recruiter Screen", Executive Director's "Hiring Manager Screen", found
//     by accident on November 11), and nothing else says so.
//   Blocking for onboarding: what would stop or mislead the scheduler on a
//     role before anything is configured (two activities sharing a name in a
//     stage; events larger than the panels supported).
//   Worth knowing: likely alternatives, odd or near-duplicate names, who
//     hosts without giving feedback, stage names likely to churn.
//
// The lists are matched with the worker's own jobAllows (worker/job-lists.js)
// and the rules with rules.js's own matchers (sessionMatches, alternativeKey),
// never copies, so the audit can't drift from what it checks. Rename history
// isn't in Ashby's API (application history gives current titles only), so
// renames are found by comparing with the previous audit's snapshot.
//
// Read-only. Titles and staff names only: no candidates. What the API can't
// show is said, not guessed: interviewer slots are on the template page, so
// panel size is "observed up to N people per event", shadows included.
const { ashbyRead } = require("./ashby-read");
const { MAX_PANEL } = require("./panel");
const { jobAllows } = require("../../worker/job-lists");

const DAY = 86400000;
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const key = t => String(t ?? "").replace(/[‐-―−]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
const show = t => JSON.stringify(String(t ?? ""));
const nameOf = u => [u?.firstName, u?.lastName].filter(x => typeof x === "string" && x.trim()).join(" ").trim();

// Edit distance, bounded: beyond `max` it stops counting.
function distance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
// Two different names that read as one spelled two ways ("URL Shortner" and
// "URL Shortener"), not two numbered things ("Round 1" and "Round 2").
function nearDuplicate(a, b) {
  const x = key(a), y = key(b);
  if (x === y || Math.min(x.length, y.length) < 8) return false;
  if (x.replace(/\d+/g, "#") === y.replace(/\d+/g, "#")) return false;
  return distance(x, y, 2) <= 2;
}
const nearest = (name, titles) => {
  const best = titles.map(t => ({ t, d: distance(key(name), key(t), 6) })).filter(x => x.d <= 6).sort((a, b) => a.d - b.d)[0];
  return best ? best.t : null;
};
// Stage names that tend to be renamed: placeholders, copies, dates, agency
// wording (FDE's "Agency Recruiter Screen" became "Initial Screen").
const CHURNY = /\b(copy|old|temp|tmp|draft|tbd|agency|v\d+|20\d\d)\b/i;

// One read of everything the checks need.
async function readAshby({ apiKey, lookbackDays = 90, now = Date.now(), request, log = console, sleep }) {
  async function read(endpoint, body) {
    const { ok, data } = await ashbyRead({ key: apiKey, endpoint, body, ...(request ? { request } : {}), ...(sleep ? { sleep } : {}), log });
    if (!ok || data?.success !== true) throw Object.assign(new Error(`Ashby refused ${endpoint}${data?.errors ? ` (${String(data.errors).slice(0, 120)})` : ""}.`), { status: 503 });
    return data;
  }
  async function all(endpoint, body) {
    const out = [], seen = new Set();
    let cursor;
    do {
      const d = await read(endpoint, { ...body, limit: 100, ...(cursor ? { cursor } : {}) });
      out.push(...(d.results || []));
      cursor = d.moreDataAvailable ? d.nextCursor : null;
      if (cursor && seen.has(cursor)) throw new Error(`Ashby's ${endpoint} paging repeated itself.`);
      if (cursor) seen.add(cursor);
    } while (cursor);
    return out;
  }
  const jobs = await all("job.list", { status: ["Open"] });
  const plans = {};
  for (const j of jobs) plans[j.id] = (await read("jobInterviewPlan.info", { jobId: j.id })).results;
  const interviews = await all("interview.list", { includeArchived: true });
  const users = await all("user.list", { includeDeactivated: true });
  const schedules = await all("interviewSchedule.list", { createdAfter: now - lookbackDays * DAY });
  return { jobs, plans, interviews, users, schedules, lookbackDays, readAt: now,
    jobInfo: async id => { try { return (await read("job.info", { id })).results; } catch (_) { return null; } } };
}

// Titles by id, for the next audit to find renames.
function snapshotOf(data) {
  const jobs = {};
  for (const j of data.jobs) {
    const stages = {};
    for (const s of data.plans[j.id]?.stages || []) {
      const activities = {};
      for (const a of s.activities || []) activities[a.id] = { title: a.title, interviews: Object.fromEntries((a.interviews || []).map(i => [i.interviewId, i.title])) };
      stages[s.id] = { title: s.title, activities };
    }
    jobs[j.id] = { title: j.title, stages };
  }
  return { at: new Date(data.readAt).toISOString(), jobs };
}

async function audit({ data, rules = null, lists = null, previous = null }) {
  const blocking = [], drift = [], notices = [];
  const jobTitle = id => (data.jobs.find(j => j.id === id)?.title || "").trim();
  const where = (jobId, stage) => `${jobTitle(jobId) || jobId}${stage ? ` / ${String(stage).trim()}` : ""}`;
  const add = (list, kind, jobId, stage, text) => list.push({ kind, job: jobId ? where(jobId) : null, ...(stage ? { stage: String(stage).trim() } : {}), text });
  const open = new Set(data.jobs.map(j => j.id));
  const stagesOf = jobId => data.plans[jobId]?.stages || [];
  const sessionsOf = jobId => stagesOf(jobId).flatMap(s => (s.activities || []).flatMap(a => (a.interviews || []).filter(i => i.isSchedulable).map(i => ({ ...i, stage: s, activity: a }))));
  const debrief = new Set(data.interviews.filter(i => i.isDebrief).map(i => i.id));
  const live = data.schedules.filter(s => s.status !== "Cancelled");
  const usersByEmail = new Map(data.users.map(u => [String(u.email || "").toLowerCase(), u]));
  const enabledByName = new Map();
  for (const u of data.users.filter(u => u.isEnabled)) { const k = key(nameOf(u)); enabledByName.set(k, [...(enabledByName.get(k) || []), u]); }
  const configuredJobs = new Set([...Object.keys(lists?.compose?.jobs || {}), ...Object.keys(lists?.send?.jobs || {}), ...(rules?.entries.alternatives || []).map(a => a.jobId),
    ...(rules?.entries.preferredInterviewers || []).filter(p => p.jobId).map(p => p.jobId)]);

  // What past events show, per interview: people per event, who hosted
  // without giving feedback, and who took it at all.
  const perInterview = new Map();
  for (const s of live) for (const e of s.interviewEvents || []) {
    const st = perInterview.get(e.interviewId) || { sizes: {}, events: 0, hosts: new Map(), people: new Set() };
    const ppl = e.interviewers || [];
    st.events++; st.sizes[ppl.length] = (st.sizes[ppl.length] || 0) + 1;
    for (const p of ppl) {
      st.people.add(String(p.email || "").toLowerCase());
      if (p.isFeedbackRequired === false) st.hosts.set(nameOf(p) || "someone", (st.hosts.get(nameOf(p) || "someone") || 0) + 1);
    }
    perInterview.set(e.interviewId, st);
  }

  // ---- Drift: the worker's job lists against the plans.
  const listProblem = [];
  for (const [label, l] of [["BOOKING_COMPOSE_JOBS", lists?.compose], ["BOOKING_SEND_JOBS", lists?.send]]) {
    if (!l) continue;
    if (l.problem) { add(drift, "list_unreadable", null, null, `${label} can't be read (${l.problem}), so the worker opens nothing on it.`); listProblem.push(label); continue; }
    for (const [jobId, stages] of Object.entries(l.jobs)) {
      if (!open.has(jobId)) {
        const info = await data.jobInfo(jobId);
        add(drift, "list_job_not_open", null, null, `${label} names ${info ? `${show(info.title.trim())} (${jobId.slice(0, 8)}), which is ${String(info.status || "not open").toLowerCase()}` : `job ${jobId}, which Ashby doesn't have`}. Nothing is ${label === "BOOKING_SEND_JOBS" ? "sent" : "composed"} for it; remove it or reopen the job.`);
        continue;
      }
      if (stages === "all") continue;
      const titles = stagesOf(jobId).map(s => s.title);
      const scheduled = stagesOf(jobId).filter(s => (s.activities || []).length).map(s => s.title);
      for (const t of stages) if (!titles.some(title => jobAllows({ [jobId]: [t] }, jobId, title)))
        add(drift, "list_stage_missing", jobId, null, `${label} names stage ${show(t)}, which isn't in the plan, so nothing is ${label === "BOOKING_SEND_JOBS" ? "sent" : "composed"} for it.${nearest(t, titles) ? ` Closest: ${show(nearest(t, titles).trim())}.` : ""} Stages with interviews: ${scheduled.map(x => show(x.trim())).join(", ")}.`);
    }
  }
  if (lists?.send && lists?.compose && !listProblem.length) for (const [jobId, stages] of Object.entries(lists.send.jobs)) {
    const c = lists.compose.jobs[jobId];
    if (c === "all") continue;
    const beyond = !c ? ["the whole job"] : stages === "all" ? ["every stage"] : stages.filter(t => !jobAllows(lists.compose.jobs, jobId, t));
    if (beyond.length) add(drift, "send_beyond_compose", open.has(jobId) ? jobId : null, null, `BOOKING_SEND_JOBS opts in ${beyond.join(", ")} beyond BOOKING_COMPOSE_JOBS${open.has(jobId) ? "" : ` for job ${jobId}`}, so the worker opens neither list.`);
  }

  // ---- Drift: the rules file against the plans and people.
  if (rules) {
    const E = rules.entries;
    for (const a of E.alternatives) {
      if (!open.has(a.jobId)) { add(drift, "alternatives_job", null, null, `The ${a.label} alternatives name job ${a.jobId.slice(0, 8)}, which isn't open.`); continue; }
      const sessions = sessionsOf(a.jobId);
      const found = a.interviews.map(t => ({ t, hits: sessions.filter(s => rules.alternativeKey(s.title) === rules.alternativeKey(t)) }));
      for (const f of found.filter(f => !f.hits.length)) {
        const near = nearest(f.t, sessions.map(s => s.title));
        add(drift, "alternatives_missing", a.jobId, null, `The ${a.label} alternatives name ${show(f.t)}, which isn't an interview on this job any more, so the pair is never recognised.${near ? ` Closest: ${show(near.trim())}.` : ""}`);
      }
      const acts = new Set(found.flatMap(f => f.hits.map(h => h.activity.id)));
      if (found.every(f => f.hits.length) && acts.size > 1) add(drift, "alternatives_split", a.jobId, null, `The ${a.label} alternatives (${a.interviews.map(show).join(", ")}) are in different activities now, and only one activity is planned at a time.`);
    }
    const everySession = [...open].flatMap(id => sessionsOf(id).map(s => ({ ...s, jobId: id })));
    for (const p of E.preferredInterviewers) {
      const scope = p.jobId ? (open.has(p.jobId) ? everySession.filter(s => s.jobId === p.jobId) : null) : everySession;
      const label = `The preferred interviewers for ${p.match === "exact" ? show(p.value) : `sessions containing ${show(p.value)}`}${p.jobId ? ` on ${open.has(p.jobId) ? show(jobTitle(p.jobId)) : `job ${p.jobId.slice(0, 8)}`}` : ""}`;
      if (!scope) { add(drift, "preferred_job", null, null, `${label} name a job that isn't open.`); continue; }
      const hits = scope.filter(s => rules.sessionMatches(p, s.title));
      if (!hits.length) { add(drift, "preferred_session", p.jobId || null, null, `${label} match no interview any more, so nobody is preferred.${nearest(p.value, scope.map(s => s.title)) ? ` Closest: ${show(nearest(p.value, scope.map(s => s.title)).trim())}.` : ""}`); continue; }
      for (const email of [...p.emails, ...p.lastResort]) {
        const u = usersByEmail.get(email);
        if (!u || !u.isEnabled) { add(drift, "preferred_person", p.jobId || null, null, `${label} include ${u ? nameOf(u) : email}, who ${u ? "is deactivated in Ashby" : "has no Ashby account"}.`); continue; }
        const seen = hits.some(h => perInterview.get(h.interviewId)?.people.has(email));
        const held = hits.some(h => perInterview.get(h.interviewId)?.events);
        if (!seen && held) add(notices, "preferred_unseen", p.jobId || null, null, `${label} include ${nameOf(u)}, who hasn't taken one in ${data.lookbackDays} days. Whether they're still eligible is on the template page, which this doesn't read: check it.`);
      }
    }
    for (const [what, list] of [["start window", E.placementWindows], ["not-counted rule (interviewer load)", E.notCounted]])
      for (const w of list) if (!everySession.some(s => rules.sessionMatches(w, s.title)))
        add(drift, "session_rule_unmatched", null, null, `The ${what} for ${w.match === "exact" ? show(w.value) : `sessions containing ${show(w.value)}`} matches no interview on any open job.`);
    for (const [what, emails] of [["meeting-hours override", E.hourOverrides], ["attendance override", E.attendanceOverrides]])
      for (const email of emails) { const u = usersByEmail.get(email); if (!u || !u.isEnabled) add(drift, "override_person", null, null, `The ${what} for ${u ? nameOf(u) : email} is for someone who ${u ? "is deactivated in Ashby" : "has no Ashby account"}.`); }
    for (const id of E.identities) {
      const u = usersByEmail.get(id.email), same = enabledByName.get(key(id.name)) || [];
      if (!u || !u.isEnabled) add(drift, "identity_person", null, null, `The account override for ${id.name} points at ${id.email}, which ${u ? "is deactivated" : "isn't an account"} in Ashby, so their interviews can't be resolved.`);
      else if (same.length < 2) add(notices, "identity_unneeded", null, null, `${id.name} now has ${same.length === 1 ? "one active account" : "no active account under that name"}, so the account override may no longer be needed.`);
    }
  }

  // ---- Drift: renames and removals since the last audit, from its snapshot.
  if (previous?.jobs) for (const [jobId, was] of Object.entries(previous.jobs)) {
    if (!open.has(jobId)) continue;
    const target = configuredJobs.has(jobId) ? drift : notices;
    const now = Object.fromEntries(stagesOf(jobId).map(s => [s.id, s]));
    for (const [stageId, ws] of Object.entries(was.stages || {})) {
      const st = now[stageId];
      if (!st) { add(target, "stage_removed", jobId, null, `Stage ${show(ws.title.trim())} was removed from the plan since ${previous.at.slice(0, 10)}.`); continue; }
      if (st.title !== ws.title) add(target, "stage_renamed", jobId, null, `Stage ${show(ws.title.trim())} was renamed ${show(st.title.trim())} since ${previous.at.slice(0, 10)}.`);
      const acts = Object.fromEntries((st.activities || []).map(a => [a.id, a]));
      for (const [actId, wa] of Object.entries(ws.activities || {})) {
        const a = acts[actId];
        if (a && a.title !== wa.title) add(target, "activity_renamed", jobId, st.title, `Activity ${show(wa.title)} was renamed ${show(a.title)}.`);
        if (!a) continue;
        const ints = Object.fromEntries((a.interviews || []).map(i => [i.interviewId, i.title]));
        for (const [iid, t] of Object.entries(wa.interviews || {})) if (ints[iid] !== undefined && ints[iid] !== t) add(target, "interview_renamed", jobId, st.title, `Interview ${show(t)} was renamed ${show(ints[iid])}.`);
      }
    }
  }

  // ---- Per open job and stage: onboarding blockers and things worth knowing.
  // An interview shared by several jobs is reported once, under the first.
  const observedOnce = new Set();
  for (const j of data.jobs) {
    for (const st of stagesOf(j.id)) {
      const acts = st.activities || [];
      const byName = new Map();
      for (const a of acts) byName.set(key(a.title), [...(byName.get(key(a.title)) || []), a]);
      for (const [, same] of byName) if (same.length > 1)
        add(blocking, "duplicate_activity", j.id, st.title, `${same.length} activities are named ${show(same[0].title.trim())}. The worker finds the card by its name, so a schedule here can't be composed until one is renamed.`);
      for (const a of acts) {
        const sessions = (a.interviews || []).filter(i => i.isSchedulable && !debrief.has(i.interviewId));
        for (const i of sessions) {
          const ob = perInterview.get(i.interviewId);
          if (!ob || observedOnce.has(i.interviewId)) continue;
          observedOnce.add(i.interviewId);
          const sizes = Object.entries(ob.sizes).map(([n, c]) => [Number(n), c]);
          const max = Math.max(...sizes.map(([n]) => n)), usual = sizes.sort((x, y) => y[1] - x[1] || y[0] - x[0])[0][0];
          if (usual > MAX_PANEL && ob.events < 3) add(notices, "panel_large_thin", j.id, st.title, `${show(i.title.trim())} had ${usual} people on ${ob.events === 1 ? "its only event" : `each of its ${ob.events} events`} in ${data.lookbackDays} days: too few to tell a larger panel from shadows. Check the template's slots.`);
          else if (usual > MAX_PANEL) add(blocking, "panel_large", j.id, st.title, `${show(i.title.trim())} usually has ${usual} people per event (observed over ${ob.events} event${ob.events === 1 ? "" : "s"} in ${data.lookbackDays} days; slots themselves aren't readable from the API). Panels above ${MAX_PANEL} can't be proposed, so it would need booking by hand.`);
          else if (max > MAX_PANEL) add(notices, "panel_sometimes_large", j.id, st.title, `${show(i.title.trim())} had up to ${max} people on an event, usually ${usual}. Extra people are often shadows; check the template if it's really a larger panel.`);
          else if (usual === 2) add(notices, "panel_two", j.id, st.title, `${show(i.title.trim())} usually has 2 people per event: a two-person panel (supported where SCHEDULING_PANELS allows it).`);
          // Hosts: people on at least half its events without giving feedback.
          const hosts = [...ob.hosts].filter(([, c]) => c * 2 >= ob.events);
          if (hosts.length) add(notices, "hosts", j.id, st.title, `${show(i.title.trim())}: ${hosts.map(([n, c]) => `${n} (${c} of ${ob.events} events)`).join(", ")} attended without giving feedback: hosting.`);
        }
        // Likely alternatives: two interviews in one activity that past schedules
        // in this stage held one or the other of, never both.
        // Per candidate, not per schedule: an onsite split over two days is two schedules.
        const perApp = new Map();
        for (const s of live.filter(s => s.interviewStageId === st.id)) { const set = perApp.get(s.applicationId) || new Set(); for (const e of s.interviewEvents || []) set.add(e.interviewId); perApp.set(s.applicationId, set); }
        const inStage = [...perApp.values()];
        for (let x = 0; x < sessions.length; x++) for (let y = x + 1; y < sessions.length; y++) {
          const A = sessions[x], B = sessions[y];
          const onlyA = inStage.filter(s => s.has(A.interviewId) && !s.has(B.interviewId)).length, onlyB = inStage.filter(s => s.has(B.interviewId) && !s.has(A.interviewId)).length, both = inStage.filter(s => s.has(A.interviewId) && s.has(B.interviewId)).length;
          const covers = s => alt => alt.jobId === j.id && alt.interviews.some(t => rules.alternativeKey(t) === rules.alternativeKey(s.title));
          const declared = !!rules && rules.entries.alternatives.some(alt => covers(A)(alt) && covers(B)(alt));
          // A pair a declared rule half-matches is already drift (a name gone stale): not suggested again.
          const touched = !!rules && rules.entries.alternatives.some(alt => covers(A)(alt) || covers(B)(alt));
          if (!touched && onlyA && onlyB && !both) add(notices, "likely_alternatives", j.id, st.title, `${show(A.title.trim())} and ${show(B.title.trim())} look like alternatives: candidates here had one (${onlyA}) or the other (${onlyB}), never both. Planned together, both get booked.`);
          if (declared && both) add(notices, "alternatives_both_seen", j.id, st.title, `${show(A.title.trim())} and ${show(B.title.trim())} are declared alternatives, but ${both} candidate${both === 1 ? "" : "s"} here had both.`);
        }
      }
      if (acts.length && CHURNY.test(st.title)) add(notices, "stage_name_churn", j.id, null, `Stage ${show(st.title.trim())} has the kind of name that gets changed (${CHURNY.exec(st.title)[0]}); if it's on a job list, expect to update it.`);
    }
  }

  // ---- Names: stray whitespace, and the same name spelled two ways.
  const odd = t => t !== t.trim() || /\t|\s{2,}/.test(t);
  const reported = new Set();
  const named = [];
  for (const j of data.jobs) {
    if (odd(j.title)) named.push({ jobId: j.id, what: "Job title", t: j.title });
    for (const st of stagesOf(j.id)) {
      if (odd(st.title)) named.push({ jobId: j.id, what: "Stage", t: st.title });
      for (const a of st.activities || []) {
        if (odd(a.title)) named.push({ jobId: j.id, what: `Activity in ${st.title.trim()}`, t: a.title });
        for (const i of a.interviews || []) if (odd(i.title) && !reported.has(i.interviewId)) { reported.add(i.interviewId); named.push({ jobId: j.id, what: "Interview", t: i.title }); }
      }
    }
  }
  const byJob = new Map();
  for (const n of named) byJob.set(n.jobId, [...(byJob.get(n.jobId) || []), n]);
  for (const [jobId, ns] of byJob) add(notices, "whitespace", jobId, null, `Stray spaces or tabs in ${ns.map(n => `${n.what.toLowerCase()} ${show(n.t)}`).join(", ")}. Matching ignores them, but anyone typing the names won't.`);
  const titles = new Map();
  for (const j of data.jobs) for (const s of sessionsOf(j.id)) { const k = key(s.title); if (!titles.has(k)) titles.set(k, { title: s.title.trim(), jobs: new Set() }); titles.get(k).jobs.add(j.id); }
  const stageTitles = new Map();
  for (const j of data.jobs) for (const st of stagesOf(j.id)) { const k = key(st.title); if (!stageTitles.has(k)) stageTitles.set(k, { title: st.title.trim(), jobs: new Set() }); stageTitles.get(k).jobs.add(j.id); }
  for (const [what, map] of [["Interviews", titles], ["Stages", stageTitles]]) {
    const list = [...map.values()];
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) if (nearDuplicate(list[x].title, list[y].title)) {
      const jobs = [...new Set([...list[x].jobs, ...list[y].jobs])].map(id => jobTitle(id));
      add(notices, "near_duplicate", null, null, `${what} ${show(list[x].title)} and ${show(list[y].title)} look like one name spelled two ways (${jobs.slice(0, 3).join("; ")}${jobs.length > 3 ? "; …" : ""}). A rule written for one won't match the other.`);
    }
  }

  // ---- Open jobs the lists don't cover (only when lists were given).
  if (lists?.compose?.jobs) for (const j of data.jobs) if (!lists.compose.jobs[j.id] && !String(j.title).trim().match(/^test( pipeline)?$/i))
    add(notices, "not_listed", j.id, null, "Open, but not on BOOKING_COMPOSE_JOBS: the bot doesn't compose for it.");

  // Two-person panels and hosts, one line per job: every job has its own
  // Welcome, and a line each buries the rest.
  const grouped = [];
  for (const [kind, lead] of [["panel_two", "Usually two people per event (a two-person panel, supported where SCHEDULING_PANELS allows it)"], ["hosts", "On at least half the events without giving feedback (hosting)"]]) {
    const byJob = new Map();
    for (const n of notices.filter(n => n.kind === kind)) byJob.set(n.job, [...(byJob.get(n.job) || []), n]);
    for (const [job, ns] of byJob) grouped.push({ kind, job, text: `${lead}: ${ns.map(n => kind === "hosts" ? n.text.replace(/ attended without giving feedback: hosting\.$/, "") : n.text.match(/^("[^"]*")/)[1]).join("; ")}.` });
  }
  const rest = notices.filter(n => n.kind !== "panel_two" && n.kind !== "hosts");
  return { blocking, drift, notices: [...rest, ...grouped], configured: !!(rules || lists), snapshot: snapshotOf(data), counts: { jobs: data.jobs.length, schedules: live.length, lookbackDays: data.lookbackDays } };
}

const ITEM = f => `• ${f.job ? `${f.job}${f.stage ? ` / ${f.stage}` : ""}: ` : ""}${f.text}`;
// The full report, for a person reading the script's output.
function renderReport(r, { title = "Scheduling audit" } = {}) {
  const out = [`${title}: ${r.counts.jobs} open jobs, ${r.counts.schedules} schedules from the last ${r.counts.lookbackDays} days.`];
  out.push("", `DRIFTED SINCE CONFIGURED (${r.drift.length})`);
  out.push(...(r.configured ? (r.drift.length ? r.drift.map(ITEM) : ["• none"]) : ["• Nothing configured was given (no rules file, no job lists), so there's nothing to compare."]));
  out.push("", `BLOCKING FOR ONBOARDING (${r.blocking.length})`, ...(r.blocking.length ? r.blocking.map(ITEM) : ["• none"]));
  out.push("", `WORTH KNOWING (${r.notices.length})`, ...(r.notices.length ? r.notices.map(ITEM) : ["• none"]));
  return out.join("\n");
}
// What the weekly channel post says: drift only, and only when there is some.
// `seen` holds last week's drift lines, so a repeat is marked as still open.
function renderDrift(r, { seen = new Set() } = {}) {
  if (!r.drift.length) return null;
  const lines = r.drift.map(f => { const l = ITEM(f); return seen.has(l) ? `${l} (still, from last week)` : l; });
  return [`Weekly scheduling audit: ${r.drift.length} thing${r.drift.length === 1 ? "" : "s"} the bot is configured for no longer match${r.drift.length === 1 ? "es" : ""} Ashby. Until fixed, these stop or mis-plan schedules without saying so.`, ...lines].join("\n");
}

module.exports = { readAshby, audit, renderReport, renderDrift, snapshotOf, nearDuplicate, distance, ITEM };
