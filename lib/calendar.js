"use strict";
/**
 * The Poetic Interviews calendar, read live.
 *
 * Produces EXACTLY the shape of fixtures/poetic-interviews-*.json, which is
 * the contract: lib/declines.js, the rail, the classifier and every test are
 * untouched by this file existing. One interface, two implementations, and the
 * fixture stays as the permanent test source.
 *
 * A SEPARATE SERVICE ACCOUNT from the sheet reader, deliberately.
 * GOOGLE_SA_KEY_B64 reads the spreadsheet; GOOGLE_CAL_SA_KEY_B64 reads this
 * calendar. Neither is touched by the other's code.
 *
 * ONE SCOPE, and the key file carries none of its own, so this line and the
 * calendar's share level are the only two things limiting what the credential
 * can do. Do not widen it for convenience.
 */
const crypto = require("crypto");

const TOKEN_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const TOKEN_SKEW_S = 300;
const WINDOW_DAYS = 21;
const PAGE_SIZE = 250;
const CACHE_TTL_MS = 3 * 60e3;

let _sa = null, _saError = null, _token = null, _cache = null;

/** An error that names its own kind, so the route can say which fault it is. */
function fault(kind, message, detail) {
  const e = new Error(message);
  e.kind = kind;
  if (detail) e.detail = detail;
  return e;
}

function serviceAccount() {
  if (_sa || _saError) return _sa;
  const b64 = process.env.GOOGLE_CAL_SA_KEY_B64;
  if (!b64) { _saError = "GOOGLE_CAL_SA_KEY_B64 is not set"; return null; }
  try {
    const parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    if (!parsed.client_email || !parsed.private_key || !parsed.token_uri) {
      _saError = "GOOGLE_CAL_SA_KEY_B64 is missing client_email, private_key or token_uri";
      return null;
    }
    _sa = parsed;
  } catch (e) {
    _saError = "GOOGLE_CAL_SA_KEY_B64 is not valid base64 JSON";
  }
  return _sa;
}

function calendarId() { return process.env.POETIC_CALENDAR_ID || ""; }

function configError() {
  serviceAccount();
  if (!process.env.GOOGLE_CAL_SA_KEY_B64 || _saError) {
    return _saError || "GOOGLE_CAL_SA_KEY_B64 is not set";
  }
  if (!calendarId()) return "POETIC_CALENDAR_ID is not set";
  return null;
}
function isConfigured() { return configError() === null; }

async function accessToken() {
  if (_token && Date.now() < _token.expiresAtMs) return _token.value;
  const sa = serviceAccount();
  if (!sa) throw fault("not_configured", configError());

  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const claim = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({
    iss: sa.client_email, scope: TOKEN_SCOPE, aud: sa.token_uri,
    iat: now, exp: now + 3600,
  });
  const assertion = claim + "." +
    crypto.createSign("RSA-SHA256").update(claim).sign(sa.private_key, "base64url");

  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw fault("auth",
      "google token exchange failed (" + res.status + "): " + (body.error || "unknown") +
      (body.error_description ? ". " + body.error_description : ""));
  }
  _token = { value: body.access_token,
             expiresAtMs: Date.now() + Math.max(0, (body.expires_in || 3600) - TOKEN_SKEW_S) * 1000 };
  return _token.value;
}

/* ---------------- the window ---------------- */

/** Start of today in America/Los_Angeles, as an ISO instant. */
function startOfTodayPT(now) {
  const d = now || new Date();
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
  /* Midnight PT is 07:00 or 08:00 UTC depending on the season. Probe the
     offset at midday on that date rather than assuming one. */
  const probe = new Date(ymd + "T12:00:00Z");
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "2-digit", hour12: false,
  }).format(probe);
  const offsetH = 12 - Number(local);
  return { ymd, iso: new Date(Date.parse(ymd + "T00:00:00Z") + offsetH * 3600e3).toISOString() };
}

/* The Ashby briefing id, parsed out of the description exactly as the fixture
   was built. The fixture's descriptions were stripped; live ones are large
   HTML blobs and are never carried through. */
const BRIEFING = /interview-briefings\/([0-9a-f-]{36})/i;
function ashbyEventIdFrom(description) {
  const m = BRIEFING.exec(String(description || ""));
  return m ? m[1] : null;
}

/** One Google event, in the fixture's event shape. */
function toFixtureEvent(ev) {
  return {
    id: ev.id,
    summary: ev.summary || "",
    start: (ev.start || {}).dateTime || (ev.start || {}).date || null,
    end: (ev.end || {}).dateTime || (ev.end || {}).date || null,
    allDay: !!(ev.start || {}).date,
    status: ev.status || null,
    ashbyEventId: ashbyEventIdFrom(ev.description),
    creator: (ev.creator || {}).email || null,
    location: ev.location || null,
    attendees: (ev.attendees || []).map(function (a) {
      var out = { email: a.email || "", responseStatus: a.responseStatus || "needsAction" };
      if (a.resource) out.resource = true;
      if (a.displayName) out.displayName = a.displayName;
      if (a.optional) out.optional = true;
      if (a.comment) out.comment = a.comment;
      return out;
    }),
  };
}

