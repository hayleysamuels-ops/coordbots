"use strict";

/**
 * No framework and no build step, matching the other dashboards in this
 * monorepo: the server sends precomputed JSON and this file turns it into
 * DOM. Charts are inline SVG rather than a charting library, so there is
 * nothing to bundle and nothing to load from a CDN.
 */

const state = {
  config: null,
  active: "overview",
  period: "quarter",
  payloads: new Map(),
};

const main = document.getElementById("main");
const tabsEl = document.getElementById("tabs");
const footerEl = document.getElementById("footer");
const metaEl = document.getElementById("topbar-meta");

// --- Small helpers ---------------------------------------------------------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

const svgNS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(child);
  }
  return node;
}

function num(value) {
  return (value ?? 0).toLocaleString("en-US");
}

// The day after a YYYY-MM-DD key, as the exclusive start of the faded
// region. Built through UTC so it can't be shifted by the viewer's own
// time zone — these keys are already local to the client being shown.
function nextDay(key) {
  if (!key) return null;
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function formatDay(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatWhen(iso) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

// A percentage change with no baseline is null, not zero — "up from
// nothing" is not a 0% week, and rendering it as one would be a lie that
// looks like data.
function delta(value) {
  if (value == null) return el("span", { class: "delta flat", text: "no baseline" });
  if (value === 0) return el("span", { class: "delta flat", text: "0%" });
  const up = value > 0;
  return el("span", {
    class: `delta ${up ? "up" : "down"}`,
    text: `${up ? "▲" : "▼"} ${Math.abs(value)}%`,
  });
}

function stat(number, label, { sub, hero, deltaValue } = {}) {
  return el("div", { class: `stat${hero ? " hero" : ""}` }, [
    el("div", { class: "stat-number" }, [String(number), deltaValue !== undefined ? delta(deltaValue) : null]),
    el("div", { class: "stat-label", text: label }),
    sub ? el("div", { class: "stat-sub", text: sub }) : null,
  ]);
}

// --- Charts ----------------------------------------------------------------

/**
 * A bar chart over a time series, with a thin disruption marker under each
 * bar.
 *
 * Bars from `fadeFrom` onward are drawn faded. Interviews are booked
 * ahead and the current day or week is only partly elapsed, so the last
 * columns are incomplete rather than low — at full strength they read as
 * a collapse in volume, which is exactly the wrong story for a dashboard
 * about how much work is being done.
 */
function barChart(series, { fadeFrom, labelFn, height = 220, showSecondary = true }) {
  if (series.length === 0) return el("div", { class: "empty", text: "No interviews in this period." });

  const width = 1000;
  const padLeft = 44;
  const padBottom = 28;
  const padTop = 12;
  const plotWidth = width - padLeft - 8;
  const plotHeight = height - padBottom - padTop;

  const max = Math.max(...series.map((r) => r.events), 1);
  const slot = plotWidth / series.length;
  const barWidth = Math.max(2, Math.min(slot * 0.62, 34));

  const children = [];

  // Four horizontal gridlines with value labels, so a bar can be read
  // without hovering it.
  for (let i = 0; i <= 4; i++) {
    const value = Math.round((max / 4) * i);
    const y = padTop + plotHeight - (plotHeight * i) / 4;
    children.push(svgEl("line", { class: "gridline", x1: padLeft, x2: width - 8, y1: y, y2: y }));
    children.push(svgEl("text", { class: "tick", x: padLeft - 8, y: y + 3, "text-anchor": "end" }, [
      document.createTextNode(String(value)),
    ]));
  }

  series.forEach((row, i) => {
    const x = padLeft + i * slot + (slot - barWidth) / 2;
    const barHeight = (row.events / max) * plotHeight;
    // Faded from `fadeFrom` onward: for daily bars that is tomorrow, for
    // weekly bars the Monday of the in-progress week. Either way these
    // columns are incomplete, not low.
    const future = fadeFrom && row.key >= fadeFrom;

    const bar = svgEl("rect", {
      class: `bar${future ? " future" : ""}`,
      x,
      y: padTop + plotHeight - barHeight,
      width: barWidth,
      height: Math.max(barHeight, row.events > 0 ? 1.5 : 0),
      rx: 2,
    });
    bar.appendChild(
      svgEl("title", {}, [
        document.createTextNode(
          `${labelFn(row.key)} — ${row.events} interviews, ${row.hours}h` +
            (row.cancellations ? `, ${row.cancellations} cancelled` : "") +
            (row.reschedules ? `, ${row.reschedules} rescheduled` : "") +
            (future ? " — incomplete: in progress or booked ahead" : "")
        ),
      ])
    );
    children.push(bar);

    // Cancellations and reschedules as a thin underline beneath each bar
    // rather than a second full-height bar: they are an order of magnitude
    // smaller than the volume and would otherwise be invisible at the same
    // scale.
    if (showSecondary) {
      const disrupted = (row.cancellations || 0) + (row.reschedules || 0);
      if (disrupted > 0) {
        const markHeight = Math.max(2, (disrupted / max) * plotHeight);
        children.push(
          svgEl("rect", {
            class: "bar cancel",
            x,
            y: padTop + plotHeight + 2,
            width: barWidth,
            height: Math.min(markHeight, padBottom - 14),
            rx: 1,
          })
        );
      }
    }
  });

  // Thin out x labels so they never collide, whatever the series length.
  const labelEvery = Math.ceil(series.length / 14);
  series.forEach((row, i) => {
    if (i % labelEvery !== 0) return;
    children.push(
      svgEl("text", { class: "tick", x: padLeft + i * slot + slot / 2, y: height - 4, "text-anchor": "middle" }, [
        document.createTextNode(labelFn(row.key)),
      ])
    );
  });

  children.push(
    svgEl("line", { class: "axis", x1: padLeft, x2: width - 8, y1: padTop + plotHeight, y2: padTop + plotHeight })
  );

  return svgEl("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, role: "img" }, children);
}

function heatmapGrid(cells, timeZone) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const order = [1, 2, 3, 4, 5, 6, 0]; // Monday-first, matching the week keys
  const max = Math.max(...cells.map((c) => c.events), 1);
  const lookup = new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c.events]));

  const grid = el("div", { class: "heatmap" });
  grid.appendChild(el("div"));
  for (let hour = 0; hour < 24; hour++) {
    grid.appendChild(el("div", { class: "heat-hour", text: hour % 3 === 0 ? String(hour) : "" }));
  }

  for (const dow of order) {
    grid.appendChild(el("div", { class: "heat-label", text: days[order.indexOf(dow)] }));
    for (let hour = 0; hour < 24; hour++) {
      const count = lookup.get(`${dow}:${hour}`) || 0;
      const cell = el("div", { class: "heat-cell" });
      if (count > 0) {
        // Square-root scale: a linear ramp makes everything but the single
        // busiest hour look empty on a distribution this skewed.
        const intensity = Math.sqrt(count / max);
        cell.style.background = `color-mix(in srgb, var(--accent, #eb4e19) ${Math.round(intensity * 100)}%, var(--surface-sunken))`;
      }
      cell.title = `${days[order.indexOf(dow)]} ${String(hour).padStart(2, "0")}:00 ${timeZone} — ${count} interviews`;
      grid.appendChild(cell);
    }
  }

  return el("div", { class: "table-wrap" }, [grid]);
}

