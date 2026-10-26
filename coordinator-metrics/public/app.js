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
  // Which accordion section is open on a client tab. Persisted across
  // re-renders so changing period or scope does not snap the tab shut.
  openSection: "support",
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

/**
 * Same date with the year, for the window a page states.
 *
 * "Oct 25 – Oct 20" is the one place a missing year is actively
 * misleading: the two ends of a 12-month window land in different years
 * and read as a five-day range without it.
 */
function formatDayLong(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
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

/**
 * A Results tile: current value, and the change from the equivalent
 * prior period.
 *
 * Coloured by IMPROVEMENT, not by sign. Turnaround falling is good and
 * must not render red just because the arrow points down; the same
 * green/amber decision is made from `direction` rather than from the
 * sign of the change.
 */
function resultTile(label, { value, unit = "", prior, direction = "lower", suppressed, note, sub, baseline, hero, count }) {
  const shown = value == null ? "—" : `${num(value)}${unit}`;

  let delta = null;
  if (!suppressed && value != null && prior != null && prior !== 0) {
    const diff = value - prior;
    if (Math.abs(diff) >= 0.05) {
      const improved = direction === "lower" ? diff < 0 : diff > 0;
      delta = el("span", {
        class: `delta ${improved ? "up" : "down"}`,
        // The arrow follows the VALUE; the colour follows whether that
        // is an improvement. They disagree on a lower-is-better metric,
        // which is the point.
        text: `${diff > 0 ? "▲" : "▼"} ${num(Math.round(Math.abs(diff) * 10) / 10)}${unit}`,
      });
    }
  }

  return el("div", { class: `stat${hero ? " hero" : ""}` }, [
    el("div", { class: "stat-number" }, [
      shown,
      // The whole number beside the percentage, not buried in the grey
      // line under it. Two short-notice bookings out of 40 and fifteen
      // out of 900 are different problems, and the percentage alone
      // makes the small client look like the worse one.
      count != null ? el("span", { class: "stat-count", text: num(count) }) : null,
      delta,
    ]),
    el("div", { class: "stat-label", text: label }),
    sub ? el("div", { class: "stat-sub", text: sub }) : null,
    baseline ? el("div", { class: "stat-sub", text: "12-month baseline — no target set" }) : null,
    suppressed && !baseline
      ? el("div", { class: "stat-sub", text: "no comparison — too few interviews in the prior period" })
      : null,
    note ? el("div", { class: "stat-sub", style: "font-style:italic", text: note }) : null,
  ]);
}

function groupHeading(title, blurb) {
  return el("div", { class: "group-heading" }, [
    el("h2", { text: title }),
    el("p", { class: "section-note", text: blurb }),
  ]);
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

/**
 * The Results group: how well the work ran, as distinct from how much of
 * it there was.
 */
function resultsGroup(payload, label) {
  const block = payload.results && payload.results[state.period];
  if (!block) return document.createComment("no results for this period");

  const c = block.current;
  const p = block.prior;
  const suppressed = block.deltaSuppressed;
  const baseline = block.isBaseline;
  const d = (metric, field) => (p && p[metric] ? p[metric][field] : null);

  return el("div", {}, [
    // No heading of its own: the accordion head above already names the
    // section, and rendering both printed the title twice.
    el("p", {
      class: "section-note",
      text: baseline
        ? `Over the ${label}. Shown as the baseline: no targets are set until these have been watched for a quarter.`
        : `Over the ${label}, against this client's own previous ${label.replace("last ", "")}. Lower is better on every metric here.`,
    }),
    el("div", { class: "scope-note" }, [
      el("p", {
        text:
          "These reflect this client's own interview mix, stage design and volume, and are not comparable " +
          "between clients. Each is measured only against this client's own prior period.",
      }),
      el("p", {
        text:
          "They are measures of how a process ran, not of how an individual performed. Several coordinators " +
          "work a client, work moves between them, and Ashby records only who created a booking — not who " +
          "chased it, re-planned it, or picked it up from someone else.",
      }),
    ]),
    el("div", { class: "stat-grid" }, [
      resultTile("Booking turnaround (median)", {
        // Emphasised: this and short notice are the two Results figures
        // the dashboard is meant to lead on.
        hero: true,
        value: c.bookingTurnaround.medianHours,
        unit: "bh",
        prior: d("bookingTurnaround", "medianHours"),
        suppressed, baseline,
        sub:
          c.bookingTurnaround.p90Hours == null
            ? `${num(c.bookingTurnaround.sample)} rounds`
            : `90th percentile ${num(c.bookingTurnaround.p90Hours)}bh · ${num(c.bookingTurnaround.sample)} rounds`,
        note: "business hours from becoming schedulable to being confirmed",
      }),
      resultTile("Time between stages (median)", {
        value: c.stageGap.medianDays,
        unit: "d",
        prior: d("stageGap", "medianDays"),
        suppressed, baseline,
        sub: c.stageGap.slowest
          ? `slowest: ${c.stageGap.slowest.label} at ${c.stageGap.slowest.medianDays}d (${num(c.stageGap.slowest.count)})`
          : `${num(c.stageGap.sample)} transitions`,
      }),
      resultTile("Short-notice bookings", {
        hero: true,
        value: c.shortNotice.share,
        unit: "%",
        count: c.shortNotice.count,
        prior: d("shortNotice", "share"),
        suppressed, baseline,
        sub: `${num(c.shortNotice.count)} of ${num(c.shortNotice.sample)} confirmed under ${state.config.shortNoticeHours}h before start`,
        note: "partly client-driven, not purely a coordination measure",
      }),
      resultTile("Cancelled, never rebooked", {
        value: c.cancellationWithoutRebook.share,
        unit: "%",
        count: c.cancellationWithoutRebook.count,
        prior: d("cancellationWithoutRebook", "share"),
        suppressed, baseline,
        sub: `${num(c.cancellationWithoutRebook.count)} of ${num(c.cancellationWithoutRebook.sample)} settled cancellations`,
        note: "excludes the last 14 days, which may still be rebooked",
      }),
      resultTile("Reschedule rate", {
        value: c.rescheduleRate.share,
        unit: "%",
        count: c.rescheduleRate.count,
        prior: d("rescheduleRate", "share"),
        suppressed, baseline,
        sub: `${num(c.rescheduleRate.count)} of ${num(c.rescheduleRate.sample)} rounds moved at least once`,
        note: "context-dependent",
      }),
    ]),
  ]);
}

/**
 * One section of the client tab's accordion.
 *
 * `render` is a thunk so a collapsed section costs nothing to build —
 * the heatmap and the two tables are the expensive ones, and on a tab
 * where only one section is open at a time most of them never run.
 */
const DOW_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A numbered section with a one-line definition under its title.
 *
 * The number is not decoration: it pairs the section with its row in the
 * rail, so "03" in the rail and "03" on the page are the same thing when
 * you jump between them.
 */
function pageSection(id, index, title, definition, body, aside) {
  return el("section", { class: "pg-section", id: `s-${id}` }, [
    el("div", { class: "pg-head" }, [
      el("span", { class: "pg-num", text: String(index).padStart(2, "0") }),
      el("div", {}, [
        el("h2", { class: "pg-title", text: title }),
        definition ? el("p", { class: "pg-def", text: definition }) : null,
      ]),
      aside ? el("span", { class: "pg-aside", text: aside }) : null,
    ]),
    el("div", { class: "pg-body" }, [body]),
  ]);
}

/**
 * The left rail: a contents list that also carries each section's key
 * figure.
 *
 * This replaced a one-open-at-a-time accordion. The accordion hid every
 * number until you opened it, so the tab told you nothing at a glance;
 * the rail is both the navigation and the summary, and the sections
 * below stay open.
 */
function sectionRail(items) {
  return el(
    "nav",
    { class: "rail", "aria-label": "Sections on this tab" },
    [
      el("p", { class: "rail-eyebrow", text: "On this tab" }),
      ...items.map((item, i) =>
        el(
          "a",
          {
            class: "rail-item",
            href: `#s-${item.id}`,
            onclick: (e) => {
              // Scrolled rather than jumped: a hard jump loses the sense
              // of where the section sits in the page.
              e.preventDefault();
              const target = document.getElementById(`s-${item.id}`);
              if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
            },
          },
          [
            el("span", { class: "rail-num", text: String(i + 1) }),
            el("span", { class: "rail-label", text: item.title }),
            el("span", { class: "rail-figure", text: item.figure ?? "" }),
          ]
        )
      ),
      el("div", { class: "rail-foot" }, [
        el("a", { class: "rail-item rail-minor", href: "#s-quality", text: "Data quality check",
          onclick: (e) => { e.preventDefault(); document.getElementById("s-quality")?.scrollIntoView({ behavior: "smooth" }); } }),
        el("a", { class: "rail-item rail-minor", href: "#s-method", text: "How the numbers are built",
          onclick: (e) => { e.preventDefault(); document.getElementById("s-method")?.scrollIntoView({ behavior: "smooth" }); } }),
      ]),
    ]
  );
}

// Highlights the rail row for whichever section is currently in view.
function trackRail(root) {
  const sections = [...root.querySelectorAll(".pg-section")];
  const links = [...root.querySelectorAll(".rail-item[href^='#s-']")];
  if (!sections.length || !("IntersectionObserver" in window)) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = entry.target.id;
        links.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#${id}`));
      }
    },
    // Fires when a section crosses the upper third, so the highlight
    // matches what is being read rather than what is merely on screen.
    { rootMargin: "-10% 0px -70% 0px", threshold: 0 }
  );
  sections.forEach((s) => observer.observe(s));
}

