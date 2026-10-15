"use strict";

/**
 * Static-asset syntax checks.
 *
 * These exist because of a real failure: public/style.css was assembled by
 * copying the first 117 lines of candidate-dashboard's stylesheet, which
 * cut an `@media (prefers-color-scheme: dark)` block in half. The media
 * query was never closed, so every rule after it — 360-odd lines, the
 * entire component layer — was swallowed into the unterminated block and
 * discarded. Chrome parsed 3 rules out of 488 lines and the page rendered
 * completely unstyled.
 *
 * Nothing in the suite noticed, because every other test exercises the
 * server and the metrics. A stylesheet that silently evaluates to almost
 * nothing is exactly the kind of break that unit tests miss and a human
 * notices immediately, so the cheap structural check earns its place.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const PUBLIC = path.join(__dirname, "..", "public");

// Strips comments and quoted strings so braces inside them can't be
// miscounted. Not a real CSS parser — it doesn't need to be. The failure
// being guarded against is structural, and a dependency-free check keeps
// this app's "no build step, no bundler" property intact.
function stripCommentsAndStrings(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

test("style.css braces are balanced", () => {
  const css = stripCommentsAndStrings(fs.readFileSync(path.join(PUBLIC, "style.css"), "utf8"));

  let depth = 0;
  let line = 1;
  let deepestUnclosedLine = null;

  for (const ch of css) {
    if (ch === "\n") line += 1;
    else if (ch === "{") {
      if (depth === 0) deepestUnclosedLine = line;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      assert.ok(depth >= 0, `stray closing brace at line ${line}`);
    }
  }

  assert.strictEqual(
    depth,
    0,
    `unbalanced braces: ${depth} block(s) left open, outermost opened at line ${deepestUnclosedLine}. ` +
      `An unclosed block swallows every rule after it and the browser discards them silently.`
  );
});

test("every at-rule block in style.css is closed", () => {
  const css = stripCommentsAndStrings(fs.readFileSync(path.join(PUBLIC, "style.css"), "utf8"));

  // @media/@supports/@keyframes open a block; @import/@charset do not.
  const blockAtRules = (css.match(/@(media|supports|keyframes|font-face|layer)\b/g) || []).length;
  let closedBlockAtRules = 0;
  const re = /@(?:media|supports|keyframes|font-face|layer)\b[^{]*\{/g;

  let match;
  while ((match = re.exec(css))) {
    let depth = 1;
    for (let i = re.lastIndex; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
    }
    if (depth === 0) closedBlockAtRules += 1;
  }

  assert.strictEqual(closedBlockAtRules, blockAtRules, "an at-rule block is missing its closing brace");
});

test("style.css still defines the component layer, not just tokens", () => {
  const css = fs.readFileSync(path.join(PUBLIC, "style.css"), "utf8");

  // The truncation that caused the original failure cut the file right
  // after the token block, so "tokens present" alone would have passed.
  // These are selectors from the component layer that app.js renders.
  for (const selector of [".stat-number", ".tab", ".chart", ".heat-cell", "table", ".notice"]) {
    assert.ok(css.includes(selector), `style.css is missing ${selector} — is the file truncated?`);
  }
});

test("the page references the stylesheet and script it ships", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  assert.ok(html.includes('href="style.css"'));
  assert.ok(html.includes('src="app.js"'));
  for (const asset of ["style.css", "app.js"]) {
    assert.ok(fs.existsSync(path.join(PUBLIC, asset)), `${asset} is referenced but missing`);
  }
});

test("app.js parses as valid JavaScript", () => {
  // Same class of failure in the other direction: a syntax error here
  // leaves the page a static shell with no data and no error on screen.
  const source = fs.readFileSync(path.join(PUBLIC, "app.js"), "utf8");
  assert.doesNotThrow(() => new Function(source), "app.js has a syntax error");
});
