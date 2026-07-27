(() => {
  const REFRESH_MS = 60 * 1000;

  const columns = [
    {
      key: "feedbackOverdue",
      hoursField: "hoursOverdue",
      thresholdKey: "feedbackOverdueHours",
      renderDetail: (item) =>
        item.interviewers && item.interviewers.length
          ? `Waiting on: ${item.interviewers.map((i) => i.name).join(", ")}`
          : "",
      ageLabel: (hours) => `${hours}h overdue`,
    },
    {
      key: "needsScheduling",
      hoursField: "hoursPending",
      thresholdKey: "needsSchedulingAlertHours",
      renderDetail: () => "",
      ageLabel: (hours) => `${formatDuration(hours)} pending`,
    },
  ];

  function formatDuration(hours) {
    if (hours < 48) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
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
          ageLabel: `${formatDuration(item.hoursStale)} stale`,
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
    if (hours < 24) return `${Math.round(hours)}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
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

  function render(data) {
    for (const col of columns) {
      renderColumn(col, data[col.key] || [], data.thresholds[col.thresholdKey]);
    }
    renderStale(data.staleCandidates || []);
    renderInterviewerLimits(data.interviewerLimits || []);
    renderRecentSourced(data.recentSourced || []);
    updateSourcedSubtitle(data.thresholds && data.thresholds.sourcedLookbackDays);

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
      if (wasHidden) menu.removeAttribute("hidden");
      return;
    }
    closeAllMenus();
  });

  load();
  setInterval(load, REFRESH_MS);
})();