/**
 * Our work beside the client's own, at the same client.
 *
 * Asked for so a difference in how the two run is visible rather than
 * inferred from a share. It compares only WITHIN one client, so the
 * objection that sank cross-client Results comparisons — different
 * interview mix, different stage design — does not apply in the same
 * way. It is still not a controlled comparison, and the panel says so:
 * the roles each side covers are usually different, and the side with
 * the harder reqs is not the side with the worse process.
 *
 * Rendered only when BOTH sides clear a floor. Below it, one late
 * booking moves a rate by tens of points and the panel invents a
 * finding out of a rounding artefact.
 */
const COMPARE_MIN_SAMPLE = 25;

function versusPanel(fullPayload, label) {
  const ours = fullPayload.scopes.coordinated;
  const theirs = fullPayload.scopes.notCoordinated;
  if (!ours || !theirs) return null;

  const oursResults = ours.results[state.period];
  const theirsResults = theirs.results[state.period];
  if (!oursResults || !theirsResults) return null;

  // The panel as a whole still needs something on both sides; the rows
  // then gate themselves individually.
  // Period-scoped, like every row below. Reading totals here left the
  // volume row frozen at the 12-month figure while the rates beneath it
  // moved with the toggle — two different periods in one panel.
  const oursEvents = ours.periods[state.period].current.events;
  const theirsEvents = theirs.periods[state.period].current.events;

  if (oursEvents < COMPARE_MIN_SAMPLE || theirsEvents < COMPARE_MIN_SAMPLE) {
    return el("div", { class: "empty" }, [
      `Not enough on both sides to compare over the ${label}: ` +
        `${num(oursEvents)} interviews coordinated by Carrara, ` +
        `${num(theirsEvents)} booked by the client's own team. ` +
        `A comparison needs at least ${COMPARE_MIN_SAMPLE} each.`,
    ]);
  }

  const a = oursResults.current;
  const b = theirsResults.current;

  // The direct-booking share is the evidence for the caveat below, so
  // it is computed from the payload rather than asserted in prose.
  const directShare = (scope) => {
    const t = scope.timeToSchedule;
    const total = t.sample + t.directBookings;
    return total ? Math.round((t.directBookings / total) * 1000) / 10 : 0;
  };
  const directOurs = directShare(ours);
  const directTheirs = directShare(theirs);

  // Lower is better on every row here, as it is throughout Results.
  //
  // Each row is gated on ITS OWN sample, not on the panel's event
  // count. The two are very different numbers — Luminai's client-side
  // reschedule rate rests on 105 rounds against 128 interviews, and on
  // a 7-day period both collapse to single figures while the event
  // count still clears the panel's floor. One late booking out of four
  // is a 25-point swing, which is a rounding artefact wearing the
  // clothes of a finding.
  const rate = (label, metric, field, unit) => ({
    label,
    unit,
    ours: a[metric][field],
    theirs: b[metric][field],
    oursSample: a[metric].sample,
    theirsSample: b[metric].sample,
  });

  const rows = [
    { label: "Interviews", ours: oursEvents, theirs: theirsEvents, unit: "", neutral: true },
    rate("Booking turnaround (median)", "bookingTurnaround", "medianHours", "bh"),
    rate("Short-notice bookings", "shortNotice", "share", "%"),
    rate("Reschedule rate", "rescheduleRate", "share", "%"),
    rate("Cancelled, never rebooked", "cancellationWithoutRebook", "share", "%"),
  ];

  return el("div", {}, [
    el("div", { class: "vs-grid" }, [
      el("div", { class: "vs-head" }, [
        el("span", { class: "vs-row-label" }),
        el("span", { class: "vs-ours", text: "Carrara" }),
        el("span", { class: "vs-theirs", text: "Client's own" }),
      ]),
      ...rows.map((row) => {
        const thin =
          !row.neutral &&
          (row.oursSample < COMPARE_MIN_SAMPLE || row.theirsSample < COMPARE_MIN_SAMPLE);
        // NO better/worse verdict here, deliberately — see the note
        // below the table. Colour is the strongest signal on the page
        // and this comparison cannot carry one.
        const cell = (side, value, sample) =>
          el("span", { class: `vs-${side}${thin ? " vs-thin" : ""}` },
            thin
              ? [el("span", { class: "vs-thin-mark", title: `only ${num(sample)} in this period`, text: "—" })]
              : [value == null ? "—" : `${num(value)}${row.unit}`]);
        return el("div", { class: "vs-row" }, [
          el("span", { class: "vs-row-label" }, [
            row.label,
            thin ? el("span", { class: "vs-row-note", text: `too few to compare (${num(Math.min(row.oursSample, row.theirsSample))})` }) : null,
          ]),
          cell("ours", row.ours, row.oursSample),
          cell("theirs", row.theirs, row.theirsSample),
        ]);
      }),
    ]),
    el("div", { class: "scope-note" }, [
      el("p", {
        text:
          "Neither column is marked better. The two sides are not doing the same job, and on two of these " +
          "measures the difference between them is known to run one way for reasons that have nothing to do " +
          "with how well the work was done.",
      }),
      el("p", {
        text:
          `${directOurs}% of what Carrara booked here was booked outright — the schedule and the interview ` +
          `created in one action — against ${directTheirs}% of the client's own. Someone advancing a candidate ` +
          "and booking them in the same sitting records almost no turnaround and has little left to " +
          "reschedule. A coordinator takes a request and works it. Turnaround and reschedule rate will " +
          "therefore tend to look worse on the Carrara side at every client, and do.",
      }),
      el("p", {
        text:
          "The rounds are not alike either: a coordinator gets the panels, the onsites and the ones that " +
          "already went wrong, and a round picked up BECAUSE it was rescheduled counts its reschedule " +
          "against whoever picked it up. Read a gap here as somewhere to look, never as a verdict, and do " +
          "not put it in front of a client as one.",
      }),
      el("p", {
        text:
          "Interviews booked with no scheduler recorded in Ashby are in neither column. The data quality " +
          "section below says how many that is.",
      }),
    ]),
  ]);
}

