"use strict";

const crypto = require("crypto");

/**
 * Verify an Ashby webhook signature.
 *
 * Ashby signs the RAW request body (the exact bytes, before JSON parsing) with
 * HMAC-SHA256 using the secret token you configured on the webhook, and sends
 * the result in the `Ashby-Signature` header as: "sha256=<hex digest>".
 *
 * @param {Buffer|string} rawBody - the untouched request body
 * @param {string} signatureHeader - value of the Ashby-Signature header
 * @param {string} secret - the webhook secret token
 * @returns {boolean}
 */
function verifyAshbySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  // Constant-time compare to avoid timing attacks.
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { verifyAshbySignature };