// --- Sections --------------------------------------------------------------

function periodControl(onChange) {
  const options = [["week", "7 days"], ["month", "30 days"], ["quarter", "90 days"]];
  return el(
    "div",
    { class: "segmented" },
    options.map(([key, label]) =>
      el("button", {
        type: "button",
        text: label,
        "aria-pressed": String(state.period === key),
        onclick: () => {
          state.period = key;
          onChange();
        },
      })
    )
  );
}

function roleTable(byRole) {
  if (byRole.length === 0) return el("div", { class: "empty", text: "No interviews to break down by role yet." });

  const max = byRole[0].events;
  const rows = byRole.map((role) =>
    el("tr", {}, [
      el("td", { class: "lead" }, [
        role.title,
        role.department ? el("div", { class: "muted", style: "font-size:12px", text: role.department }) : null,
      ]),
      el("td", {}, [role.jobStatus === "Open" ? el("span", { class: "tag open", text: "Open" }) : el("span", { class: "tag", text: role.jobStatus || "—" })]),
      el("td", { class: "num", text: num(role.events) }),
      el("td", { class: "num", text: num(role.hours) + "h" }),
      el("td", { class: "num", text: num(role.candidates) }),
      el("td", { style: "width:160px" }, [
        el("div", { class: "meter", style: `width:${Math.max(2, (role.events / max) * 100)}%` }),
      ]),
    ])
  );

  return el("div", { class: "table-wrap" }, [
    el("table", {}, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Role" }),
          el("th", { text: "Status" }),
          el("th", { class: "num", text: "Interviews" }),
          el("th", { class: "num", text: "Hours" }),
          el("th", { class: "num", text: "Candidates" }),
          el("th", { text: "" }),
        ]),
      ]),
      el("tbody", {}, rows),
    ]),
  ]);
}