function renderClient(fullPayload) {
  const payload = fullPayload.scopes[state.scope];
  const period = payload.periods[state.period];
  const label = periodLabel(state.period);
  const isEnded = fullPayload.status === "ended";
  const sup = fullPayload.support;
  const t = payload.totals;
  const resultsBlock = payload.results[state.period];
  const r = resultsBlock.current;
  const frag = document.createDocumentFragment();

  frag.appendChild(
    el("div", { class: "client-head" }, [
      el("div", {}, [
        el("h2", { class: "client-name" }, [
          el("span", { class: "tab-dot" }),
          fullPayload.clientName,
        ]),
        el("p", {
          class: "client-context",
          text:
            `${(state.config.scopes.find((sc) => sc.key === state.scope) || {}).label || state.scope} · ` +
            `${label} · ${fullPayload.timeZone}`,
        }),
        // Who is assigned here, stated plainly. Asked for so the tab
        // says whose client this is without anyone opening Notion.
        // Names only, never counts: ordered or numbered it becomes the
        // leaderboard the roster panel is deliberately not.
        fullPayload.roster && fullPayload.roster.configured.length
          ? el("p", { class: "client-roster" }, [
              el("span", { class: "client-roster-label", text: "Coordinators" }),
              [...fullPayload.roster.configured].sort((a, b) => a.localeCompare(b)).join(" · "),
            ])
          : null,
      ]),
      el("div", { class: "client-controls" }, [
        scopeControl(() => render()),
        periodControl(() => render(), { onlyFull: isEnded }),
      ]),
    ])
  );

  if (isEnded) {
    frag.appendChild(
      el("div", { class: "notice" }, [
        el("h3", { text: "Ended engagement" }),
        el("p", {
          text:
            `Carrara coordinated for ${fullPayload.clientName} from ${formatDay(fullPayload.engagementStart)} ` +
            `to ${formatDay(fullPayload.engagementEnd)}. Every figure here covers that period, not a rolling ` +
            "12 months, so the work does not fade out as time passes.",
        }),
      ])
    );
  }

  const sections = [];
  const railItems = [];
  const add = (id, title, figure, definition, body, aside) => {
    railItems.push({ id, title, figure });
    sections.push(pageSection(id, railItems.length, title, definition, body, aside));
  };

  add("support", "Level of support", sup.interviews.share == null ? "—" : sup.interviews.share + "%",
    `Share of everything that ran at ${fullPayload.clientName} that Carrara coordinated.`,
    el("div", {}, [
      el("div", { class: "share-row" }, [
        shareBlock("of interviews", sup.interviews),
        shareBlock("of candidates", sup.candidates),
        shareBlock("of roles", sup.roles),
      ]),
      el("p", { class: "section-note", text:
        "Three shares rather than one blended figure: being named on a req is not the same as running its " +
        "interviews, and an average hides where those two diverge." }),
    ]),
    "Coordinated vs all activity");

  add("results", "Results", r.bookingTurnaround.medianHours == null ? "—" : r.bookingTurnaround.medianHours + " bh",
    `Measured against ${fullPayload.clientName}'s own previous period. Colour shows better or worse, not up or down.`,
    resultsGroup(payload, label));

  {
    const vs = versusPanel(fullPayload, label);
    if (vs) {
      const theirs = fullPayload.scopes.notCoordinated;
      add("versus", "Carrara vs the client's own team",
        theirs ? num(theirs.periods[state.period].current.events) : "—",
        `The same measures, split by who booked the interview. Both columns are ${fullPayload.clientName}.`,
        vs,
        "Within this client only");
    }
  }

  add("volume", "Volume", num(t.events),
    "Counts for the selected period. Meals are counted; holds are not.",
    el("div", {}, [
      // This week against last, before the period totals. Asked for:
      // the week-on-week move is what says whether someone is actually
      // underwater right now, and it was previously only on the
      // overview table. Absolute, not a percentage — on a base of two
      // interviews a percentage swings wildly and describes nothing.
      fullPayload.status === "ended"
        ? null
        : el("div", { class: "weekbar" }, [
            el("span", { class: "weekbar-label", text: "This week" }),
            el("span", { class: "weekbar-value", text: num(payload.periods.week.current.events) }),
            weekDelta(payload.periods.week.current.events, payload.periods.week.previous.events),
            el("span", { class: "weekbar-sub", text: `${num(payload.periods.week.previous.events)} last week` }),
          ]),
      el("p", { class: "band-label", text: "Work delivered" }),
      el("div", { class: "stat-grid tight" }, [
        stat(num(period.current.events), "Interviews", { sub: `incl. ${num(t.meals)} meals` }),
        stat(num(Math.round(period.current.hours)) + "h", "Interview hours"),
        stat(num(period.current.candidates), "Candidates"),
        stat(num(t.roles), "Roles"),
        stat(num(t.interviewerSlots), "Interviewer seats"),
      ]),
      el("p", { class: "band-label", text: "Changes and outcomes" }),
      el("div", { class: "stat-grid tight" }, [
        stat(num(t.bookedAhead), "Booked ahead", { sub: "after today" }),
        stat(num(t.reschedulesDerived), "Reschedules", { sub: "derived" }),
        stat(num(t.cancellations), "Cancellations"),
        stat(num(t.dropOffs), "Archived after interviewing", { sub: "counts applications, not people" }),
        stat(num(t.outOfHours), "Out of hours",
          { sub: `before ${state.config.businessHours.start} or after ${state.config.businessHours.end}` }),
      ]),
    ]));

  add("trend", "Volume over time", payload.series.weekly.length + " wk",
    "Faded bars are the current week and interviews booked ahead.",
    el("div", {}, [
      state.period === "week"
        ? barChart(payload.series.daily.slice(-28), { fadeFrom: nextDay(fullPayload.today), labelFn: formatDay })
        : state.period === "month"
        ? barChart(payload.series.daily.slice(-60), { fadeFrom: nextDay(fullPayload.today), labelFn: formatDay })
        : barChart(state.period === "quarter" ? payload.series.weekly.slice(-13) : payload.series.weekly, {
            fadeFrom: fullPayload.currentWeek, labelFn: formatDay }),
    ]));

  add("byRole", "By role", num(payload.byRole[state.period].length),
    "Grouped by job record, not by title. Identically titled reqs are numbered, never merged.",
    roleTable(payload.byRole[state.period]));

  add("byStage", "By stage", num(payload.byStage[state.period].length),
    "Interviews held in each stage. Stages passed without an interview are absent.",
    stageBars(payload.byStage[state.period]));

  const hs = payload.heatmapSummary ? payload.heatmapSummary[state.period] : null;
  add("heatmap", "When the work happens", hs ? DOW_LABEL[hs.busiest.dow] : "—",
    `Interview start times by weekday and hour, in ${fullPayload.timeZone}.`,
    el("div", { class: "heat-wrap" }, [
      heatmapGrid(payload.heatmap[state.period], fullPayload.timeZone),
      hs
        ? el("div", { class: "heat-readout" }, [
            readout("Busiest window", `${DOW_LABEL[hs.busiest.dow]} ${String(hs.busiest.hour).padStart(2, "0")}:00`,
              `${hs.busiest.share}% of all starts`),
            readout("In business hours", hs.inHoursShare + "%",
              `start between ${state.config.businessHours.start}:00 and ${state.config.businessHours.end}:00`),
            readout("Out of hours", num(hs.outOfHours), "evenings, early mornings and weekends"),
          ])
        : null,
    ]));

  add("areas", "Areas to work on",
    String((payload.areasToWorkOn.byRole.length + payload.areasToWorkOn.byStage.length) || 0) + " flagged",
    "Roles and stages where cancelled interviews were most often never rebooked.",
    areasToWorkOn(payload, fullPayload.clientName));

  frag.appendChild(
    el("div", { class: "rail-layout" }, [sectionRail(railItems), el("div", { class: "rail-main" }, sections)])
  );

  if (payload.records && payload.records.busiestDay) {
    frag.appendChild(
      el("div", { class: "notice" }, [
        el("h3", { text: "Busiest day" }),
        el("p", { text: `${formatDay(payload.records.busiestDay.date)} — ${payload.records.busiestDay.events} interviews coordinated in a single day.` }),
      ])
    );
  }

  const quality = renderRoster(fullPayload);
  quality.id = "s-quality";
  frag.appendChild(quality);
  const method = renderDataQuality(fullPayload, payload);
  method.id = "s-method";
  frag.appendChild(method);

  // Observed after the fragment is in the document, from render().
  queueMicrotask(() => trackRail(document.getElementById("main") || document));

  return frag;
}

