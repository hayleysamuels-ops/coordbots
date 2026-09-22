/**
 * The one place that decides: what value does a field REALLY have?
 *
 * The panel's answer when it has one, the stored manual value otherwise. The
 * browser and the server both need this — the tracker uses it for the header,
 * filters, progress and flags; the readiness sweep uses it to decide what is
 * still red. Two copies would drift, so this file is loaded by both: required
 * as a module on the server, and served to the browser at /effective.js.
 *
 * Callers supply the stored value themselves, because only the browser knows
 * the field defaults from the schema.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.EFFECTIVE = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Tracker field -> the panel row that answers it.
  var PANEL_COVERS = {
    position: "position",
    startDate: "trialDates",
    endDate: "trialDates",
    bgScreen: "ebs",
    workTrialScheduled: "workTrialScheduled",
    debriefScheduled: "debriefScheduled",
    agentShadowSched: "agentShadow",
  };

  function isoToDay(iso) {
    if (!iso) return "";
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(iso));
  }

  /**
   * May the panel answer this field?
   * Only a live or stale panel with a usable value may. Not linked,
   * linked-but-not-found, loading and UNKNOWN all fall back to what a person
   * typed — otherwise unlinking a row would make information disappear.
   */
  function covers(entry, key, candidate) {
    var pk = PANEL_COVERS[key];
    if (!pk) return false;
    var linked = candidate && candidate.values && candidate.values.ashbyCandidateId;
    if (!linked) return false;
    if (!entry || (entry.state !== "live" && entry.state !== "stale")) return false;
    var p = entry.panel;
    if (!p || !p.fields) return false;
    /* The panel covers a date when it HAS one, and also when it actively says
       there is not one. "Ashby has no trial booked" is an answer; falling back
       to a stored date there is how a cancelled trial kept its old dates. */
    if (key === "startDate") return !!p.trialStart || p.scheduleState === "unscheduled";
    if (key === "endDate") return !!p.trialEnd || p.scheduleState === "unscheduled";
    var f = p.fields[pk];
    if (!f) return false;
    var v = String(f.value == null ? "" : f.value).trim();
    return v !== "" && v !== "—" && v !== "UNKNOWN";
  }

  /** The panel's answer in the tracker's own vocabulary, or undefined. */
  function panelValue(candidate, key, entry) {
    if (!covers(entry, key, candidate)) return undefined;
    var p = entry.panel;
    /* Empty, not undefined: undefined means "the panel has no view" and falls
       back to the stored value, which is the opposite of what is meant here. */
    if (key === "startDate") return p.trialStart ? isoToDay(p.trialStart) : "";
    if (key === "endDate") return p.trialEnd ? isoToDay(p.trialEnd) : "";
    var v = String((p.fields[PANEL_COVERS[key]] || {}).value || "").trim();
    if (key === "position") return v;
    if (key === "workTrialScheduled" || key === "debriefScheduled")
      return v === "YES" ? "YES" : "NOT YET";
    if (key === "bgScreen")
      return v === "FEEDBACK IN" ? "DONE - NOTES ADDED"
           : v === "SCHEDULED, NO FEEDBACK" ? "SCHEDULED"
           : v === "N/A" ? "N/A" : "NOT SCHEDULED";
    if (key === "agentShadowSched")
      return v === "SCHEDULED" ? "CALL SCHEDULED" : v === "N/A" ? "N/A" : "NOT SCHEDULED";
    return undefined;
  }

  /** Panel answer if there is one, else the stored value the caller passes in. */
  function resolve(candidate, key, entry, storedValue) {
    var v = panelValue(candidate, key, entry);
    return v === undefined ? storedValue : v;
  }

  return { PANEL_COVERS: PANEL_COVERS, covers: covers, panelValue: panelValue,
           resolve: resolve, isoToDay: isoToDay };
});