function stageTable(byStage) {
  if (byStage.length === 0) return el("div", { class: "empty", text: "No stage data yet." });
  const max = byStage[0].events;

  return el("div", { class: "table-wrap" }, [
    el("table", {}, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Stage" }),
          el("th", { class: "num", text: "Interviews" }),
          el("th", { class: "num", text: "Hours" }),
          el("th", { class: "num", text: "Candidates" }),
          el("th", { text: "" }),
        ]),
      ]),
      el(
        "tbody",
        {},
        byStage.slice(0, 15).map((row) =>
          el("tr", {}, [
            el("td", { class: "lead", text: row.title }),
            el("td", { class: "num", text: num(row.events) }),
            el("td", { class: "num", text: num(row.hours) + "h" }),
            el("td", { class: "num", text: num(row.candidates) }),
            el("td", { style: "width:160px" }, [
              el("div", { class: "meter", style: `width:${Math.max(2, (row.events / max) * 100)}%` }),
            ]),
          ])
        )
      ),
    ]),
  ]);
}

function section(title, note, body, toolbar) {
  return el("section", { class: "section" }, [
    el("div", { class: "toolbar" }, [
      el("div", {}, [el("h2", { text: title }), note ? el("p", { class: "section-note", text: note }) : null]),
      toolbar || null,
    ]),
    el("div", { class: "card" }, [body]),
  ]);
}

// --- Client panel ----------------------------------------------------------