// One share: a big percentage, its ratio, and a bar.
function shareBlock(label, share) {
  return el("div", { class: "share-block" }, [
    el("div", { class: "share-value" }, [
      el("span", { class: "share-pct", text: share.share == null ? "—" : share.share + "%" }),
      el("span", { class: "share-label", text: label }),
    ]),
    el("div", { class: "share-track" }, [
      el("div", { class: "share-fill", style: `width:${Math.max(0, Math.min(100, share.share || 0))}%` }),
    ]),
    el("p", { class: "share-sub", text: `${num(share.ours)} of ${num(share.all)}` }),
  ]);
}

function readout(label, value, sub) {
  return el("div", { class: "readout" }, [
    el("p", { class: "readout-label", text: label }),
    el("p", { class: "readout-value", text: value }),
    sub ? el("p", { class: "readout-sub", text: sub }) : null,
  ]);
}

/**
 * By stage as a two-column bar list rather than a second table — beside
 * By role, two tables of the same shape read as one undifferentiated
 * block.
 */
function stageBars(rows) {
  if (!rows || !rows.length) return el("div", { class: "empty", text: "No stage data for this period." });
  const max = Math.max(...rows.map((r) => r.events), 1);
  const shown = rows.slice(0, 14);
  const half = Math.ceil(shown.length / 2);
  const column = (list) =>
    el("div", { class: "stage-col" }, list.map((row) =>
      el("div", { class: "stage-row" }, [
        el("div", { class: "stage-top" }, [
          el("span", { class: "stage-name", text: row.title }),
          el("span", { class: "stage-count", text: num(row.events) }),
        ]),
        el("div", { class: "stage-track" }, [
          el("div", { class: "stage-fill", style: `width:${Math.max(1, (row.events / max) * 100)}%` }),
        ]),
      ])
    ));
  return el("div", { class: "stage-cols" }, [column(shown.slice(0, half)), column(shown.slice(half))]);
}

