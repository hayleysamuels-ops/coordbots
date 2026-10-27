"use strict";

/**
 * List and download backups from the configured off-site store.
 *
 *   npm run backups                      list what is in the bucket
 *   npm run backups -- --get <key>       download one
 *   npm run backups -- --latest          download the most recent
 *
 * Downloads land in ./ unless --out is given. Nothing here writes to
 * the live database: restoring is a deliberate manual step, documented
 * in the README, because an automated restore is a loaded gun.
 *
 * This runs from any machine with the BACKUP_S3_* variables set, which
 * is the point — the recovery path must not depend on the platform
 * that just lost the volume.
 */

const path = require("node:path");
const { configured } = require("../src/backup-sinks");

(async () => {
  const sink = configured();
  if (!sink) {
    console.error("No off-site destination configured. Set BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET,");
    console.error("BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY.");
    process.exit(2);
  }

  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
  };
  const outDir = valueOf("--out") || ".";

  const keys = await sink.list();
  if (!keys.length) {
    console.log(`${sink.name}: empty.`);
    return;
  }

  const wanted = args.includes("--latest") ? keys[keys.length - 1] : valueOf("--get");
  if (!wanted) {
    console.log(`${sink.name} — ${keys.length} object(s), oldest first:\n`);
    for (const k of keys) console.log(`  ${k}`);
    console.log(`\nDownload the newest with:  npm run backups -- --latest`);
    return;
  }

  const local = path.join(outDir, path.basename(wanted));
  const { bytes } = await sink.get(wanted, local);
  console.log(`${wanted} -> ${local} (${(bytes / 1048576).toFixed(1)}MB)`);
  console.log(`Verify it before trusting it:\n  gunzip -c ${local} > /tmp/restore.sqlite`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