function renderClient(payload) {
  const period = payload.periods[state.period];
  const periodLabel = { week: "last 7 days", month: "last 30 days", quarter: "last 90 days" }[state.period];

  const frag = document.createDocumentFragment();

  frag.appendChild(el("p", { class: "eyebrow", text: `${payload.clientName} · ${payload.timeZone} · 12-month view` }));

  frag.appendChild(
    el("div", { class: "stat-grid" }, [
      stat(num(period.current.events), `Interviews coordinated, ${periodLabel}`, {
        hero: true,
        deltaValue: period.change.events,
        sub: `${num(period.previous.events)} in the previous period`,
      }),
      stat(num(Math.round(period.current.hours)) + "h", `Interview time placed on calendars, ${periodLabel}`, {
        deltaValue: period.change.hours,
        sub: `${num(Math.round(period.previous.hours))}h in the previous period`,
      }),
      stat(num(period.current.candidates), `Candidates scheduled, ${periodLabel}`),
      stat(num(payload.totals.roles), "Roles supported", { sub: "distinct jobs with interview activity" }),
    ])
  );

  frag.appendChild(
    el("div", { class: "stat-grid" }, [
      stat(num(payload.totals.events), "Interviews, 12 months", {
        sub: `${num(payload.totals.debriefs)} of them debriefs`,
      }),
      stat(num(payload.totals.hours) + "h", "Interview hours, 12 months"),
      stat(num(payload.totals.interviewerSlots), "Interviewer seats filled", {
        sub: `${payload.totals.averagePanelSize} interviewers per interview on average`,
      }),
      stat(num(payload.totals.candidates), "Candidates, 12 months"),
    ])
  );

  // Disruption: the work that a raw volume count makes invisible.
  frag.appendChild(
    el("div", { class: "stat-grid" }, [
      stat(num(payload.totals.reschedulesDerived), "Reschedules, 12 months", {
        sub: payload.totals.reschedulesObserved
          ? `${num(payload.totals.reschedulesObserved)} directly observed since tracking began`
          : "derived — see the note below",
      }),
      stat(num(payload.totals.cancellations), "Cancellations, 12 months", {
        sub: "cancelled with no re-booking",
      }),
      stat(num(payload.totals.dropOffs), "Candidate drop-offs", {
        sub: "archived after reaching a scheduled interview",
      }),
      stat(num(payload.totals.shortNotice), "Short-notice bookings", {
        sub: `booked under ${state.config.shortNoticeHours}h before the interview`,
      }),
      stat(num(payload.totals.outOfHours), "Out-of-hours interviews", {
        sub: `starting before ${state.config.businessHours.start}:00 or after ${state.config.businessHours.end}:00 local`,
      }),
      stat(
        payload.timeToSchedule.medianHours == null ? "—" : payload.timeToSchedule.medianHours + "h",
        "Median booking turnaround",
        {
          sub:
            payload.timeToSchedule.p90Hours == null
              ? "no schedules waited to be booked"
              : `90th percentile ${payload.timeToSchedule.p90Hours}h · ${num(payload.timeToSchedule.sample)} schedules waited; ` +
                `${num(payload.timeToSchedule.directBookings)} booked outright`,
        }
      ),
    ])
  );

  const chartHost = el("div");
  const redrawChart = () => {
    chartHost.replaceChildren(
      state.period === "week"
        ? barChart(payload.series.daily.slice(-28), { fadeFrom: nextDay(payload.today), labelFn: formatDay })
        : state.period === "month"
        ? barChart(payload.series.daily.slice(-60), { fadeFrom: nextDay(payload.today), labelFn: formatDay })
        : barChart(payload.series.weekly, { fadeFrom: payload.currentWeek, labelFn: formatDay }),
      el("div", { class: "legend" }, [
        el("span", {}, [el("i", { class: "swatch", style: "background:var(--accent,#eb4e19)" }), "Interviews"]),
        el("span", {}, [
          el("i", { class: "swatch", style: "background:var(--accent,#eb4e19);opacity:.3" }),
          state.period === "quarter" ? "This week so far, and booked ahead" : "Today, and booked ahead",
        ]),
        el("span", {}, [el("i", { class: "swatch", style: "background:var(--critical)" }), "Cancelled or rescheduled"]),
      ])
    );
  };
  redrawChart();

  frag.appendChild(
    section(
      "Volume over time",
      state.period === "quarter" ? "Each bar is one week." : "Each bar is one day.",
      chartHost,
      periodControl(() => render())
    )
  );

  frag.appendChild(
    section(
      "By role",
      "Every job with interview activity in the last 12 months, busiest first.",
      roleTable(payload.byRole)
    )
  );

  frag.appendChild(
    section("By stage", "Which rounds the volume sits in. Onsites and panels cost far more to coordinate than screens.", stageTable(payload.byStage))
  );

  frag.appendChild(
    section(
      "When the work happens",
      `Interview start times by day and hour, in ${payload.timeZone}. Darker is busier.`,
      heatmapGrid(payload.heatmap, payload.timeZone)
    )
  );

  if (payload.records && payload.records.busiestDay) {
    frag.appendChild(
      el("div", { class: "notice" }, [
        el("h3", { text: "Busiest day" }),
        el("p", {
          text: `${formatDay(payload.records.busiestDay.date)} — ${payload.records.busiestDay.events} interviews coordinated in a single day.`,
        }),
      ])
    );
  }

  frag.appendChild(renderDataQuality(payload));

  return frag;
}

/**
 * The honest footnote. Ashby records no reschedule history and no
 * cancellation reason, so two of the headline numbers are derived rather
 * than reported. Saying so on the page is the difference between a metric
 * and a claim.
 */
function renderDataQuality(payload) {
  return el("div", { class: "notice" }, [
    el("h3", { text: "How these numbers are built" }),
    el("p", {
      text:
        "Ashby stores no reschedule history and no cancellation reason. Reschedules over the full 12 months are " +
        "therefore derived: a cancelled interview whose candidate and stage were re-booked afterwards is counted " +
        "as a reschedule, and one that was never re-booked is counted as a cancellation. " +
        (payload.dataQuality.rescheduleTrackingSince
          ? `Directly observed reschedules — exact, but only countable going forward — have been tracked since ${formatWhen(
              payload.dataQuality.rescheduleTrackingSince
            )}.`
          : "Direct reschedule tracking has not recorded a full cycle yet."),
    }),
    el("p", {
      style: "margin-top:8px",
      text:
        "Counted: candidate-facing interviews and debriefs. Excluded: holds and logistics blocks, matched on the " +
        `title keywords ${payload.dataQuality.excludedTitleKeywords.join(", ") || "(none)"}` +
        (payload.totals.excludedEvents ? ` — ${num(payload.totals.excludedEvents)} events excluded.` : "."),
    }),
    el("p", {
      style: "margin-top:8px",
      text:
        "Roles are grouped by Ashby job record, not by job title, so two reqs with the same title stay two rows " +
        "(numbered (1) and (2), oldest first) and related titles like \u201cTeam Lead\u201d or \u201cNew Grad\u201d are " +
        "never folded into the parent role. Job records titled " +
        `${payload.dataQuality.excludedJobTitles.join(", ") || "(none)"} are treated as scaffolding and excluded` +
        (payload.totals.excludedJobEvents
          ? ` — ${num(payload.totals.excludedJobEvents)} events dropped.`
          : " (none matched)."),
    }),
  ]);
}