function areasToWorkOn(payload, clientName) {
  const a = payload.areasToWorkOn;
  if (!a || a.clientAverage == null) return document.createComment("no cancellation data");

  const groups = [["By role", a.byRole], ["By stage", a.byStage]].filter(([, rows]) => rows.length);
  if (!groups.length) {
    return el("div", { class: "section" }, [
      el("div", { class: "card" }, [
        el("div", {
          class: "empty",
          text:
            `No role or stage is doing worse than ${clientName}'s own average of ${a.clientAverage}%, ` +
            `among groups with at least ${a.minGroupSize} cancellations. Nothing stands out.`,
        }),
      ]),
    ]);
  }

  const table = (rows) =>
    el("div", { class: "table-wrap" }, [
      el("table", {}, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { text: "Group" }),
            el("th", { class: "num", text: "Never rebooked" }),
            el("th", { class: "num", text: "Share" }),
            el("th", { class: "num", text: "vs client avg" }),
            el("th", { text: "Records" }),
          ]),
        ]),
        el(
          "tbody",
          {},
          rows.map((row) => {
            const gap = Math.round((row.share - a.clientAverage) * 10) / 10;
            return el("tr", {}, [
              el("td", { class: "lead", text: row.name }),
              el("td", { class: "num", text: `${num(row.neverRebooked)} of ${num(row.total)}` }),
              el("td", { class: "num", text: `${row.share}%` }),
              el("td", { class: "num" }, [el("span", { class: "delta down", text: `+${gap}pp` })]),
              el("td", {}, [
                el(
                  "details",
                  {},
                  [
                    el("summary", { text: `${row.examples.length} example${row.examples.length === 1 ? "" : "s"}` }),
                    el(
                      "ul",
                      { class: "record-list" },
                      row.examples.map((x) =>
                        el("li", {}, [
                          el("a", { href: x.scheduleUrl, target: "_blank", rel: "noopener", text: "schedule" }),
                          x.candidate ? ` · ${x.candidate}` : "",
                          x.candidateUrl
                            ? el("a", { href: x.candidateUrl, target: "_blank", rel: "noopener", style: "margin-left:6px", text: "profile" })
                            : null,
                          el("span", { class: "muted", style: "margin-left:6px", text: formatDay(String(x.at).slice(0, 10)) }),
                        ])
                      )
                    ),
                  ]
                ),
              ]),
            ]);
          })
        ),
      ]),
    ]);

  // No heading: the accordion head above names this section already.
  return el("div", { class: "section" }, [
    el("p", {
      class: "section-note",
      text:
        `Cancellations never rebooked, against ${clientName}'s own average of ${a.clientAverage}% ` +
        `(${num(a.sample)} settled cancellations). Only groups of ${a.minGroupSize} or more, doing worse than that average.`,
    }),
    ...groups.map(([title, rows]) =>
      el("div", { class: "card", style: "margin-bottom:16px" }, [
        el("p", { class: "eyebrow", text: title }),
        table(rows),
      ])
    ),
  ]);
}