/**
 * Every event in the window, following nextPageToken to exhaustion.
 *
 * PAGINATION IS NOT OPTIONAL. The API caps at 250 per page. A truncated read
 * looks exactly like a quiet calendar: the fixture's own capture came back cut
 * at 11 Sept and briefly read as "this candidate has no events at all".
 */
async function fetchPages(token, id, timeMin, timeMax) {
  const events = [];
  let pageToken = null, pages = 0;
  do {
    const url = new URL("https://www.googleapis.com/calendar/v3/calendars/" +
      encodeURIComponent(id) + "/events");
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", String(PAGE_SIZE));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, { headers: { authorization: "Bearer " + token } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = ((body.error || {}).errors || [{}])[0] || {};
      if (res.status === 403) {
        throw fault("forbidden",
          "Google refused the calendar read (403). Either the Calendar API is not enabled on " +
          "the project, or the calendar is not shared with the service account.",
          reason.reason || (body.error || {}).message || null);
      }
      if (res.status === 404) {
        throw fault("not_found", "Calendar not found (404). Check POETIC_CALENDAR_ID.",
                    (body.error || {}).message || null);
      }
      throw fault("http", "Calendar read failed (" + res.status + "). " +
                  ((body.error || {}).message || ""));
    }
    (body.items || []).forEach(function (e) { events.push(e); });
    pageToken = body.nextPageToken || null;
    pages++;
    /* A runaway loop is worse than a truncated read, and both are worse than
       saying so. 40 pages is 10,000 events in a 21-day window. */
    if (pages > 40) throw fault("http", "Calendar paging did not terminate after 40 pages.");
  } while (pageToken);
  return { events, pages };
}

/**
 * The live snapshot, in the fixture's shape.
 *
 * Throws a fault with a .kind rather than returning anything partial. Nothing
 * here ever falls back to the fixture: a rail showing 14 September data while
 * labelled live is worse than a rail showing an error.
 */
async function fetchSnapshot(opts) {
  const o = opts || {};
  const err = configError();
  if (err) throw fault("not_configured", err);

  const now = o.now || new Date();
  const from = startOfTodayPT(now);
  const to = new Date(Date.parse(from.iso) + (o.days || WINDOW_DAYS) * 86400e3);
  const token = await accessToken();
  const got = await fetchPages(token, calendarId(), from.iso, to.toISOString());

  const events = got.events.map(toFixtureEvent);

  /* THE FREE/BUSY TRAP. Shared at "See free/busy information only", Google
     returns events with no attendees array at all, every classifier finds zero
     declines, and the rail renders a clean empty state. Events with nobody on
     them is not a quiet week, it is the wrong share level. */
  if (events.length && !events.some(function (e) { return e.attendees.length; })) {
    throw fault("free_busy",
      events.length + " events were returned and not one has attendees. The calendar is " +
      "almost certainly shared at \"See free/busy information only\", which strips them. " +
      "Declines cannot be read at that share level.");
  }

  return {
    calendarId: calendarId(),
    calendarSummary: "Poetic Interviews",
    timeZone: "America/Los_Angeles",
    live: true,
    fetchedAt: new Date().toISOString(),
    window: { start: from.ymd, end: to.toISOString().slice(0, 10) },
    note: "Live read from the Poetic Interviews calendar.",
    pages: got.pages,
    events,
  };
}

/**
 * Cached, so a page load does not hit Google every time.
 *
 * A refresh that fails does NOT discard what we have, but the result is marked
 * stale with the age and the reason, so the footer can say the time is old
 * rather than printing one that implies freshness.
 */
async function getSnapshot(opts) {
  const o = opts || {};
  const ttl = o.ttlMs === undefined ? CACHE_TTL_MS : o.ttlMs;
  const nowMs = o.nowMs === undefined ? Date.now() : o.nowMs;
  if (_cache && nowMs - _cache.at < ttl) return _cache.snapshot;
  try {
    const snapshot = await fetchSnapshot(o);
    _cache = { at: nowMs, snapshot };
    return snapshot;
  } catch (e) {
    if (!_cache) throw e;
    return Object.assign({}, _cache.snapshot, {
      stale: { ageMs: nowMs - _cache.at, reason: e.message, kind: e.kind || "http" },
    });
  }
}

function resetCache() { _sa = null; _saError = null; _token = null; _cache = null; }

module.exports = {
  TOKEN_SCOPE, WINDOW_DAYS, PAGE_SIZE, CACHE_TTL_MS,
  isConfigured, configError, calendarId,
  startOfTodayPT, ashbyEventIdFrom, toFixtureEvent,
  fetchSnapshot, getSnapshot, resetCache,
  _internal: { fault, fetchPages, serviceAccount },
};