// --- Overview panel --------------------------------------------------------

function renderOverview(payload) {
  const period = payload.periods[state.period];
  const periodLabel = { week: "last 7 days", month: "last 30 days", quarter: "last 90 days" }[state.period];
  const frag = document.createDocumentFragment();

  frag.appendChild(
    el("p", { class: "eyebrow", text: `All clients · ${payload.byClient.length} books of work · 12-month view` })
  );

  frag.appendChild(
    el("div", { class: "stat-grid" }, [
      stat(num(payload.totals.events), "Interviews coordinated, 12 months", { hero: true }),
      stat(num(payload.totals.hours) + "h", "Interview time placed on calendars"),
      stat(num(payload.totals.candidates), "Candidates scheduled"),
      stat(num(payload.totals.roles), "Roles supported"),
      stat(num(payload.totals.interviewerSlots), "Interviewer seats filled"),
      stat(num(payload.totals.reschedulesDerived + payload.totals.cancellations), "Reschedules and cancellations handled"),
    ])
  );

  frag.appendChild(
    el("div", { class: "stat-grid" }, [
      stat(num(period.current.events), `Interviews, ${periodLabel}`, {
        deltaValue: period.change.events,
        sub: `${num(period.previous.events)} in the previous period`,
      }),
      stat(num(Math.round(period.current.hours)) + "h", `Interview hours, ${periodLabel}`, {
        deltaValue: period.change.hours,
      }),
      stat(num(payload.totals.shortNotice), "Short-notice bookings, 12 months"),
      stat(num(payload.totals.dropOffs), "Candidate drop-offs, 12 months"),
    ])
  );

  frag.appendChild(
    section(
      "Total volume by week",
      "Every client combined. Weeks are Monday-start.",
      el("div", {}, [
        barChart(payload.series.weekly, { fadeFrom: payload.currentWeek, labelFn: formatDay }),
        el("div", { class: "legend" }, [
          el("span", {}, [el("i", { class: "swatch", style: "background:var(--accent,#eb4e19)" }), "Interviews"]),
          el("span", {}, [
            el("i", { class: "swatch", style: "background:var(--accent,#eb4e19);opacity:.3" }),
            "This week so far, and booked ahead",
          ]),
          el("span", {}, [el("i", { class: "swatch", style: "background:var(--critical)" }), "Cancelled or rescheduled"]),
        ]),
      ]),
      periodControl(() => render())
    )
  );

  const max = Math.max(...payload.byClient.map((c) => c.events), 1);
  frag.appendChild(
    section(
      "By client",
      "Twelve months of coordination, client by client. Click a tab above for the detail.",
      el("div", { class: "table-wrap" }, [
        el("table", {}, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: "Client" }),
              el("th", { class: "num", text: "Interviews" }),
              el("th", { class: "num", text: "Hours" }),
              el("th", { class: "num", text: "Candidates" }),
              el("th", { class: "num", text: "Roles" }),
              el("th", { class: "num", text: "Reschedules" }),
              el("th", { class: "num", text: "Cancelled" }),
              el("th", { class: "num", text: "This week" }),
              el("th", { text: "" }),
            ]),
          ]),
          el(
            "tbody",
            {},
            payload.byClient.map((row) =>
              el("tr", { style: "cursor:pointer", onclick: () => selectTab(row.clientId) }, [
                el("td", { class: "lead" }, [
                  el("span", {
                    class: "tab-dot",
                    style: `--tab-accent:${row.accentColor || "var(--ember)"}`,
                  }),
                  row.clientName,
                ]),
                el("td", { class: "num", text: num(row.events) }),
                el("td", { class: "num", text: num(row.hours) + "h" }),
                el("td", { class: "num", text: num(row.candidates) }),
                el("td", { class: "num", text: num(row.roles) }),
                el("td", { class: "num", text: num(row.reschedules) }),
                el("td", { class: "num", text: num(row.cancellations) }),
                el("td", { class: "num" }, [String(row.thisWeek), delta(row.weekChange)]),
                el("td", { style: "width:140px" }, [
                  el("div", {
                    class: "meter",
                    style: `width:${Math.max(2, (row.events / max) * 100)}%;background:${row.accentColor || "var(--ember)"}`,
                  }),
                ]),
              ])
            )
          ),
        ]),
      ])
    )
  );

  return frag;
}

