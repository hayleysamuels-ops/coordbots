"use strict";
// Probe only the browser process. No page, external request, or saved login is used.
async function checkRuntime(chromium, chromiumSandbox) {
  const browser = await chromium.launch({headless:true,chromiumSandbox});
  await browser.close();
}
module.exports = {checkRuntime};
