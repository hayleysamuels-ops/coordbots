One logo per client, chosen by that deployment's `CLIENT_LOGO` (see `src/client-logo.js`).

- `CLIENT_LOGO=luminai` serves `luminai.svg` (or `.png`, `.webp`).
- `luminai-dark.svg` is used in dark mode if it exists; otherwise the light file is used there too.
- Lowercase letters, digits and dashes only.
- Shown 26px tall and at most 160px wide in the topbar.

Adding a file here ships to every dashboard but changes nothing until a deployment sets `CLIENT_LOGO` to its name.
