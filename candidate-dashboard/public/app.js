(() => {
  const REFRESH_MS = 60 * 1000;

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

  function isSectionDisabled(key) {
    return disabledSectionKeys.has(key);
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
    "staleCandidates",
    "recentSourced",
    "onsiteToday",
    "rescheduledInterviews",
  ];

  function collectDistinct(data, idKey, nameKey) {
    const byId = new Map();
    for (const key of CANDIDATE_SECTION_KEYS) {
      if (isSectionDisabled(key)) continue;
      for (const item of (data || {})[key] || []) {
        if (item[idKey] && !byId.has(item[idKey])) {
          byId.set(item[idKey], item[nameKey] || "Unknown");
        }
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
    for (const key of CANDIDATE_SECTION_KEYS) {
      if (isSectionDisabled(key)) continue;
      for (const item of (data || {})[key] || []) {
        if (item.departmentId) ids.add(item.departmentId);
      }
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
      renderDetail: (item) =>
        item.interviewers && item.interviewers.length
          ? `Waiting on: ${item.interviewers.map((i) => i.name).join(", ")}`
          : "",
    },
    {
      key: "needsScheduling",
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
      renderDetail: (item) =>
        `Currently scheduled: ${formatEventDateTime(item.startTime)}` +
        (item.interviewers && item.interviewers.length
          ? ` — Interviewers: ${item.interviewers.map((i) => i.name).join(", ")}`
          : ""),
    },
  ];

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

  function candidateKey(item) {
    return `candidate:${item.candidateId}`;
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
    return `
      <div class="card sev-${sev}">
        <div class="card-top">
          <div class="card-name">${nameHtml}</div>
          ${dismissHtml(candidateKey(item))}
        </div>
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
        <td class="aq-candidate">${nameHtml}</td>
        <td class="aq-stage-role">
          <div class="aq-stage">${queue.label}</div>
          <div class="aq-role">${item.jobTitle || ""}</div>
        </td>
        <td><span class="signal-tag ${queue.signalClass}">${queue.label}</span></td>
        <td class="aq-waiting ${sevClass}"${detail ? ` title="${detail}"` : ""}>${queue.waitingLabel(hours)}</td>
        <td class="aq-dismiss">${dismissHtml(candidateKey(item))}</td>
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
      if (!isSectionDisabled("staleCandidates")) {
        rows.push(`
          <a class="queue-nav-item" href="#staleCandidates">
            <span>Stale candidates</span><span class="queue-count">${filterByEntity(data.staleCandidates || []).length}</span>
          </a>`);
      }
      watchlistNav.innerHTML = rows.join("");
    }
  }

  function renderSignalChips(countsByQueue, totalCount) {
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
    renderSignalChips(countsByQueue, totalCount);
    updateActionQueueFootnote(data.thresholds && data.thresholds.rescheduleCountThreshold);

    const sub = document.getElementById("actionQueue-sub");
    if (sub) {
      sub.textContent = totalCount
        ? `${totalCount} candidate${totalCount === 1 ? "" : "s"} blocked on a coordinator action, ordered by how long each has been waiting.`
        : "Nothing blocked on a coordinator action right now.";
    }

    const visibleRows = activeSignal === "all" ? allRows : allRows.filter((r) => r.queue.key === activeSignal);
    const tbody = document.getElementById("action-queue-body");
    if (!tbody) return;
    tbody.innerHTML = visibleRows.length
      ? visibleRows.map((row) => actionQueueRowHtml(row, data.thresholds)).join("")
      : `<tr><td colspan="5"><div class="empty-state">Nothing flagged</div></td></tr>`;
  }

  function renderStale(items) {
    const container = document.getElementById("cards-staleCandidates");
    if (!items.length) {
      container.innerHTML = `<div class="empty-state">Nothing flagged</div>`;
      return;
    }
    container.innerHTML = items
      .map((item) =>
        cardHtml(item, {
          sev: "critical",
          ageLabel: `${formatAge(item.hoursStale)} stale`,
          reasonBadge: item.reasonLabel,
          detail:
            item.interviewers && item.interviewers.length
              ? `Waiting on: ${item.interviewers.map((i) => i.name).join(", ")}`
              : "",
        })
      )
      .join("");
  }

  function renderInterviewerLimits(items) {
    const container = document.getElementById("cards-interviewerLimits");
    if (!items.length) {
      container.innerHTML = `<div class="empty-state">Nothing flagged</div>`;
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

  function renderInterviewerTraining(items) {
    const container = document.getElementById("cards-interviewerTraining");
    const toggleContainer = document.getElementById("interviewerTraining-toggle");
    const pausedCount = items.filter((item) => item.isPaused).length;

    toggleContainer.innerHTML = pausedCount
      ? `<button type="button" class="show-paused-toggle">${showPausedTrainees ? "Hide" : "Show"} ${pausedCount} paused interview trainee${pausedCount === 1 ? "" : "s"}</button>`
      : "";

    const visible = showPausedTrainees ? items : items.filter((item) => !item.isPaused);
    if (!visible.length) {
      container.innerHTML = `<div class="empty-state">Nothing flagged</div>`;
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

  function renderRecentSourced(items) {
    const container = document.getElementById("cards-recentSourced");
    if (!items.length) {
      container.innerHTML = `<div class="empty-state">Nothing flagged</div>`;
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
  function renderOnsiteToday(items) {
    const container = document.getElementById("cards-onsiteToday");
    if (!items.length) {
      container.innerHTML = `<div class="empty-state">Nothing scheduled today</div>`;
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
            <div class="onsite-timeline-body">
              <div class="onsite-timeline-name">${nameHtml}</div>
              ${subParts.length ? `<div class="onsite-timeline-sub">${subParts.join(" · ")}</div>` : ""}
              ${interviewerText ? `<div class="onsite-timeline-sub">${interviewerText}</div>` : ""}
            </div>
            <div class="onsite-timeline-dismiss">${dismissHtml(candidateKey(item))}</div>
          </div>`;
      })
      .join("");
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

  function renderOfferColumn(col, items) {
    const container = document.getElementById(`cards-${col.key}`);
    if (!items.length) {
      container.innerHTML = `<div class="empty-state">${col.emptyText}</div>`;
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
    "interviewerLimits",
    "recentSourced",
    "staleCandidates",
    "onsiteToday",
    "interviewerTraining",
    "offersNotYetSent",
    "offersAwaitingAcceptance",
    "offersSigned",
  ];

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
  // structural CSS — `.page-stack > * + *`'s divider — recomputes against
  // the real remaining siblings instead of leaving a stray divider where the
  // removed section used to be. Collapses a now-empty `.side-margin` too, so
  // a disabled Onsite Interviews Today doesn't leave an empty gap. Only
  // covers keys that still have their own static `[data-key]` section —
  // recentSourced/staleCandidates/onsiteToday. The four TRIAGE_QUEUES keys
  // don't (they're merged rows in one table now, not separate sections);
  // renderActionQueue()'s own per-queue isSectionDisabled() checks handle
  // those, same idea, different mechanism since there's no longer a whole
  // section to remove for just one of the four.
  function applyDisabledSections(disabledSections) {
    disabledSectionKeys = new Set(disabledSections || []);
    for (const key of disabledSectionKeys) {
      const section = document.querySelector(`[data-key="${key}"]`);
      if (!section) continue; // already removed on a previous render, or not a static-section key

      const sideMargin = section.closest(".side-margin");
      section.remove();

      if (sideMargin && !sideMargin.querySelector(".column")) sideMargin.remove();
    }
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
    applyDisabledSections(appConfig.disabledSections);
  }

  function render(data) {
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
    renderActionQueue(data);
    renderSectionTimestamp("actionQueue", data.lastUpdated, data.lastError);
    if (!isSectionDisabled("staleCandidates")) renderStale(filterByEntity(data.staleCandidates || []));
    if (!isSectionDisabled("interviewerLimits")) {
      renderInterviewerLimits(data.interviewerLimits || []); // no department/job filter — no job/department concept for an interviewer
    }
    if (!isSectionDisabled("interviewerTraining")) {
      renderInterviewerTraining(data.interviewerTraining || []); // same — not tied to a candidate
    }
    if (!isSectionDisabled("recentSourced")) {
      renderRecentSourced(filterByEntity(data.recentSourced || []));
      const appConfig = data.appConfig || {};
      updateSourcedSubtitle(
        data.thresholds && data.thresholds.sourcedLookbackDays,
        appConfig.sourceReferralKeywords,
        appConfig.sourceAgencyKeywords
      );
    }
    if (!isSectionDisabled("onsiteToday")) {
      renderOnsiteToday(filterByEntity(data.onsiteToday || []));
      updateOnsiteSubtitle(data.appConfig && data.appConfig.onsiteStageKeywords);
    }
    for (const col of offerColumns) {
      if (isSectionDisabled(col.key)) continue;
      renderOfferColumn(col, data[col.key] || []);
    }
    if (!isSectionDisabled("offersSigned")) {
      updateOffersSignedSubtitle(data.thresholds && data.thresholds.offersSignedLookbackDays);
    }

    for (const key of SECTION_TIMESTAMP_KEYS) {
      if (isSectionDisabled(key)) continue;
      renderSectionTimestamp(key, data.lastUpdated, data.lastError);
    }

    // Always reassigns (never appends) before optionally appending the error
    // below — `data.lastUpdated` stays null forever if every refresh since
    // startup has failed, which used to mean the `if (data.lastUpdated)`
    // branch never ran to reset textContent first; with `+=` as the only
    // write, each failed poll (every 60s) appended another copy of the same
    // error onto whatever was already there instead of replacing it.
    const lastUpdatedEl = document.getElementById("last-updated");
    lastUpdatedEl.textContent = data.lastUpdated
      ? `Updated ${new Date(data.lastUpdated).toLocaleTimeString([], { timeZone: displayTimeZone })}`
      : "Never updated";
    if (data.lastError) {
      lastUpdatedEl.textContent += ` — last refresh failed: ${data.lastError}`;
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

  function showUndoToast(key, scope) {
    const toast = document.getElementById("dismiss-toast");
    const text = document.getElementById("dismiss-toast-text");
    if (!toast || !text) return;
    text.textContent = scope === "forever" ? "Hidden indefinitely." : "Hidden until tomorrow.";
    toast.dataset.key = key;
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
    try {
      const res = await fetch("/api/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, scope }),
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
    const signalControl = e.target.closest("[data-signal]");
    if (signalControl) {
      activeSignal = signalControl.dataset.signal;
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

  // A menu positioned from a stale rect (post-scroll) would float away from
  // its button, so any scroll — page or a .cards container — closes it.
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

  // Hover/focus delegation for the candidate-card detail popup. mouseover/
  // mouseout (rather than mouseenter/mouseleave) so a single listener on
  // document can handle every card even as they're re-rendered on each
  // poll; the relatedTarget check treats moving between a card's own
  // children (e.g. name -> the popup itself, since it's a DOM descendant of
  // .card even though it renders fixed-position) as staying "inside" the
  // card, so it doesn't flicker closed. focusin/focusout mirror the same
  // logic for keyboard users tabbing to the name link and then the dismiss
  // button inside the now-visible popup.
  document.addEventListener("mouseover", (e) => {
    const card = e.target.closest(".card");
    if (!card || (e.relatedTarget && card.contains(e.relatedTarget))) return;
    showCardDetails(card);
  });
  document.addEventListener("mouseout", (e) => {
    const card = e.target.closest(".card");
    if (!card || (e.relatedTarget && card.contains(e.relatedTarget))) return;
    hideCardDetails(card);
  });
  document.addEventListener("focusin", (e) => {
    const card = e.target.closest(".card");
    if (card) showCardDetails(card);
  });
  document.addEventListener("focusout", (e) => {
    const card = e.target.closest(".card");
    if (!card || (e.relatedTarget && card.contains(e.relatedTarget))) return;
    hideCardDetails(card);
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
      document.querySelectorAll(".tab-btn").forEach((b) => {
        const isActive = b.dataset.tab === target;
        b.classList.toggle("is-active", isActive);
        b.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.toggleAttribute("hidden", panel.id !== `tab-${target}`);
      });
    });
  });

  load();
  setInterval(load, REFRESH_MS);
})();
