"use strict";

/**
 * Where backups go.
 *
 * One sink today: anything that speaks the S3 API — Cloudflare R2,
 * Backblaze B2, AWS S3, MinIO. They differ only in endpoint, so one
 * implementation covers whichever the user picks.
 *
 * SigV4 is hand-rolled rather than pulled in, because the whole service
 * has two runtime dependencies and the AWS SDK is tens of megabytes to
 * sign one PUT. The signing is ~60 lines of well-specified crypto and
 * `test/sigv4.test.js` pins it against the worked example published in
 * the AWS SigV4 documentation, so it is tested rather than hoped at.
 *
 * NOTE: the dumps contain candidate names and scheduler email
 * addresses for every configured client. The bucket must be private,
 * and whoever can read it can read six clients' candidate data — a
 * wider audience than the dashboard password, which is deliberately
 * held by very few people. Pick the destination accordingly.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

/** RFC3986 escaping. encodeURIComponent leaves !'()* alone; SigV4 does not. */
function uriEscape(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Path segments are escaped individually so the slashes survive. */
function escapePath(p) {
  return p.split("/").map(uriEscape).join("/");
}

/**
 * Signs a request with AWS Signature Version 4 and returns the headers.
 *
 * Exported so the test can drive it with the documentation's fixed
 * credentials, date and payload and compare against the published
 * Authorization header.
 */
function signV4({ method, host, canonicalUri, query = "", headers, payloadHash, accessKeyId, secretAccessKey, region, service, now }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const all = { ...headers, host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const sortedKeys = Object.keys(all)
    .map((k) => k.toLowerCase())
    .sort();
  const lower = {};
  for (const [k, v] of Object.entries(all)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");

  const canonicalHeaders = sortedKeys.map((k) => `${k}:${lower[k]}\n`).join("");
  const signedHeaders = sortedKeys.join(";");

  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  let key = Buffer.from(`AWS4${secretAccessKey}`, "utf8");
  for (const part of [dateStamp, region, service, "aws4_request"]) key = hmac(key, part);
  const signature = crypto.createHmac("sha256", key).update(stringToSign).digest("hex");

  return {
    ...all,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function s3Config() {
  const endpoint = (process.env.BACKUP_S3_ENDPOINT || "").trim().replace(/\/+$/, "");
  const bucket = (process.env.BACKUP_S3_BUCKET || "").trim();
  const accessKeyId = (process.env.BACKUP_S3_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (process.env.BACKUP_S3_SECRET_ACCESS_KEY || "").trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    // R2 ignores the region but still requires one in the signature.
    region: (process.env.BACKUP_S3_REGION || "auto").trim(),
    prefix: (process.env.BACKUP_S3_PREFIX || "coordinator-metrics").trim().replace(/^\/+|\/+$/g, ""),
  };
}

function s3Sink(cfg) {
  const url = new URL(cfg.endpoint);
  const basePath = `/${cfg.bucket}`;

  async function request(method, key, body) {
    const canonicalUri = escapePath(`${basePath}/${key}`.replace(/\/+/g, "/"));
    const payloadHash = body ? sha256Hex(body) : sha256Hex("");
    const headers = signV4({
      method,
      host: url.host,
      canonicalUri,
      headers: body ? { "content-length": String(body.length), "content-type": "application/gzip" } : {},
      payloadHash,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
      service: "s3",
      now: new Date(),
    });
    const res = await fetch(`${url.origin}${canonicalUri}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`S3 ${method} ${key} -> ${res.status} ${text.slice(0, 300)}`);
    }
    return res;
  }

  return {
    name: `s3:${cfg.bucket}`,

    async put(localFile) {
      const key = `${cfg.prefix}/${path.basename(localFile)}`;
      await request("PUT", key, fs.readFileSync(localFile));
      return key;
    },

    async list() {
      // ListObjectsV2 with the prefix. Keys are returned sorted, and the
      // filenames are timestamped, so lexical order is chronological.
      const canonicalUri = escapePath(basePath);
      const query = `list-type=2&prefix=${uriEscape(cfg.prefix + "/")}`;
      const headers = signV4({
        method: "GET",
        host: url.host,
        canonicalUri,
        query,
        headers: {},
        payloadHash: sha256Hex(""),
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        region: cfg.region,
        service: "s3",
        now: new Date(),
      });
      const res = await fetch(`${url.origin}${canonicalUri}?${query}`, {
        headers,
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`S3 LIST -> ${res.status}`);
      const xml = await res.text();
      return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).sort();
    },

    async prune({ keepDaily = 30, keepMonthly = 12 } = {}) {
      const keys = (await this.list()).filter((k) => /metrics-.*\.sqlite\.gz$/.test(k));
      const keep = new Set(keys.slice(-keepDaily));
      const monthSeen = new Map();
      for (const k of keys) {
        const name = path.basename(k);
        const month = name.slice("metrics-".length, "metrics-".length + 7);
        if (!monthSeen.has(month)) monthSeen.set(month, k);
      }
      for (const k of [...monthSeen.values()].slice(-keepMonthly)) keep.add(k);
      for (const k of keys) {
        if (keep.has(k)) continue;
        await request("DELETE", k.replace(/^\/+/, ""));
      }
    },
  };
}

/** The configured sink, or null when none is set up. */
function configured() {
  const cfg = s3Config();
  return cfg ? s3Sink(cfg) : null;
}

module.exports = { configured, signV4, uriEscape, escapePath };
