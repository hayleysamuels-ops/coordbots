"use strict";

/**
 * Take a backup right now.
 *
 *   npm run backup
 *
 * Useful before a risky migration, and as the way to prove the
 * configured destination actually works — the S3 credentials are not
 * exercised until something uploads, and discovering they are wrong
 * during an incident is too late.
 */
require("../src/backup")
  .run({ reason: "manual" })
  .then((r) => process.exit(r.ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
