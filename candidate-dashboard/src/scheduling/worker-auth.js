"use strict";
const crypto = require("crypto");
function signature(secret, stamp, nonce, body) { return crypto.createHmac("sha256", secret).update(stamp + "\n" + nonce + "\n" + body).digest("hex"); }
function signed(secret, payload, now = Date.now()) {
  const body = JSON.stringify(payload), stamp = String(now), nonce = crypto.randomBytes(24).toString("hex");
  return { body, headers: { "Content-Type": "application/json", "X-Worker-Time": stamp, "X-Worker-Nonce": nonce, "X-Worker-Signature": signature(secret, stamp, nonce, body) } };
}
function verifier(secret, now = () => Date.now()) {
  if (!secret || secret.length < 32) throw new Error("Worker shared secret must contain at least 32 characters");
  const used = new Map();
  return (headers, body) => {
    const stamp = headers["x-worker-time"], nonce = headers["x-worker-nonce"], received = headers["x-worker-signature"];
    const time = now();
    for (const [key, expires] of used) if (expires < time) used.delete(key);
    if (!/^\d+$/.test(stamp || "") || Math.abs(time - Number(stamp)) > 30000 || !/^[a-f0-9]{48}$/.test(nonce || "") || used.has(nonce) || !/^[a-f0-9]{64}$/.test(received || "")) return false;
    const expected = signature(secret, stamp, nonce, body);
    if (!crypto.timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"))) return false;
    used.set(nonce, time + 60000); return true;
  };
}
module.exports = { signed, verifier };
