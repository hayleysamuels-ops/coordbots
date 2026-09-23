"use strict";
const crypto = require("crypto");
const ALLOWED_ORIGINS = new Set(["https://app.ashbyhq.com", "https://accounts.google.com", "https://login.microsoftonline.com", "https://login.live.com"]);
const TTL = 15 * 60 * 1000;
const fail = (status,message) => { throw Object.assign(new Error(message),{status}); };
// This controller exposes only one time-limited login browser to its initiating
// coordinator. It cannot approve, schedule, send invitations or return cookies.
function createConnection({ chromium, vault, clientId, expectedIdentity, chromiumSandbox = true, now = () => Date.now() }) {
  if (!clientId || !expectedIdentity) throw new Error("Client and expected Ashby identity are required");
  let lease = null, browser = null, cleanupTimer = null, opening = false, lastVerification = null;
  function usable(page) {
    if(!page || page.isClosed()) return false;
    try { return page.url()!=="about:blank" && ALLOWED_ORIGINS.has(new URL(page.url()).origin); }
    catch(_) { return false; }
  }
  async function activePage(live) {
    if(usable(live.page)) return live.page;
    const pages=live.context.pages().filter(usable);
    const ashby=pages.find(page=>new URL(page.url()).origin==="https://app.ashbyhq.com");
    live.page=ashby||pages.at(-1);
    if(!live.page) {
      // Google can close its login window before Ashby paints the callback.
      // Reopening the fixed Ashby URL in the same context preserves any OAuth
      // cookies already established and gives the coordinator a usable page.
      live.page=await live.context.newPage();
      await live.page.goto("https://app.ashbyhq.com/",{waitUntil:"domcontentloaded",timeout:45000});
    }
    return live.page;
  }
  async function close() {
    clearTimeout(cleanupTimer); cleanupTimer=null;
    const old=browser; browser=null; lease=null;
    if(old) await old.close();
  }
  async function start(owner) {
    if(opening) fail(409,"Connection setup is already starting");
    if(lease && lease.expires>now()) fail(409,"A coordinator already has the sign-in window open");
    opening=true;
    try {
      await close();
      browser=await chromium.launch({headless:true,chromiumSandbox});
      const saved=vault.load();
      const storageState=saved && saved.clientId===clientId && saved.expectedIdentity===expectedIdentity ? saved.storageState : undefined;
      const context=await browser.newContext({viewport:{width:1100,height:800},acceptDownloads:false,...(storageState?{storageState}:{})});
      await context.route("**/*",async route => {
        const request=route.request();
        if(request.isNavigationRequest()) {
          let origin; try { origin=new URL(request.url()).origin; } catch(_){return route.abort();}
          if(!ALLOWED_ORIGINS.has(origin)) return route.abort();
        }
        return route.continue();
      });
      lease={id:crypto.randomUUID(),owner,context,page:await context.newPage(),expires:now()+TTL};
      // OAuth creates a blank popup before navigating it. Promoting that blank
      // page made the coordinator viewer go white after Google 2FA. Follow a
      // popup only after it reaches an allowed origin, and fall back to the
      // original Ashby page when the popup closes.
      context.on("page",page=>page.on("domcontentloaded",()=>{if(lease&&usable(page))lease.page=page;}));
      await lease.page.goto("https://app.ashbyhq.com/",{waitUntil:"domcontentloaded",timeout:45000});
      cleanupTimer=setTimeout(()=>close().catch(()=>{}),TTL); cleanupTimer.unref();
      return {id:lease.id,expires:lease.expires,width:1100,height:800};
    } catch(error) {
      await close();
      if (/sandbox|namespace|Operation not permitted/i.test(String(error.message)))
        fail(503,"Railway could not start Chromium with its sandbox enabled. Administrator setup is required before sign-in.");
      throw error;
    } finally { opening=false; }
  }
  function current(owner,id) {
    if(!lease || lease.owner!==owner || lease.id!==id || lease.expires<=now()) fail(403,"Sign-in session expired or belongs to another coordinator");
    return lease;
  }
  async function act(owner,id,input) {
    const live=current(owner,id), page=await activePage(live);
    if(input.type === "click") {
      if(!Number.isFinite(input.x)||!Number.isFinite(input.y)||input.x<0||input.y<0||input.x>=1100||input.y>=800) fail(400,"Invalid browser coordinates");
      await page.mouse.click(input.x,input.y);
    } else if(input.type === "text") {
      if(typeof input.text!=="string"||input.text.length>4096) fail(400,"Invalid text input");
      await page.keyboard.insertText(input.text);
    } else if(input.type === "key") {
      if(!["Enter","Tab","Shift+Tab","Backspace","Delete","Escape","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","ControlOrMeta+A"].includes(input.key)) fail(400,"Unsupported key");
      await page.keyboard.press(input.key);
    } else if(input.type === "scroll") {
      if(!Number.isFinite(input.dy)||Math.abs(input.dy)>1600) fail(400,"Invalid scroll");
      await page.mouse.wheel(0,input.dy);
    } else if(input.type === "navigate") {
      if(typeof input.url!=="string"||input.url.length>4096) fail(400,"Invalid Ashby magic link");
      let target;try{target=new URL(input.url);}catch(_){fail(400,"Invalid Ashby magic link");}
      if(target.protocol!=="https:"||target.origin!=="https://app.ashbyhq.com"||target.username||target.password) fail(400,"Use an app.ashbyhq.com magic link");
      await page.goto(target.href,{waitUntil:"domcontentloaded",timeout:45000});
    } else fail(400,"Unsupported browser action");
    return {ok:true};
  }
  return {
    start,act,
    async verify() {
      if(opening || (lease && lease.expires>now())) fail(409,"Close the sign-in window before checking the saved connection");
      const saved=vault.load();
      if(!saved || saved.clientId!==clientId || saved.expectedIdentity!==expectedIdentity || !saved.storageState)
        fail(409,"Save a session for the configured Ashby account first");
      opening=true;lastVerification=null;let probe;
      try {
        probe=await chromium.launch({headless:true,chromiumSandbox});
        const context=await probe.newContext({storageState:saved.storageState,acceptDownloads:false});
        await context.route("**/*",async route=>{
          if(route.request().isNavigationRequest()) {
            let origin;try{origin=new URL(route.request().url()).origin;}catch(_){return route.abort();}
            if(origin!=="https://app.ashbyhq.com")return route.abort();
          }
          return route.continue();
        });
        const page=await context.newPage();
        await page.goto("https://app.ashbyhq.com/home/upcoming",{waitUntil:"domcontentloaded",timeout:30000});
        const identity=page.getByRole("button",{name:expectedIdentity,exact:true});
        await identity.waitFor({state:"visible",timeout:15000});
        if(new URL(page.url()).origin!=="https://app.ashbyhq.com" || await identity.count()!==1)
          fail(409,"The saved session does not show the expected Ashby account");
        lastVerification={savedAt:saved.savedAt,at:now()};
        return {sessionVerified:true,verifiedAt:new Date(lastVerification.at).toISOString(),bookingEnabled:false};
      } catch(_) {
        lastVerification=null;
        fail(409,"The saved connection could not be verified. It may need a new sign-in, or Ashby may be temporarily unavailable.");
      } finally {try{if(probe)await probe.close();}finally{opening=false;}}
    },
    async frame(owner,id) {
      const page=await activePage(current(owner,id)), url=new URL(page.url());
      return {origin:url.origin,image:(await page.screenshot({type:"jpeg",quality:75})).toString("base64")};
    },
    async finish(owner,id) {
      const live=current(owner,id);
      const page=await activePage(live);
      if(new URL(page.url()).origin!=="https://app.ashbyhq.com") fail(409,"Finish signing into Ashby first");
      // Verify the observed account AND organization, never just a login cookie.
      if(await page.getByRole("button",{name:expectedIdentity,exact:true}).count()!==1)
        fail(409,"Select the configured Ashby account and organization before saving");
      lastVerification=null;
      vault.save({clientId, expectedIdentity, savedAt:new Date(now()).toISOString(),
        storageState:await live.context.storageState({indexedDB:true})});
      await close(); return {saved:true,bookingEnabled:false,message:"Ashby session saved. Booking remains disabled until the booking adapter is verified."};
    },
    async cancel(owner,id) { current(owner,id); await close(); return {ok:true}; },
    async status() {
      const saved=vault.load();
      const matches=!!saved && saved.clientId===clientId && saved.expectedIdentity===expectedIdentity;
      return {clientId,expectedIdentity,sessionSaved:matches,savedAt:matches?saved.savedAt:null,
        sessionVerified:!!(matches && lastVerification && lastVerification.savedAt===saved.savedAt && now()-lastVerification.at<=60000),
        verifiedAt:matches&&lastVerification?new Date(lastVerification.at).toISOString():null,bookingEnabled:false,signInOpen:!!lease && lease.expires>now()};
    },
    close,
  };
}
module.exports = { createConnection };
