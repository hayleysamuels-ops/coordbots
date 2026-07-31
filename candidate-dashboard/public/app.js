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

  // Sections this deployment has turned off (DISABLED_SECTIONS, see
  // config.js) — populated from appConfig once, in applyDisabledSections().
  // render() checks this instead of every renderX() guarding a possibly-
  // removed container, so the removal logic lives in one place.
  let disabledSectionKeys = new Set();

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
      options: () => lastDepartments,
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

  const columns = [
    {
      key: "feedbackOverdue",
      hoursField: "hoursOverdue",
      thresholdKey: "feedbackOverdueHours",
      renderDetail: (item) =>
        item.interviewers && item.interviewers.length
          ? `Waiting on: ${item.interviewers.map((i) => i.name).join(", ")}`
          : "",
      ageLabel: (hours) => `${formatAge(hours)} overdue`,
    },
    {
      key: "needsScheduling",
      hoursField: "hoursPending",
      thresholdKey: "needsSchedulingAlertHours",
      renderDetail: () => "",
      ageLabel: (hours) => `${formatAge(hours)} pending`,
    },
    {
      key: "availabilitySubmitted",
      hoursField: "hoursWaiting",
      thresholdKey: "availabilitySubmittedAlertHours",
      renderDetail: () => "",
      ageLabel: (hours) => `${formatAge(hours)} waiting`,
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

  // The per-card dismiss control: a "×" that toggles a small menu offering the
  // two durations. `key` is "candidate:<id>" or "interviewer:<id>".
  function dismissHtml(key) {
    return `
      <div class="dismiss">
        <button class="dismiss-btn" data-key="${key}" aria-label="Dismiss" title="Dismiss">×</button>
        <div class="dismiss-menu" hidden>
          <button data-key="${key}" data-scope="today">Hide until tomorrow</button>
          <button data-key="${key}" data-scope="forever">Hide indefinitely</button>
        </div>
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

  function renderColumn(col, items, threshold) {
    const container = document.getElementById(`cards-${col.key}`);
    if (!items.length) {
      container.innerHTML = `<div class="empty-state">Nothing flagged</div>`;
      return;
    }
    container.innerHTML = items
      .map((item) => {
        const hours = item[col.hoursField];
        return cardHtml(item, {
          sev: severity(hours, threshold),
          ageLabel: col.ageLabel(hours),
          detail: col.renderDetail(item),
        });
      })
      .join("");
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

  // Rendered in the browser's own local timezone — the "is this today"
  // filtering happens server-side on a UTC calendar day (see
  // listOnsiteToday in ashby.js), so this is display-only.
  function formatEventTime(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  // Unlike formatEventTime above (today's onsite events, time-only), a
  // rescheduled interview's current slot could be any date, so this
  // includes the date too.
  function formatEventDateTime(iso) {
    if (!iso) return "not yet scheduled";
    return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
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

  function renderOnsiteToday(items) {
    const container = document.getElementById("cards-onsiteToday");
    if (!items.length) {
      container.innerHTML = `<div class="empty-state">Nothing scheduled today</div>`;
      return;
    }
    container.innerHTML = items
      .map((item) =>
        cardHtml(item, {
          sev: "warning",
          ageLabel: formatEventTime(item.startTime),
          ageClass: "muted",
          reasonBadge: item.stageTitle,
          detail:
            item.interviewers && item.interviewers.length
              ? `Interviewers: ${item.interviewers.map((i) => i.name).join(", ")}`
              : "",
        })
      )
      .join("");
  }

  function renderRescheduledInterviews(items) {
    const container = document.getElementById("cards-rescheduledInterviews");
    if (!items.length) {
      container.innerHTML = `<div class="empty-state">Nothing flagged</div>`;
      return;
    }
    container.innerHTML = items
      .map((item) =>
        cardHtml(item, {
          sev: "critical",
          ageLabel: `${item.rescheduleCount} reschedules`,
          detail:
            `Currently scheduled: ${formatEventDateTime(item.startTime)}` +
            (item.interviewers && item.interviewers.length
              ? ` — Interviewers: ${item.interviewers.map((i) => i.name).join(", ")}`
              : ""),
        })
      )
      .join("");
  }

  const SECTION_TIMESTAMP_KEYS = [
    "feedbackOverdue",
    "needsScheduling",
    "availabilitySubmitted",
    "interviewerLimits",
    "recentSourced",
    "staleCandidates",
    "onsiteToday",
    "rescheduledInterviews",
    "interviewerTraining",
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

  // Removes a disabled section's nav link and <section> entirely (not just
  // `hidden`) so structural CSS — `.page-stack > * + *`'s divider,
  // `.row-pair > .column:not(:first-child)`'s border — recomputes against
  // the real remaining siblings instead of leaving a stray divider/border
  // where the removed section used to be. Collapses now-empty wrapper
  // containers (`.row-pair`, `.side-margin`) too, so an all-disabled pair or
  // a disabled Onsite Interviews Today doesn't leave an empty gap.
  function applyDisabledSections(disabledSections) {
    disabledSectionKeys = new Set(disabledSections || []);
    for (const key of disabledSectionKeys) {
      const section = document.querySelector(`[data-key="${key}"]`);
      if (!section) continue; // already removed on a previous render, or not a real section key

      const navLink = document.querySelector(`.section-nav a[href="#${key}"]`);
      if (navLink) navLink.remove();

      const rowPair = section.closest(".row-pair");
      const sideMargin = section.closest(".side-margin");
      section.remove();

      if (rowPair && !rowPair.querySelector(".column")) rowPair.remove();
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
    // exists.
    for (const col of columns) {
      if (isSectionDisabled(col.key)) continue;
      renderColumn(col, filterByEntity(data[col.key] || []), data.thresholds[col.thresholdKey]);
    }
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
    if (!isSectionDisabled("rescheduledInterviews")) {
      renderRescheduledInterviews(filterByEntity(data.rescheduledInterviews || []));
      updateRescheduledSubtitle(data.thresholds && data.thresholds.rescheduleCountThreshold);
    }

    for (const key of SECTION_TIMESTAMP_KEYS) {
      if (isSectionDisabled(key)) continue;
      renderSectionTimestamp(key, data.lastUpdated, data.lastError);
    }

    const lastUpdatedEl = document.getElementById("last-updated");
    if (data.lastUpdated) {
      lastUpdatedEl.textContent = `Updated ${new Date(data.lastUpdated).toLocaleTimeString()}`;
    }
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
    el.textContent =
      `Today's interviews whose stage title contains ${quoted}. Ashby has no per-interview onsite flag ` +
      `in this org, so this is approximated by interview stage name rather than a real location signal.`;
  }

  // "More than a couple times" used to be a fixed phrase regardless of the
  // actual RESCHEDULE_COUNT_THRESHOLD value.
  function updateRescheduledSubtitle(threshold) {
    const el = document.getElementById("rescheduledInterviews-sub");
    if (!el || !threshold) return;
    el.textContent =
      `Interview events rescheduled more than ${threshold} time${threshold === 1 ? "" : "s"}. Ashby has no ` +
      `reschedule history of its own, so this only counts reschedules this app has actually observed since ` +
      `it started tracking — it can't see further back than that.`;
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
      `Last loaded ${new Date().toLocaleTimeString()}`;
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
    document.querySelectorAll(".dismiss-menu").forEach((m) => m.setAttribute("hidden", ""));
    document.getElementById("entity-filter-menu").setAttribute("hidden", "");
    document.getElementById("entity-filter-btn").setAttribute("aria-expanded", "false");
    document.querySelectorAll(".card-details.open").forEach((d) => d.classList.remove("open"));
  }

  // Positions a card's floating `.card-details` popup from its card's real
  // viewport rect, same anchoring approach as .dismiss-menu/.entity-filter-menu.
  // Prefers below the card; flips above if there isn't room. At most one
  // popup is open at a time.
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

  async function dismiss(key, scope) {
    closeAllMenus();
    try {
      const res = await fetch("/api/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, scope }),
      });
      const data = await res.json();
      render(data);
    } catch (err) {
      console.error(err);
    }
  }

  // One delegated listener handles every card's dismiss control, since cards
  // are re-rendered on each poll. Order matters: menu-item click before the
  // toggle, and a click anywhere else closes any open menu.
  document.addEventListener("click", (e) => {
    const menuItem = e.target.closest(".dismiss-menu button");
    if (menuItem) {
      dismiss(menuItem.dataset.key, menuItem.dataset.scope);
      return;
    }
    const toggle = e.target.closest(".dismiss-btn");
    if (toggle) {
      const menu = toggle.parentElement.querySelector(".dismiss-menu");
      const wasHidden = menu.hasAttribute("hidden");
      closeAllMenus();
      if (wasHidden) {
        // Anchor the fixed-position menu to the button's real viewport
        // position (not CSS relative-positioning) so it can't be clipped by
        // the scrollable .cards container it lives inside.
        const rect = toggle.getBoundingClientRect();
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.right = `${window.innerWidth - rect.right}px`;
        menu.removeAttribute("hidden");
      }
      return;
    }

    const pausedToggle = e.target.closest(".show-paused-toggle");
    if (pausedToggle) {
      showPausedTrainees = !showPausedTrainees;
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
        // Anchored the same way as .dismiss-menu — see rationale above.
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
