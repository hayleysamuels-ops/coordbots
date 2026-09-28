"use strict";
(() => {
  const root = document.getElementById("scheduling-review");
  if (!root) return;
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let state, template, candidates = [], loading = false;
  root.innerHTML = `<h2>Scheduling</h2><p>Review interview plans, approve bookings, and share onsite drafts with the team.</p>
    <p><a href="/booking.html">Prepare and approve an Ashby booking</a> · <a href="/ashby-connection.html">Manage Ashby connection</a></p>
    <p id="scheduling-message" role="status"></p><button id="scheduling-refresh" type="button">Refresh schedules</button>
    <details id="scheduling-editor"><summary>Draft an onsite schedule</summary><form id="scheduling-form">
    <label>Candidate application <select name="applicationId" required></select></label>
    <button id="scheduling-template" type="button">Load current Ashby interview plan</button>
    <label>Interview activity <select id="scheduling-activity"><option value="">Load an interview plan first</option></select></label>
    <button id="scheduling-use-template" type="button">Use selected activity</button>
    <p id="scheduling-template-message" role="status"></p>
    <p>Enter times in ${esc(timezone)}. Review the complete schedule before sharing.</p>
    <div id="scheduling-sessions"></div><button type="button" id="scheduling-add">Add session</button>
    <label>Discussion notes <textarea name="notes" maxlength="2000"></textarea></label>
    <button type="submit">Save draft for review</button></form></details>
    <div id="scheduling-sources"></div><div id="scheduling-proposals"></div>`;
  const message = root.querySelector("#scheduling-message");
  const form = root.querySelector("form");
  const sessions = root.querySelector("#scheduling-sessions");
  async function api(path = "", body) {
    const response = await fetch("/api/scheduling-review" + path, body ? { method: "POST", headers: { "Content-Type": "application/json", "X-Scheduling-Request": "1" }, body: JSON.stringify(body) } : {});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load scheduling");
    return data;
  }
  function addSession(seed) {
    const field = document.createElement("fieldset");
    field.innerHTML = `<legend>Interview session</legend><label>Session <input name="title" maxlength="200" required></label>
      <label>Start <input name="start" type="datetime-local" required></label><label>End <input name="end" type="datetime-local" required></label>
      <label>Interviewers <input name="interviewers" maxlength="500" required></label><label>Room / location <input name="location" maxlength="200" required></label>
      <button type="button" class="remove-session">Remove session</button>`;
    if (seed && seed.title) {
      field.querySelector('[name="title"]').value = seed.title;
      field.querySelector("legend").textContent = seed.title + " · " + seed.durationMinutes + " minutes in Ashby";
    }
    field.querySelector("button").onclick = () => field.remove(); sessions.append(field);
  }
  function render() {
    const status = state.status;
    message.textContent = status.bookingMessage + (status.canApprove ? "" : " Individual coordinator sign-in is required to approve or draft schedules.");
    root.querySelector("#scheduling-editor").hidden = !status.canApprove;
    root.querySelector("#scheduling-sources").innerHTML = (state.sources || []).length ? '<h3>Existing tracker proposals</h3>' + state.sources.map(r => `<p>${esc(r.candidateName || r.plan.role)} · ${esc(r.plan.startDate)} <button data-import="${esc(r.id)}" ${status.canApprove ? "" : "disabled"}>Copy into discussion draft</button></p>`).join("") : "";
    const fmt = (v, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(v));
    root.querySelector("#scheduling-proposals").innerHTML = state.proposals.length ? state.proposals.slice().reverse().map(row => {
      const p = row.plan, destination = row.destination || {};
      return `<article class="scheduling-draft"><h3>${esc(p.candidateName)} · ${esc(p.jobTitle)}</h3>
        <p><strong>${esc(({ draft: "Draft — ready for review", sharing: "Sending — check delivery before retrying", shared: "Shared for team discussion", discussion_uncertain: "Slack delivery needs review", rejected: "Rejected" })[row.state] || row.state)}</strong> · Revision ${row.revision}</p>
        <p>Timezone: ${esc(p.timezone)} · Slack destination: <strong>${esc(destination.channelName)}</strong></p>
        <p>Coordinator-authored draft. Availability has not been verified.</p>
        <div class="scheduling-table-wrap"><table><thead><tr><th>Session</th><th>Start</th><th>End</th><th>Interviewers</th><th>Location</th></tr></thead><tbody>${p.sessions.map(s => `<tr><td>${esc(s.title)}</td><td>${esc(fmt(s.start, p.timezone))}</td><td>${esc(fmt(s.end, p.timezone))}</td><td>${esc(s.interviewers)}</td><td>${esc(s.location)}</td></tr>`).join("")}</tbody></table></div>
        <p>${esc(p.notes)}</p>${row.issue ? `<p role="alert">${esc(row.issue)}</p>` : ""}
        ${row.state === "draft" ? `<div class="scheduling-actions"><button data-action="share" data-id="${esc(row.id)}" ${!status.canApprove || !status.slackReady || !destination.channelId ? "disabled" : ""}>Approve draft and send to Slack</button>
        <button data-action="book" data-id="${esc(row.id)}" ${!status.canApprove || !status.bookingReady ? "disabled" : ""}>Approve and schedule in Ashby</button>
        <button data-action="reject" data-id="${esc(row.id)}" ${!status.canApprove ? "disabled" : ""}>Reject draft</button></div>` : ""}
        ${row.slack ? `<p>Shared in ${esc(row.slack.channel)}. Draft reference: ${esc(row.id)}</p>` : ""}
      </article>`;
    }).join("") : "<p>No schedule drafts yet.</p>";
  }
  async function refresh() {
    if (loading) return; loading = true;
    try {
      const response = await fetch(root.dataset.candidatesUrl || "/api/issues");
      if (!response.ok) throw new Error("Could not load candidates");
      const snapshot = await response.json();
      const rows = Object.values(snapshot).filter(Array.isArray).flat();
      candidates = [...new Map(rows.filter(c => c?.applicationId && c.status === "Active").map(c => [c.applicationId, c])).values()];
      const select = form.elements.applicationId, previous = select.value;
      select.innerHTML = '<option value="">Select an application</option>' + candidates.map(c => `<option value="${esc(c.applicationId)}">${esc(c.candidateName)} · ${esc(c.jobTitle)}</option>`).join("");
      select.value = previous;
      state = await api(); render();
    } catch (e) { message.textContent = e.message; }
    finally { loading = false; }
  }
  root.querySelector("#scheduling-add").onclick = () => addSession();
  form.elements.applicationId.addEventListener("change", () => { template = null; root.querySelector("#scheduling-activity").innerHTML = '<option value="">Load an interview plan first</option>'; });
  root.querySelector("#scheduling-template").onclick = async () => {
    const note = root.querySelector("#scheduling-template-message");
    try {
      const id = form.elements.applicationId.value;
      if (!id) throw new Error("Choose an application first.");
      template = await api("/template/" + encodeURIComponent(id));
      root.querySelector("#scheduling-activity").innerHTML = template.activities.map((a, i) => `<option value="${i}">${esc(a.title)}</option>`).join("");
      note.textContent = template.stageTitle + ". Session titles and durations loaded. Confirm order, availability, interviewers, rooms, and times before sharing.";
    } catch (e) { template = null; note.textContent = e.message; }
  };
  root.querySelector("#scheduling-use-template").onclick = () => {
    if (!template || template.applicationId !== form.elements.applicationId.value) return;
    const activity = template.activities[Number(root.querySelector("#scheduling-activity").value)];
    if (!activity) return;
    // Append rather than silently destroying the coordinator's entered work.
    const blank = [...sessions.querySelectorAll("fieldset")].filter(f => [...f.querySelectorAll("input")].every(i => !i.value));
    blank.forEach(f => f.remove()); activity.sessions.forEach(addSession);
  };
  root.querySelector("#scheduling-refresh").onclick = refresh;
  root.addEventListener("click", async event => {
    const sourceButton = event.target.closest("button[data-import]");
    if (sourceButton && !sourceButton.disabled) {
      sourceButton.disabled = true;
      try { await api("/import/" + encodeURIComponent(sourceButton.dataset.import), {}); await refresh(); }
      catch (e) { message.textContent = e.message; }
      finally { sourceButton.disabled = false; }
      return;
    }
    const button = event.target.closest("button[data-action]"); if (!button || button.disabled) return;
    const row = state.proposals.find(r => r.id === button.dataset.id); if (!row) return;
    button.disabled = true;
    try {
      await api(`/${row.id}/${button.dataset.action}`, { revision: row.revision, digest: row.digest, channelId: row.destination?.channelId });
      await refresh();
    } catch (e) { message.textContent = e.message; }
    finally { button.disabled = false; }
  });
  form.addEventListener("submit", async event => {
    event.preventDefault(); const button = form.querySelector('[type="submit"]'); button.disabled = true;
    try {
      const entries = [...sessions.querySelectorAll("fieldset")].map(field => {
        const value = name => field.querySelector(`[name="${name}"]`).value;
        return { title: value("title"), start: new Date(value("start")).toISOString(), end: new Date(value("end")).toISOString(), interviewers: value("interviewers"), location: value("location") };
      });
      await api("/drafts", { applicationId: form.elements.applicationId.value, timezone, sessions: entries, notes: form.elements.notes.value });
      form.reset(); sessions.innerHTML = ""; addSession(); await refresh();
    } catch (e) { message.textContent = e.message; }
    finally { button.disabled = false; }
  });
  document.querySelector('[data-tab="scheduling"]')?.addEventListener("click", refresh);
  addSession();
})();
