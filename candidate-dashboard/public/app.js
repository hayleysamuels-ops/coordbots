(() => {
  const REFRESH_MS = 60 * 1000;

  // Department filter is purely client-side: the last-fetched snapshot is
  // cached here so changing the dropdown re-renders instantly without a
  // network round-trip. Applies to every candidate-facing section; NOT
  // Interviewer Weekly Limits, which has no department concept (an
  // interviewer isn't tied to one job/department the way a candidate's
  // application is).
  let lastData = null;
  let selectedDepartmentId = "";

  function filterByDepartment(items) {
    if (!selectedDepartmentId) return items;
    return items.filter((item) => item.departmentId === selectedDepartmentId);
  }

  // Rebuilds the dropdown's options from the latest department list, keeping
  // the current selection if it's still a valid option (departments rarely
  // change, but the snapshot refreshes periodically regardless).
  function populateDepartmentOptions(departments) {
    const select = document.getElementById("department-filter");
    const previousValue = select.value;
    const options = ['<option value="">All departments</option>']
      .concat(departments.map((d) => `<option value="${d.id}">${d.name}</option>`));
    select.innerHTML = options.join("");
    if (departments.some((d) => d.id === previousValue)) {
      select.value = previousValue;
    }
    selectedDepartmentId = select.value;
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

  function cardHtml(item, { sev, ageLabel, detail, reasonBadge }) {
    const nameHtml = item.ashbyProfileUrl
      ? `<a href="${item.ashbyProfileUrl}" target="_blank" rel="noopener">${item.candidateName || "Unknown candidate"}</a>`
      : item.candidateName || "Unknown candidate";

    return `
      <div class="card sev-${sev}">
        <div class="card-top">
          <div class="card-name">${nameHtml}</div>
          ${cardTopRight(ageLabel, `sev-${sev}`, candidateKey(item))}
        </div>
        <div class="card-sub">${item.jobTitle || ""}</div>
        ${reasonBadge ? `<div class="reason-badge">${reasonBadge}</div>` : ""}
        ${detail ? `<div class="card-detail">${detail}</div>` : ""}
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

  function formatAgo(iso) {
    const hours = (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60);
    if (hours < 1) return "just now";
    return `${formatAge(hours)} ago`;
  }

  function renderRecentSourced(items) {
    const container = document.getElementById("cards-recentSourced");
    if (!items.length) {
      container.innerHTML = `<div class="empty-state">Nothing flagged</div>`;
      return;
    }
    container.innerHTML = items
      .map((item) => {
        const nameHtml = item.ashbyProfileUrl
          ? `<a href="${item.ashbyProfileUrl}" target="_blank" rel="noopener">${item.candidateName || "Unknown candidate"}</a>`
          : item.candidateName || "Unknown candidate";
        const source = item.sourceTitle
          ? `${item.sourceCategory} · ${item.sourceTitle}`
          : item.sourceCategory;
        const statusBadge =
          item.status && item.status !== "Active"
            ? `<span class="status-badge">${item.status}</span>`
            : "";
        return `
          <div class="card sev-good">
            <div class="card-top">
              <div class="card-name">${nameHtml}</div>
              ${cardTopRight(formatAgo(item.createdAt), "muted", candidateKey(item))}
            </div>
            <div class="card-sub">${item.jobTitle || ""}</div>
            <div class="card-detail">${source}${statusBadge}</div>
          </div>
        `;
      })
      .join("");
  }

  function renderActiveReferrals(items) {
    const container = document.getElementById("cards-activeReferrals");
    if (!items.length) {
      container.innerHTML = `<div class="empty-state">Nothing flagged</div>`;
      return;
    }
    container.innerHTML = items
      .map((item) => {
        const nameHtml = item.ashbyProfileUrl
          ? `<a href="${item.ashbyProfileUrl}" target="_blank" rel="noopener">${item.candidateName || "Unknown candidate"}</a>`
          : item.candidateName || "Unknown candidate";
        return `
          <div class="card sev-good">
            <div class="card-top">
              <div class="card-name">${nameHtml}</div>
              ${cardTopRight(item.stageTitle, "muted", candidateKey(item))}
            </div>
            <div class="card-sub">${item.jobTitle || ""}</div>
          </div>
        `;
      })
      .join("");
  }

  // Six sections share one refresh cycle (data.lastUpdated/lastError);
  // Active Referrals refreshes independently on its own, much slower cycle
  // (data.activeReferralsUpdated/activeReferralsError) — see referralCache.js.
  // Per-section timestamps make that split visible instead of implying every
  // section is equally fresh.
  const SECTION_TIMESTAMP_KEYS = [
    "feedbackOverdue",
    "needsScheduling",
    "availabilitySubmitted",
    "interviewerLimits",
    "recentSourced",
    "staleCandidates",
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

  function render(data) {
    lastData = data;
    populateDepartmentOptions(data.departments || []);

    for (const col of columns) {
      renderColumn(col, filterByDepartment(data[col.key] || []), data.thresholds[col.thresholdKey]);
    }
    renderStale(filterByDepartment(data.staleCandidates || []));
    renderInterviewerLimits(data.interviewerLimits || []); // no department filter — see DEPARTMENT_FILTERED_KEYS note
    renderRecentSourced(filterByDepartment(data.recentSourced || []));
    renderActiveReferrals(filterByDepartment(data.activeReferrals || []));
    updateSourcedSubtitle(data.thresholds && data.thresholds.sourcedLookbackDays);

    for (const key of SECTION_TIMESTAMP_KEYS) {
      renderSectionTimestamp(key, data.lastUpdated, data.lastError);
    }
    renderSectionTimestamp("activeReferrals", data.activeReferralsUpdated, data.activeReferralsError);

    const lastUpdatedEl = document.getElementById("last-updated");
    if (data.lastUpdated) {
      lastUpdatedEl.textContent = `Updated ${new Date(data.lastUpdated).toLocaleTimeString()}`;
    }
    if (data.lastError) {
      lastUpdatedEl.textContent += ` — last refresh failed: ${data.lastError}`;
    }
  }

  function updateSourcedSubtitle(days) {
    if (!days) return;
    const label = days === 1 ? "day" : "days";
    document.getElementById("recentSourced-sub").textContent =
      `Candidates referred or sourced by an agency in the last ${days} ${label}.`;
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
    closeAllMenus();
  });

  // A menu positioned from a stale rect (post-scroll) would float away from
  // its button, so any scroll — page or a .cards container — closes it.
  window.addEventListener("scroll", closeAllMenus, true);

  // Changing the filter re-renders from the already-fetched snapshot — no
  // network call, so it's instant even while Active Referrals is mid-scan.
  document.getElementById("department-filter").addEventListener("change", (e) => {
    selectedDepartmentId = e.target.value;
    if (lastData) render(lastData);
  });

  load();
  setInterval(load, REFRESH_MS);
})();