function renderRoster(fullPayload) {
  const roster = fullPayload.roster;
  if (!roster) return null;
  if (state.scope !== "coordinated") return document.createComment("roster shown only in coordinated scope");

  const children = [
    // Said on the page, not only in the code: this is a check that the
    // roster resolves, and a reader who takes it for a workload summary
    // would be reading something it is not.
    el("p", {
      class: "section-note",
      text:
        "A roster match check. It confirms each rostered coordinator resolves to real scheduled work in Ashby, " +
        "which is how a misspelled name, a renamed account or a coordinator assigned to the wrong client gets " +
        "caught. It is not a workload or performance measure: several coordinators work a client, work moves " +
        "between them, and Ashby records only who created a booking.",
    }),
    el("p", {
      text:
        `${roster.matched.length} of the ${roster.configured.length} rostered coordinators resolve at ` +
        `${fullPayload.clientName}, listed alphabetically: ` +
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

  // Collapsed. Open, a list of names beside numbers is the most
  // leaderboard-shaped thing on the page, whatever the heading says.
  return el("details", { class: "data-quality" }, [
    el("summary", { text: "Data quality — roster match check" }),
    el("div", { class: "notice" }, children),
  ]);
}

function renderDataQuality(fullPayload, payload) {
  const dq = fullPayload.dataQuality;
  const un = dq.unattributed;
  // What the coordinated / client's-own split cannot place. Stated
  // rather than left to a subtraction: the events figure is tiny and
  // the schedules one is not, and a cancellation rate is drawn from
  // schedules.
  const unattributedNote =
    un && un.schedulesSample
      ? el("p", {
          style: "margin-top:8px",
          text:
            `Ashby records no scheduler on ${num(un.schedules)} of this client's ${num(un.schedulesSample)} ` +
            `schedules (${((un.schedules / un.schedulesSample) * 100).toFixed(1)}%) and ` +
            `${num(un.events)} of ${num(un.eventsSample)} interviews ` +
            `(${((un.events / Math.max(1, un.eventsSample)) * 100).toFixed(1)}%). Those are in neither the ` +
            "Carrara column nor the client's own — counting them on either side would invent a finding. " +
            "Volume is barely affected; cancellation and reschedule rates, which are drawn from schedules, " +
            "are the figures to discount.",
        })
      : null;
  return el("div", { class: "notice" }, [
    el("h3", { text: "How these numbers are built" }),
    unattributedNote,
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

/**
 * A row's last twelve complete weeks, as a miniature bar chart.
 *
 * A single "this week" number says where a client is; the shape says
 * where it is going, and a ramp or a cliff is the thing worth clicking
 * into. Deliberately unlabelled — it is a shape, not a reading.
 */
function sparkline(values, accent) {
  if (!values || !values.length) return el("span", { class: "muted", text: "—" });
  const max = Math.max(...values, 1);
  return el(
    "div",
    { class: "spark", title: `Last ${values.length} complete weeks` },
    values.map((v) =>
      el("i", {
        class: "spark-bar",
        style: `height:${Math.max(8, (v / max) * 100)}%;background:${accent || "var(--ember)"}`,
      })
    )
  );
}

/**
 * The headline comparison: what we coordinated, against everything that
 * ran at the same clients.
 *
 * Two stacked tracks rather than one percentage. "10,120 of 13,493" is
 * the claim worth making, and showing the remainder keeps a roster gap
 * visible instead of reading as low output.
 */
function compareBar(ours, all, caption) {
  const pct = all ? (ours / all) * 100 : 0;
  return el("div", { class: "compare" }, [
    el("div", { class: "compare-heads" }, [
      el("div", {}, [
        el("p", { class: "compare-label", text: "Coordinated by Carrara" }),
        el("p", { class: "compare-value", text: num(ours) }),
      ]),
      el("div", { class: "compare-right" }, [
        el("p", { class: "compare-label", text: "All that ran" }),
        el("p", { class: "compare-value muted", text: num(all) }),
      ]),
    ]),
    el("div", { class: "compare-track" }, [
      el("div", { class: "compare-fill", style: `width:${Math.max(0, Math.min(100, pct))}%` }),
    ]),
    caption ? el("p", { class: "compare-caption", text: caption }) : null,
  ]);
}

/** One of the four overview tiles: label above, number, explanation under. */
function ovTile(label, value, sub) {
  return el("div", { class: "ov-tile" }, [
    el("p", { class: "ov-tile-label", text: label }),
    el("p", { class: "ov-tile-value", text: value }),
    el("p", { class: "ov-tile-sub", text: sub }),
  ]);
}

function renderOverview(fullPayload) {
  const payload = fullPayload.scopes[state.scope];
  const label = periodLabel(state.period);
  const groups = payload.groups || {};
  const core = groups.core || { clientNames: [], coordinated: 0, all: 0, sharePct: null };
  const frag = document.createDocumentFragment();

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const w = payload.window;

  // Head: the window every figure below is drawn from, and the scope
  // toggle. The scope toggle belongs here as much as on a client tab —
  // the overview reads state.scope either way, and without a control it
  // was stuck on the default with nothing on screen to say so.
  //
  // The PERIOD control is deliberately not here. The overview's periods
  // carry only events and hours, so the tiles, the Results ranges and
  // the by-client table are all 12-month figures and cannot follow it.
  // Sitting at the top of the page it looked like it drove all of them,
  // and the by-client heading obediently relabelled itself "last 30
  // days" over numbers that had not moved. It lives on the chart, which
  // is the one thing it changes.
  frag.appendChild(
    el("div", { class: "ov-head" }, [
      el("p", {
        class: "ov-window",
        text: w
          ? `Last 12 months · ${formatDayLong(w.from.slice(0, 10))} – ${formatDayLong(fullPayload.today)}`
          : "Last 12 months",
      }),
      el("div", { class: "client-controls" }, [scopeControl(() => render())]),
    ])
  );

  // The headline states what was coordinated and out of what, for ONE
  // engagement group. Forus is client-scheduled and Profound has ended,
  // so both are stated separately rather than folded into a percentage
  // that would describe neither.
  const asides = [];
  const cs = groups.clientScheduled;
  if (cs && cs.clientIds.length) {
    asides.push(`${cs.clientNames.join(", ")} schedules its own interviews — counted in volume, left out of the share.`);
  }
  const ended = groups.ended;
  if (ended && ended.clientIds.length) {
    asides.push(
      `${ended.clientNames.join(", ")} — engagement ended — kept in totals, not in this week or the trend.`
    );
  }

  frag.appendChild(
    el("div", { class: "ov-hero" }, [
      el("div", {}, [
        el("h2", { class: "ov-headline" }, [
          "Carrara coordinated ",
          el("strong", { text: num(core.coordinated) }),
          ` interviews across the ${plural(core.clientNames.length, "client", "clients")} we schedule for`,
          core.sharePct == null ? "." : ` — ${core.sharePct}% of everything that ran there.`,
        ]),
        asides.length
          ? el("ul", { class: "ov-asides" }, asides.map((text) => el("li", { text })))
          : null,
      ]),
      compareBar(
        core.coordinated,
        core.all,
        core.sharePct == null ? null : `${core.sharePct}% across ${core.clientNames.join(", ")}`
      ),
    ])
  );

  // Four tiles. Ten made the page a wall of numbers with no hierarchy.
  // Each carries a one-line explanation, because "interviewer seats" and
  // "candidates" were both read as "people" by two different readers.
  const clientCount = (payload.byClient || []).length;
  frag.appendChild(
    el("div", { class: "ov-tiles" }, [
      ovTile("Interviews held", num(payload.totals.events), `All ${clientCount} clients, every engagement type`),
      ovTile("Interview hours", num(payload.totals.hours) + "h", "Scheduled time on interviewers' calendars"),
      ovTile("Candidates", num(payload.totals.candidates), "Unique people with at least one interview"),
      ovTile("Interviewer seats", num(payload.totals.interviewerSlots), `Across ${num(payload.totals.roles)} roles`),
    ])
  );

  // Chart and the Results range side by side: the range is a short list
  // and full width made it look like the page's main claim, which is
  // exactly the reading it is built to prevent.
  const range = payload.resultsRange;
  const span = (r, unit, dp = 0) =>
    r == null ? "—" : r.low === r.high ? `${r.low.toFixed(dp)}${unit}` : `${r.low.toFixed(dp)} – ${r.high.toFixed(dp)}${unit}`;

  frag.appendChild(
    el("div", { class: "ov-split" }, [
      el("div", { class: "card" }, [
        el("div", { class: "card-head" }, [
          el("div", {}, [
            el("h3", { class: "card-title", text: "Interviews per week" }),
            el("p", {
              class: "card-note",
              text: `Active clients only, over the ${label}. Weeks are Monday-start.`,
            }),
          ]),
          el("div", { class: "chart-controls" }, [
            periodControl(() => render()),
            el("div", { class: "legend" }, [
              el("span", {}, [el("i", { class: "swatch", style: "background:var(--accent,#eb4e19)" }), "Complete week"]),
              el("span", {}, [
                el("i", { class: "swatch", style: "background:var(--accent,#eb4e19);opacity:.3" }),
                "In progress or booked ahead",
              ]),
            ]),
          ]),
        ]),
        barChart(overviewSeries(payload), { fadeFrom: fullPayload.currentWeek, labelFn: formatDay, height: 200 }),
      ]),
      range && range.bookingTurnaround
        ? el("div", { class: "card" }, [
            el("h3", { class: "card-title", text: "Results across clients" }),
            el("p", {
              class: "card-note",
              text: `Lowest to highest client figure. Ranges only — each client is read against its own prior period, on its tab.`,
            }),
            el("div", { class: "range-list" }, [
              rangeRow("Booking turnaround, median", span(range.bookingTurnaround, ""), "business hours"),
              rangeRow("Short-notice bookings", span(range.shortNotice, "", 1), "%"),
              rangeRow("Time between stages", span(range.stageGap, "", 1), "days"),
              rangeRow("Cancelled, never rebooked", span(range.cancellationWithoutRebook, "", 0), "%"),
              rangeRow("Reschedule rate", span(range.rescheduleRate, "", 0), "%"),
            ]),
          ])
        : null,
    ])
  );

  // By client. Ours against everything that ran, with the trend shape
  // beside it — the ordering here is by volume, and deliberately carries
  // no Results column: those are not comparable between clients.
  const GROUP_NOTE = { core: "", clientScheduled: "Client-scheduled", ended: "Ended" };

  frag.appendChild(
    el("div", { class: "ov-section" }, [
      el("h3", { class: "ov-section-title", text: "By client" }),
      // Fixed at 12 months, never `label`: these rows have no per-period
      // variant, so following the chart's toggle would retitle numbers
      // that had not changed.
      el("p", { class: "ov-section-note", text: "Last 12 months. Select a row to open that client's tab." }),
      el("div", { class: "card table-wrap" }, [
        el("table", { class: "ov-table" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: "Client" }),
              el("th", { text: "Coordinated / all that ran" }),
              el("th", { class: "num", text: "Hours" }),
              el("th", { class: "num", text: "Candidates" }),
              el("th", { class: "num", text: "Roles" }),
              el("th", { class: "num", text: "Reschedules" }),
              el("th", { class: "num", text: "Cancelled" }),
              el("th", { class: "num", text: "This week" }),
              el("th", { text: "Last 12 weeks" }),
            ]),
          ]),
          el(
            "tbody",
            {},
            payload.byClient.map((row) => {
              const note = GROUP_NOTE[row.group];
              const share = row.allEvents ? (row.coordinatedEvents / row.allEvents) * 100 : null;
              // A share is only meaningful inside one engagement type —
              // Forus's own team books most of its interviews, so a
              // percentage there would describe a different thing to the
              // same column on the row above it.
              const showShare = row.group === "core";
              return el("tr", { onclick: () => selectTab(row.clientId) }, [
                el("td", { class: "lead" }, [
                  el("span", { class: "tab-dot", style: `--tab-accent:${row.accentColor || "var(--ember)"}` }),
                  row.clientName,
                  note ? el("span", { class: "pill", text: note }) : null,
                ]),
                el("td", { class: "share-cell" }, [
                  el("div", { class: "share-cell-top" }, [
                    el("span", { class: "share-cell-ours", text: num(row.coordinatedEvents) }),
                    el("span", { class: "muted", text: ` / ${num(row.allEvents)}` }),
                    showShare
                      ? el("span", { class: "share-cell-pct", text: `${share.toFixed(1)}%` })
                      : el("span", { class: "share-cell-pct muted", text: note ? "not in share" : "" }),
                  ]),
                  el("div", { class: "share-cell-track" }, [
                    el("div", {
                      class: "share-cell-fill",
                      style: `width:${Math.max(1, Math.min(100, share || 0))}%;background:${row.accentColor || "var(--ember)"}`,
                    }),
                  ]),
                ]),
                el("td", { class: "num", text: num(row.hours) }),
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
                el("td", { class: "spark-cell" }, [sparkline(row.sparkline, row.accentColor)]),
              ]);
            })
          ),
        ]),
      ]),
    ])
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

  frag.appendChild(
    el("p", {
      class: "ov-foot",
      text:
        "Counts include meals; holds are excluded by whole-word title match. Booked-ahead interviews appear in " +
        "the chart, faded, and never in a total.",
    })
  );

  return frag;
}

/** One label / value / unit row in the Results range card. */
function rangeRow(label, value, unit) {
  return el("div", { class: "range-row" }, [
    el("span", { class: "range-label", text: label }),
    el("span", { class: "range-value" }, [value, unit ? el("span", { class: "range-unit", text: unit }) : null]),
  ]);
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
