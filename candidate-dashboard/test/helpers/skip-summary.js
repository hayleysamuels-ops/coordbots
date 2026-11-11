"use strict";
// A node:test reporter that adds one block at the very end of `npm test`:
// every skipped test, its file and the reason it gave, so a skip never has
// to be found by scrolling back. Runs alongside the normal spec reporter
// (package.json). The template-guard tests skip, rather than fail, when a
// read runs out of time on a slow machine, and a reader that genuinely hung
// would look the same, so those skips are called out.
const path = require("path");

const SLOW = /slow machine/;

module.exports = async function* skipSummary(source) {
  const skipped = [];
  for await (const event of source) {
    if ((event.type === "test:pass" || event.type === "test:fail") && event.data.skip !== undefined) {
      const reason = typeof event.data.skip === "string" && event.data.skip ? event.data.skip : "no reason given";
      skipped.push({ file: event.data.file ? path.relative(process.cwd(), event.data.file) : "?", name: event.data.name, reason });
    }
  }
  if (!skipped.length) {
    yield "\nSkipped tests: none.\n";
    return;
  }
  const lines = [`\nSkipped tests: ${skipped.length}`];
  for (const s of skipped) lines.push(`  - ${s.file} > ${s.name}\n      ${s.reason}`);
  if (skipped.some((s) => SLOW.test(s.reason))) {
    lines.push("  Note: a skip that says it ran out of time on a slow machine can also mean the reader hung. Rerun that file on its own before trusting this run.");
  }
  yield lines.join("\n") + "\n";
};
