'use strict';

/**
 * lib/sheets.js — read-only Google Sheets client for the WT Tracker sheet.
 *
 * Auth: service account (poetic-sheet-reader@work-trial-tracker.iam.gserviceaccount.com),
 * scope spreadsheets.readonly. Access comes from the Drive share on the sheet, not from
 * any IAM role — the service account deliberately holds none.
 *
 * Follows the bot env convention, not the Google-auth convention: missing variables
 * degrade this module to "not configured" rather than hard-exiting the tracker.
 *
 * Never logs row content. The sheet holds candidate names and placement details;
 * Railway logs are not where that belongs.
 */

const crypto = require('crypto');

const TOKEN_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_SKEW_S = 300;        // refresh 5 min before expiry
const VALUES_TTL_MS = 15 * 60e3; // match the bot-1 Ashby cache

let _sa = null;
let _saError = null;
let _token = null;               // { value, expiresAtMs }
const _values = new Map();       // range -> { at, result }

// ---------------------------------------------------------------- config

function serviceAccount() {
  if (_sa || _saError) return _sa;
  const raw = process.env.GOOGLE_SA_KEY_B64;
  if (!raw) { _saError = 'GOOGLE_SA_KEY_B64 is not set'; return null; }
  try {
    const sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (!sa.client_email || !sa.private_key || !sa.token_uri) {
      _saError = 'GOOGLE_SA_KEY_B64 decoded but is missing client_email, private_key or token_uri';
      return null;
    }
    _sa = sa;
    return _sa;
  } catch (e) {
    // Deliberately does not echo the value.
    _saError = 'GOOGLE_SA_KEY_B64 is not valid base64-encoded JSON';
    return null;
  }
}

function sheetId() {
  return process.env.POETIC_SHEET_ID || null;
}

/** True when both variables are present and the key parses. Cheap; safe to call per request. */
function isConfigured() {
  return Boolean(serviceAccount() && sheetId());
}

/** Why isConfigured() is false, for the Bots panel. Never includes secret material. */
function configError() {
  serviceAccount(); // populate _saError before it is read
  if (!process.env.GOOGLE_SA_KEY_B64 || _saError) return _saError || 'GOOGLE_SA_KEY_B64 is not set';
  if (!sheetId()) return 'POETIC_SHEET_ID is not set';
  return null;
}

// ---------------------------------------------------------------- auth

async function accessToken() {
  if (_token && Date.now() < _token.expiresAtMs) return _token.value;

  const sa = serviceAccount();
  if (!sa) throw new Error(configError());

  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claim = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: sa.client_email,
    scope: TOKEN_SCOPE,
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  });
  const assertion = claim + '.' +
    crypto.createSign('RSA-SHA256').update(claim).sign(sa.private_key, 'base64url');

  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // error_description can name the clock-skew and malformed-key cases; it carries no secret.
    throw new Error(
      `google token exchange failed (${res.status}): ${body.error || 'unknown'}` +
      (body.error_description ? `. ${body.error_description}` : '')
    );
  }

  _token = {
    value: body.access_token,
    expiresAtMs: Date.now() + Math.max(0, (body.expires_in || 3600) - TOKEN_SKEW_S) * 1000,
  };
  return _token.value;
}

// ---------------------------------------------------------------- read

/**
 * Why a 401/403 happened, in words a coordinator can act on. Shared by both
 * readers so their advice cannot drift. Clears the cached token: a rotated or
 * revoked key must not be retried against a stale one.
 */
async function authFailureReason(res) {
  _token = null;
  const body = await res.json().catch(() => ({}));
  const msg = (body && body.error && body.error.message) || '';
  return /has not been used|disabled/i.test(msg)
    ? 'Sheets API is not enabled on the work-trial-tracker GCP project'
    : 'service account cannot read the sheet. Check the Drive share on poetic-sheet-reader';
}

/**
 * Read an A1 range, e.g. "'WT Tracker'!A1:Z500".
 *
 * Resolves to { ok: true, rows, cachedAt } or { ok: false, reason }.
 * Never throws and never returns an empty result to stand in for a failure —
 * a caller must be able to tell "no rows" from "could not read", so the panel
 * reports UNKNOWN with a reason rather than a confident negative.
 */
