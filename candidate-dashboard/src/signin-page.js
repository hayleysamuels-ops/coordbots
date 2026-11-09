"use strict";
// The sign-in page (signin.js), served outside the login, so it carries its
// own styles: the tokens are copied from style.css, as in legal/privacy.html.
// Keep them in step if those change.

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function signInPage({ title, domains, passwordSignIn, next, error, signedOut }) {
  const nextQuery = next && next !== "/" ? "?next=" + encodeURIComponent(next) : "";
  const accounts = domains.map((d) => `<strong>${escapeHtml(d)}</strong>`);
  const accountText = accounts.length > 1 ? accounts.slice(0, -1).join(", ") + " or " + accounts[accounts.length - 1] : accounts[0];
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Sign in · ${escapeHtml(title)}</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700&family=PT+Serif:wght@700&display=swap">
  <style>
    :root {
      --ember: #eb4e19;
      --ember-hover: #d2440f;
      --page: #f5f3f1;
      --surface: #ffffff;
      --text-primary: #2d2a2a;
      --text-secondary: #59534f;
      --border: #d3cfcc;
      --font-serif: "PT Serif", Georgia, "Times New Roman", serif;
      --font-sans: "Manrope", system-ui, -apple-system, "Segoe UI", sans-serif;
      --radius-card: 12px;
      --radius-control: 8px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --ember: #ffad89;
        --ember-hover: #ffc2a7;
        --page: #2d2a2a;
        --surface: #3a3634;
        --text-primary: #ffffff;
        --text-secondary: #d3cfcb;
        --border: rgba(255, 255, 255, 0.12);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 64px 16px;
      background: var(--page);
      color: var(--text-primary);
      font-family: var(--font-sans);
      font-size: 15px;
      line-height: 1.6;
    }
    main {
      max-width: 420px;
      margin: 0 auto;
      padding: 32px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-top: 3px solid var(--ember);
      border-radius: var(--radius-card);
    }
    h1 { font-family: var(--font-serif); font-size: 24px; line-height: 1.25; letter-spacing: -0.01em; margin: 0 0 8px; }
    p { margin: 0 0 16px; }
    .muted { color: var(--text-secondary); }
    .notice { padding: 10px 12px; border-radius: var(--radius-control); border: 1px solid var(--border); margin-bottom: 16px; }
    .notice.error { border-color: var(--ember); }
    .btn {
      display: block; width: 100%; padding: 10px 14px; border: 0; border-radius: var(--radius-control);
      background: var(--ember); color: #fff; font: 600 15px var(--font-sans); text-align: center; text-decoration: none; cursor: pointer;
    }
    .btn:hover { background: var(--ember-hover); }
    @media (prefers-color-scheme: dark) { .btn { color: #2d2a2a; } }
    details { margin-top: 24px; border-top: 1px solid var(--border); padding-top: 16px; }
    summary { cursor: pointer; color: var(--text-secondary); }
    label { display: block; margin: 12px 0 4px; font-weight: 600; }
    input {
      width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-control);
      background: var(--page); color: var(--text-primary); font: 15px var(--font-sans);
    }
    details .btn { margin-top: 16px; background: transparent; color: var(--text-primary); border: 1px solid var(--border); }
    details .btn:hover { background: var(--page); }
    footer { max-width: 420px; margin: 16px auto 0; text-align: center; font-size: 13px; }
    footer a { color: var(--text-secondary); }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p class="muted">Sign in with your ${accountText} Google account.</p>
    ${error ? `<div class="notice error" role="alert">${escapeHtml(error)}</div>` : ""}
    ${signedOut && !error ? `<div class="notice" role="status">You're signed out.</div>` : ""}
    <a class="btn" href="/auth/google${nextQuery}">Sign in with Google</a>
    ${passwordSignIn ? `<details${error && /password|username/i.test(error) ? " open" : ""}>
      <summary>Sign in with the dashboard password</summary>
      <form method="post" action="/signin/password">
        <input type="hidden" name="next" value="${escapeHtml(next || "/")}">
        <label for="username">Username</label>
        <input id="username" name="username" autocomplete="username" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button class="btn" type="submit">Sign in</button>
      </form>
    </details>` : ""}
  </main>
  <footer><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>
</body>
</html>
`;
}

module.exports = { signInPage };
