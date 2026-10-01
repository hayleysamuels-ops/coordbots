"use strict";

// Interviewer training tracker UI. Loaded only where TRAINING_TRACKER_CLIENT_ID
// is set — everywhere else this file 404s and its markup is stripped from
// index.html (see src/scheduling/page-gate.js), so the original Ashby-native
// Interviewer Training section renders instead.
//
// Defines window.renderTrainingTracker, which app.js calls in place of its own
// renderInterviewerTraining — the same optional-global handoff
// renderReadyScheduling already uses. app.js still owns the poll loop; this
// file only renders and mutates.
(() => {
  const section = document.getElementById("training-attention");
  if (!section) return;

  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Latest payload, so an action can re-render immediately from the snapshot
  // the mutation returned rather than waiting for the next poll.
  let latest = null;
  // Which inline panel is open, and which cards are expanded. Kept outside the
  // payload so a poll mid-interaction never collapses what someone opened.
  let openPanel = null; // "enrol" | "paths" | null
  const expanded = new Set();
  let users = null;

  // ---------------------------------------------------------------- helpers

  function dayLabel(days) {
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 14) return `${days}d ago`;
    if (days < 60) return `${Math.round(days / 7)}w ago`;
    return `${Math.round(days / 30)}mo ago`;
  }

  function dateLabel(iso) {
    if (!iso) return "";
    // A bare YYYY-MM-DD (the expected-return date comes straight off a
    // <input type="date">) is parsed by the Date constructor as UTC midnight,
    // which then renders as the PREVIOUS day for any viewer behind UTC.
    // Confirmed live: a return date of 2026-11-15 displayed as "Nov 14, 2026".
    // Splitting it into local Y/M/D keeps a calendar date a calendar date.
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    const d = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) : new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  // Recency shading. The question this answers is "is this interviewer being
  // used?", so it is driven by time since the last session that HAPPENED,
  // counted or not. Five steps rather than a true gradient: a continuous
  // colour ramp reads as decorative, whereas discrete steps are comparable
  // across cards at a glance.
  function recencyClass(entry) {
    if (entry.state === "complete") return "recency-done";
    if (entry.state === "archived") return "recency-done";
    const d = entry.daysSinceActivity;
    if (d <= 7) return "recency-fresh";
    if (d <= 14) return "recency-warm";
    if (d <= 30) return "recency-cool";
    return "recency-cold";
  }

  function progressBar(entry) {
    const cells = [];
    for (let i = 0; i < entry.requirements.shadows; i++) {
      cells.push(`<span class="pip ${i < entry.shadows ? "pip-done" : ""}" title="Shadow"></span>`);
    }
    cells.push('<span class="pip-gap"></span>');
    for (let i = 0; i < entry.requirements.reverseShadows; i++) {
      cells.push(`<span class="pip pip-reverse ${i < entry.reverseShadows ? "pip-done" : ""}" title="Reverse shadow"></span>`);
    }
    return `<span class="pips">${cells.join("")}</span>`;
  }

  function badges(entry) {
    const out = [];
    if (entry.needsConfirmation) {
      out.push(
        `<span class="training-badge badge-warn">${entry.needsConfirmation} to confirm</span>` +
          // The badge alone told you a decision existed but not where it lived;
          // the detail panel is the only place it can be made.
          `<button type="button" class="training-link training-toggle-confirm">confirm now</button>`
      );
    }
    if (entry.pendingDuringPause) {
      out.push(`<span class="training-badge badge-warn">${entry.pendingDuringPause} while paused</span>`);
    }
    if (entry.hasRequirementOverride) {
      out.push(
        `<span class="training-badge badge-quiet">custom ${entry.requirements.shadows}+${entry.requirements.reverseShadows}</span>`
      );
    }
    if ((entry.disagreements || []).length) {
      out.push(`<span class="training-badge badge-info" title="${esc(entry.disagreements.join(" "))}">Ashby disagrees</span>`);
    }
    return out.join("");
  }

  // A session the rules can't settle gets its own prompt with named buttons,
  // instead of the ordinary row's controls.
  //
  // The ordinary row offers a role dropdown whose first option reads
  // "auto (Shadow)" — meaning the sequence rule picked Shadow. Confirming
  // therefore meant changing that to "Shadow", which looks like choosing the
  // value it already shows, i.e. like doing nothing. The old hint even said
  // "confirm or discount" while offering no control called either. So an
  // unconfirmed session now asks a plain question and answers it with
  // buttons that say what they do.
  function unconfirmedSessionRow(entry, s) {
    return `
      <li class="training-session is-unconfirmed">
        <span class="training-session-when">${esc(dateLabel(s.at))}</span>
        <span class="training-confirm-q">Only interviewer — was this training?</span>
        <span class="training-confirm-actions">
          <button type="button" class="training-btn training-btn-quiet training-confirm" data-event="${esc(s.eventId)}" data-role="Shadow">Shadow</button>
          <button type="button" class="training-btn training-btn-quiet training-confirm" data-event="${esc(s.eventId)}" data-role="ReverseShadow">Reverse shadow</button>
          <button type="button" class="training-link training-not-training" data-event="${esc(s.eventId)}">No — they ran it</button>
        </span>
      </li>`;
  }

  function sessionRow(entry, s) {
    if (s.needsConfirmation) return unconfirmedSessionRow(entry, s);

    const when = dateLabel(s.at);
    const who = (s.coInterviewers || []).map((c) => c.name).join(", ");
    const reason = s.discounted
      ? "not counted"
      : s.duringPause
      ? "happened while paused — not counted"
      : "";
    const roleSelect =
      s.kind === "manual"
        ? `<span class="muted">manual credit</span>`
        : `<select class="training-role" data-event="${esc(s.eventId)}">
             <option value=""${!s.overrideRole ? " selected" : ""}>auto (${esc(s.role)})</option>
             <option value="Shadow"${s.overrideRole === "Shadow" ? " selected" : ""}>Shadow</option>
             <option value="ReverseShadow"${s.overrideRole === "ReverseShadow" ? " selected" : ""}>Reverse shadow</option>
           </select>`;
    const action =
      s.kind === "manual"
        ? `<button type="button" class="training-link training-credit-delete" data-credit="${esc(s.creditId)}">remove</button>`
        : `<label class="training-check"><input type="checkbox" class="training-discount" data-event="${esc(s.eventId)}"${
            s.discounted ? " checked" : ""
          } /> didn't attend</label>`;
    return `
      <li class="training-session ${s.counts ? "" : "is-uncounted"}">
        <span class="training-session-when">${esc(when)}</span>
        ${roleSelect}
        <span class="training-session-who muted">${esc(who || (s.kind === "manual" ? s.note : ""))}</span>
        ${reason ? `<span class="training-session-why">${esc(reason)}</span>` : ""}
        ${action}
      </li>`;
  }

  // One card per INTERVIEWER, with a row per path they're training on.
  //
  // Counts are never combined across paths: a shadow on the System Design
  // interview says nothing about readiness for the Bug Bash one, so each row
  // keeps its own requirement, its own progress and its own last-used date.
  // Consolidating the CARD (not the counts) is what stops someone training on
  // three interviews from occupying three separate places on the page.
  function personCard(rows) {
    const first = rows[0];
    // The card's recency shading reflects the person's most recent interview
    // on ANY path - the card-level question is "is this interviewer being
    // used at all", while each row answers it per path.
    const freshest = rows.reduce((a, b) => (a.daysSinceActivity <= b.daysSinceActivity ? a : b));
    return `
      <article class="training-card ${recencyClass(freshest)}" data-person="${esc(first.userId)}">
        <div class="training-card-head">
          <span class="training-name">${esc(first.userName || first.userEmail || "Unknown interviewer")}</span>
          ${rows.length > 1 ? `<span class="training-path-count muted">${rows.length} paths</span>` : ""}
        </div>
        ${rows.map(pathRow).join("")}
      </article>`;
  }

  // A state chip appears on a row only when that path is NOT plainly in
  // progress. Without it, a person grouped under Paused because one path is
  // paused would give no clue which of their paths it was.
  function stateChip(entry) {
    if (entry.state === "paused") return `<span class="training-badge badge-warn">Paused</span>`;
    if (entry.state === "complete") return `<span class="training-badge badge-done">Complete</span>`;
    if (entry.state === "archived") return `<span class="training-badge badge-quiet">Archived</span>`;
    if (entry.stalled) return `<span class="training-badge badge-info">Stalled</span>`;
    return "";
  }

  function pathRow(entry) {
    const isOpen = expanded.has(entry.key);
    const pause = entry.pause || {};
    return `
      <div class="training-path-row ${isOpen ? "is-open" : ""}" data-key="${esc(entry.key)}" data-user="${esc(entry.userId)}" data-path="${esc(entry.pathId)}">
        <div class="training-row-top">
          <span class="training-path">${esc(entry.pathLabel)}</span>
          <div class="training-card-progress">
            ${progressBar(entry)}
            <span class="training-counts">${entry.shadows}/${entry.requirements.shadows} shadow · ${entry.reverseShadows}/${entry.requirements.reverseShadows} reverse</span>
          </div>
        </div>
        <div class="training-card-meta">
          <span class="training-last">Last interview ${esc(dayLabel(entry.daysSinceActivity))}</span>
          ${stateChip(entry)}
          ${badges(entry)}
          <button type="button" class="training-link training-toggle">${isOpen ? "hide detail" : "detail"}</button>
        </div>
        ${
          entry.state === "paused"
            ? `<div class="training-pause-note">Paused ${esc(dateLabel(pause.at))}${
                pause.reason ? ` — ${esc(pause.reason)}` : ""
              }${pause.expectedReturn ? ` · back ${esc(dateLabel(pause.expectedReturn))}` : ""}</div>`
            : ""
        }
        ${
          (entry.disagreements || []).length
            ? `<div class="training-disagree">${entry.disagreements.map((d) => esc(d)).join(" ")}</div>`
            : ""
        }
        ${isOpen ? detail(entry) : ""}
      </div>`;
  }

  function detail(entry) {
    return `
      <div class="training-detail">
        <ul class="training-sessions">
          ${
            entry.sessions.length
              ? entry.sessions.map((s) => sessionRow(entry, s)).join("")
              : `<li class="muted">No interviews on this path since they were added on ${esc(dateLabel(entry.enrolledAt))}.</li>`
          }
        </ul>
        <div class="training-detail-actions">
          <div class="training-field">
            <label>Requirement</label>
            <input type="number" min="0" max="20" class="training-req-shadows" value="${entry.requirements.shadows}" />
            <span class="muted">shadow</span>
            <input type="number" min="0" max="20" class="training-req-reverse" value="${entry.requirements.reverseShadows}" />
            <span class="muted">reverse</span>
            <button type="button" class="training-btn training-btn-quiet training-save-req">Save</button>
          </div>
          <div class="training-field">
            <label>Credit an earlier session</label>
            <select class="training-credit-role">
              <option value="Shadow">Shadow</option>
              <option value="ReverseShadow">Reverse shadow</option>
            </select>
            <input type="date" class="training-credit-date" />
            <button type="button" class="training-btn training-btn-quiet training-add-credit">Add</button>
          </div>
          <div class="training-field training-field-end">
            ${
              entry.state === "paused"
                ? `<button type="button" class="training-btn training-unpause">Resume</button>`
                : `<button type="button" class="training-btn training-btn-quiet training-pause">Pause</button>`
            }
            ${
              entry.state === "archived"
                ? `<button type="button" class="training-btn training-unarchive">Restore</button>`
                : `<button type="button" class="training-btn training-btn-quiet training-archive">Archive</button>`
            }
          </div>
        </div>
      </div>`;
  }

  // `people` is an array of row-arrays, one per interviewer. The count in the
  // heading is therefore people, not enrolments - someone on three paths is
  // one person needing attention, not three.
  function group(el, title, note, people) {
    if (!people.length) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = `
      <h3 class="training-group-title">${esc(title)} <span class="training-group-count">${people.length}</span></h3>
      ${note ? `<p class="training-group-note muted">${esc(note)}</p>` : ""}
      <div class="training-cards">${people.map(personCard).join("")}</div>`;
  }

  // ----------------------------------------------------------------- panels

  function enrolPanel(data) {
    const paths = data.trainingPaths || [];
    const loaded = Boolean(((data.sectionStatus || {}).interviewerTraining || {}).lastUpdated);
    if (!paths.length) {
      return `<div class="training-panel"><p>${
        loaded
          ? "Add a path first — an interviewer is always training on one specific interview for one specific role."
          : "Still loading training data — give it a moment before adding anyone."
      }</p></div>`;
    }
    // A datalist, not a select: this org has 788 enabled Ashby users and a
    // dropdown that long is unusable. Typing filters natively, and the
    // hidden id lookup happens on submit by matching the chosen label.
    const userOptions = (users || [])
      .map((u) => `<option value="${esc(u.name)}${u.email ? ` (${esc(u.email)})` : ""}"></option>`)
      .join("");
    return `
      <div class="training-panel">
        <h3>Add an interviewer</h3>
        <p class="muted">
          Counting starts today. Anything they've already done is added as a
          credit on their card, so adding someone can never complete them off
          the back of history.
        </p>
        <div class="training-field">
          <input id="training-enrol-user" list="training-user-list" placeholder="${
            users ? `Search ${users.length} interviewers…` : "Loading interviewers…"
          }" autocomplete="off" />
          <datalist id="training-user-list">${userOptions}</datalist>
          <select id="training-enrol-path">
            ${paths.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join("")}
          </select>
          <button type="button" class="training-btn" id="training-enrol-save">Add</button>
        </div>
        <p class="training-enrol-error" id="training-enrol-error"></p>
      </div>`;
  }

  function pathsPanel(data) {
    const paths = data.trainingPaths || [];
    // Every option, not an arbitrary top slice - at Forus there are ~400
    // (interview, role) pairs and the one someone wants may well not be in
    // the busiest handful. Ordered so interviews that actually involve more
    // than one interviewer come first, since those are the only ones where
    // shadowing happens at all.
    const options = (data.trainingPathOptions || []).filter((o) => !o.alreadyConfigured);
    const suggestions = data.trainingSuggestions || [];
    return `
      <div class="training-panel">
        <h3>Training paths</h3>
        <p class="muted">
          A path is one Ashby interview for one role. Both halves matter: at
          this org the same interview title is used across different roles,
          and the same role is split across duplicate interview records.
        </p>
        ${
          paths.length
            ? `<ul class="training-path-list">${paths
                .map(
                  (p) => `<li>
                    <span>${esc(p.label)}</span>
                    <span class="muted">${p.requiredShadows}+${p.requiredReverseShadows} · ${p.interviewIds.length} Ashby interview${
                    p.interviewIds.length === 1 ? "" : "s"
                  }</span>
                    <button type="button" class="training-link training-path-delete" data-path="${esc(p.id)}">remove</button>
                  </li>`
                )
                .join("")}</ul>`
            : `<p class="muted">No paths yet.</p>`
        }
        ${
          suggestions.length
            ? `<div class="training-suggestions">
                 <h4>New matching interviews in Ashby</h4>
                 <p class="muted">Same title and role as a path you already track, but a different Ashby record. Add it and its interviews start counting.</p>
                 <ul>${suggestions
                   .map(
                     (s) => `<li>
                        <span>${esc(s.pathLabel)} — ${s.eventCount} recent interview${s.eventCount === 1 ? "" : "s"}</span>
                        <button type="button" class="training-link training-suggestion-add" data-path="${esc(s.pathId)}" data-interview="${esc(s.interviewId)}">add</button>
                      </li>`
                   )
                   .join("")}</ul>
               </div>`
            : ""
        }
        <h4>Add a path</h4>
        <div class="training-field">
          <input type="search" id="training-path-filter" placeholder="Filter interviews…" autocomplete="off" />
        </div>
        <div class="training-field">
          <select id="training-path-option" size="8">
            ${
              options.length
                ? options
                    .map(
                      (o, i) =>
                        `<option value="${i}">${esc(o.label)} — ${o.shadowedEventCount} multi-interviewer of ${o.eventCount} recent</option>`
                    )
                    .join("")
                : "<option value=''>No interviews scheduled recently</option>"
            }
          </select>
          <input type="number" min="0" max="20" id="training-path-shadows" value="2" title="Shadows required" />
          <input type="number" min="0" max="20" id="training-path-reverse" value="2" title="Reverse shadows required" />
          <button type="button" class="training-btn" id="training-path-save">Add path</button>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------------- api

  async function post(path, body) {
    const res = await fetch(`/api/training/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      window.alert(err.error || `Request failed (${res.status})`);
      return null;
    }
    return res.json();
  }

  // A mutation returns the freshly recomputed snapshot, so the page updates on
  // the same request instead of waiting for the next poll.
  async function act(path, body) {
    const snapshot = await post(path, body);
    if (snapshot) render(snapshot, false);
  }

  async function loadUsers() {
    if (users) return;
    try {
      const res = await fetch("/api/training/users");
      users = res.ok ? await res.json() : [];
    } catch (err) {
      users = [];
    }
    if (openPanel === "enrol" && latest) render(latest, false);
  }

  // ---------------------------------------------------------------- render

  // Groups a person's rows into one bucket. A person can be paused on one
  // path, actively training on another and finished with a third, so the card
  // goes wherever its MOST attention-needing path belongs, and every row
  // inside carries its own state chip so nothing is hidden by the choice.
  //
  // Order: a decision you have to make outranks a deliberate pause, which
  // outranks accidental neglect, which outranks routine progress. "Complete"
  // is last because a person only lands there when every path is finished -
  // one finished path among several in flight isn't a finished interviewer.
  function bucketFor(rows) {
    const needsDecision = (e) => e.needsConfirmation || e.pendingDuringPause || (e.disagreements || []).length;
    if (rows.some((e) => e.state === "active" && needsDecision(e))) return "attention";
    if (rows.some((e) => e.state === "paused")) return "paused";
    if (rows.some((e) => e.state === "active" && e.stalled)) return "stalled";
    if (rows.some((e) => e.state === "active")) return "active";
    if (rows.length && rows.every((e) => e.state === "complete")) return "complete";
    return null;
  }

  // userId -> rows, preserving the server's ordering (name, then path).
  function byPerson(entries) {
    const people = new Map();
    for (const e of entries) {
      if (!people.has(e.userId)) people.set(e.userId, []);
      people.get(e.userId).push(e);
    }
    return people;
  }

  function render(data, hasError) {
    latest = data;
    const entries = data.interviewerTraining || [];
    const panelHost = document.getElementById("training-attention");

    // Archived paths live on the History tab only, so they never drag a
    // working card into a bucket or add a dead row to it.
    const live = entries.filter((e) => e.state !== "archived");
    const buckets = { attention: [], paused: [], stalled: [], active: [], complete: [] };
    for (const rows of byPerson(live).values()) {
      const bucket = bucketFor(rows);
      if (bucket) buckets[bucket].push(rows);
    }

    const panelHtml = openPanel === "enrol" ? enrolPanel(data) : openPanel === "paths" ? pathsPanel(data) : "";

    group(panelHost, "Needs a decision", "Ashby can't resolve these on its own.", buckets.attention);
    panelHost.insertAdjacentHTML("afterbegin", panelHtml);

    group(
      document.getElementById("training-paused"),
      "Paused",
      "Progress is held on the paused path. Interviews that happen anyway are recorded but not counted.",
      buckets.paused
    );
    group(
      document.getElementById("training-stalled"),
      "Stalled",
      `Active, but no interview for ${(data.appConfig || {}).trainingStalledAfterDays || 30} days or more.`,
      buckets.stalled
    );
    group(document.getElementById("training-active"), "In training", "", buckets.active);
    group(
      document.getElementById("training-complete"),
      "Complete — not yet in the Ashby pool",
      "This tracker never writes to Ashby, so adding them to the interviewer pool is still a manual step.",
      buckets.complete
    );

    const empty = document.getElementById("training-empty");
    if (!entries.length) {
      // Before the first refresh cycle finishes, the snapshot's training keys
      // are empty even when the store is full - progress is computed inside
      // listIssues(), which takes tens of seconds against a large org. Saying
      // "no paths configured" then is actively misleading: someone would
      // reasonably go and create paths that already exist. Distinguish "not
      // loaded yet" from "genuinely empty" using this section's own
      // lastUpdated, the same timestamp the section header renders from.
      const status = (data.sectionStatus || {}).interviewerTraining || {};
      empty.innerHTML = hasError
        ? `<p class="muted">Couldn't load training data on the last refresh.</p>`
        : !status.lastUpdated
        ? `<p class="muted">Loading training data…</p>`
        : (data.trainingPaths || []).length
        ? `<p class="muted">No interviewers are training yet. Use "Add interviewer" to start one.</p>`
        : `<p class="muted">No training paths configured yet. Open "Paths" to add the first one.</p>`;
    } else {
      empty.innerHTML = "";
    }

    renderHistory(entries);
  }

  function renderHistory(entries) {
    const host = document.getElementById("training-history");
    if (!host) return;
    // Only the finished and archived ROWS, not every row belonging to a person
    // who happens to have one - someone complete on one path and still
    // training on another belongs here for the first path only.
    const done = entries.filter((e) => e.state === "complete" || e.state === "archived");
    if (!done.length) {
      host.innerHTML = `<p class="muted">Nobody has completed or been archived off a path yet.</p>`;
      return;
    }
    const section = (title, rows) => {
      const people = [...byPerson(rows).values()];
      return people.length
        ? `<h3 class="training-group-title">${esc(title)} <span class="training-group-count">${people.length}</span></h3>
           <div class="training-cards">${people.map(personCard).join("")}</div>`
        : "";
    };
    host.innerHTML =
      section("Completed", done.filter((e) => e.state === "complete")) +
      section("Archived", done.filter((e) => e.state === "archived"));
  }

  // --------------------------------------------------------------- events

  // Scoped to the path ROW, not the card. A card can now hold several paths,
  // each with its own requirement inputs and credit fields, so resolving from
  // the card would always find the first row's controls.
  function cardContext(el) {
    const row = el.closest(".training-path-row");
    return row ? { userId: row.dataset.user, pathId: row.dataset.path, key: row.dataset.key, article: row } : null;
  }

  document.addEventListener("click", async (event) => {
    const t = event.target;
    if (!(t instanceof HTMLElement)) return;

    if (t.id === "training-enrol-btn") {
      openPanel = openPanel === "enrol" ? null : "enrol";
      loadUsers();
      if (latest) render(latest, false);
      return;
    }
    if (t.id === "training-setup-btn") {
      openPanel = openPanel === "paths" ? null : "paths";
      if (latest) render(latest, false);
      return;
    }

    // "confirm now" on the badge just opens the detail panel, where the
    // prompt lives - the same thing the row's own "detail" link does.
    if (t.classList.contains("training-toggle-confirm") || t.classList.contains("training-toggle")) {
      const ctx = cardContext(t);
      if (!ctx) return;
      if (expanded.has(ctx.key)) expanded.delete(ctx.key);
      else expanded.add(ctx.key);
      if (latest) render(latest, false);
      return;
    }

    const ctx = cardContext(t);
    if (ctx) {
      if (t.classList.contains("training-pause")) {
        const reason = window.prompt("Why are they paused? (optional)") ?? "";
        const expectedReturn = window.prompt("Expected back on? (YYYY-MM-DD, optional)") || null;
        return act("pause", { userId: ctx.userId, pathId: ctx.pathId, reason, expectedReturn });
      }
      if (t.classList.contains("training-unpause")) return act("unpause", { userId: ctx.userId, pathId: ctx.pathId });
      if (t.classList.contains("training-archive")) {
        if (!window.confirm("Archive this interviewer off this path? They stay in history.")) return;
        return act("archive", { userId: ctx.userId, pathId: ctx.pathId });
      }
      if (t.classList.contains("training-unarchive")) return act("unarchive", { userId: ctx.userId, pathId: ctx.pathId });

      if (t.classList.contains("training-confirm")) {
        return act("session", { userId: ctx.userId, pathId: ctx.pathId, eventId: t.dataset.event, role: t.dataset.role });
      }
      if (t.classList.contains("training-not-training")) {
        return act("session", {
          userId: ctx.userId,
          pathId: ctx.pathId,
          eventId: t.dataset.event,
          discounted: true,
          note: "ran it rather than shadowed it",
        });
      }
      if (t.classList.contains("training-save-req")) {
        const shadows = parseInt(ctx.article.querySelector(".training-req-shadows").value, 10);
        const reverseShadows = parseInt(ctx.article.querySelector(".training-req-reverse").value, 10);
        return act("requirements", { userId: ctx.userId, pathId: ctx.pathId, shadows, reverseShadows });
      }
      if (t.classList.contains("training-add-credit")) {
        const role = ctx.article.querySelector(".training-credit-role").value;
        const date = ctx.article.querySelector(".training-credit-date").value;
        return act("credit", {
          userId: ctx.userId,
          pathId: ctx.pathId,
          role,
          at: date ? new Date(`${date}T12:00:00`).toISOString() : null,
          note: "added by hand",
        });
      }
      if (t.classList.contains("training-credit-delete")) {
        return act("credit/delete", { userId: ctx.userId, pathId: ctx.pathId, creditId: t.dataset.credit });
      }
    }

    if (t.classList.contains("training-path-delete")) {
      if (!window.confirm("Remove this path? Everyone training on it is removed too.")) return;
      return act("paths/delete", { pathId: t.dataset.path });
    }
    if (t.classList.contains("training-suggestion-add")) {
      return act("paths/add-interview", { pathId: t.dataset.path, interviewId: t.dataset.interview });
    }
    if (t.id === "training-path-save") {
      const index = document.getElementById("training-path-option").value;
      const option = (latest.trainingPathOptions || []).filter((o) => !o.alreadyConfigured)[Number(index)];
      if (!option) return;
      return act("paths", {
        interviewTitle: option.interviewTitle,
        interviewIds: option.interviewIds,
        jobId: option.jobId,
        jobTitle: option.jobTitle,
        label: option.label,
        requiredShadows: parseInt(document.getElementById("training-path-shadows").value, 10),
        requiredReverseShadows: parseInt(document.getElementById("training-path-reverse").value, 10),
      });
    }
    if (t.id === "training-enrol-save") {
      const typed = document.getElementById("training-enrol-user").value.trim();
      const pathId = document.getElementById("training-enrol-path").value;
      const error = document.getElementById("training-enrol-error");
      // The datalist is a free-text input, so a typo produces a label that
      // matches nobody. Say so rather than silently doing nothing or, worse,
      // enrolling an empty user id.
      const user = (users || []).find((u) => `${u.name}${u.email ? ` (${u.email})` : ""}` === typed || u.name === typed);
      if (!user) {
        if (error) error.textContent = typed ? `No interviewer matches "${typed}".` : "Pick an interviewer first.";
        return;
      }
      if (error) error.textContent = "";
      return act("enrol", { userId: user.id, pathId, userName: user.name, userEmail: user.email });
    }
  });

  // Filters the path picker in place. Deliberately not a re-render: that
  // would rebuild the input and lose focus mid-typing.
  document.addEventListener("input", (event) => {
    const t = event.target;
    if (!(t instanceof HTMLElement) || t.id !== "training-path-filter") return;
    const needle = t.value.trim().toLowerCase();
    const select = document.getElementById("training-path-option");
    if (!select) return;
    for (const option of select.options) {
      option.hidden = Boolean(needle) && !option.textContent.toLowerCase().includes(needle);
    }
    const firstVisible = [...select.options].find((o) => !o.hidden);
    if (firstVisible && select.selectedOptions[0] && select.selectedOptions[0].hidden) firstVisible.selected = true;
  });

  document.addEventListener("change", async (event) => {
    const t = event.target;
    if (!(t instanceof HTMLElement)) return;
    const ctx = cardContext(t);
    if (!ctx) return;
    if (t.classList.contains("training-role")) {
      return act("session", { userId: ctx.userId, pathId: ctx.pathId, eventId: t.dataset.event, role: t.value || null });
    }
    if (t.classList.contains("training-discount")) {
      return act("session", {
        userId: ctx.userId,
        pathId: ctx.pathId,
        eventId: t.dataset.event,
        discounted: t.checked,
      });
    }
  });

  window.renderTrainingTracker = render;
})();
