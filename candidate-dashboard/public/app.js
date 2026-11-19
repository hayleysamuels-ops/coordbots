(() => {
  const REFRESH_MS = 60 * 1000;

  // With Google sign-in on (signin.js), a request after the session ends
  // gets a 401 carrying X-Sign-In: send the page there, coming back here
  // after. Wraps every script's fetch, since they all look it up on window.
  // Dashboards without sign-in never send the header.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await nativeFetch(...args);
    const signIn = res.status === 401 && res.headers.get("X-Sign-In");
    if (signIn) location.assign(`${signIn}?next=${encodeURIComponent(location.pathname + location.search)}`);
    return res;
  };

  // Who is signed in (/api/viewer): { signIn: false } on a dashboard with
  // the shared password only. Loaded once, before the first render.
  let viewer = { signIn: false };
  const verifiedViewer = () => viewer.signIn && viewer.method === "google";

  // The usage log (usage-log.js), where the server says it's on: what only
  // the browser sees, i.e. tabs, queue views, section jumps and Ashby links
  // opened. The server records who from the session, and everything else
  // (sign-ins, page loads, hides, notes) itself.
  function trackUsage(event, fields) {
    if (!viewer.usageLog) return;
    fetch("/api/usage", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, ...fields }) }).catch(() => {});
  }
  // Every Ashby candidate link (a new tab), however it's opened: click,
  // Cmd/Ctrl-click or middle-click. The server names the candidate.
  function trackAshbyLink(e) {
    const link = e.target.closest && e.target.closest('a[target="_blank"][href*="/candidates/"]');
    if (link && (e.type === "click" || e.button === 1)) trackUsage("ashby", { href: link.href });
  }
  document.addEventListener("click", trackAshbyLink, true);
  document.addEventListener("auxclick", trackAshbyLink, true);

  // The filter is purely client-side: the last-fetched snapshot is cached
  // here so checking/unchecking an option, or switching which field to
  // filter by, re-renders instantly without a network round-trip. Applies
  // to every candidate-facing section; NOT Interviewer Weekly Limits, which
  // has no department/job/recruiter/coordinator concept (an interviewer
  // isn't tied to one the way a candidate's application is).
  let lastData = null;
  let lastDepartments = [];

  // Interviewer Training hides paused trainees by default (they aren't
  // actionable the way an active trainee's progress is) behind a toggle;
  // client-side only, same re-render-from-cache pattern as the filter.
  let showPausedTrainees = false;

  // Which Action queue signal is currently narrowing the merged table —
  // "all" or one of TRIAGE_QUEUES' keys. Drives both the sidebar's Triage
  // queues group and the chip row above the table; same re-render-from-cache
  // pattern as the department/job/recruiter/coordinator filter and the
  // paused-trainees toggle above.
  let activeSignal = "all";
  // Stale rows (past STALE_FEEDBACK_HOURS / STALE_SCHEDULING_HOURS) are in
  // the Action queue by default; the Stale chip takes them out for when
  // there are enough of them to bury the fresh ones (Forus had 43). Resets to
  // shown on reload on purpose: folding stale in was about not hiding them.
  let showStale = true;

  // Sections this deployment has turned off (DISABLED_SECTIONS, see
  // config.js) — populated from appConfig once, in applyDisabledSections().
  // render() checks this instead of every renderX() guarding a possibly-
  // removed container, so the removal logic lives in one place.
  let disabledSectionKeys = new Set();

  // Real IANA time zone (DISPLAY_TIMEZONE, see config.js) every ABSOLUTE
  // time in the UI is formatted in — set once in applyAppConfig(). Default
  // here only matters before the first snapshot arrives; the server always
  // sends a resolved value. Deliberately NOT used for pure elapsed-duration
  // labels (formatAge/formatAgo/formatUpdatedAgo — "3h ago" means the same
  // thing regardless of time zone) or for formatDateOnly (a plain calendar
  // date with no time-of-day component — see its own comment for why it
  // stays pinned to UTC instead).
  let displayTimeZone = "America/New_York";
  // Scorecard reminders (reminder-route.js): on where appConfig says so, and
  // the button shows only to someone signed in with Google (verifiedViewer).
  let remindersEnabled = false;
  const remindersInFlight = new Set(); // interviewEventIds being sent

  function isSectionDisabled(key) {
    return disabledSectionKeys.has(key);
  }

  // candidateId -> draft text, for whichever note editors are currently
  // open (new or editing an existing note) — inline in place, never a
  // floating popup. render() runs on every 60s poll same as everything
  // else; without this, that poll would blow away whatever a coordinator
  // had half-typed before they hit Save. Presence of a key means that
  // candidate's editor is open; the value is kept current by the
  // `.note-input` input listener below.
  const openNoteEditors = new Map();

  // Section keys that carry a `.note` field (see applyNotes() in
  // issues.js) AND actually render it — the four merged into the Action
  // queue table plus the five candidate-card sections. Onsite Interviews
  // Today also gets a `.note` from the server but renders as a timeline,
  // not a card, and was left out of scope for showing notes there. Used by
  // findCandidateNote() below to seed an "Edit" click with the note's
  // current text without a network round-trip.
  const NOTE_SOURCE_KEYS = [
    "feedbackOverdue",
    "needsScheduling",
    "availabilitySubmitted",
    "rescheduledInterviews",
    "recentSourced",
    "offersNotYetSent",
    "offersAwaitingAcceptance",
    "offersSigned",
  ];

  function findCandidateNote(candidateId) {
    if (!lastData) return "";
    for (const key of NOTE_SOURCE_KEYS) {
      for (const item of lastData[key] || []) {
        if (item.candidateId === candidateId) return item.note || "";
      }
    }
    return "";
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Sections that carry job/recruiter/coordinator info on their items —
  // used to derive those filter modes' options client-side, since (unlike
  // departments) there's no org-wide "list all jobs/recruiters/coordinators"
  // call; only ones actually represented in the current candidate sections
  // are worth offering as filter options.
  const CANDIDATE_SECTION_KEYS = [
    "feedbackOverdue",
    "needsScheduling",
    "availabilitySubmitted",
    "recentSourced",
    "onsiteToday",
    "interviewsToday",
    "rescheduledInterviews",
  ];

  // What the filter's options are drawn from: the candidates on screen, and
  // the roles Interviewer Load has interviews for (its `roles` carry the same
  // jobId/departmentId/recruiterId/coordinatorId fields), so a role with
  // interviews but no flagged candidate can still be picked. One filter for
  // both tabs means one list.
  function filterSourceItems(data) {
    const items = [];
    for (const key of CANDIDATE_SECTION_KEYS) {
      if (isSectionDisabled(key)) continue;
      items.push(...((data || {})[key] || []));
    }
    if (!isSectionDisabled("interviewerLoad") && data && data.interviewerLoad) items.push(...(data.interviewerLoad.roles || []));
    return items;
  }

  function collectDistinct(data, idKey, nameKey) {
    const byId = new Map();
    for (const item of filterSourceItems(data)) {
      if (item[idKey] && !byId.has(item[idKey])) {
        byId.set(item[idKey], item[nameKey] || "Unknown");
      }
    }
    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Department options used to be the full org-wide `lastDepartments` list
  // (every department Ashby has, including archived ones with zero current
  // candidates) — unlike job/recruiter/coordinator, which only ever offer
  // values actually represented among the candidates on screen. That made
  // the Department dropdown both noisier (dead entries that return nothing)
  // and prone to duplicate-looking rows whenever an org has an archived
  // department sharing a name with a live one. This mirrors collectDistinct
  // above but resolves names via the `lastDepartments` id->name lookup
  // (candidate items only carry `departmentId`, not a name) instead of a
  // per-item nameKey.
  function collectDistinctDepartments(data) {
    const byId = new Map(lastDepartments.map((d) => [d.id, d]));
    const ids = new Set();
    for (const item of filterSourceItems(data)) {
      if (item.departmentId) ids.add(item.departmentId);
    }
    const options = [...ids].map((id) => {
      const dep = byId.get(id);
      return { id, name: (dep && dep.name) || "Unknown", isArchived: Boolean(dep && dep.isArchived), createdAt: dep && dep.createdAt };
    });
    return disambiguateDepartmentNames(options).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Filtering to only departments with current candidates (above) resolves
  // most name collisions on its own, since one half of a same-named pair is
  // usually the archived department with nothing currently pointing at it.
  // But two ACTIVE departments can legitimately share a name — those are
  // still distinct records and must never be silently merged into one
  // dropdown row (checking it would only filter by whichever id survived).
  // So any remaining collision gets its label disambiguated instead:
  // archived copies are labeled first; if that's not enough to separate a
  // group (e.g. two active same-named departments), they're numbered
  // oldest-first by `createdAt` so the numbering stays stable across
  // refreshes.
  function disambiguateDepartmentNames(options) {
    const groups = new Map();
    for (const o of options) {
      if (!groups.has(o.name)) groups.set(o.name, []);
      groups.get(o.name).push(o);
    }
    const result = [];
    for (const group of groups.values()) {
      if (group.length === 1) {
        result.push(group[0]);
        continue;
      }
      const labeled = group.map((o) => (o.isArchived ? { ...o, name: `${o.name} (archived)` } : o));
      const counts = new Map();
      for (const o of labeled) counts.set(o.name, (counts.get(o.name) || 0) + 1);
      const stillColliding = labeled.filter((o) => counts.get(o.name) > 1);
      if (!stillColliding.length) {
        result.push(...labeled);
        continue;
      }
      stillColliding.sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
      const numbered = new Map(stillColliding.map((o, i) => [o.id, i + 1]));
      result.push(...labeled.map((o) => (numbered.has(o.id) ? { ...o, name: `${o.name} (${numbered.get(o.id)})` } : o)));
    }
    return result;
  }

  // Which field is currently live: one of FILTER_MODES' keys. Only one
  // filters at a time — switching modes doesn't combine two fields
  // together, it replaces which one is active. Each mode remembers its own
  // selection independently (switching back and forth doesn't lose any of
  // them). Department options come from the server (data.departments); the
  // rest are derived client-side via collectDistinct above.
  const FILTER_MODES = {
    department: {
      key: "departmentId",
      noun: "department",
      pluralNoun: "departments",
      options: () => collectDistinctDepartments(lastData),
    },
    job: {
      key: "jobId",
      noun: "job",
      pluralNoun: "jobs",
      options: () => collectDistinct(lastData, "jobId", "jobTitle"),
    },
    recruiter: {
      key: "recruiterId",
      noun: "recruiter",
      pluralNoun: "recruiters",
      options: () => collectDistinct(lastData, "recruiterId", "recruiterName"),
    },
    coordinator: {
      key: "coordinatorId",
      noun: "coordinator",
      pluralNoun: "coordinators",
      options: () => collectDistinct(lastData, "coordinatorId", "coordinatorName"),
    },
  };

  let filterMode = "department";
  // Empty set = "All <plural>" (no filter), matching the old empty-string
  // convention. Populated with IDs the user has checked. One Set per mode,
  // built from FILTER_MODES so adding a mode above doesn't require touching
  // this too.
  const selectedIdsByMode = Object.fromEntries(Object.keys(FILTER_MODES).map((mode) => [mode, new Set()]));

  function activeSelection() {
    const mode = FILTER_MODES[filterMode];
    return { ids: selectedIdsByMode[filterMode], key: mode.key, noun: mode.noun, pluralNoun: mode.pluralNoun };
  }

  function filterByEntity(items) {
    const { ids, key } = activeSelection();
    if (ids.size === 0) return items;
    return items.filter((item) => ids.has(item[key]));
  }

  function currentEntityOptions() {
    return FILTER_MODES[filterMode].options();
  }

  function entityButtonLabel() {
    const { ids, noun, pluralNoun } = activeSelection();
    if (ids.size === 0) return `All ${pluralNoun}`;
    if (ids.size === 1) {
      const only = currentEntityOptions().find((o) => ids.has(o.id));
      return only ? only.name : `1 ${noun}`;
    }
    return `${ids.size} ${pluralNoun}`;
  }

  function updateEntityButtonLabel() {
    document.getElementById("entity-filter-btn").textContent = entityButtonLabel();
  }

  // Rebuilds the menu's checkbox rows from the current mode's option list,
  // dropping any selected IDs that no longer exist (departments/jobs rarely
  // change, but the snapshot refreshes periodically regardless). Called both
  // after a fresh render() and when the mode toggle switches fields.
  function populateEntityOptions() {
    const options = currentEntityOptions();
    const { ids, pluralNoun } = activeSelection();
    const validIds = new Set(options.map((o) => o.id));
    for (const id of ids) {
      if (!validIds.has(id)) ids.delete(id);
    }

    const menu = document.getElementById("entity-filter-menu");
    const resetLabel = `All ${pluralNoun}`;
    const rows = [`<button type="button" class="entity-filter-reset">${resetLabel}</button>`, `<hr class="entity-filter-divider">`]
      .concat(
        options.map(
          (o) => `
            <label class="entity-filter-row">
              <input type="checkbox" value="${o.id}" ${ids.has(o.id) ? "checked" : ""}>
              ${o.name}
            </label>`
        )
      );
    menu.innerHTML = rows.join("");
    updateEntityButtonLabel();
  }

  // The four sections that used to be their own stacked columns are now
  // merged into one "Action queue" table (see renderActionQueue() below) —
  // this table drives that merge instead of one renderColumn() per key.
  // `signalClass` picks the Signal tag's color (see .signal-tag in
  // style.css); `waitingHours`/`waitingLabel` compute and format the
  // "how long has this been sitting" value each row is sorted and
  // color-graded by.
  const TRIAGE_QUEUES = [
    {
      key: "feedbackOverdue",
      label: "Feedback overdue",
      thresholdKey: "feedbackOverdueHours",
      signalClass: "signal-critical",
      waitingHours: (item) => item.hoursOverdue,
      waitingLabel: (hours) => `${formatAge(hours)} overdue`,
      renderDetail: (item) => owedByList(item.interviewers),
      // Only feedbackOverdue defines this — the other three queues have no
      // per-row interviewer-panel concept, so their signalDetail is a
      // no-op. See interviewerSummary() above for the "Tom Reyes +2"
      // truncation; the names are the people still owing a scorecard.
      signalDetail: (item) => interviewerSummary(item.interviewers),
    },
    {
      key: "needsScheduling",
      // Replaced from appConfig.needsSchedulingLabel in applyAppConfig():
      // "Scheduling not started" where the scheduling pilot is on (its
      // "Ready to schedule" section shows candidates past that point).
      label: "Needs scheduling",
      thresholdKey: "needsSchedulingAlertHours",
      // Not signal-serious: that's the same ember hue as feedbackOverdue's
      // signal-critical, just a lighter tint — Carrara's warning/serious/
      // critical trio is a deliberately monochrome "heat ramp" for grading
      // ONE thing's escalating severity, not for telling apart unrelated
      // categories. A Signal tag needs actual hue variety to scan at a
      // glance, so this reaches outside that ramp instead.
      signalClass: "signal-warning",
      waitingHours: (item) => item.hoursPending,
      waitingLabel: (hours) => `${formatAge(hours)} pending`,
      renderDetail: () => "",
      signalDetail: () => "",
    },
    {
      key: "availabilitySubmitted",
      label: "Availability submitted",
      thresholdKey: "availabilitySubmittedAlertHours",
      // moss/"good", not another ember shade — the candidate has already
      // responded here (distinct from the other three, which are all
      // still waiting on someone internally), and it doubles as real hue
      // separation from feedbackOverdue/needsScheduling's tags.
      signalClass: "signal-good",
      waitingHours: (item) => item.hoursWaiting,
      waitingLabel: (hours) => `${formatAge(hours)} waiting`,
      renderDetail: () => "",
      signalDetail: () => "",
    },
    {
      key: "rescheduledInterviews",
      label: "Rescheduled 3+ times",
      thresholdKey: null,
      signalClass: "signal-neutral",
      // Unlike the other three, this record shape has no native "waiting
      // since X" hours field (see listIssues() in ashby.js — only
      // rescheduleCount and the current startTime exist). Derived from
      // startTime instead, an existing field: hours since the
      // (already-rescheduled) slot was supposed to happen. A startTime
      // still in the future reads as "Upcoming" rather than a negative
      // duration — it hasn't actually been missed (yet).
      waitingHours: (item) => (Date.now() - new Date(item.startTime).getTime()) / (1000 * 60 * 60),
      waitingLabel: (hours) => (hours >= 0 ? `${formatAge(hours)} since rescheduled` : "Upcoming"),
      renderDetail: (item) => `Currently scheduled: ${formatEventDateTime(item.startTime)}` + (interviewerList(item.interviewers) ? ` — ${interviewerList(item.interviewers)}` : ""),
      signalDetail: () => "",
    },
  ];

  // Full list, comma-separated — used as a tooltip/hover-detail where space
  // isn't constrained.
  function interviewerList(interviewers) {
    return interviewers && interviewers.length ? `Interviewers: ${interviewers.map((i) => i.name).join(", ")}` : "";
  }

  // A Feedback Overdue row's `interviewers` is exactly the people who still
  // owe a scorecard for that interview, resolved per person server-side
  // (missingFeedbackOwers in ashby.js) — not the whole panel.
  function owedByList(interviewers) {
    return interviewers && interviewers.length ? `Waiting on: ${interviewers.map((i) => i.name).join(", ")}` : "";
  }

  // First name plus a count of the rest — "Tom Reyes +2" — for the Action
  // queue's Signal cell, where a full comma-separated list would break row
  // height on a 3+ person panel. No "+N" at all for a single interviewer.
  function interviewerSummary(interviewers) {
    if (!interviewers || !interviewers.length) return "";
    const [first, ...rest] = interviewers;
    return rest.length ? `${first.name} +${rest.length}` : first.name;
  }

  // Under 24h shows whole hours; 24h and up shows days (one decimal place)
  // instead of whole/floored days. The underlying data is still
  // hour-denominated (config thresholds, severity ratios) — this only
  // affects what's shown.
  function formatAge(hours) {
    if (hours < 24) return `${Math.round(hours)}h`;
    return `${(hours / 24).toFixed(1)}d`;
  }

  function severity(hours, thresholdHours) {
    const ratio = hours / thresholdHours;
    if (ratio >= 3) return "critical";
    if (ratio >= 1.5) return "serious";
    return "warning";
  }

  // The per-card dismiss control: two always-visible buttons for the two
  // durations, not a "×" that opens a floating menu. A popup menu used to
  // sit here — dropped because a browser extension injecting its own
  // fixed-position overlay (confirmed live: reproduced in a normal profile,
  // gone in incognito) could sit above it and swallow the second click,
  // silently eating the dismiss with no error a coordinator would ever see.
  // Both actions now live inline in the card's normal layout (same place
  // the "×" toggle always lived, which was never the fragile part) instead
  // of in a dynamically-positioned `position: fixed` element — nothing here
  // for an overlay to cover that isn't also covering the whole card.
  // `key` is "candidate:<id>" or "interviewer:<id>".
  // Visible text, not bare glyphs — "1d"/"×" tested unclear (× especially,
  // since it conventionally reads as "close" rather than "hide
  // indefinitely"). title/aria-label still carry the fuller phrasing for
  // anyone hovering or on a screen reader; the on-card text is the short
  // form of the same two phrases, not a different, vaguer label.
  function dismissHtml(key) {
    return `
      <div class="dismiss">
        <button class="dismiss-btn" data-key="${key}" data-scope="today" aria-label="Hide until tomorrow" title="Hide until tomorrow">Snooze</button>
        <button class="dismiss-btn dismiss-forever" data-key="${key}" data-scope="forever" aria-label="Hide indefinitely" title="Hide indefinitely">Hide</button>
      </div>`;
  }

  // Right-hand cluster of a card's top row: the age/status label plus dismiss.
  function cardTopRight(ageLabel, ageClass, key) {
    return `
      <div class="card-top-right">
        <div class="card-age ${ageClass}">${ageLabel}</div>
        ${dismissHtml(key)}
      </div>`;
  }

  // "10:42 AM" today, "Tue 10:42 AM" before that, in DISPLAY_TIMEZONE.
  function formatReminderTime(ms) {
    const day = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: displayTimeZone }).format(d);
    const sameDay = day(new Date(ms)) === day(new Date());
    return new Date(ms).toLocaleString([], { ...(sameDay ? {} : { weekday: "short" }), hour: "numeric", minute: "2-digit", timeZone: displayTimeZone });
  }

  // A Feedback Overdue row's reminder control: who last sent one (everyone
  // sees it) and the Remind button (Google sign-in only, so every reminder is
  // recorded under a verified name). The server picks who gets it from
  // its own data: exactly the row's `interviewers`.
  // Returns { button, last }: the button sits in the row with Snooze/Hide,
  // the "Reminded …" line under them, so the column stays narrow.
  function reminderHtml(item) {
    if (!remindersEnabled || !item.interviewEventId) return { button: "", last: "" };
    const r = item.reminder;
    const last = r ? `<div class="aq-reminded" title="${escapeHtml(`Sent to ${(r.sent || []).join(", ")}`)}">Reminded ${escapeHtml(formatReminderTime(r.at))} by ${escapeHtml(r.byName || "someone")}</div>` : "";
    if (!verifiedViewer()) return { button: "", last };
    const busy = remindersInFlight.has(item.interviewEventId);
    const names = (item.interviewers || []).map((i) => i.name).join(", ");
    const button = `<button class="remind-btn" data-event-id="${escapeHtml(item.interviewEventId)}" ${busy ? "disabled" : ""}
          title="${escapeHtml(`Send ${names || "the interviewers"} a Slack reminder`)}">${busy ? "Sending…" : "Remind"}</button>`;
    return { button, last };
  }

  async function sendReminder(interviewEventId) {
    if (remindersInFlight.has(interviewEventId)) return;
    remindersInFlight.add(interviewEventId);
    if (lastData) render(lastData);
    let message;
    try {
      const res = await fetch("/api/remind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interviewEventId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        message = body.error || "Couldn't send the reminder.";
      } else {
        const parts = [];
        if (body.sent.length) parts.push(`Reminded ${body.sent.map((s) => s.name).join(", ")} on Slack.`);
        for (const s of body.skipped) {
          const when = s.lastAt ? ` (${formatReminderTime(s.lastAt)})` : "";
          parts.push(`Not sent to ${s.name}: ${s.reason}${when}.`);
        }
        message = parts.join(" ") || "Nobody to remind.";
        if (body.snapshot) lastData = body.snapshot;
      }
    } catch (err) {
      console.error("[remind]", err);
      message = "Couldn't reach the dashboard. Nothing was sent.";
    } finally {
      remindersInFlight.delete(interviewEventId);
    }
    if (lastData) render(lastData);
    showUndoToast(null, null, message);
  }

  // ready-scheduling.js renders its own cards but reuses this control, so
  // its Snooze/Hide buttons go through the same delegated listeners below.
  window.dismissHtml = dismissHtml;

  function candidateKey(item) {
    return `candidate:${item.candidateId}`;
  }

  // A coordinator's own free-text note on a candidate — entirely local to
  // this dashboard (see src/notes.js) and never written to Ashby. Shared by
  // candidate cards (cardHtml()) and Action queue rows
  // (actionQueueRowHtml()); `compact` trims padding/font-size for the
  // latter so the control doesn't crowd the Snooze/Hide buttons in the same
  // row. Independent of the dismiss/snooze lifecycle — see notes.js — and
  // shared across every coordinator behind this dashboard's one basic-auth
  // login, with no per-author attribution (also noted in notes.js).
  //
  // Three states, all inline in place (never a floating popup): no note
  // yet -> a small "+ Add note" control; a saved note -> its text (styled
  // smaller/muted than the candidate name, same treatment as
  // .aq-signal-sub's missing-interviewer text) plus Edit/Delete; editing ->
  // an inline textarea plus Save/Cancel. openNoteEditors (see above) is
  // checked first so an open editor survives a background re-render.
  function noteBlockHtml(item, { compact }) {
    const candidateId = item.candidateId;
    if (!candidateId) return "";
    const wrapClass = compact ? "note-block note-block-compact" : "note-block";

    if (openNoteEditors.has(candidateId)) {
      const draft = openNoteEditors.get(candidateId);
      return `
        <div class="${wrapClass} note-editing" data-candidate-id="${candidateId}">
          <textarea class="note-input" data-candidate-id="${candidateId}" rows="2" placeholder="Note for this candidate…">${escapeHtml(draft)}</textarea>
          <div class="note-editor-actions">
            <button type="button" class="note-save-btn" data-candidate-id="${candidateId}">Save</button>
            <button type="button" class="note-cancel-btn" data-candidate-id="${candidateId}">Cancel</button>
          </div>
        </div>`;
    }

    if (item.note) {
      return `
        <div class="${wrapClass}" data-candidate-id="${candidateId}">
          <div class="note-text">${escapeHtml(item.note)}</div>
          <div class="note-view-actions">
            <button type="button" class="note-edit-btn" data-candidate-id="${candidateId}">Edit</button>
            <button type="button" class="note-delete-btn" data-candidate-id="${candidateId}">Delete</button>
          </div>
        </div>`;
    }

    return `
      <div class="${wrapClass}" data-candidate-id="${candidateId}">
        <button type="button" class="note-add-btn" data-candidate-id="${candidateId}">+ Add note</button>
      </div>`;
  }

  // Candidate cards show only the name by default — everything else
  // (age/severity, job title, dismiss control, badges, detail line) lives in
  // `.card-details`, shown as a floating popup on hover/focus (positioned by
  // showCardDetails() below) rather than expanding the card in place.
  function cardHtml(item, { sev, ageLabel, ageClass, detail, reasonBadge }) {
    const nameHtml = item.ashbyProfileUrl
      ? `<a href="${item.ashbyProfileUrl}" target="_blank" rel="noopener">${item.candidateName || "Unknown candidate"}</a>`
      : item.candidateName || "Unknown candidate";

    // Dismiss lives on the always-visible card row (styled very subtle by
    // default — see .dismiss-btn in style.css), not in the hover popup, so
    // it doesn't require hovering just to hide a card. Age/job title/badges/
    // detail stay in `.card-details`, the floating popup.
    // The note block is a sibling of `.card-details`, not nested inside
    // it — it must stay visible even when the hover popup is collapsed
    // (see noteBlockHtml() above), unlike everything else past the name.
    return `
      <div class="card sev-${sev}">
        <div class="card-top">
          <div class="card-name">${nameHtml}</div>
          ${dismissHtml(candidateKey(item))}
        </div>
        ${noteBlockHtml(item, { compact: false })}
        <div class="card-details">
          <div class="card-age ${ageClass || `sev-${sev}`}">${ageLabel}</div>
          <div class="card-sub">${item.jobTitle || ""}</div>
          ${reasonBadge ? `<div class="reason-badge">${reasonBadge}</div>` : ""}
          ${detail ? `<div class="card-detail">${detail}</div>` : ""}
        </div>
      </div>
    `;
  }

  // One row per candidate across all non-disabled TRIAGE_QUEUES, tagged
  // with which queue it came from — `filterByEntity` (department/job/
  // recruiter/coordinator) is applied per source exactly as it was when
  // these were separate sections, before merging. Sorted longest-waiting
  // first, across all four sources at once.
  function buildActionQueueRows(data) {
    const rows = [];
    for (const queue of TRIAGE_QUEUES) {
      if (isSectionDisabled(queue.key)) continue;
      for (const item of filterByEntity(data[queue.key] || [])) {
        rows.push({ item, queue, hours: queue.waitingHours(item) });
      }
    }
    rows.sort((a, b) => b.hours - a.hours);
    return rows;
  }

  function actionQueueRowHtml({ item, queue, hours }, thresholds) {
    const nameHtml = item.ashbyProfileUrl
      ? `<a href="${item.ashbyProfileUrl}" target="_blank" rel="noopener">${item.candidateName || "Unknown candidate"}</a>`
      : item.candidateName || "Unknown candidate";
    const detail = queue.renderDetail(item);
    // Signal tag color is fixed per queue (which category this is); the
    // Waiting cell's color is the existing ratio-to-threshold severity()
    // instead (how urgent THIS row specifically is within its category) —
    // same computation renderColumn() used to feed into a card's left
    // border, just displayed as text color here. Rescheduled rows have no
    // threshold concept, so they get neither treatment.
    const sevClass = queue.thresholdKey && thresholds ? `sev-${severity(hours, thresholds[queue.thresholdKey])}` : "";
    return `
      <tr class="action-queue-row">
        <td class="aq-candidate">${nameHtml}${noteBlockHtml(item, { compact: true })}</td>
        <td class="aq-stage-role">
          <div class="aq-stage">${queue.label}</div>
          <div class="aq-role">${item.jobTitle || ""}</div>
        </td>
        <td>
          <span class="signal-tag ${queue.signalClass}">${queue.label}</span>
          ${queue.signalDetail(item) ? `<div class="aq-signal-sub">${queue.signalDetail(item)}</div>` : ""}
        </td>
        <td class="aq-waiting ${sevClass}"${detail ? ` title="${detail}"` : ""}>${queue.waitingLabel(hours)}${item.isStale ? ` <span class="stale-label">stale</span>` : ""}</td>
        <td class="aq-dismiss">${(() => {
          const remind = queue.key === "feedbackOverdue" ? reminderHtml(item) : { button: "", last: "" };
          return `<div class="aq-actions">${remind.button}${dismissHtml(candidateKey(item))}</div>${remind.last}`;
        })()}</td>
      </tr>`;
  }

  // Sidebar's Triage queues group and the chip row above the table are two
  // views of the same `activeSignal` state — clicking either narrows the
  // same merged table the same way (see the delegated click listener's
  // `[data-signal]` handling below). Counts reflect the entity filter and
  // disabled sections but NOT the current activeSignal selection, so every
  // option's true size stays visible regardless of which one is picked.
  function renderQueueNav(countsByQueue, totalCount, data) {
    const triageNav = document.getElementById("triage-queue-nav");
    if (triageNav) {
      const rows = [
        `<button type="button" class="queue-nav-item${activeSignal === "all" ? " is-active" : ""}" data-signal="all">
          <span>All action items</span><span class="queue-count">${totalCount}</span>
        </button>`,
      ];
      for (const queue of TRIAGE_QUEUES) {
        if (isSectionDisabled(queue.key)) continue;
        rows.push(`
          <button type="button" class="queue-nav-item${activeSignal === queue.key ? " is-active" : ""}" data-signal="${queue.key}">
            <span>${queue.label}</span><span class="queue-count">${countsByQueue[queue.key]}</span>
          </button>`);
      }
      triageNav.innerHTML = rows.join("");
    }

    const watchlistNav = document.getElementById("watchlist-queue-nav");
    if (watchlistNav) {
      const rows = [];
      if (!isSectionDisabled("recentSourced")) {
        rows.push(`
          <a class="queue-nav-item" href="#recentSourced">
            <span>Recently sourced</span><span class="queue-count">${filterByEntity(data.recentSourced || []).length}</span>
          </a>`);
      }
      watchlistNav.innerHTML = rows.join("");
    }
  }

  function renderSignalChips(countsByQueue, totalCount, hiddenCount, staleCount) {
    const container = document.getElementById("signal-chip-row");
    if (!container) return;
    const chips = [
      `<button type="button" class="signal-chip${activeSignal === "all" ? " is-active" : ""}" data-signal="all">All ${totalCount}</button>`,
    ];
    for (const queue of TRIAGE_QUEUES) {
      if (isSectionDisabled(queue.key)) continue;
      chips.push(
        `<button type="button" class="signal-chip${activeSignal === queue.key ? " is-active" : ""}" data-signal="${queue.key}">${queue.label} ${countsByQueue[queue.key]}</button>`
      );
    }
    // A toggle, not a signal: it shows or hides stale rows within whichever
    // signal is picked. Pressed (stale shown) by default. Only offered when
    // there are stale rows to show or hide.
    if (staleCount) {
      chips.push(
        `<button type="button" class="signal-chip signal-chip-stale${showStale ? "" : " is-off"}" data-stale-toggle aria-pressed="${showStale}" title="${showStale ? "Hide" : "Show"} rows far past their threshold">Stale ${staleCount} · ${showStale ? "shown" : "hidden"}</button>`
      );
    }
    // Set apart from the signals: it lists what's been taken off the
    // dashboard, not something waiting on a coordinator.
    chips.push(
      `<button type="button" class="signal-chip signal-chip-hidden${activeSignal === "hidden" ? " is-active" : ""}" data-signal="hidden">Hidden &amp; snoozed ${hiddenCount}</button>`
    );
    container.innerHTML = chips.join("");
  }

  // Reschedule-count caveat used to live on the Rescheduled Interviews
  // section's own subtitle (updateRescheduledSubtitle) — folded in here
  // since that section no longer exists on its own, merged into this table.
  function updateActionQueueFootnote(threshold) {
    const el = document.getElementById("actionQueue-footnote");
    if (!el) return;
    if (isSectionDisabled("rescheduledInterviews") || !threshold) {
      el.textContent = "";
      return;
    }
    el.textContent =
      `"Rescheduled 3+ times" only counts reschedules more than ${threshold} time${threshold === 1 ? "" : "s"} that this ` +
      `app has actually observed since it started tracking — Ashby has no reschedule history of its own, so it can't see ` +
      `further back than that.`;
  }

  function renderActionQueue(data) {
    const allRows = buildActionQueueRows(data);
    const countsByQueue = {};
    for (const queue of TRIAGE_QUEUES) {
      countsByQueue[queue.key] = isSectionDisabled(queue.key) ? 0 : filterByEntity(data[queue.key] || []).length;
    }
    const totalCount = allRows.length;

    renderQueueNav(countsByQueue, totalCount, data);
    const staleCount = allRows.filter((r) => r.item.isStale).length;
    renderSignalChips(countsByQueue, totalCount, (data.hidden || []).length, staleCount);
    updateActionQueueFootnote(data.thresholds && data.thresholds.rescheduleCountThreshold);

    const thead = document.getElementById("action-queue-head");
    if (thead && actionQueueHeadHtml === null) actionQueueHeadHtml = thead.innerHTML;
    if (activeSignal === "hidden") {
      renderHiddenQueue(data);
      return;
    }
    if (thead && thead.innerHTML !== actionQueueHeadHtml) thead.innerHTML = actionQueueHeadHtml;

    const sub = document.getElementById("actionQueue-sub");
    if (sub) {
      sub.textContent = totalCount
        ? `${totalCount} candidate${totalCount === 1 ? "" : "s"} blocked on a coordinator action, ordered by how long each has been waiting.`
        : "Nothing blocked on a coordinator action right now.";
    }

    const visibleRows = (activeSignal === "all" ? allRows : allRows.filter((r) => r.queue.key === activeSignal))
      .filter((r) => showStale || !r.item.isStale);

    const tbody = document.getElementById("action-queue-body");
    if (!tbody) return;
    // All four TRIAGE_QUEUES keys are one fetch group server-side (see
    // issues.js's SECTION_GROUPS) and so always share one status — any one
    // of them stands in for "the whole merged table."
    const hasError = sectionHasError(data, "feedbackOverdue");

    tbody.innerHTML = visibleRows.length
      ? visibleRows.map((row) => actionQueueRowHtml(row, data.thresholds)).join("")
      : `<tr><td colspan="5">${emptyStateHtml(hasError, "Nothing flagged")}</td></tr>`;
  }

  // The Action queue's Hidden & snoozed tab: every hide and snooze still in
  // force (data.hidden, built server-side in hidden-list.js), with a Restore
  // button on each. It ignores the entity filters so nothing hidden can be
  // out of sight here too. "Hidden by" is the name typed into the browser
  // that hid it: self-reported, not a record of who was signed in. With
  // Google sign-in, it's the signed-in account's name instead (byVerified),
  // and only older entries are self-reported.
  let actionQueueHeadHtml = null;
  const HIDDEN_SECTION_LABELS = {
    readyToSchedule: "Ready to schedule",
    recentSourced: "Recently sourced",
    onsiteToday: "Onsite today",
    interviewsToday: "Interviews today",
    interviewerLimits: "Weekly limits",
    interviewerTraining: "Interviewer training",
    offersNotYetSent: "Offer not yet sent",
    offersAwaitingAcceptance: "Offer awaiting acceptance",
    offersSigned: "Offer signed",
  };

  function hiddenSectionLabel(key) {
    const queue = TRIAGE_QUEUES.find((q) => q.key === key);
    return queue ? queue.label : HIDDEN_SECTION_LABELS[key] || key;
  }

  function formatHiddenTime(ms) {
    return new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: displayTimeZone });
  }

  function hiddenRowHtml(entry) {
    const label = entry.name ? escapeHtml(entry.name) : `<span class="muted">${entry.kind === "interviewer" ? "Interviewer" : "Candidate"} (name not saved)</span>`;
    const nameHtml = entry.ashbyProfileUrl ? `<a href="${escapeHtml(entry.ashbyProfileUrl)}" target="_blank" rel="noopener">${label}</a>` : label;
    const kind = entry.kind === "interviewer" ? `<div class="hidden-sub">Interviewer</div>` : entry.jobTitle ? `<div class="hidden-sub">${escapeHtml(entry.jobTitle)}</div>` : "";
    const from = entry.sections.length ? entry.sections.map(hiddenSectionLabel).map(escapeHtml).join(", ") : `<span class="muted">—</span>`;
    // A snooze always lifts at the next midnight in DISPLAY_TIMEZONE, so
    // "midnight" is enough; the exact time is in the tooltip.
    const status = entry.scope === "forever"
      ? "Hidden"
      : `<span${entry.expiresAt ? ` title="${escapeHtml(formatHiddenTime(entry.expiresAt))}"` : ""}>Snoozed until midnight</span>`;
    const by = !entry.by
      ? `<span class="muted">—</span>`
      : entry.byVerified || !verifiedViewer()
        ? escapeHtml(entry.by)
        : `${escapeHtml(entry.by)} <span class="muted">(self-reported)</span>`;
    const when = entry.hiddenAt ? escapeHtml(formatHiddenTime(entry.hiddenAt)) : `<span class="muted">Not saved</span>`;
    return `
      <tr class="action-queue-row">
        <td class="aq-candidate">${nameHtml}${kind}</td>
        <td>${from}</td>
        <td>${status}</td>
        <td>${by}</td>
        <td>${when}</td>
        <td class="aq-dismiss"><button type="button" class="hidden-restore-btn" data-key="${escapeHtml(entry.key)}">Restore</button></td>
      </tr>`;
  }

  function renderHiddenQueue(data) {
    const entries = data.hidden || [];
    const thead = document.getElementById("action-queue-head");
    if (thead) {
      thead.innerHTML = `
        <tr>
          <th>Name</th>
          <th>Hidden from</th>
          <th>Status</th>
          <th>${verifiedViewer() ? "Hidden by" : "Hidden by (self-reported)"}</th>
          <th>When</th>
          <th></th>
        </tr>`;
    }
    const sub = document.getElementById("actionQueue-sub");
    if (sub && verifiedViewer()) {
      sub.textContent =
        `Everything hidden or snoozed on this dashboard, whatever the filters above. Restore puts it back. ` +
        `"Hidden by" is the Google account that was signed in; entries marked self-reported are from before sign-in, or from the dashboard password, and show the name typed into that browser.`;
    } else if (sub) {
      const name = hiderName();
      sub.innerHTML =
        `Everything hidden or snoozed on this dashboard, whatever the filters above. Restore puts it back. ` +
        `"Hidden by" is the name typed into the browser that hid it, not a record of who did. ` +
        `<span class="hidden-by-self">This browser: ${name ? escapeHtml(name) : "no name"} · <button type="button" class="hider-name-change">Change</button></span>`;
    }
    const tbody = document.getElementById("action-queue-body");
    if (!tbody) return;
    const showing = entries.filter((e) => e.onDashboard);
    const elsewhere = entries.filter((e) => !e.onDashboard);
    tbody.innerHTML = entries.length
      ? showing.map(hiddenRowHtml).join("") +
        (elsewhere.length
          ? `<tr class="hidden-divider"><td colspan="6">Not on the dashboard right now (${elsewhere.length}). Restoring one shows it again if it's flagged later.</td></tr>` +
            elsewhere.map(hiddenRowHtml).join("")
          : "")
      : `<tr><td colspan="6"><div class="empty-state">Nothing is hidden or snoozed.</div></td></tr>`;
  }

  // The name sent as "by" with each hide or snooze, asked for once and kept
  // in this browser. undefined: never asked; "": asked and skipped.
  const HIDER_NAME_KEY = "dashboard.hiddenByName";
  function hiderName() {
    try {
      const v = localStorage.getItem(HIDER_NAME_KEY);
      return v === null ? undefined : v;
    } catch (err) {
      return ""; // storage blocked: don't ask on every hide
    }
  }

  function askHiderName() {
    const dialog = document.getElementById("hider-name-dialog");
    if (!dialog || typeof dialog.showModal !== "function") return Promise.resolve("");
    const input = document.getElementById("hider-name-input");
    input.value = hiderName() || "";
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => {
        const name = dialog.returnValue === "save" ? input.value.trim().slice(0, 80) : (hiderName() || "");
        try { localStorage.setItem(HIDER_NAME_KEY, name); } catch (err) {}
        resolve(name);
      }, { once: true });
      dialog.returnValue = "";
      dialog.showModal();
      input.focus();
    });
  }

  async function restoreHidden(key) {
    try {
      const res = await fetch("/api/undismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = await res.json();
      render(data);
      showUndoToast(null, null, "Restored.");
    } catch (err) {
      console.error(`[restore] request failed for key "${key}":`, err);
    }
  }

  function renderInterviewerLimits(items, hasError) {
    const container = document.getElementById("cards-interviewerLimits");
    if (!items.length) {
      container.innerHTML = emptyStateHtml(hasError, "Nothing flagged");
      return;
    }
    container.innerHTML = items
      .map((item) => {
        const sev = item.remaining <= 0 ? "critical" : "warning";
        const ageLabel =
          item.remaining <= 0 ? `${Math.abs(item.remaining)} over limit` : `${item.remaining} left`;
        return `
          <div class="card sev-${sev}">
            <div class="card-top">
              <div class="card-name">${item.name || "Unknown interviewer"}</div>
              ${cardTopRight(ageLabel, `sev-${sev}`, `interviewer:${item.userId}`)}
            </div>
            <div class="card-sub">${item.scheduledCount} of ${item.weeklyLimit} interviews this week</div>
          </div>
        `;
      })
      .join("");
  }

  function renderInterviewerTraining(items, hasError) {
    const container = document.getElementById("cards-interviewerTraining");
    const toggleContainer = document.getElementById("interviewerTraining-toggle");
    // Both of these live inside index.html's training-legacy block, which is
    // stripped where the training tracker is on (TRAINING_TRACKER_CLIENT_ID).
    // Normally the caller hands off to window.renderTrainingTracker instead
    // and never reaches here — but if training.js fails to load for any
    // reason (a 401, a cache miss, a network blip) that global is undefined,
    // execution falls through to this function, and writing to a missing
    // element throws out of render() entirely. That would take down EVERY
    // section on the page over one missing script, so degrade to an empty
    // training section instead. Confirmed live: a 401 on training.js left
    // the whole dashboard blank until this guard was added.
    if (!container || !toggleContainer) return;
    const pausedCount = items.filter((item) => item.isPaused).length;

    toggleContainer.innerHTML = pausedCount
      ? `<button type="button" class="show-paused-toggle">${showPausedTrainees ? "Hide" : "Show"} ${pausedCount} paused interview trainee${pausedCount === 1 ? "" : "s"}</button>`
      : "";

    const visible = showPausedTrainees ? items : items.filter((item) => !item.isPaused);
    if (!visible.length) {
      container.innerHTML = emptyStateHtml(hasError, "Nothing flagged");
      return;
    }
    container.innerHTML = visible
      .map((item) => {
        const sev = item.isPaused ? "critical" : "good";
        const roleLabel = item.stageRole === "ReverseShadow" ? "Reverse shadow" : "Shadow";
        const progressLabel = `${item.interviewsCompleted} of ${item.interviewsRequired}`;
        return `
          <div class="card sev-${sev}">
            <div class="card-top">
              <div class="card-name">${item.interviewerName || "Unknown interviewer"}</div>
              ${cardTopRight(item.isPaused ? "Paused" : progressLabel, `sev-${sev}`, `interviewer:${item.userId}`)}
            </div>
            <div class="card-sub">${roleLabel} — ${item.poolTitle}</div>
            ${item.isPaused ? `<div class="card-detail">${progressLabel} completed</div>` : ""}
          </div>
        `;
      })
      .join("");
  }

  function formatAgo(iso) {
    const hours = (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60);
    if (hours < 1) return "just now";
    return `${formatAge(hours)} ago`;
  }

  // Rendered in displayTimeZone (DISPLAY_TIMEZONE, see config.js) — the
  // same zone the server's "is this today" day boundary uses (see isToday
  // in ashby.js), so a card's displayed time and which day it counts as
  // "today" always agree, regardless of the viewer's own browser locale.
  function formatEventTime(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: displayTimeZone });
  }

  // Unlike formatEventTime above (today's onsite events, time-only), a
  // rescheduled interview's current slot could be any date, so this
  // includes the date too. Same displayTimeZone as formatEventTime.
  function formatEventDateTime(iso) {
    if (!iso) return "not yet scheduled";
    return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: displayTimeZone });
  }

  function renderRecentSourced(items, hasError) {
    const container = document.getElementById("cards-recentSourced");
    if (!items.length) {
      container.innerHTML = emptyStateHtml(hasError, "Nothing flagged");
      return;
    }
    container.innerHTML = items
      .map((item) => {
        const source = item.sourceTitle
          ? `${item.sourceCategory} · ${item.sourceTitle}`
          : item.sourceCategory;
        const statusBadge =
          item.status && item.status !== "Active"
            ? `<span class="status-badge">${item.status}</span>`
            : "";
        return cardHtml(item, {
          sev: "good",
          ageLabel: formatAgo(item.createdAt),
          ageClass: "muted",
          detail: `${source}${statusBadge}`,
        });
      })
      .join("");
  }

  // Right-rail timeline, not cards — one row per onsite, time-first (the
  // thing that actually orders a coordinator's day), matching this
  // section's persistent-margin placement. Same underlying fields as
  // before (startTime, stageTitle, jobTitle, interviewers, candidateName,
  // ashbyProfileUrl); dismiss still uses candidateKey()/dismissHtml() same
  // as every other section.
  //
  // Only time + name + dismiss are always visible now — stage/role/
  // interviewers moved into a `.card-details` hover/focus popup, the same
  // mechanism cardHtml()'s candidate cards already use (see
  // showCardDetails() and the mouseover/mouseout/focusin/focusout listeners
  // below, whose selector now also matches `.onsite-timeline-item`). Time
  // stays always-visible unlike the rest of the detail — unlike stage/role/
  // interviewers, it's the whole point of a *schedule*, not supplementary
  // detail; hiding it would make the timeline useless to scan at a glance.
  function renderOnsiteToday(items, hasError) {
    const container = document.getElementById("cards-onsiteToday");
    if (!items.length) {
      container.innerHTML = emptyStateHtml(hasError, "Nothing scheduled today");
      return;
    }
    container.innerHTML = items
      .map((item) => {
        const nameHtml = item.ashbyProfileUrl
          ? `<a href="${item.ashbyProfileUrl}" target="_blank" rel="noopener">${item.candidateName || "Unknown candidate"}</a>`
          : item.candidateName || "Unknown candidate";
        const subParts = [item.stageTitle, item.jobTitle].filter(Boolean);
        const interviewerText =
          item.interviewers && item.interviewers.length ? `Interviewers: ${item.interviewers.map((i) => i.name).join(", ")}` : "";
        return `
          <div class="onsite-timeline-item">
            <div class="onsite-timeline-time">${formatEventTime(item.startTime)}</div>
            <div class="onsite-timeline-name">${nameHtml}</div>
            <div class="card-details">
              ${subParts.length ? `<div class="onsite-timeline-sub">${subParts.join(" · ")}</div>` : ""}
              ${interviewerText ? `<div class="onsite-timeline-sub">${interviewerText}</div>` : ""}
            </div>
            <div class="onsite-timeline-dismiss">${dismissHtml(candidateKey(item))}</div>
          </div>`;
      })
      .join("");
  }

  // Interviews today (ashby.js todaysStartedEvents): one row per interview,
  // each person inline with a quiet marker. ✓ = their scorecard is in; a
  // faint ring = not in yet. People who don't owe one (hosts, Welcome/Lunch,
  // feedback-not-required) are muted with no marker, so they can never read
  // as missing. While the interview is running there are no markers at all,
  // just "in progress". null `submitted` (lookup failed) also gets no marker.
  function interviewPersonHtml(person, inProgress) {
    const name = escapeHtml(person.name || "Unknown");
    if (!person.owes) return `<span class="it-person it-host">${name}</span>`;
    if (inProgress || person.submitted === null) return `<span class="it-person">${name}</span>`;
    return person.submitted
      ? `<span class="it-person">${name}<span class="it-mark it-in" role="img" aria-label="feedback in" title="Feedback in">✓</span></span>`
      : `<span class="it-person">${name}<span class="it-mark it-owed" role="img" aria-label="feedback not in yet" title="Feedback not in yet">○</span></span>`;
  }

  function renderInterviewsToday(items, hasError) {
    const container = document.getElementById("cards-interviewsToday");
    if (!container) return;
    if (!items.length) {
      container.innerHTML = emptyStateHtml(hasError, "No interviews yet today");
      return;
    }
    container.innerHTML = items
      .map((item) => {
        const nameHtml = item.ashbyProfileUrl
          ? `<a href="${item.ashbyProfileUrl}" target="_blank" rel="noopener">${escapeHtml(item.candidateName || "Unknown candidate")}</a>`
          : escapeHtml(item.candidateName || "Unknown candidate");
        const sub = [item.interviewTitle, item.jobTitle].filter(Boolean).map(escapeHtml).join(" · ");
        const people = (item.people || []).map((p) => interviewPersonHtml(p, item.inProgress)).join("");
        return `
          <div class="interview-today-item">
            <div class="onsite-timeline-time">${formatEventTime(item.startTime)}${item.inProgress ? ` <span class="it-progress">in progress</span>` : ""}</div>
            <div class="onsite-timeline-name">${nameHtml}</div>
            ${sub ? `<div class="onsite-timeline-sub">${sub}</div>` : ""}
            ${people ? `<div class="it-people">${people}</div>` : ""}
          </div>`;
      })
      .join("");
  }

  // Feedback leaderboard (feedback-leaderboard.js has the rules). Top 10
  // only, by design: no full ranking, no bottom of the table, no "where you
  // sit". When fewer than 10 people qualify, only they are shown, with a line
  // saying how many qualified; no placeholder rows. Ties on share are broken
  // by median time to submit. "N others also at 100%" (a count, never names)
  // keeps a perfect record from being invisible below the cut.
  // Interviewer load (interviewerLoadSnapshot in interviewer-load.js): one
  // row per person for the chosen period, busiest first, people at zero
  // folded into one line. The period toggle and name search re-render from
  // lastData, no request. Bars are one neutral grey (colour is for state,
  // DESIGN.md) scaled to the second-busiest person, so a single outlier
  // (Pace: 107 this month against 49) doesn't flatten everyone else; the
  // capped bar is marked.
  let loadPeriod = "week";
  let loadSearch = "";
  const LOAD_PERIOD_WORDS = { day: "today", week: "this week", month: "this month" };

  // "Thu 19 Nov", "Mon 16 – Sun 22 Nov", "November 2026". Built by hand:
  // toLocaleDateString's en-US order scrambled the week ("16 Mon – Sun, Nov 22").
  // The keys are calendar dates already in DISPLAY_TIMEZONE, so read as UTC.
  function loadPeriodLabel(period, key) {
    const [y, m, d] = (period === "month" ? key + "-01" : key).split("-").map(Number);
    const at = (dd) => new Date(Date.UTC(y, m - 1, dd));
    const wd = (dt) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getUTCDay()];
    const mon = (dt) => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][dt.getUTCMonth()];
    if (period === "month") return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]} ${y}`;
    const start = at(d);
    if (period === "day") return `${wd(start)} ${start.getUTCDate()} ${mon(start)}`;
    const end = at(d + 6);
    const startText = `${wd(start)} ${start.getUTCDate()}${start.getUTCMonth() === end.getUTCMonth() ? "" : " " + mon(start)}`;
    return `${startText} – ${wd(end)} ${end.getUTCDate()} ${mon(end)}`;
  }

  // "4.8 h" under 10 hours, "18 h" from 10.
  function formatLoadHours(minutes) {
    const h = minutes / 60;
    return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
  }

  function renderInterviewerLoad(load, hasError) {
    const container = document.getElementById("cards-interviewerLoad");
    if (!container) return;
    document.querySelectorAll(".load-period-btn").forEach((b) => {
      const on = b.dataset.loadPeriod === loadPeriod;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const label = document.getElementById("load-period-label");
    const search = document.getElementById("load-search");
    // Titles this client counts as interviews but not hours (Poetic: Build Time).
    const untimedNames = (lastData && lastData.appConfig && lastData.appConfig.interviewerLoadUntimed) || [];
    const hoursNote = document.getElementById("load-hours-note");
    if (hoursNote) {
      hoursNote.hidden = !untimedNames.length;
      hoursNote.textContent = untimedNames.length
        ? `Hours leave out ${untimedNames.join(" and ")} blocks: they count as interviews, but the interviewer isn't with the candidate the whole time.`
        : "";
    }
    if (!load) {
      if (label) label.textContent = "";
      container.innerHTML = emptyStateHtml(hasError, "Still reading interview schedules for the first time.");
      return;
    }
    if (label) label.textContent = loadPeriodLabel(loadPeriod, load.periods[loadPeriod]);
    // Search only where the list is long enough to need it.
    if (search) search.hidden = load.rows.length < 60;
    const words = LOAD_PERIOD_WORDS[loadPeriod];
    if (!load.rows.length) {
      container.innerHTML = emptyStateHtml(hasError, `Nobody has interviewed in the last ${load.rosterDays} days.`);
      return;
    }
    const q = search && !search.hidden ? loadSearch.trim().toLowerCase() : "";

    // The filter above the tabs (department/job/recruiter/coordinator). Each
    // interview carries its candidate's role (load.roles); a filtered row
    // shows the selected roles' share "of" the person's whole-period total,
    // so a filtered row can't be read as someone's whole load. Who appears:
    // anyone who interviewed for a selected role in the roster window.
    const sel = activeSelection();
    const filtering = sel.ids.size > 0 && Array.isArray(load.roles);
    const roleOn = filtering ? load.roles.map((r) => sel.ids.has(r[sel.key])) : [];
    const totalOf = (r) => r[loadPeriod];
    const viewOf = (r) => {
      if (!filtering) return totalOf(r);
      const v = { done: 0, booked: 0, minutes: 0, untimed: 0 };
      for (const [i, done, booked, mins, untimed] of totalOf(r).byRole || []) {
        if (!roleOn[i]) continue;
        v.done += done; v.booked += booked; v.minutes += mins; v.untimed += untimed;
      }
      return v;
    };
    const filterNote = document.getElementById("load-filter-note");
    if (filterNote) {
      filterNote.hidden = !filtering;
      if (filtering) {
        const names = currentEntityOptions().filter((o) => sel.ids.has(o.id)).map((o) => o.name);
        const list = names.length ? names.join(", ") : `${sel.ids.size} ${sel.ids.size === 1 ? sel.noun : sel.pluralNoun}`;
        const what = { departmentId: `candidates in ${list}`, jobId: list, recruiterId: `candidates whose recruiter is ${list}`, coordinatorId: `candidates whose coordinator is ${list}` }[sel.key] || list;
        const unmatched = (load.unmatched && load.unmatched[loadPeriod]) || 0;
        filterNote.textContent = `Showing interviews for ${what}. "of" is each person's total ${words} across every role.` +
          (unmatched ? ` ${unmatched} ${unmatched === 1 ? "interview" : "interviews"} ${words} aren't matched to a role yet, so they're only in the totals.` : "");
      }
    }
    const count = (r) => { const v = viewOf(r); return v.done + v.booked; };
    const minutes = (r) => viewOf(r).minutes || 0;
    const rows = load.rows.filter((r) => (!q || r.name.toLowerCase().includes(q)) && (!filtering || (r.roles || []).some((i) => roleOn[i])));
    // Hours lead (load is time); the count breaks ties.
    const busy = rows.filter((r) => count(r) > 0).sort((a, b) => minutes(b) - minutes(a) || count(b) - count(a) || a.name.localeCompare(b.name));
    const idle = rows.filter((r) => count(r) === 0);
    // Bars are scaled on each person's whole-period total, so a filtered
    // bar's length still shows their whole load and its darker part the share.
    const totalMinutes = (r) => totalOf(r).minutes || 0;
    const mins = busy.map(totalMinutes).sort((a, b) => b - a);
    // Scale to the second-busiest, unless the top one is within 1.5x of it.
    const scale = (mins.length > 1 && mins[0] > mins[1] * 1.5 ? mins[1] : mins[0]) || 1;
    const untimedLine = (n) => {
      if (!n) return "";
      const what = untimedNames.length === 1 ? untimedNames[0] : "not timed";
      const tip = untimedNames.length > 1 ? ` title="${escapeHtml(`Not timed: ${untimedNames.join(", ")}`)}"` : "";
      return `<div class="load-untimed"${tip}>+ ${n} ${escapeHtml(what)}</div>`;
    };
    const pctOf = (m) => (m > 0 ? Math.max(2, Math.round((Math.min(m, scale) / scale) * 100)) : 0);
    const rowHtml = (r) => {
      const v = viewOf(r);
      const t = totalOf(r);
      const c = v.done + v.booked;
      const tc = t.done + t.booked;
      const capped = t.minutes > scale;
      const totalPct = pctOf(t.minutes);
      const tip = filtering
        ? `${r.name}: ${c} of ${tc} ${tc === 1 ? "interview" : "interviews"} ${words}, ${formatLoadHours(v.minutes)} of ${formatLoadHours(t.minutes)}`
        : `${r.name}: ${c} ${c === 1 ? "interview" : "interviews"} ${words} (${v.done} done, ${v.booked} booked), ${formatLoadHours(v.minutes)}` + (v.untimed ? `, plus ${v.untimed} not timed` : "");
      const of = (text) => (filtering ? ` <span class="load-of">of ${text}</span>` : "");
      let bar = "";
      if (filtering && totalPct) {
        const share = t.minutes ? Math.min(100, Math.round((v.minutes / t.minutes) * 100)) : 0;
        bar = `<div class="load-bar-track${capped ? " is-capped" : ""}" style="width:${totalPct}%">${share ? `<div class="load-bar" style="width:${share}%"></div>` : ""}</div>`;
      } else if (totalPct) {
        bar = `<div class="load-bar${capped ? " is-capped" : ""}" style="width:${totalPct}%"></div>`;
      }
      return `
          <tr>
            <td class="load-name">${escapeHtml(r.name)}</td>
            <td class="load-total">${c}${of(tc)}</td>
            <td class="load-hours">${formatLoadHours(v.minutes)}${of(formatLoadHours(t.minutes))}${untimedLine(v.untimed)}</td>
            <td class="load-split">${v.done} · ${v.booked}</td>
            <td class="load-bar-cell" title="${escapeHtml(tip)}">${bar}</td>
          </tr>`;
    };
    const idleHtml = idle.length
      ? `<details class="load-idle">
          <summary>${idle.length} ${filtering ? `who've interviewed for this recently, none ${words}` : `with no interviews ${words}`}</summary>
          <p class="load-idle-names">${idle.map((r) => escapeHtml(r.name)).join(" · ")}</p>
        </details>`
      : "";
    const table = busy.length
      ? `<div class="action-queue-wrap">
          <table class="action-queue-table load-table">
            <thead><tr><th>Name</th><th class="load-total">Interviews</th><th class="load-hours">Hours</th><th class="load-split">Done · Booked</th><th class="load-bar-cell" aria-label="Hours, as a bar"></th></tr></thead>
            <tbody>${busy.map(rowHtml).join("")}</tbody>
          </table>
        </div>`
      : emptyStateHtml(false, q ? "Nobody by that name has interviews in this period." : filtering && !rows.length ? `Nobody has interviewed for this in the last ${load.rosterDays} days.` : `Nobody has interviews ${words}${filtering ? " for this" : ""}.`);
    // Keep an opened "no interviews" list open across the 60s re-render.
    const wasOpen = container.querySelector(".load-idle")?.open;
    container.innerHTML = table + idleHtml;
    if (wasOpen) { const d = container.querySelector(".load-idle"); if (d) d.open = true; }
  }

  function renderFeedbackLeaderboard(board, hasError) {
    const container = document.getElementById("cards-feedbackLeaderboard");
    const footnote = document.getElementById("feedbackLeaderboard-footnote");
    if (!container) return;
    if (!board) {
      container.innerHTML = emptyStateHtml(hasError, "Still reading scorecards for the first time.");
      if (footnote) footnote.textContent = "";
      return;
    }
    const people = board.qualifying === 1 ? "1 person has" : `${board.qualifying} people have`;
    const sub = document.getElementById("feedbackLeaderboard-sub");
    if (sub) {
      sub.textContent =
        `Ranked on the share of each interviewer's completed interviews in the last ${board.days} days where their feedback is in; ` +
        `ties go to whoever submits faster. Only the top ten are shown.`;
    }
    if (footnote) {
      footnote.textContent =
        `${people} completed at least ${board.minInterviews} interviews in the last ${board.days} days. ` +
        `An interview counts once it ended a day ago or more. Hosts and interviews nobody owes feedback on don't count, and people who have left aren't shown.`;
    }
    if (!board.top.length) {
      container.innerHTML = emptyStateHtml(hasError, `Nobody has completed ${board.minInterviews} interviews in the last ${board.days} days yet.`);
      return;
    }
    const rows = board.top
      .map(
        (p) => `
          <tr>
            <td class="lb-rank">${p.rank}</td>
            <td class="lb-name">${escapeHtml(p.name)}</td>
            <td class="lb-share">${Math.round(p.share * 100)}%</td>
            <td class="lb-count">${p.submitted} of ${p.completed}</td>
            <td class="lb-median">${p.medianHoursToSubmit == null ? "—" : formatAge(p.medianHoursToSubmit)}</td>
          </tr>`
      )
      .join("");
    container.innerHTML = `
      <div class="action-queue-wrap">
        <table class="action-queue-table leaderboard-table">
          <thead>
            <tr><th>#</th><th>Interviewer</th><th>Feedback in</th><th>Interviews</th><th>Median time to submit</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${board.othersAtFull ? `<p class="column-sub leaderboard-others">${board.othersAtFull === 1 ? "1 other" : `${board.othersAtFull} others`} also at 100%.</p>` : ""}`;
  }

  // startDate is a plain "YYYY-MM-DD" date, no time/timezone component —
  // parsed as UTC calendar-date parts (not `new Date(str)`, which the
  // browser would interpret in local time and could shift the displayed
  // day near midnight in negative-UTC-offset zones). Deliberately still
  // pinned to "UTC" here, NOT displayTimeZone: the value was constructed via
  // Date.UTC(y, m-1, d), i.e. midnight UTC on that day — formatting that
  // instant in, say, America/New_York would render it as the PREVIOUS day
  // (roughly 7-8pm the day before), an off-by-one. There's no time-of-day to
  // convert in the first place, so there's nothing for displayTimeZone to do
  // here — this is a different concern from formatEventTime/
  // formatEventDateTime above, which DO have a real instant to convert.
  function formatDateOnly(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  }

  // Offers Awaiting Acceptance / Not Yet Sent / Signed share the same card
  // shape (candidate, job title, start date, an age label off a different
  // date field per column) — same table-driven pattern as `TRIAGE_QUEUES`
  // above. Deliberately NOT run through filterByEntity() — the Offers tab
  // has no department/job/recruiter/coordinator filter bar (see CLAUDE.md).
  const offerColumns = [
    {
      key: "offersAwaitingAcceptance",
      sev: "warning",
      dateField: "versionCreatedAt",
      ageLabel: (iso) => `Sent ${formatAgo(iso)}`,
      emptyText: "Nothing awaiting acceptance",
    },
    {
      key: "offersNotYetSent",
      sev: "warning",
      dateField: "versionCreatedAt",
      ageLabel: (iso) => `Created ${formatAgo(iso)}`,
      emptyText: "Nothing pending",
    },
    {
      key: "offersSigned",
      sev: "good",
      dateField: "decidedAt",
      ageLabel: (iso) => `Signed ${formatAgo(iso)}`,
      emptyText: "Nothing signed recently",
    },
  ];

  function renderOfferColumn(col, items, hasError) {
    const container = document.getElementById(`cards-${col.key}`);
    if (!items.length) {
      container.innerHTML = emptyStateHtml(hasError, col.emptyText);
      return;
    }
    container.innerHTML = items
      .map((item) =>
        cardHtml(item, {
          sev: col.sev,
          ageLabel: col.ageLabel(item[col.dateField]),
          ageClass: "muted",
          detail: item.startDate ? `Start date: ${formatDateOnly(item.startDate)}` : "",
        })
      )
      .join("");
  }

  // "Offers Signed" used to always say "the last 7 days" regardless of the
  // real OFFERS_SIGNED_LOOKBACK_DAYS value — same pattern as
  // updateSourcedSubtitle/updateActionQueueFootnote above.
  function updateOffersSignedSubtitle(days) {
    const el = document.getElementById("offersSigned-sub");
    if (!el || !days) return;
    const label = days === 1 ? "day" : "days";
    el.textContent = `Offers the candidate has accepted in the last ${days} ${label}.`;
  }

  // feedbackOverdue/needsScheduling/availabilitySubmitted/rescheduledInterviews
  // used to each have their own "Updated Xm ago" here — merged into one
  // "actionQueue" timestamp now (see render()'s direct
  // renderSectionTimestamp("actionQueue", ...) call), since they're one
  // table, not four sections, each disableable independently via
  // TRIAGE_QUEUES rather than this list.
  const SECTION_TIMESTAMP_KEYS = [
    "interviewerLoad",
    "interviewerLimits",
    "recentSourced",
    "onsiteToday",
    "interviewsToday",
    "interviewerTraining",
    "feedbackLeaderboard",
    "offersNotYetSent",
    "offersAwaitingAcceptance",
    "offersSigned",
  ];

  // `data.sectionStatus` is per-key ({ lastUpdated, lastError }) — each
  // section fails and refreshes independently server-side now (see
  // issues.js's SECTION_GROUPS), so a stale/failed section shows its OWN
  // last-known-good timestamp and error rather than one global pair
  // blanking every section whenever any single one fails. Falls back to
  // nulls for a key sectionStatus doesn't have an entry for (shouldn't
  // happen for a real section key, but keeps callers null-safe regardless).
  function getSectionStatus(data, key) {
    return (data.sectionStatus && data.sectionStatus[key]) || { lastUpdated: null, lastError: null };
  }

  function sectionHasError(data, key) {
    return Boolean(getSectionStatus(data, key).lastError);
  }

  // A section with zero items reads very differently depending on whether
  // its last refresh actually succeeded. "Nothing flagged" is a confident
  // all-clear; showing that exact text when the fetch that would confirm
  // it just failed is actively misleading — it reads as "verified: nothing
  // to do" when the truth is "don't know." hasError swaps in language that
  // says so instead of silently reusing the normal empty copy.
  function emptyStateHtml(hasError, normalText) {
    return hasError
      ? `<div class="empty-state empty-state-error">Refresh failed — can't confirm this is empty.</div>`
      : `<div class="empty-state">${normalText}</div>`;
  }

  function formatUpdatedAgo(iso) {
    if (!iso) return "Never updated";
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / (1000 * 60));
    if (minutes < 1) return "Updated just now";
    if (minutes < 60) return `Updated ${minutes}m ago`;
    return `Updated ${formatAge(minutes / 60)} ago`;
  }

  function renderSectionTimestamp(key, iso, errorMessage) {
    const el = document.getElementById(`updated-${key}`);
    if (!el) return;
    el.textContent = errorMessage ? `${formatUpdatedAgo(iso)} — refresh failed` : formatUpdatedAgo(iso);
    el.classList.toggle("stale", Boolean(errorMessage));
  }

  // Removes a disabled section's <section> entirely (not just `hidden`) so
  // structural sibling selectors recompute against the real remaining
  // siblings (this once avoided a stray `.page-stack > * + *` divider, since
  // dropped when sections became cards). Collapses a now-empty `.side-margin` too, so
  // a disabled Onsite Interviews Today doesn't leave an empty gap. Only
  // covers keys that still have their own static `[data-key]` section —
  // recentSourced/onsiteToday/interviewsToday. The four TRIAGE_QUEUES keys
  // don't (they're merged rows in one table now, not separate sections);
  // renderActionQueue()'s own per-queue isSectionDisabled() checks handle
  // those, same idea, different mechanism since there's no longer a whole
  // section to remove for just one of the four.
  function applyDisabledSections(disabledSections) {
    disabledSectionKeys = new Set(disabledSections || []);
    // Note which tabs hold sections at all, before any are removed (this runs
    // on every render; the mark is only ever set). Scheduling has none.
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      if (panel.querySelector("[data-key]")) panel.dataset.hasSections = "true";
    });
    for (const key of disabledSectionKeys) {
      const section = document.querySelector(`[data-key="${key}"]`);
      if (!section) continue; // already removed on a previous render, or not a static-section key

      const sideMargin = section.closest(".side-margin");
      section.remove();
      // A section that is a whole tab (the feedback leaderboard) takes its
      // tab button with it, so a disabled section never leaves an empty tab.
      document.querySelectorAll(`.tab-btn[data-key-tab="${key}"]`).forEach((btn) => btn.remove());

      if (sideMargin && !sideMargin.querySelector(".column")) sideMargin.remove();
    }
    // A tab with every one of its sections off goes entirely, button and
    // panel (LiteLLM: no weekly limits and no training pools, so no
    // Interviewer Info tab; no Ashby offers, so no Offers tab). If it was
    // the open tab, fall back to the Dashboard.
    document.querySelectorAll('.tab-panel[data-has-sections="true"]').forEach((panel) => {
      // Never the Dashboard: its Action queue isn't a [data-key] section.
      if (panel.id === "tab-dashboard" || panel.querySelector("[data-key]")) return;
      const tab = panel.id.replace(/^tab-/, "");
      const wasOpen = !panel.hidden;
      document.querySelectorAll(`.tab-btn[data-tab="${tab}"]`).forEach((btn) => btn.remove());
      panel.remove();
      if (wasOpen) {
        document.getElementById("tab-dashboard")?.removeAttribute("hidden");
        document.querySelectorAll('.tab-btn[data-tab="dashboard"]').forEach((btn) => {
          btn.classList.add("is-active");
          btn.setAttribute("aria-pressed", "true");
        });
      }
    });
    // One tab left is no choice: hide the tab bar rather than show a lone button.
    const switcher = document.querySelector(".tab-switcher");
    if (switcher) switcher.hidden = switcher.querySelectorAll(".tab-btn").length < 2;
    syncFilterBar();
  }

  // Client-specific display config (page title, header accent color,
  // disabled sections) — static for the life of the server, but applying it
  // idempotently on every render is simpler than special-casing "only on
  // first load."
  function applyAppConfig(appConfig) {
    if (!appConfig) return;
    if (appConfig.dashboardTitle) {
      document.title = appConfig.dashboardTitle;
      document.getElementById("dashboard-title").textContent = appConfig.dashboardTitle;
    }
    if (appConfig.clientAccentColor) {
      document.documentElement.style.setProperty("--header-accent", appConfig.clientAccentColor);
    }
    if (appConfig.displayTimeZone) {
      displayTimeZone = appConfig.displayTimeZone;
    }
    remindersEnabled = Boolean(appConfig.remindersEnabled);
    if (appConfig.needsSchedulingLabel) {
      TRIAGE_QUEUES.find((queue) => queue.key === "needsScheduling").label = appConfig.needsSchedulingLabel;
    }
    applyDisabledSections(appConfig.disabledSections);
  }

  // Every refresh (each minute, the refresh button, a hide, a note) replaces
  // every section's rows, and rows above the one you're reading can come and
  // go, so the browser's scroll position alone would leave you on a
  // different row. render() notes the rows at the top of the window before
  // and scrolls so the first of them still there sits where it was. If none
  // of them is (all hidden or gone), it falls back to the section they were
  // in.
  const READING_ITEMS = ".action-queue-row, .card, .onsite-timeline-item, .interview-today-item, .scheduling-draft";

  function readingItemId(el) {
    const section = el.closest("section");
    const keyed = el.querySelector("[data-key]");
    const key = keyed ? keyed.dataset.key : (el.querySelector("a, .card-name") || el).textContent.trim().slice(0, 80);
    // The same candidate can be in one section twice (two Action queue
    // signals), so count which one this is.
    const same = section ? [...section.querySelectorAll(READING_ITEMS)].filter((x) => {
      const k = x.querySelector("[data-key]");
      return (k ? k.dataset.key : (x.querySelector("a, .card-name") || x).textContent.trim().slice(0, 80)) === key;
    }) : [el];
    return `${section ? section.id : ""}|${key}|${same.indexOf(el)}`;
  }

  function readingPlace() {
    if (window.scrollY < 1) return null;
    const onScreen = [...document.querySelectorAll(READING_ITEMS)]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ el, top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }))
      .filter((x) => x.bottom > 0 && x.top < window.innerHeight)
      .sort((a, b) => a.top - b.top)
      .slice(0, 8);
    if (!onScreen.length) return null;
    const section = onScreen[0].el.closest("section");
    return {
      items: onScreen.map((x) => ({ id: readingItemId(x.el), top: x.top })),
      section: section && section.id ? { id: section.id, top: section.getBoundingClientRect().top } : null,
    };
  }

  function keepReadingPlace(place) {
    if (!place) return;
    const now = new Map();
    for (const el of document.querySelectorAll(READING_ITEMS)) if (el.offsetParent !== null) now.set(readingItemId(el), el);
    for (const [i, item] of place.items.entries()) {
      const el = now.get(item.id);
      // When the rows above it have gone (just hidden, say), the next one
      // moves up into the first one's place, so you can keep working down
      // the list without moving the mouse.
      if (el) return window.scrollBy(0, el.getBoundingClientRect().top - (i ? place.items[0].top : item.top));
    }
    const section = place.section && document.getElementById(place.section.id);
    if (section) window.scrollBy(0, section.getBoundingClientRect().top - place.section.top);
  }

  function render(data) {
    const place = readingPlace();
    renderSections(data);
    keepReadingPlace(place);
  }

  function renderSections(data) {
    lastData = data;
    lastDepartments = data.departments || [];
    applyAppConfig(data.appConfig);
    populateEntityOptions();

    // Sections in DISABLED_SECTIONS had their DOM removed by
    // applyDisabledSections() above — skip rendering into them entirely
    // rather than have each renderX() guard a container that no longer
    // exists. renderActionQueue() checks each of TRIAGE_QUEUES' own
    // isSectionDisabled() itself (there's no longer a per-key DOM section
    // to remove — they're merged rows in one table), same as the loop this
    // replaced used to.
    //
    // Each section's timestamp/error now comes from its OWN
    // data.sectionStatus[key] (see getSectionStatus() above), not the one
    // global data.lastUpdated/data.lastError — every section fails and
    // refreshes independently server-side (issues.js's SECTION_GROUPS), so
    // e.g. Onsite Interviews Today (part of the listIssues() group) no
    // longer shows "refresh failed" just because an unrelated
    // listRecentSourced() call failed this cycle.
    window.renderReadyScheduling?.(
      filterByEntity(data.readyToSchedule || []),
      getSectionStatus(data, "readyToSchedule"),
      filterByEntity(data.readyToScheduleHidden || []).length,
    );
    renderActionQueue(data);
    const actionQueueStatus = getSectionStatus(data, "feedbackOverdue");
    renderSectionTimestamp("actionQueue", actionQueueStatus.lastUpdated, actionQueueStatus.lastError);
    if (!isSectionDisabled("interviewerLimits")) {
      // no department/job filter — no job/department concept for an interviewer
      renderInterviewerLimits(data.interviewerLimits || [], sectionHasError(data, "interviewerLimits"));
    }
    if (!isSectionDisabled("interviewerLoad")) {
      // Interviewer-centric like Weekly Limits: no entity filter.
      renderInterviewerLoad(data.interviewerLoad, sectionHasError(data, "interviewerLoad"));
    }
    if (!isSectionDisabled("interviewerTraining")) {
      // same — not tied to a candidate. With the training tracker on
      // (TRAINING_TRACKER_CLIENT_ID), training.js defines this global and
      // owns the section instead — it needs the whole payload, not just the
      // entries, because it also renders paths, picker options and
      // suggestions. Same optional-global handoff as renderReadyScheduling
      // above. Without the tracker the global is never defined (the script
      // 404s and its markup is stripped — see scheduling/page-gate.js), so
      // the original Ashby-native rendering below runs untouched.
      if (window.renderTrainingTracker) {
        window.renderTrainingTracker(data, sectionHasError(data, "interviewerTraining"));
      } else {
        renderInterviewerTraining(data.interviewerTraining || [], sectionHasError(data, "interviewerTraining"));
      }
    }
    if (!isSectionDisabled("recentSourced")) {
      renderRecentSourced(filterByEntity(data.recentSourced || []), sectionHasError(data, "recentSourced"));
      const appConfig = data.appConfig || {};
      updateSourcedSubtitle(
        data.thresholds && data.thresholds.sourcedLookbackDays,
        appConfig.sourceReferralKeywords,
        appConfig.sourceAgencyKeywords
      );
    }
    if (!isSectionDisabled("onsiteToday")) {
      renderOnsiteToday(filterByEntity(data.onsiteToday || []), sectionHasError(data, "onsiteToday"));
      updateOnsiteSubtitle(data.appConfig && data.appConfig.onsiteStageKeywords);
    }
    if (!isSectionDisabled("interviewsToday")) {
      renderInterviewsToday(filterByEntity(data.interviewsToday || []), sectionHasError(data, "interviewsToday"));
    }
    if (!isSectionDisabled("feedbackLeaderboard")) {
      // Not run through filterByEntity: an interviewer isn't tied to one
      // department/job/recruiter/coordinator (same as Interviewer Info).
      renderFeedbackLeaderboard(data.feedbackLeaderboard, sectionHasError(data, "feedbackLeaderboard"));
    }
    for (const col of offerColumns) {
      if (isSectionDisabled(col.key)) continue;
      renderOfferColumn(col, data[col.key] || [], sectionHasError(data, col.key));
    }
    if (!isSectionDisabled("offersSigned")) {
      updateOffersSignedSubtitle(data.thresholds && data.thresholds.offersSignedLookbackDays);
    }

    for (const key of SECTION_TIMESTAMP_KEYS) {
      if (isSectionDisabled(key)) continue;
      const status = getSectionStatus(data, key);
      renderSectionTimestamp(key, status.lastUpdated, status.lastError);
    }

    // The header stays a coarse whole-refresh summary (see issues.js's
    // lastUpdated/lastError comment) — per-section state above is what
    // actually reflects which sections are current. Always reassigns
    // (never appends) before optionally appending the error below —
    // `data.lastUpdated` stays null forever if every refresh since startup
    // has failed, which used to mean the `if (data.lastUpdated)` branch
    // never ran to reset textContent first; with `+=` as the only write,
    // each failed poll (every 60s) appended another copy of the same error
    // onto whatever was already there instead of replacing it.
    const lastUpdatedEl = document.getElementById("last-updated");
    lastUpdatedEl.textContent = data.lastUpdated
      ? `Updated ${new Date(data.lastUpdated).toLocaleTimeString([], { timeZone: displayTimeZone })}`
      : "Never updated";
    if (data.lastError) {
      lastUpdatedEl.textContent += ` — ${data.lastError}`;
    }
  }

  // "final and exec", "onsite", "a, b, and c" — never a fixed 2-item
  // assumption, since a client's keyword list can be any length.
  function joinWithAnd(items) {
    if (items.length === 0) return "";
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
  }

  // Onsite Interviews Today's description used to hardcode "final-round and
  // executive interviews" — this org's ONSITE_STAGE_KEYWORDS, not a fact
  // about Ashby. Describes the real keyword substrings instead, so it's
  // accurate for any client's ONSITE_STAGE_KEYWORDS (e.g. Luminai's just
  // "onsite").
  function updateOnsiteSubtitle(keywords) {
    const el = document.getElementById("onsiteToday-sub");
    if (!el) return;
    if (!keywords || !keywords.length) {
      el.textContent = "Onsite Interviews Today isn't configured for this org (no ONSITE_STAGE_KEYWORDS set).";
      return;
    }
    const quoted = joinWithAnd(keywords.map((k) => `"${k}"`));
    el.textContent = `Today's interviews whose stage title contains ${quoted}.`;
  }

  // Recently Sourced used to always say "referred or sourced by an agency"
  // even if a client disabled one category (SOURCE_REFERRAL_KEYWORDS or
  // SOURCE_AGENCY_KEYWORDS set to an empty value) — describes only the
  // categories actually enabled.
  function updateSourcedSubtitle(days, referralKeywords, agencyKeywords) {
    const el = document.getElementById("recentSourced-sub");
    if (!el || !days) return;
    const hasReferral = Boolean(referralKeywords && referralKeywords.length);
    const hasAgency = Boolean(agencyKeywords && agencyKeywords.length);
    let categoryText;
    if (hasReferral && hasAgency) categoryText = "referred or sourced by an agency";
    else if (hasReferral) categoryText = "referred";
    else if (hasAgency) categoryText = "sourced by an agency";

    if (!categoryText) {
      el.textContent = "Recently Sourced isn't configured for this org (no source keywords set).";
      return;
    }
    const label = days === 1 ? "day" : "days";
    el.textContent = `Candidates ${categoryText} in the last ${days} ${label}.`;
  }

  function markLoaded() {
    document.getElementById("last-loaded").textContent =
      `Last loaded ${new Date().toLocaleTimeString([], { timeZone: displayTimeZone })}`;
  }

  async function load() {
    try {
      const res = await fetch("/api/issues");
      const data = await res.json();
      render(data);
      markLoaded();
    } catch (err) {
      document.getElementById("last-updated").textContent = "Failed to load";
      console.error(err);
    }
  }

  document.getElementById("refresh-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.classList.add("spinning");
    document.getElementById("last-updated").textContent = "Refreshing…";
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      const data = await res.json();
      render(data);
      markLoaded();
    } catch (err) {
      console.error(err);
    } finally {
      btn.classList.remove("spinning");
    }
  });

  function closeAllMenus() {
    document.getElementById("entity-filter-menu").setAttribute("hidden", "");
    document.getElementById("entity-filter-btn").setAttribute("aria-expanded", "false");
    document.querySelectorAll(".card-details.open").forEach((d) => d.classList.remove("open"));
  }

  // Positions a card's floating `.card-details` popup from its card's real
  // viewport rect, same anchoring approach as .entity-filter-menu. Prefers
  // below the card; flips above if there isn't room. At most one popup is
  // open at a time.
  function showCardDetails(card) {
    const details = card.querySelector(".card-details");
    if (!details) return;
    document.querySelectorAll(".card-details.open").forEach((d) => {
      if (d !== details) d.classList.remove("open");
    });

    details.classList.add("open");
    const rect = card.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow >= details.offsetHeight + 12 || rect.top < details.offsetHeight) {
      details.style.top = `${rect.bottom + 6}px`;
      details.style.bottom = "";
    } else {
      details.style.top = "";
      details.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    }
    const left = Math.min(rect.left, window.innerWidth - details.offsetWidth - 12);
    details.style.left = `${Math.max(8, left)}px`;
  }

  function hideCardDetails(card) {
    const details = card.querySelector(".card-details");
    if (details) details.classList.remove("open");
  }

  // No confirmation step before a dismiss fires (the old floating menu's
  // second click doubled as one) — recoverability now comes from this toast
  // instead, shown after every dismiss regardless of scope. One toast at a
  // time; a new dismiss replaces whatever's showing rather than stacking.
  let dismissToastTimer = null;

  // With `message`, a plain notice (a restore) with no Undo button.
  function showUndoToast(key, scope, message) {
    const toast = document.getElementById("dismiss-toast");
    const text = document.getElementById("dismiss-toast-text");
    if (!toast || !text) return;
    text.textContent = message || (scope === "forever" ? "Hidden indefinitely." : "Hidden until tomorrow.");
    const undo = toast.querySelector(".dismiss-toast-undo");
    if (undo) undo.hidden = Boolean(message);
    toast.dataset.key = message ? "" : key;
    toast.hidden = false;
    clearTimeout(dismissToastTimer);
    dismissToastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 12000);
  }

  function hideUndoToast() {
    clearTimeout(dismissToastTimer);
    const toast = document.getElementById("dismiss-toast");
    if (toast) toast.hidden = true;
  }

  async function dismiss(key, scope) {
    // A record missing candidateId/userId (candidateKey()/cardTopRight()'s
    // key argument) would otherwise produce "candidate:undefined" here —
    // sending that would silently succeed server-side and then incorrectly
    // group-dismiss every OTHER record that also happens to lack an id,
    // rather than just the one card the user actually clicked. Refuse and
    // log loudly instead of sending a request that looks successful but
    // does the wrong thing.
    if (!key || key.endsWith(":undefined")) {
      console.error(`[dismiss] refusing to dismiss — invalid key "${key}" (scope: "${scope}"). The underlying record is missing its id.`);
      return;
    }
    closeAllMenus();
    // Signed in with Google, the server records the account's name instead.
    let by = verifiedViewer() ? null : hiderName();
    if (by === undefined) by = await askHiderName();
    try {
      const res = await fetch("/api/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, scope, by: by || null }),
      });
      const data = await res.json();
      render(data);
      showUndoToast(key, scope);
    } catch (err) {
      console.error(`[dismiss] request failed for key "${key}" (scope: "${scope}"):`, err);
    }
  }

  async function undoDismiss() {
    const toast = document.getElementById("dismiss-toast");
    const key = toast && toast.dataset.key;
    hideUndoToast();
    if (!key) return;
    try {
      const res = await fetch("/api/undismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = await res.json();
      render(data);
    } catch (err) {
      console.error(`[undo] request failed for key "${key}":`, err);
    }
  }

  // Focuses the just-opened note editor for `candidateId`, cursor at the
  // end — called right after render() has synchronously rebuilt the DOM, so
  // the new textarea already exists. If the same candidate happens to
  // appear in more than one place (e.g. an Action queue row and a card),
  // this focuses whichever instance querySelector finds first; only one is
  // realistically being edited at a time.
  function focusNoteInput(candidateId) {
    const el = document.querySelector(`.note-input[data-candidate-id="${CSS.escape(candidateId)}"]`);
    if (el) {
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
    }
  }

  async function saveNote(candidateId, text) {
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId, text }),
      });
      const data = await res.json();
      openNoteEditors.delete(candidateId);
      render(data);
    } catch (err) {
      console.error(`[notes] save failed for candidate "${candidateId}":`, err);
    }
  }

  async function deleteNote(candidateId) {
    try {
      const res = await fetch("/api/notes/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId }),
      });
      const data = await res.json();
      openNoteEditors.delete(candidateId);
      render(data);
    } catch (err) {
      console.error(`[notes] delete failed for candidate "${candidateId}":`, err);
    }
  }

  // Runs the dismiss/undo button under `target`, if any. Shared by both the
  // pointerdown and click listeners below so the two can't drift apart.
  function activateDismissControl(target) {
    const dismissBtn = target.closest(".dismiss-btn");
    if (dismissBtn) {
      dismiss(dismissBtn.dataset.key, dismissBtn.dataset.scope);
      return true;
    }
    const undoBtn = target.closest(".dismiss-toast-undo");
    if (undoBtn) {
      undoDismiss();
      return true;
    }
    return false;
  }

  // Dismiss/undo fire on pointerdown, not just click — click alone is what a
  // page-covering extension overlay (password manager, ad blocker, etc.)
  // most commonly intercepts, since that's the event most sites listen for.
  // pointerdown fires earlier in the same interaction and is far less
  // commonly swallowed. `lastPointerActivation` records which exact element
  // handled it so the click that normally follows doesn't re-fire the same
  // action a second time — this only compares by element reference within a
  // short window, so it never suppresses a genuine second click (e.g. a
  // keyboard-triggered click, which has no preceding pointerdown at all and
  // so is handled here same as before).
  let lastPointerActivation = null;

  document.addEventListener("pointerdown", (e) => {
    const control = e.target.closest(".dismiss-btn, .dismiss-toast-undo");
    if (!control) return;
    lastPointerActivation = { el: control, time: Date.now() };
    activateDismissControl(e.target);
  });

  // One delegated listener handles every card's dismiss control, since cards
  // are re-rendered on each poll.
  document.addEventListener("click", (e) => {
    const control = e.target.closest(".dismiss-btn, .dismiss-toast-undo");
    if (control) {
      const alreadyHandled =
        lastPointerActivation && lastPointerActivation.el === control && Date.now() - lastPointerActivation.time < 1000;
      if (!alreadyHandled) activateDismissControl(e.target);
      return;
    }

    const remindBtn = e.target.closest(".remind-btn");
    if (remindBtn) {
      sendReminder(remindBtn.dataset.eventId);
      return;
    }

    const loadBtn = e.target.closest(".load-period-btn");
    if (loadBtn) {
      loadPeriod = loadBtn.dataset.loadPeriod;
      if (lastData) renderInterviewerLoad(lastData.interviewerLoad, sectionHasError(lastData, "interviewerLoad"));
      return;
    }

    const restoreBtn = e.target.closest(".hidden-restore-btn");
    if (restoreBtn) {
      restoreHidden(restoreBtn.dataset.key);
      return;
    }

    if (e.target.closest(".hider-name-change")) {
      askHiderName().then(() => { if (lastData) render(lastData); });
      return;
    }

    const noteAddBtn = e.target.closest(".note-add-btn");
    if (noteAddBtn) {
      const candidateId = noteAddBtn.dataset.candidateId;
      openNoteEditors.set(candidateId, "");
      if (lastData) render(lastData);
      focusNoteInput(candidateId);
      return;
    }

    const noteEditBtn = e.target.closest(".note-edit-btn");
    if (noteEditBtn) {
      const candidateId = noteEditBtn.dataset.candidateId;
      openNoteEditors.set(candidateId, findCandidateNote(candidateId));
      if (lastData) render(lastData);
      focusNoteInput(candidateId);
      return;
    }

    const noteCancelBtn = e.target.closest(".note-cancel-btn");
    if (noteCancelBtn) {
      openNoteEditors.delete(noteCancelBtn.dataset.candidateId);
      if (lastData) render(lastData);
      return;
    }

    const noteDeleteBtn = e.target.closest(".note-delete-btn");
    if (noteDeleteBtn) {
      deleteNote(noteDeleteBtn.dataset.candidateId);
      return;
    }

    const noteSaveBtn = e.target.closest(".note-save-btn");
    if (noteSaveBtn) {
      const candidateId = noteSaveBtn.dataset.candidateId;
      const editor = noteSaveBtn.closest(".note-block");
      const textarea = editor ? editor.querySelector(".note-input") : null;
      saveNote(candidateId, textarea ? textarea.value : "");
      return;
    }

    const pausedToggle = e.target.closest(".show-paused-toggle");
    if (pausedToggle) {
      showPausedTrainees = !showPausedTrainees;
      if (lastData) render(lastData);
      return;
    }

    // Sidebar's Triage queues group and the chip row above the Action queue
    // table are two surfaces for the same `activeSignal` state — this
    // selector only matches elements that actually carry `data-signal`
    // (both `.signal-chip` and the sidebar's Triage `.queue-nav-item`
    // buttons), so the Watchlist group's plain anchor links (no
    // `data-signal`) fall through untouched, navigating normally.
    // The sidebar's Watchlist links jump to a section: logged, then left to
    // navigate as before.
    const sectionLink = e.target.closest('a.queue-nav-item[href^="#"]');
    if (sectionLink) trackUsage("section", { detail: (sectionLink.querySelector("span") || sectionLink).textContent.trim() });

    if (e.target.closest("[data-stale-toggle]")) {
      showStale = !showStale;
      trackUsage("queue", { detail: showStale ? "Stale shown" : "Stale hidden" });
      if (lastData) render(lastData);
      return;
    }

    const signalControl = e.target.closest("[data-signal]");
    if (signalControl) {
      activeSignal = signalControl.dataset.signal;
      const queue = TRIAGE_QUEUES.find((q) => q.key === activeSignal);
      trackUsage("queue", { detail: queue ? queue.label : activeSignal === "hidden" ? "Hidden & snoozed" : "All action items" });
      if (lastData) render(lastData);
      return;
    }

    const modeBtn = e.target.closest(".filter-mode-btn");
    if (modeBtn) {
      const newMode = modeBtn.dataset.mode;
      if (newMode !== filterMode) {
        filterMode = newMode;
        document.querySelectorAll(".filter-mode-btn").forEach((b) => {
          const isActive = b.dataset.mode === filterMode;
          b.classList.toggle("is-active", isActive);
          b.setAttribute("aria-pressed", isActive ? "true" : "false");
        });
        populateEntityOptions();
        if (lastData) render(lastData);
      }
      return;
    }

    const entityReset = e.target.closest(".entity-filter-reset");
    if (entityReset) {
      activeSelection().ids.clear();
      populateEntityOptions();
      if (lastData) render(lastData);
      return;
    }

    const entityToggle = e.target.closest("#entity-filter-btn");
    if (entityToggle) {
      const menu = document.getElementById("entity-filter-menu");
      const wasHidden = menu.hasAttribute("hidden");
      closeAllMenus();
      if (wasHidden) {
        // Fixed position, anchored to the toggle's real viewport rect (not
        // CSS relative-positioning) so it can't be clipped by a scrollable
        // ancestor — same reasoning `.card-details` uses above.
        const rect = entityToggle.getBoundingClientRect();
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.right = `${window.innerWidth - rect.right}px`;
        menu.removeAttribute("hidden");
        entityToggle.setAttribute("aria-expanded", "true");
      }
      return;
    }

    // Clicks inside the entity menu itself (e.g. on a checkbox's label text)
    // shouldn't close it — selecting multiple options requires the menu to
    // stay open across several clicks. Its own change listener below
    // handles updating the filter; this just prevents the fallthrough close.
    if (e.target.closest("#entity-filter-menu")) {
      return;
    }

    closeAllMenus();
  });

  // Checking/unchecking an option re-renders instantly from the cached
  // snapshot — no network call — and deliberately leaves the menu open so
  // several options can be picked in one go.
  document.getElementById("entity-filter-menu").addEventListener("change", (e) => {
    const checkbox = e.target.closest("input[type=checkbox]");
    if (!checkbox) return;
    const { ids } = activeSelection();
    if (checkbox.checked) {
      ids.add(checkbox.value);
    } else {
      ids.delete(checkbox.value);
    }
    updateEntityButtonLabel();
    if (lastData) render(lastData);
  });

  // Keeps openNoteEditors' draft current as a coordinator types — doesn't
  // itself re-render (that would fight the cursor position); it just makes
  // sure that when render() DOES run again (the next 60s poll, most
  // commonly), noteBlockHtml() repopulates the textarea with what they've
  // typed so far instead of reverting to the last-saved note.
  document.addEventListener("input", (e) => {
    const textarea = e.target.closest(".note-input");
    if (!textarea) return;
    const candidateId = textarea.dataset.candidateId;
    if (candidateId) openNoteEditors.set(candidateId, textarea.value);
  });

  // A menu positioned from a stale rect (post-scroll) would float away from
  // its button, so any scroll closes it.
  // Exception: the entity menu's own internal scroll (it's overflow-y: auto
  // so long option lists can scroll) would otherwise trigger this same
  // capture-phase listener and immediately close itself.
  window.addEventListener(
    "scroll",
    (e) => {
      if (e.target instanceof Element && e.target.closest("#entity-filter-menu")) return;
      closeAllMenus();
    },
    true
  );

  // Hover/focus delegation for the candidate-card detail popup — shared by
  // candidate cards (cardHtml()) and the Onsite Interviews Today timeline
  // (renderOnsiteToday()), the two places a `.card-details` popup shows up.
  // mouseover/mouseout (rather than mouseenter/mouseleave) so a single
  // listener on document can handle every card/row even as they're
  // re-rendered on each poll; the relatedTarget check treats moving between
  // an item's own children (e.g. name -> the popup itself, since it's a DOM
  // descendant of the item even though it renders fixed-position) as
  // staying "inside," so it doesn't flicker closed. focusin/focusout mirror
  // the same logic for keyboard users tabbing to the name link and then the
  // dismiss button inside the now-visible popup.
  const HOVER_DETAIL_SELECTOR = ".card, .onsite-timeline-item";
  document.addEventListener("mouseover", (e) => {
    const item = e.target.closest(HOVER_DETAIL_SELECTOR);
    if (!item || (e.relatedTarget && item.contains(e.relatedTarget))) return;
    showCardDetails(item);
  });
  document.addEventListener("mouseout", (e) => {
    const item = e.target.closest(HOVER_DETAIL_SELECTOR);
    if (!item || (e.relatedTarget && item.contains(e.relatedTarget))) return;
    hideCardDetails(item);
  });
  document.addEventListener("focusin", (e) => {
    const item = e.target.closest(HOVER_DETAIL_SELECTOR);
    if (item) showCardDetails(item);
  });
  document.addEventListener("focusout", (e) => {
    const item = e.target.closest(HOVER_DETAIL_SELECTOR);
    if (!item || (e.relatedTarget && item.contains(e.relatedTarget))) return;
    hideCardDetails(item);
  });

  // Touch has no hover state to reveal the popup with, and no reliable
  // "moved away" signal to close it either — a tap anywhere on the
  // item (except its dismiss buttons or its name link, both of which
  // already do something on tap) toggles the popup instead, so it's
  // reachable at all on a touchscreen. Harmless on desktop too: clicking
  // an already hover-opened popup just closes it, a reasonable "tap away"
  // gesture rather than a conflict.
  document.addEventListener("click", (e) => {
    const item = e.target.closest(HOVER_DETAIL_SELECTOR);
    // .note-block is excluded same as .dismiss/a[href] — a tap on the
    // note's Add/Edit/Delete/Save/Cancel controls (or into its textarea)
    // shouldn't also toggle the unrelated .card-details popup open/closed.
    if (!item || e.target.closest(".dismiss, a[href], .note-block")) return;
    const details = item.querySelector(".card-details");
    if (details) details.classList.toggle("open");
  });

  // Top-level page tabs (Dashboard / Interviewer Info) — pure DOM show/hide
  // via the `hidden` attribute, independent of render()/data refresh (both
  // tab panels' cards get rendered on every poll regardless of which is
  // visible — cheap, and means switching tabs never shows stale content).
  // Generic over `.tab-panel` ids matching `tab-<data-tab value>`, so a
  // future third tab needs no changes here.
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      trackUsage("tab", { detail: btn.textContent.trim() });
      document.querySelectorAll(".tab-btn").forEach((b) => {
        const isActive = b.dataset.tab === target;
        b.classList.toggle("is-active", isActive);
        b.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.toggleAttribute("hidden", panel.id !== `tab-${target}`);
      });
      syncFilterBar();
    });
  });

  // The filter bar sits above the tabs and shows only where something
  // follows it: the Dashboard, and Interviewer Info when Interviewer Load is
  // on. Elsewhere (Offers, Feedback Leaderboard, Scheduling) it's hidden, so
  // a selection is never in force without the control in view.
  function syncFilterBar() {
    const bar = document.getElementById("filter-bar");
    if (!bar) return;
    const open = [...document.querySelectorAll(".tab-panel")].find((p) => !p.hidden);
    const follows = open && (open.id === "tab-dashboard" || (open.id === "tab-interviewers" && open.querySelector('[data-key="interviewerLoad"]')));
    bar.hidden = !follows;
  }

  async function loadViewer() {
    try {
      const res = await fetch("/api/viewer");
      if (res.ok) viewer = await res.json();
    } catch (err) {
      console.error("[viewer]", err);
    }
    const el = document.getElementById("signed-in-as");
    if (!el || !viewer.signIn || !viewer.method) return;
    const who = viewer.method === "google" ? escapeHtml(viewer.email) : "Dashboard password";
    const usageLink = viewer.admin ? `<a href="/usage">Usage log</a> · ` : "";
    el.innerHTML = `${who} · ${usageLink}<form method="post" action="/signout"><button type="submit" class="signout-btn">Sign out</button></form>`;
    el.hidden = false;
  }

  const loadSearchInput = document.getElementById("load-search");
  if (loadSearchInput) {
    loadSearchInput.addEventListener("input", () => {
      loadSearch = loadSearchInput.value;
      if (lastData) renderInterviewerLoad(lastData.interviewerLoad, sectionHasError(lastData, "interviewerLoad"));
    });
  }

  loadViewer().finally(load);
  setInterval(load, REFRESH_MS);
})();