// --- Shell -----------------------------------------------------------------

function renderTabs() {
  tabsEl.replaceChildren(
    el("button", {
      class: "tab",
      role: "tab",
      type: "button",
      text: "Overview",
      "aria-selected": String(state.active === "overview"),
      onclick: () => selectTab("overview"),
    }),
    ...state.config.clients.map((client) =>
      el(
        "button",
        {
          class: "tab",
          role: "tab",
          type: "button",
          style: client.accentColor ? `--tab-accent:${client.accentColor}` : null,
          "aria-selected": String(state.active === client.id),
          onclick: () => selectTab(client.id),
        },
        [el("span", { class: "tab-dot" }), client.name]
      )
    )
  );
}

function applyAccent() {
  const client = state.config.clients.find((c) => c.id === state.active);
  const accent = client && client.accentColor ? client.accentColor : "";
  document.documentElement.style.setProperty("--accent", accent || "var(--ember)");
  document.getElementById("page-title").textContent =
    state.active === "overview" ? state.config.title : `${client ? client.name : ""} — Coordinator Metrics`;
}

async function load(key) {
  if (state.payloads.has(key)) return state.payloads.get(key);
  const url = key === "overview" ? "/api/overview" : `/api/client/${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  const payload = await res.json();
  state.payloads.set(key, payload);
  return payload;
}

function selectTab(key) {
  state.active = key;
  render();
}

async function render() {
  renderTabs();
  applyAccent();

  try {
    const payload = await load(state.active);
    main.replaceChildren(state.active === "overview" ? renderOverview(payload) : renderClient(payload));
    metaEl.textContent = `Updated ${formatWhen(payload.generatedAt)}`;
  } catch (err) {
    main.replaceChildren(
      el("div", { class: "notice" }, [
        el("h3", { text: "Nothing to show yet" }),
        el("p", { text: err.message }),
      ])
    );
  }

  renderFooter();
}

async function renderFooter() {
  let status = null;
  try {
    status = await (await fetch("/api/status")).json();
  } catch (_) {
    /* the footer is informational; a failed status read shouldn't blank the page */
  }

  const children = [];

  if (status && status.runs) {
    const lines = status.runs
      .slice()
      .sort((a, b) => (a.client_id < b.client_id ? -1 : 1))
      .map((run) => `${run.client_id} ${run.kind}: ${run.ok ? "ok" : "FAILED"} ${formatWhen(run.finished_at)}`);
    children.push(el("p", { text: lines.join("  ·  ") || "No sync has run yet." }));
  }

  if (status && status.progress && status.progress.running) {
    children.push(el("p", { text: `Sync in progress (${status.progress.kind}, ${status.progress.client || "starting"})…` }));
  }

  children.push(
    el("p", {}, [
      el("button", {
        class: "link",
        type: "button",
        text: "Refresh now",
        onclick: async () => {
          await fetch("/api/sync", { method: "POST" });
          state.payloads.clear();
          setTimeout(render, 4000);
        },
      }),
      document.createTextNode("  ·  "),
      el("button", {
        class: "link",
        type: "button",
        text: "Full 12-month re-sync",
        onclick: async () => {
          if (!confirm("A full re-sync re-reads 12 months from Ashby for every client and takes several minutes. Continue?")) return;
          await fetch("/api/sync?kind=full", { method: "POST" });
          state.payloads.clear();
        },
      }),
    ])
  );

  footerEl.replaceChildren(...children);
}

(async function boot() {
  try {
    state.config = await (await fetch("/api/config")).json();
  } catch (err) {
    main.replaceChildren(el("div", { class: "notice" }, [el("h3", { text: "Could not load configuration" }), el("p", { text: err.message })]));
    return;
  }

  document.title = state.config.title;
  render();
})();