async function readRange(range, { force = false } = {}) {
  if (!isConfigured()) return { ok: false, reason: configError() };

  const hit = _values.get(range);
  if (!force && hit && Date.now() - hit.at < VALUES_TTL_MS) {
    return { ...hit.result, cachedAt: hit.at };
  }

  try {
    const token = await accessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId())}` +
                `/values/${encodeURIComponent(range)}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: await authFailureReason(res) };
    }
    if (res.status === 404) {
      return { ok: false, reason: 'sheet not found. POETIC_SHEET_ID may be wrong' };
    }
    if (!res.ok) {
      return { ok: false, reason: `sheets api returned ${res.status}` };
    }

    const body = await res.json();
    const result = { ok: true, rows: body.values || [] };
    _values.set(range, { at: Date.now(), result });
    return { ...result, cachedAt: Date.now() };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * Per-row visibility for one tab.
 *
 * The values API does not carry it — hidden-ness lives in spreadsheets.get under
 * rowMetadata — so this is a second call, still read-only and still within the
 * spreadsheets.readonly scope.
 *
 * Resolves to { ok: true, startRow, rows } where rows[n] describes sheet row
 * n + 1 + startRow, or { ok: false, reason }. Deliberately NOT cached: someone
 * hiding a row is precisely the change a caller needs to notice, and the only
 * caller runs hourly.
 *
 * It never reports a row as visible by omission. A response carrying no row
 * metadata is a failure with a reason, not an empty answer, because "we could
 * not tell" and "nothing is hidden" must not look the same to a caller deciding
 * what to write.
 */
async function readVisibility({ tab, rowCount } = {}) {
  if (!isConfigured()) return { ok: false, reason: configError() };
  if (!tab) return { ok: false, reason: 'readVisibility needs a tab name' };
  const n = Math.max(1, Number(rowCount) || 1);

  try {
    const token = await accessToken();
    const fields = 'sheets(properties(title),data(startRow,rowMetadata(hiddenByUser,hiddenByFilter)))';
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId())}` +
                `?includeGridData=true&ranges=${encodeURIComponent("'" + tab + "'!A1:A" + n)}` +
                `&fields=${encodeURIComponent(fields)}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: await authFailureReason(res) };
    }
    if (res.status === 404) {
      return { ok: false, reason: 'sheet not found. POETIC_SHEET_ID may be wrong' };
    }
    if (!res.ok) {
      return { ok: false, reason: `sheets api returned ${res.status} reading row visibility` };
    }

    const body = await res.json();
    const sheet = (body.sheets || []).filter((x) => x.properties && x.properties.title === tab)[0];
    if (!sheet) return { ok: false, reason: `tab "${tab}" not found in the spreadsheet` };
    const data = (sheet.data || [])[0] || {};
    const meta = data.rowMetadata || [];
    if (!meta.length) {
      return { ok: false, reason: 'the spreadsheet returned no row metadata, so visibility is unknown' };
    }

    return {
      ok: true,
      startRow: data.startRow || 0,
      rows: meta.map((m) => ({
        hiddenByUser: !!(m && m.hiddenByUser),
        hiddenByFilter: !!(m && m.hiddenByFilter),
      })),
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * True when the first row looks like a header rather than a person.
 *
 * As of 8 Sep 2026 row 1 of 'WT Tracker' is data — Andrew Mi, not "First name" — so
 * anything indexing by row offset must check rather than assume. Sadiqeh has restructured
 * this sheet once already.
 */
function looksLikeHeader(row = []) {
  if (!row.length) return false;
  const HEADERISH = /^(first|last|full)?\s*name$|^candidate$|^team$|^role$|^location$|^desk$|^seat$|^status$|^stage$/i;
  return row.filter(Boolean).some((c) => HEADERISH.test(String(c).trim()));
}

/** Drop the header row when there is one. Returns { rows, hadHeader }. */
function stripHeader(rows = []) {
  if (rows.length && looksLikeHeader(rows[0])) return { rows: rows.slice(1), hadHeader: true };
  return { rows, hadHeader: false };
}

/** Test seam and rotation support — forget the cached token and values. */
function resetCache() {
  _token = null;
  _values.clear();
  _sa = null;
  _saError = null;
}

module.exports = {
  isConfigured,
  configError,
  readRange,
  readVisibility,
  looksLikeHeader,
  stripHeader,
  resetCache,
  VALUES_TTL_MS,
};
