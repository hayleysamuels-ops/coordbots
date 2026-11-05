"use strict";
// The topbar logo. CLIENT_LOGO names a file per client in
// public/assets/clients/: CLIENT_LOGO=luminai serves luminai.svg (or .png,
// .webp), with luminai-dark.<ext> for dark mode if there is one. The page
// always asks for the same two paths, /assets/client-logo and
// /assets/client-logo-dark (index.html), so the right logo is there on first
// paint instead of swapping in after the first poll.
//
// Unset, or set to a name with no file: Carrara's mark, exactly as before
// (the second also warns at startup). A client logo with no dark file is
// used in dark mode too.

const fs = require("fs");
const path = require("path");

const EXTENSIONS = [".svg", ".png", ".webp"];

function resolveClientLogo(slug, { assetsDir }) {
  const carrara = {
    light: path.join(assetsDir, "carrara-iso-grafite.svg"),
    dark: path.join(assetsDir, "carrara-iso-marmol.svg"),
  };
  if (!slug) return { ...carrara, warning: null };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return { ...carrara, warning: `CLIENT_LOGO "${slug}" isn't a file name (lowercase letters, digits and dashes); showing Carrara's mark.` };
  }
  const find = (name) => EXTENSIONS.map((ext) => path.join(assetsDir, "clients", name + ext)).find((p) => fs.existsSync(p)) || null;
  const light = find(slug);
  if (!light) {
    return { ...carrara, warning: `CLIENT_LOGO "${slug}" has no file in public/assets/clients/ (${EXTENSIONS.map((e) => slug + e).join(", ")}); showing Carrara's mark.` };
  }
  return { light, dark: find(`${slug}-dark`) || light, warning: null };
}

module.exports = { resolveClientLogo };
