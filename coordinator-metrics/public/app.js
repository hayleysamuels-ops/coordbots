"use strict";

/**
 * No framework and no build step, matching the other dashboards in this
 * monorepo: the server sends precomputed JSON and this file turns it into
 * DOM. Charts are inline SVG rather than a charting library, so there is
 * nothing to bundle and nothing to load from a CDN.
 */

// The period and scope option lists come from /api/config, not from a
// copy here: a hardcoded list that drifts from what the server produces
// is what took the dashboard down twice.
function periodLabel(key) {
  const match = (state.config.periods || []).find((p) => p.key === key);
  return match ? match.description : key;
}

const state = {
  config: null,
  active: "overview",
  period: null,
  scope: null,
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

// Absolute change, not a percentage. "+6" is readable on any base;
// "+300%" on a base of two interviews is noise dressed as a signal.
function weekDelta(current, previous) {
  if (previous == null) return null;
  const diff = current - previous;
  if (diff === 0) return el("span", { class: "delta flat", text: "0" });
  return el("span", {
    class: `delta ${diff > 0 ? "up" : "down"}`,
    text: `${diff > 0 ? "+" : "\u2212"}${Math.abs(diff)}`,
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
          `${labelFn(row.key)} — ${row.events} interviews, ${Math.round(row.hours * 10) / 10}h` +
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

/**
 * All activity vs. the work Carrara coordinated. A toggle rather than a
 * replacement: "we coordinated 10,689 of the 31,989 interviews that ran"
 * is a stronger claim than 10,689 alone, and if a roster is incomplete
 * the gap is visible instead of looking like low output.
 */
function scopeControl(onChange) {
  const options = (state.config.scopes || []).map((s) => [s.key, s.label]);
  return el(
    "div",
    { class: "segmented" },
    options.map(([key, label]) =>
      el("button", {
        type: "button",
        text: label,
        "aria-pressed": String(state.scope === key),
        onclick: () => {
          state.scope = key;
          onChange();
        },
      })
    )
  );
}

function periodControl(onChange, { onlyFull = false } = {}) {
  // An ended engagement has nothing in the last 7/30/90 days by
  // definition, so offering those buttons just offers four ways to see
  // zero.
  const options = (state.config.periods || [])
    .filter((p) => !onlyFull || p.key === "full")
    .map((p) => [p.key, onlyFull ? "Full engagement" : p.label]);
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

function renderClient(fullPayload) {
  const payload = fullPayload.scopes[state.scope];
  const period = payload.periods[state.period];
  const label = periodLabel(state.period);

  const frag = document.createDocumentFragment();

  const isEnded = fullPayload.status === "ended";

  frag.appendChild(
    el("div", { class: "toolbar" }, [
      el("p", {
        class: "eyebrow",
        style: "margin:0",
        text:
          `${fullPayload.clientName} · ${fullPayload.timeZone} · ` +
          (state.scope === "coordinated" ? "work Carrara coordinated" : "all interview activity"),
      }),
      scopeControl(() => render()),
    ])
  );

  // An ended engagement says so plainly, with its dates. Without this the
  // tab looks like a live client having a very quiet year.
  if (isEnded) {
    frag.appendChild(
      el("div", { class: "notice" }, [
        el("h3", { text: "Ended engagement" }),
        el("p", {
          text:
            `Carrara coordinated for ${fullPayload.clientName} from ${formatDay(fullPayload.engagementStart)} ` +
            `to ${formatDay(fullPayload.engagementEnd)}. Every figure here covers that period, not a rolling ` +
            "12 months, so the work does not fade out as time passes. It is excluded from current-period " +
            "totals and the trend chart on the Overview.",
        }),
      ])
    );
  }

  frag.appendChild(
    el("div", { class: "stat-grid" }, [
      stat(num(period.current.events), `Interviews coordinated, ${label}`, {
        hero: true,
        deltaValue: period.change.events,
        // Suppressed entirely when there is nothing to compare against —
        // "0 in the previous period" under a "no baseline" tile reads as
        // a real zero rather than an absence of data.
        sub: period.change.events == null ? null : `${num(period.previous.events)} in the previous period`,
      }),
      stat(num(Math.round(period.current.hours)) + "h", `Interview time placed on calendars, ${label}`, {
        deltaValue: period.change.hours,
        sub: period.change.hours == null ? null : `${num(Math.round(period.previous.hours))}h in the previous period`,
      }),
      stat(num(period.current.candidates), `Candidates scheduled, ${label}`),
      stat(num(payload.totals.roles), "Roles supported", { sub: "distinct jobs with interview activity" }),
    ])
  );

  frag.appendChild(
    el("div", { class: "stat-grid" }, [
      stat(num(payload.totals.events), "Interviews held, 12 months", {
        // The composition, named on the page rather than left to whoever
        // reads the source. Meals are counted as interviews — they are
        // coordinated candidate time — but someone asked how a total is
        // reached should be able to see what is inside it.
        sub:
          `includes ${num(payload.totals.debriefs)} debriefs and ` +
          `${num(payload.totals.meals)} candidate meals`,
      }),
      stat(num(payload.totals.hours) + "h", "Interview hours, 12 months"),
      stat(num(payload.totals.bookedAhead), "Booked ahead", {
        sub: `${num(payload.totals.bookedAheadHours)}h already on the calendar for future dates`,
      }),
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
      stat(num(payload.totals.dropOffs), "Applications archived after interviewing", {
        sub: "candidates who reached a scheduled interview, then were archived — counts applications, not interviews",
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
        ? barChart(payload.series.daily.slice(-28), { fadeFrom: nextDay(fullPayload.today), labelFn: formatDay })
        : state.period === "month"
        ? barChart(payload.series.daily.slice(-60), { fadeFrom: nextDay(fullPayload.today), labelFn: formatDay })
        : barChart(state.period === "quarter" ? payload.series.weekly.slice(-13) : payload.series.weekly, {
            fadeFrom: fullPayload.currentWeek,
            labelFn: formatDay,
          }),
      el("div", { class: "legend" }, [
        el("span", {}, [el("i", { class: "swatch", style: "background:var(--accent,#eb4e19)" }), "Interviews"]),
        el("span", {}, [
          el("i", { class: "swatch", style: "background:var(--accent,#eb4e19);opacity:.3" }),
          state.period === "quarter" || state.period === "full"
            ? "This week so far, and booked ahead"
            : "Today, and booked ahead",
        ]),
        el("span", {}, [el("i", { class: "swatch", style: "background:var(--critical)" }), "Cancelled or rescheduled"]),
      ])
    );
  };
  redrawChart();

  frag.appendChild(
    section(
      "Volume over time",
      state.period === "quarter" || state.period === "full" ? "Each bar is one week." : "Each bar is one day.",
      chartHost,
      periodControl(() => render(), { onlyFull: isEnded })
    )
  );

  frag.appendChild(
    section(
      "By role",
      `Every job with interview activity in the ${label}, busiest first.`,
      roleTable(payload.byRole[state.period])
    )
  );

  frag.appendChild(
    section("By stage", "Which rounds the volume sits in. Onsites and panels cost far more to coordinate than screens.", stageTable(payload.byStage[state.period]))
  );

  frag.appendChild(
    section(
      "When the work happens",
      `Interview start times by day and hour over the ${label}, in ${fullPayload.timeZone}. Darker is busier.`,
      heatmapGrid(payload.heatmap[state.period], fullPayload.timeZone)
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

  frag.appendChild(renderRoster(fullPayload));
  frag.appendChild(renderDataQuality(fullPayload, payload));

  return frag;
}

/**
 * The honest footnote. Ashby records no reschedule history and no
 * cancellation reason, so two of the headline numbers are derived rather
 * than reported. Saying so on the page is the difference between a metric
 * and a claim.
 */
/**
 * The roster, and everywhere it doesn't line up with the data.
 *
 * Name matching has two silent failure modes and both are live risks
 * here, so neither is allowed to just return nothing: a rostered name
 * that matches no events, and one name resolving to two Ashby accounts.
 */
function renderRoster(fullPayload) {
  const roster = fullPayload.roster;
  if (!roster) return null;
  if (state.scope !== "coordinated") return document.createComment("roster shown only in coordinated scope");

  const children = [
    el("h3", { text: "Who this counts" }),
    el("p", {
      text:
        `${roster.matched.length} of the ${roster.configured.length} rostered coordinators scheduled at ` +
        `${fullPayload.clientName}: ` +
        (roster.matched.length
          ? roster.matched.map((m) => `${m.name} (${num(m.events)})`).join(", ")
          : "none"),
    }),
  ];

  if (roster.unmatched.length && roster.reportUnmatched) {
    children.push(
      el("p", {
        style: "margin-top:8px",
        text:
          `No events here for: ${roster.unmatched.join(", ")}. ` +
          "Either they did not work this client, their name differs in Ashby, or they scheduled under a shared account — " +
          "a rostered name contributing nothing is reported rather than quietly counting zero.",
      })
    );
  }

  if (roster.collisions.length) {
    children.push(
      el("p", {
        style: "margin-top:8px",
        text:
          "Name collision — one rostered name maps to more than one Ashby account, so two people may be merged into one figure: " +
          roster.collisions.map((c) => `${c.name} (${c.userIds.length} accounts)`).join(", "),
      })
    );
  }

  if (roster.renames.length) {
    children.push(
      el("p", {
        style: "margin-top:8px",
        text:
          "One Ashby account appears under more than one name (a rename mid-window). Add both spellings to the roster " +
          "or that person's earlier work is missed: " +
          roster.renames.map((r) => r.names.join(" / ")).join("; "),
      })
    );
  }

  return el("div", { class: "notice" }, children);
}

function renderDataQuality(fullPayload, payload) {
  const dq = fullPayload.dataQuality;
  return el("div", { class: "notice" }, [
    el("h3", { text: "How these numbers are built" }),
    el("p", {
      text:
        "Ashby stores no reschedule history and no cancellation reason. Reschedules over the full 12 months are " +
        "therefore derived: a cancelled interview whose candidate and stage were re-booked afterwards is counted " +
        "as a reschedule, and one that was never re-booked is counted as a cancellation. " +
        (dq.rescheduleTrackingSince
          ? `Directly observed reschedules — exact, but only countable going forward — have been tracked since ${formatWhen(
              dq.rescheduleTrackingSince
            )}.`
          : "Direct reschedule tracking has not recorded a full cycle yet."),
    }),
    el("p", {
      style: "margin-top:8px",
      text:
        "Counted: candidate-facing interviews, debriefs, and candidate meals — an onsite lunch is a slot a " +
        "coordinator found and two to six people they booked around it. Excluded: holds and logistics blocks, matched on the " +
        `title keywords ${dq.excludedTitleKeywords.join(", ") || "(none)"}` +
        (payload.totals.excludedEvents ? ` — ${num(payload.totals.excludedEvents)} events excluded.` : "."),
    }),

    // What the hold rule actually caught. On the page, not just in a
    // report, so a keyword quietly eating a real interview type shows up.
    payload.excludedTitleBreakdown.length
      ? el("p", {
          style: "margin-top:8px",
          text:
            "Excluded by title: " +
            payload.excludedTitleBreakdown
              .slice(0, 10)
              .map((row) => `${row.title} (${num(row.count)})`)
              .join(", ") +
            (payload.excludedTitleBreakdown.length > 10
              ? `, and ${payload.excludedTitleBreakdown.length - 10} more titles.`
              : "."),
        })
      : null,

    // Staleness, stated rather than assumed. interview.list does not
    // return every definition an org uses, so unresolvable ids reappear
    // over time and the hold rule silently stops applying to them.
    el("p", {
      style: "margin-top:8px",
      text:
        (dq.definitionsResolvedAt
          ? `Interview definitions last resolved against Ashby ${formatWhen(dq.definitionsResolvedAt)}. `
          : "Interview definitions have not been resolved against Ashby yet. ") +
        (payload.totals.unresolvedTitleEvents
          ? `${num(payload.totals.unresolvedTitleEvents)} events still have no resolvable interview title, so the hold ` +
            "rule above could not be applied to them and their debrief status is unknown."
          : "Every event resolves to a named interview, so the hold rule was applied to all of them."),
    }),
    el("p", {
      style: "margin-top:8px",
      text:
        "Roles are grouped by Ashby job record, not by job title, so two reqs with the same title stay two rows " +
        "(numbered (1) and (2), oldest first) and related titles like \u201cTeam Lead\u201d or \u201cNew Grad\u201d are " +
        "never folded into the parent role. Job records titled " +
        `${dq.excludedJobTitles.join(", ") || "(none)"} are treated as scaffolding and excluded` +
        (payload.totals.excludedJobEvents
          ? ` — ${num(payload.totals.excludedJobEvents)} events dropped.`
          : " (none matched)."),
    }),
  ]);
}

// --- Overview panel --------------------------------------------------------

// The overview only has a weekly series, so the shorter periods take a
// tail of it rather than switching to daily bars.
function overviewSeries(payload) {
  const weeks = { week: 2, month: 5, quarter: 13, full: payload.series.weekly.length };
  return payload.series.weekly.slice(-(weeks[state.period] || payload.series.weekly.length));
}

function renderOverview(fullPayload) {
  const payload = fullPayload.scopes[state.scope];
  const period = payload.periods[state.period];
  const label = periodLabel(state.period);
  const groups = payload.groups || {};
  const core = groups.core || { clientNames: [], coordinated: 0, all: 0, sharePct: null };
  const frag = document.createDocumentFragment();

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // The headline states what was coordinated and out of what, for ONE
  // engagement group. Forus is client-scheduled and Profound has ended,
  // so both are stated separately rather than folded into a percentage
  // that would describe neither.
  frag.appendChild(
    el("div", { class: "headline" }, [
      el("p", { class: "headline-lead" }, [
        "Carrara coordinated ",
        el("strong", { text: num(core.coordinated) }),
        " interviews across the ",
        plural(core.clientNames.length, "client", "clients"),
        " we schedule for",
        core.sharePct == null ? "" : ` — ${core.sharePct}% of everything that ran there`,
        ".",
      ]),
      el("p", { class: "headline-sub", text: core.clientNames.join(", ") }),
    ])
  );

  const asides = [];
  const cs = groups.clientScheduled;
  if (cs && cs.clientIds.length) {
    asides.push(
      `At ${cs.clientNames.join(", ")}, where the client schedules its own interviews, Carrara coordinated ` +
        `${num(cs.coordinated)} of ${num(cs.all)}.`
    );
  }
  const ended = groups.ended;
  if (ended && ended.clientIds.length) {
    asides.push(
      `${ended.clientNames.join(", ")} — engagement ended — accounts for a further ${num(ended.coordinated)}, ` +
        "not included in any current-period figure or the trend below."
    );
  }
  if (asides.length) {
    frag.appendChild(el("div", { class: "headline-asides" }, asides.map((text) => el("p", { text }))));
  }

  // Four tiles. Ten made the page a wall of numbers with no hierarchy.
  frag.appendChild(
    el("div", { class: "stat-grid" }, [
      stat(num(payload.totals.events), "Interviews held, 12 months", {
        hero: true,
        sub: `includes ${num(payload.totals.debriefs)} debriefs and ${num(payload.totals.meals)} candidate meals`,
      }),
      stat(num(payload.totals.hours) + "h", "Interview time placed on calendars"),
      stat(num(payload.totals.candidates), "Candidates scheduled"),
      stat(num(payload.totals.interviewerSlots), "Interviewer seats filled", {
        sub: `across ${num(payload.totals.roles)} roles`,
      }),
    ])
  );

  frag.appendChild(
    section(
      "Volume by week",
      `Active clients only, over the ${label}. Weeks are Monday-start.`,
      el("div", {}, [
        barChart(overviewSeries(payload), { fadeFrom: fullPayload.currentWeek, labelFn: formatDay }),
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

  const max = Math.max(...payload.byClient.map((c) => c.allEvents), 1);
  const GROUP_NOTE = {
    core: "",
    clientScheduled: "client-scheduled",
    ended: "engagement ended",
  };

  frag.appendChild(
    section(
      "By client",
      "Ours against everything that ran. Click a tab above for the detail.",
      el("div", { class: "table-wrap" }, [
        el("table", {}, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: "Client" }),
              el("th", { class: "num", text: "Ours / all" }),
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
            payload.byClient.map((row) => {
              const note = GROUP_NOTE[row.group];
              const share = row.allEvents ? Math.round((row.coordinatedEvents / row.allEvents) * 100) : null;
              return el("tr", { style: "cursor:pointer", onclick: () => selectTab(row.clientId) }, [
                el("td", { class: "lead" }, [
                  el("span", { class: "tab-dot", style: `--tab-accent:${row.accentColor || "var(--ember)"}` }),
                  row.clientName,
                  note ? el("div", { class: "muted", style: "font-size:12px", text: note }) : null,
                ]),
                el("td", { class: "num" }, [
                  `${num(row.coordinatedEvents)} / ${num(row.allEvents)}`,
                  share == null ? null : el("div", { class: "muted", style: "font-size:12px", text: `${share}%` }),
                ]),
                el("td", { class: "num", text: num(row.hours) + "h" }),
                el("td", { class: "num", text: num(row.candidates) }),
                el("td", { class: "num", text: num(row.roles) }),
                el("td", { class: "num", text: num(row.reschedules) }),
                el("td", { class: "num", text: num(row.cancellations) }),
                // Absolute change, not a percentage: on a base of two
                // interviews a percentage swings wildly and says nothing.
                el("td", { class: "num" }, [
                  row.status === "ended" ? el("span", { class: "muted", text: "—" }) : String(row.thisWeek),
                  row.status === "ended" ? null : weekDelta(row.thisWeek, row.lastWeek),
                ]),
                el("td", { style: "width:140px" }, [
                  el("div", {
                    class: "meter",
                    style: `width:${Math.max(2, (row.allEvents / max) * 100)}%;background:${row.accentColor || "var(--ember)"}`,
                  }),
                ]),
              ]);
            })
          ),
        ]),
      ])
    )
  );

  if (fullPayload.rosterUnmatchedEverywhere && fullPayload.rosterUnmatchedEverywhere.length) {
    frag.appendChild(
      el("div", { class: "notice" }, [
        el("h3", { text: "Rostered coordinators with no matching work anywhere" }),
        el("p", {
          text:
            `${fullPayload.rosterUnmatchedEverywhere.join(", ")} — no scheduled events under those names at any ` +
            "configured client. Either the name differs in Ashby, or they work on a client with no dashboard yet.",
        }),
      ])
    );
  }

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
    // An ended engagement only has its own window; any other period is
    // empty by definition, so don't leave the page sitting on one.
    if (payload.status === "ended") state.period = "full";
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
  // Defaults come from the server so the UI can never select a period the
  // backend does not produce.
  state.period = state.config.defaultPeriod || (state.config.periods || [{}])[0].key;
  state.scope = state.config.defaultScope || (state.config.scopes || [{}])[0].key;
  render();
})();
