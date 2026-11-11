"use strict";
// The usage log page (/usage, admins only; see usage-log.js). Rendered
// whole on the server, filters as a plain GET form, no script. Its styles
// are its own, with the tokens copied from style.css as in signin-page.js.

const { EVENTS } = require("./usage-log");

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function whoLabel(e) {
  if (e.who) return escapeHtml(e.who);
  if (e.via === "password") return `<span class="muted">dashboard password</span>${e.session ? ` <span class="session" title="One password sign-in">${escapeHtml(e.session)}</span>` : ""}`;
  return `<span class="muted">unknown account</span>`;
}

function usagePage({ title, timeZone, rows, more, page, filters, people, days, admins }) {
  const fmtTime = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
  const fmtDay = (d) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date(d + "T00:00:00Z"));
  const adminSet = new Set(admins);
  const query = (over) => {
    const q = new URLSearchParams();
    const f = { day: filters.day, person: filters.person, admins: filters.includeAdmins ? "1" : null, page: page || null, ...over };
    for (const [k, v] of Object.entries(f)) if (v) q.set(k, String(v));
    const s = q.toString();
    return "/usage" + (s ? "?" + s : "");
  };
  const option = (value, label, selected) => `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const personOptions = [option("", "Everyone", !filters.person)]
    .concat(people.map((p) => option(p, p === "password" ? "Dashboard password" : p + (adminSet.has(p) ? " (admin)" : ""), filters.person === p)));
  const dayOptions = [option("", "All days", !filters.day)].concat(days.map((d) => option(d, fmtDay(d), filters.day === d)));

  const body = rows.length
    ? rows.map((e) => `<tr${e.who && adminSet.has(e.who) ? ' class="admin"' : ""}>
        <td class="time">${escapeHtml(fmtTime.format(e.at))}</td>
        <td>${whoLabel(e)}</td>
        <td>${escapeHtml(EVENTS[e.event])}</td>
        <td>${e.detail ? escapeHtml(e.detail) : ""}</td>
      </tr>`).join("")
    : `<tr><td colspan="4" class="empty">Nothing recorded${filters.day || filters.person ? " for this filter" : " yet"}.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Usage log · ${escapeHtml(title)}</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700&family=PT+Serif:wght@700&display=swap">
  <style>
    :root {
      --ember: #eb4e19;
      --page: #f5f3f1;
      --surface: #ffffff;
      --text-primary: #2d2a2a;
      --text-secondary: #59534f;
      --border: #d3cfcc;
      --font-serif: "PT Serif", Georgia, "Times New Roman", serif;
      --font-sans: "Manrope", system-ui, -apple-system, "Segoe UI", sans-serif;
      --radius-card: 12px;
      --radius-control: 8px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --ember: #ffad89;
        --page: #2d2a2a;
        --surface: #3a3634;
        --text-primary: #ffffff;
        --text-secondary: #d3cfcb;
        --border: rgba(255, 255, 255, 0.12);
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 32px 16px; background: var(--page); color: var(--text-primary); font: 14px/1.5 var(--font-sans); }
    main { max-width: 1100px; margin: 0 auto; }
    h1 { font-family: var(--font-serif); font-size: 24px; margin: 0 0 4px; }
    a { color: var(--text-primary); }
    .muted { color: var(--text-secondary); }
    p { margin: 0 0 16px; }
    form { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin: 0 0 16px; }
    label { display: flex; flex-direction: column; gap: 4px; font-weight: 600; }
    label.check { flex-direction: row; align-items: center; gap: 6px; font-weight: 400; padding-bottom: 8px; }
    select, button { font: 14px var(--font-sans); padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius-control); background: var(--surface); color: var(--text-primary); }
    button { cursor: pointer; }
    .table-wrap { overflow-x: auto; background: var(--surface); border: 1px solid var(--border); border-top: 3px solid var(--ember); border-radius: var(--radius-card); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { font-weight: 600; color: var(--text-secondary); }
    tr:last-child td { border-bottom: 0; }
    td.time { white-space: nowrap; }
    tr.admin td { color: var(--text-secondary); }
    .session { font: 12px ui-monospace, Menlo, monospace; color: var(--text-secondary); }
    .empty { text-align: center; color: var(--text-secondary); padding: 24px; }
    nav.pages { display: flex; gap: 16px; margin-top: 12px; }
  </style>
</head>
<body>
  <main>
    <h1>Usage log</h1>
    <p class="muted">${escapeHtml(title)}. Newest first, times in ${escapeHtml(timeZone)}. Kept 90 days; visible only to admins. <a href="/">Back to the dashboard</a></p>
    <form method="get" action="/usage">
      <label>Person <select name="person">${personOptions.join("")}</select></label>
      <label>Day <select name="day">${dayOptions.join("")}</select></label>
      <label class="check"><input type="checkbox" name="admins" value="1"${filters.includeAdmins ? " checked" : ""}> Include admins</label>
      <button type="submit">Show</button>
    </form>
    <div class="table-wrap">
      <table>
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <nav class="pages">
      ${page > 0 ? `<a href="${escapeHtml(query({ page: page - 1 || null }))}">Newer</a>` : ""}
      ${more ? `<a href="${escapeHtml(query({ page: page + 1 }))}">Older</a>` : ""}
    </nav>
  </main>
</body>
</html>
`;
}

module.exports = { usagePage };
