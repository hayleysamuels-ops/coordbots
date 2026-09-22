"use strict";
/**
 * Work Trial Tracker — tiny Express API + static host.
 * Storage: Postgres when DATABASE_URL is set (Railway), else a local data.json file.
 * Access:  Google sign-in, restricted to @carrara.is accounts that are in the users table.
 */
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { ALLOWED_DOMAIN, SEED_USERS, canApprove } = require("./users");

const app = express();
// Railway terminates HTTPS in front of us, so req.secure/req.protocol only tell
// the truth if we trust its proxy header. Used for secure cookies + callback URL.
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));

// The one definition of a reversed date range, shared with the browser.
const DATEDAY = require("./lib/dateday");
const calendar = require("./lib/calendar");

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || "";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const SESSION_DAYS = 30;

// Bot credentials. Unlike the Google variables below, these are NOT required to
// boot: a tracker that refuses to start because a bot is unconfigured would take
// the team's tracker down for a reason that has nothing to do with the tracker.
// Missing values disable the bots and say so in the Bots panel.
const ASHBY_READ_KEY = process.env.ASHBY_READ_KEY || "";
const ASHBY_SCHEDULING_KEY = process.env.ASHBY_SCHEDULING_KEY || "";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || "";

// Fail loudly at boot rather than mysteriously at sign-in time.
for (const [name, value] of [
  ["GOOGLE_CLIENT_ID", GOOGLE_CLIENT_ID],
  ["GOOGLE_CLIENT_SECRET", GOOGLE_CLIENT_SECRET],
  ["SESSION_SECRET", SESSION_SECRET],
]) {
  if (!value) {
    console.error("Missing required environment variable: " + name + ". See .env.example");
    process.exit(1);
  }
}

/* ---------------- storage ---------------- */
let store;

if (DATABASE_URL) {
  const { Pool } = require("pg");
  // Railway's private URL (*.railway.internal) and localhost don't use SSL;
  // a public proxy URL does.
  const needSSL = !/localhost|127\.0\.0\.1|\.railway\.internal/.test(DATABASE_URL);
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: needSSL ? { rejectUnauthorized: false } : false,
  });
  const ready = pool
    .query(
      "CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at BIGINT NOT NULL)"
    )
    .then(() =>
      pool.query(
        "CREATE TABLE IF NOT EXISTS users (" +
          "id SERIAL PRIMARY KEY," +
          "name TEXT NOT NULL," +
          "email TEXT NOT NULL UNIQUE," +
          "slack_user_id TEXT," +
          "can_approve BOOLEAN NOT NULL DEFAULT false," +
          "active BOOLEAN NOT NULL DEFAULT true)"
      )
    )
    .then(() =>
      // Seed is idempotent. It refreshes name/slack id, but deliberately leaves
      // can_approve and active alone so revoking someone in the database sticks
      // across deploys.
      Promise.all(
        SEED_USERS.map((u) =>
          pool.query(
            "INSERT INTO users(name,email,slack_user_id,can_approve) VALUES($1,$2,$3,$4) " +
              "ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name, slack_user_id=EXCLUDED.slack_user_id",
            [u.name, u.email, u.slack_user_id, u.can_approve]
          )
        )
      )
    );
  store = {
    async all() {
      await ready;
      const r = await pool.query("SELECT data FROM candidates ORDER BY updated_at DESC");
      return r.rows.map((x) => x.data);
    },
    async put(c) {
      await ready;
      await pool.query(
        "INSERT INTO candidates(id,data,updated_at) VALUES($1,$2,$3) " +
          "ON CONFLICT(id) DO UPDATE SET data=$2, updated_at=$3",
        [c.id, c, c.updatedAt || Date.now()]
      );
    },
    async del(id) {
      await ready;
      await pool.query("DELETE FROM candidates WHERE id=$1", [id]);
    },
    async userByEmail(email) {
      await ready;
      const r = await pool.query("SELECT * FROM users WHERE lower(email)=lower($1)", [email]);
      return r.rows[0] || null;
    },
  };
  console.log("[storage] Postgres");
} else {
  const fs = require("fs");
  const file = path.join(__dirname, "data.json");
  let mem = {};
  try {
    mem = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    mem = {};
  }
  const flush = () => {
    try {
      fs.writeFileSync(file, JSON.stringify(mem));
    } catch (e) {
      console.error("write failed", e);
    }
  };
  store = {
    async all() {
      return Object.values(mem).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    async put(c) {
      mem[c.id] = c;
      flush();
    },
    async del(id) {
      delete mem[id];
      flush();
    },
    // No database locally, so the seed list itself is the users table.
    async userByEmail(email) {
      const u = SEED_USERS.find((x) => x.email.toLowerCase() === String(email).toLowerCase());
      return u ? { ...u, active: true } : null;
    },
  };
  console.log("[storage] local file data.json. Set DATABASE_URL for shared Postgres");
}

/* ---------------- cookies & signed values ---------------- */
// A session is a signed cookie rather than a row in a session table: it survives
// Railway restarts and works if more than one instance is running.

function cookies(req) {
  const out = {};
  (req.get("cookie") || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function sign(body) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
}

function pack(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return body + "." + sign(body);
}

// Returns the payload only if the signature checks out and it hasn't expired.
function unpack(token) {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(sign(body));
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function setCookie(req, res, name, value, maxAgeSeconds) {
  res.append(
    "Set-Cookie",
    name +
      "=" +
      encodeURIComponent(value) +
      "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" +
      maxAgeSeconds +
      // Secure over HTTPS (Railway) but not on http://localhost, where it would
      // stop the cookie being stored at all.
      (req.secure ? "; Secure" : "")
  );
}

function clearCookie(req, res, name) {
  setCookie(req, res, name, "", 0);
}

/* ---------------- google sign-in ---------------- */
const SESSION_COOKIE = "wt_session";
const STATE_COOKIE = "wt_oauth_state";

// Derived from the incoming request so the same code works on localhost and on
// Railway with no extra configuration. Must match a URI registered in Google Cloud.
function callbackUrl(req) {
  return req.protocol + "://" + req.get("host") + "/auth/google/callback";
}

app.get("/auth/google", (req, res) => {
  // CSRF protection: a random value we hand to Google and expect back. It lives
  // in a short-lived cookie, never in server memory, so restarts and multiple
  // instances can't break sign-in mid-flow.
  const state = crypto.randomBytes(16).toString("hex");
  setCookie(req, res, STATE_COOKIE, pack({ state, exp: Date.now() + 10 * 60 * 1000 }), 600);

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", callbackUrl(req));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  // Asks Google to show only carrara.is accounts. This is a convenience for the
  // user, NOT a security control — the real check is on the email below.
  url.searchParams.set("hd", ALLOWED_DOMAIN);
  res.redirect(url.toString());
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const saved = unpack(cookies(req)[STATE_COOKIE]);
    clearCookie(req, res, STATE_COOKIE);
    if (!saved || !req.query.state || saved.state !== req.query.state) {
      return res.redirect("/login?error=state");
    }
    if (!req.query.code) return res.redirect("/login?error=denied");

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(req.query.code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: callbackUrl(req),
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      console.error("[auth] token exchange failed", tokenRes.status, await tokenRes.text());
      return res.redirect("/login?error=server");
    }
    const token = await tokenRes.json();
    if (!token.id_token) return res.redirect("/login?error=server");

    /* SECURITY — why we do not verify the ID token's signature here.
     *
     * We are reading the claims out of a token we received as the direct,
     * server-to-server HTTPS response to our own POST to Google's token
     * endpoint, authenticated with our client secret. Nothing untrusted sits in
     * between, so the transport itself is what proves the token is Google's.
     * This is the one case the OpenID Connect spec allows skipping validation.
     *
     * That guarantee DISAPPEARS the moment this token arrives by any other
     * route. If anyone ever moves this exchange into the browser, accepts an
     * id_token posted from the client, or forwards one on from another service,
     * the signature MUST be verified against Google's public keys first —
     * otherwise anybody can mint a token claiming any email they like and walk
     * straight in. Do not copy this pattern anywhere else.
     */
    const claims = JSON.parse(Buffer.from(token.id_token.split(".")[1], "base64url").toString("utf8"));

    const email = String(claims.email || "").toLowerCase();
    // Never trust the hd parameter on its own — check the verified email itself.
    if (claims.email_verified !== true || !email.endsWith("@" + ALLOWED_DOMAIN)) {
      return res.redirect("/login?error=domain");
    }

    const user = await store.userByEmail(email);
    if (!user || !user.active) return res.redirect("/login?error=noaccess");

    setCookie(
      req,
      res,
      SESSION_COOKIE,
      // Identity only. Permissions are looked up fresh on every request so that
      // revoking someone takes effect immediately, not in 30 days.
      pack({
        email: user.email,
        name: claims.name || user.name,
        exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
      }),
      SESSION_DAYS * 24 * 60 * 60
    );
    res.redirect("/");
  } catch (e) {
    console.error("[auth] callback failed", e);
    res.redirect("/login?error=server");
  }
});

app.post("/auth/signout", (req, res) => {
  clearCookie(req, res, SESSION_COOKIE);
  res.redirect("/login?error=signedout");
});

/* ---------------- access control ---------------- */
const LOGIN_MESSAGES = {
  domain: "This app is restricted to Carrara accounts. Please sign in with your @carrara.is email.",
  noaccess:
    "That Carrara account doesn't have access to the tracker yet. Ask Hayley to add you, then try again.",
  revoked: "Your access to the tracker has been removed. Ask Hayley if you think this is a mistake.",
  state: "That sign-in attempt expired or didn't complete. Please try again.",
  denied: "Sign-in was cancelled.",
  server: "Something went wrong signing you in. Please try again.",
  signedout: "You're signed out.",
};

function loginPage(errorKey) {
  const message = LOGIN_MESSAGES[errorKey] || "";
  const isNotice = errorKey === "signedout";
  return (
    "<!doctype html><html><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>Sign in to Work Trial Tracker</title>" +
    "<link rel='preconnect' href='https://fonts.googleapis.com'>" +
    "<link rel='preconnect' href='https://fonts.gstatic.com' crossorigin>" +
    "<link rel='stylesheet' href='https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700&display=swap'>" +
    "<style>" +
    // The same ten tokens as the app. This is the first Carrara surface anyone
    // sees, so it cannot be the one that does not match.
    ":root{--ink:#2E2B2B;--ink-2:#4D4D4D;--ink-3:#827F7D;--surface:#EBE8E4;--paper:#FFFFFF;" +
    "--line:#EEEEEE;--ember:#EB4C18;--ember-tint:#FDDED4;" +
    "--sans:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif}" +
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
    "background:var(--surface);color:var(--ink);font-family:var(--sans);font-weight:500;font-size:13px;line-height:1.5}" +
    // Flat, hairline border, 10px radius: the card treatment from the app.
    ".card{background:var(--paper);border:1px solid var(--line);border-radius:10px;" +
    "padding:32px;max-width:400px;text-align:center}" +
    ".wordmark{width:110px;height:auto;display:block;margin:0 auto 24px}" +
    "h1{margin:0 0 4px;font-size:20px;font-weight:600;letter-spacing:-.2px}" +
    "p.sub{margin:0 0 24px;color:var(--ink-3);font-size:12px;font-weight:500}" +
    ".msg{margin:0 0 20px;padding:11px 13px;border-radius:6px;font-size:13px;text-align:left;" +
    // Ember tint with ink text, never solid: the accent is spent on the button.
    "background:var(--ember-tint);color:var(--ink)}" +
    ".msg.notice{background:var(--line);color:var(--ink-2)}" +
    // The one solid Ember on this page, as the primary action.
    "a.btn{display:block;padding:11px 18px;background:var(--ember);color:#fff;border-radius:6px;" +
    "text-decoration:none;font-weight:600;font-size:13px}" +
    "</style></head><body><div class='card'>" +
    "<img class='wordmark' src='/carrara-wordmark.png' width='110' height='20' alt='Carrara'>" +
    "<h1>Work Trial Tracker</h1><p class='sub'>Candidate scheduling &amp; onboarding checklist</p>" +
    (message ? "<p class='msg" + (isNotice ? " notice" : "") + "'>" + message + "</p>" : "") +
    "<a class='btn' href='/auth/google'>Sign in with Google</a>" +
    "</div></body></html>"
  );
}

app.get("/login", (req, res) => res.send(loginPage(String(req.query.error || ""))));

// The wordmark is needed BY the login page, which is unauthenticated by
// definition. Everything else in public/ stays behind requireAuth.
app.get("/carrara-wordmark.png", (req, res) => {
  res.type("image/png").sendFile(path.join(__dirname, "public", "carrara-wordmark.png"));
});

// Runs on EVERY request below this line. The cookie only says who you are; the
// users table is re-read each time to decide whether you still have access, so
// removing someone (or setting active=false) locks them out within seconds even
// though their cookie is still valid for 30 days.
async function requireAuth(req, res, next) {
  const deny = (errorKey) => {
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: errorKey, message: LOGIN_MESSAGES[errorKey] || "" });
    }
    res.redirect("/login" + (errorKey === "signin" ? "" : "?error=" + errorKey));
  };
  try {
    const session = unpack(cookies(req)[SESSION_COOKIE]);
    if (!session) return deny("signin");
    if (!String(session.email).toLowerCase().endsWith("@" + ALLOWED_DOMAIN)) return deny("domain");

    const user = await store.userByEmail(session.email);
    if (!user || !user.active) {
      clearCookie(req, res, SESSION_COOKIE);
      return deny("revoked");
    }
    req.user = { ...user, name: session.name || user.name };
    next();
  } catch (e) {
    console.error("[auth] check failed", e);
    res.status(500).json({ error: "server" });
  }
}

app.use(requireAuth);

/* ---------------- api ---------------- */
// Who am I? Drives the name in the header; canApprove is here for the approval
// queue that comes later.
app.get("/api/me", (req, res) =>
  res.json({
    name: req.user.name,
    email: req.user.email,
    slackUserId: req.user.slack_user_id || null,
    canApprove: canApprove(req.user),
  })
);

/* ---------------- scheduling approvals ---------------- */
// Lazy initialization keeps an unavailable scheduling store from taking down
// existing tracker and bot functionality. There is no executable provider until
// the Ashby adapter is configured and verified.
let schedulingService;
const schedulingRouter = require("./lib/scheduling/routes").schedulingRoutes(new Proxy({}, {
  get(_target, method) {
    return (...args) => {
      if (!schedulingService) {
        const schedulingStore=require("./lib/scheduling/store").createSchedulingStore({ databaseUrl: DATABASE_URL, dir: __dirname });
        // Older API-created rows were incorrectly called scheduled even though
        // Ashby returned no calendar delivery receipt. Repair that state once
        // the approval queue is first opened after this deploy.
        (async()=>{for(const row of await schedulingStore.list()){
          if(row.state!=="scheduled"||row.receipt?.deliveryStatus==="verified")continue;
          const at=new Date().toISOString(),next={...row,state:"needs_review",issue:"invites_not_dispatched",
            issueMessage:"Ashby stored the schedule, but calendar invitations were not dispatched. Send or reconcile them before retrying.",
            revision:row.revision+1,updatedAt:at,audit:[...row.audit,{action:"delivery_correction",at,by:"scheduling-worker"}]};
          if(!await schedulingStore.replace(row.id,row.revision,next))
            await schedulingStore.replace(row.id,row.revision,{...next,state:"delivery_failed"});
        }})().catch(()=>console.error("[scheduling] delivery-state correction failed"));
        schedulingService = require("./lib/scheduling/service").createSchedulingService({
        store: schedulingStore,
        candidates: () => store.all(),
        proposalOnly: true,
        provider: ASHBY_SCHEDULING_KEY ? require("./lib/scheduling/ashby-provider").createAshbyProvider({
          api: require("./lib/scheduling/ashby-api").createAshbySchedulingApi(ASHBY_SCHEDULING_KEY),
          trials: () => store.all().then(rows => rows.filter(c=>c.values?.ashbyCandidateId&&c.values?.startDate&&c.values?.endDate).map(c => ({candidateId:c.values.ashbyCandidateId,role:c.values.position||c.position,startDate:c.values.startDate,endDate:c.values.endDate,cancelled:/^cancel/i.test(c.values.status||"")}))),
          assignments: (candidate,constraints) => store.all().then(rows=>require("./lib/scheduling/tracker-suggestions").trackerSuggestions(candidate,rows,constraints)),
        }) : null,
      });}
      return schedulingService[method](...args);
    };
  },
}));
app.use("/api/scheduling", schedulingRouter);
app.use("/api/ashby-connection", require("./lib/scheduling/connection-routes").connectionRoutes({
  url: process.env.ASHBY_WORKER_URL,
  secret: process.env.ASHBY_WORKER_SECRET,
}));

/* ---------------- onsite discussion approvals ---------------- */
let discussionService;
function discussions() {
  if (!discussionService) {
    const shellStore = require("./lib/scheduling/store").createSchedulingStore({ databaseUrl: DATABASE_URL, dir: __dirname });
    const sourceProposals = async () => {
      const candidates = await store.all();
      return (await shellStore.list()).filter(r => ["draft", "suggestion_approved", "approved"].includes(r.state)).map(r => ({ ...r, candidateName: candidates.find(c => c.id === r.trackerCandidateId)?.name || "Tracker candidate" }));
    };
    const readKey = process.env.ASHBY_READ_KEY || ASHBY_SCHEDULING_KEY;
    discussionService = require("./lib/discussion/service").createService({
      store: require("./lib/discussion/store").createSchedulingStore({ databaseUrl: DATABASE_URL, dir: __dirname }),
      clientId: "poetic", sourceProposals,
      candidates: async () => (await sourceProposals()).map(r => ({ applicationId: r.plan.applicationId,
        candidateId: r.plan.candidateId, candidateName: r.candidateName, jobTitle: r.plan.role, status: "Active" })),
      templateReader: require("./lib/discussion/ashby-template").createTemplateReader(readKey),
      routing: process.env.SCHEDULING_SLACK_ROUTING || "candidate",
      channelId: process.env.SCHEDULING_SLACK_CHANNEL_ID || "",
      channelName: process.env.SCHEDULING_SLACK_CHANNEL_NAME || "",
      candidateChannels: JSON.parse(process.env.SCHEDULING_CANDIDATE_CHANNELS_JSON || "{}"),
      slack: process.env.SCHEDULING_SLACK_BOT_TOKEN ? require("./lib/discussion/slack").createSlack(process.env.SCHEDULING_SLACK_BOT_TOKEN) : null,
    });
    discussionService.candidateOptions = async () => ({ candidates: (await sourceProposals()).map(r => ({ applicationId: r.plan.applicationId,
      candidateId: r.plan.candidateId, candidateName: r.candidateName, jobTitle: r.plan.role, status: "Active" })) });
  }
  return discussionService;
}
app.get("/api/discussion-candidates", async (req, res) => {
  try { res.set("Cache-Control", "no-store"); res.json(await discussions().candidateOptions()); }
  catch (_) { res.status(503).json({ error: "Tracker proposals are unavailable." }); }
});
app.use("/api/scheduling-review", (req, res, next) => {
  req.schedulingUser = { id: req.user.email, canApprove: canApprove(req.user) }; next();
}, require("./lib/discussion/routes").routes(new Proxy({}, {
  get(_target, method) { return (...args) => discussions()[method](...args); },
})));

/* ---------------- bots ---------------- */
// Everything here is already behind requireAuth, so any signed-in coordinator
// can see run history and flip a bot between live and dry-run without a deploy.
app.get("/api/bots", async (req, res) => {
  try {
    res.json({ bots: await bots.status(), ready: bots.readiness() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/bots/:name/config", async (req, res) => {
  try {
    const patch = {};
    if (typeof req.body.enabled === "boolean") patch.enabled = req.body.enabled;
    if (typeof req.body.dryRun === "boolean") patch.dryRun = req.body.dryRun;
    res.json(await bots.setConfig(req.params.name, patch, req.user.email));
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post("/api/bots/:name/run", async (req, res) => {
  try {
    res.json(await bots.runNow(req.params.name, req.user.email));
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

/* ---- bot 1: live Ashby panel. Read-only; the link itself is stored on the
   candidate row by the ordinary save path, written by a person's click. ---- */
app.get("/api/panel/:ashbyCandidateId", async (req, res) => {
  try {
    res.json(await bots.panelFor(req.params.ashbyCandidateId, { force: req.query.force === "1" }));
  } catch (e) {
    res.status(500).json({ state: "stale", error: String(e.message || e) });
  }
});

/* Who is at Work Trial in Ashby but not in the tracker. Read-only: the row is
   created by the browser through PUT /api/candidates/:id when a person clicks. */
app.get("/api/suggestions", async (req, res) => {
  try {
    const rows = await store.all();
    res.json(await bots.suggestionsFor(rows, { force: req.query.force === "1" }));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), add: [], link: [], possible: [], dismissed: [] });
  }
});

app.post("/api/suggestions/:id/dismiss", async (req, res) => {
  try {
    await bots.dismissSuggestion(req.params.id, (req.body && req.body.name) || null, req.user.email);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/suggestions/:id/undismiss", async (req, res) => {
  try {
    await bots.undismissSuggestion(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* Which WT Tracker sheet row is this person? Read-only proposals from columns
   A and B; the browser stores the chosen sheetRowKey through the ordinary
   PUT /api/candidates/:id when a coordinator clicks. */
app.get("/api/sheet-suggest", async (req, res) => {
  try {
    const rows = await store.all();
    res.json(await bots.sheetSuggest(req.query.name || "", rows));
  } catch (e) {
    res.status(500).json({ suggestions: [], error: String(e.message || e) });
  }
});

app.get("/api/panel-suggest", async (req, res) => {
  try {
    res.json(await bots.panelSuggest(req.query.name || ""));
  } catch (e) {
    res.status(500).json({ suggestions: [], error: String(e.message || e) });
  }
});

app.get("/api/state", async (req, res) => {
  try {
    res.json({ candidates: await store.all() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.put("/api/candidates/:id", async (req, res) => {
  try {
    const c = req.body;
    if (!c || c.id !== req.params.id) return res.status(400).json({ error: "id mismatch" });

    // End before start is a data integrity rule, not a UI convenience, so it
    // holds whoever is writing: a person editing a card, an import replaying a
    // snapshot, or anything added later. A reversed range iterates zero days, so
    // in the day view the trial appears on NO days and vanishes silently instead
    // of looking wrong. Three rows were saved this way on 10 Sep and accepted
    // without complaint.
    //
    // Never coerced and never silently dropped: the write is refused and the
    // caller is told both dates.
    //
    // No conflict with bot 10, which writes computer, desk and driName only.
    // Dates are panel-covered and sheet columns H and I are Ashby-owned, so
    // sheet sync has never been a date writer.
    const startDate = (c.values || {}).startDate;
    const endDate = (c.values || {}).endDate;
    if (DATEDAY.isReversed(startDate, endDate)) {
      // Logged with the id and both values, so a blocked import is visible
      // rather than mysterious.
      console.warn(
        "[api] rejected reversed dates for candidate " + c.id +
        " (" + (c.name || "unnamed") + "): start " + startDate + ", end " + endDate
      );
      return res.status(400).json({
        error: "end date " + endDate + " is before start date " + startDate,
        field: "endDate",
        startDate,
        endDate,
      });
    }

    if (!c.updatedAt) c.updatedAt = Date.now();
    await store.put(c);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete("/api/candidates/:id", async (req, res) => {
  try {
    await store.del(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// The shared panel-vs-stored resolver, served to the browser so there is one
// implementation rather than two that drift.
app.get("/effective.js", (req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "lib", "effective.js"));
});

// The field schema, on the same terms: bot 10 needs a field's default to tell a
// person's answer from an unanswered field, and one definition cannot disagree
// with itself.
/* The day model, shared with the browser for the same reason effective.js is:
   the Day view and the save validation must agree about what day a date is on.
   Before this route existed index.html carried its own copy of parseDay. */
/* The DRI alias map, shared for the same reason: capacity counts are only
   meaningful if the browser and anything server-side agree who is who. */
/* The suggester and its inventory. Shared for the same reason as the others:
   a proposal the browser shows and a proposal anything else computes must come
   from one rule. Neither module writes anything. */
app.get("/declines.js", (req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "lib", "declines.js"));
});

/* The recorded capture. Stays reachable, and stays the test source: the
   64/16/5 assertions run against this file, never against live data. */
app.get("/declines-fixture.json", (req, res) => {
  res.type("application/json").sendFile(
    path.join(__dirname, "fixtures", "poetic-interviews-2026-09-07_to_09-18.json"));
});

/**
 * The calendar the rail reads.
 *
 * Live when the credential is configured, the recorded capture when it is not,
 * and an ERROR when a live read fails. It never falls back to the fixture on a
 * fault: a rail showing 14 September data while labelled live is worse than a
 * rail showing an error.
 */
app.get("/declines-snapshot.json", async (req, res) => {
  if (!calendar.isConfigured()) {
    return res.type("application/json").sendFile(
      path.join(__dirname, "fixtures", "poetic-interviews-2026-09-07_to_09-18.json"));
  }
  try {
    const snapshot = await calendar.getSnapshot();
    /* The call succeeded and the window is genuinely empty. A different state
       from a failed call, and it must not render the same way. */
    if (!snapshot.events.length) {
      return res.json(Object.assign({}, snapshot, { empty: true }));
    }
    res.json(snapshot);
  } catch (e) {
    const kind = e.kind || "http";
    const status = kind === "forbidden" ? 403
                 : kind === "not_found" ? 404
                 : kind === "not_configured" ? 503 : 502;
    console.error("[declines] calendar read failed (" + kind + "): " + e.message);
    res.status(status).json({ error: { kind, message: e.message, detail: e.detail || null } });
  }
});

app.get("/assignment-inventory.js", (req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "lib", "assignment-inventory.js"));
});
app.get("/suggest-assignments.js", (req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "lib", "suggest-assignments.js"));
});

app.get("/dri-aliases.js", (req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "lib", "dri-aliases.js"));
});

app.get("/dateday.js", (req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "lib", "dateday.js"));
});

app.get("/fields.js", (req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "lib", "fields.js"));
});

/* ---------------- static frontend ---------------- */
// Behind requireAuth: signed-out visitors never receive the app itself.
app.use((req, res, next) => {
  if (["/ashby-connection.html", "/scheduling.html"].includes(req.path)) {
    res.set("Cache-Control", "no-store");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "no-referrer");
    res.set("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
  }
  next();
});
app.use(express.static(path.join(__dirname, "public")));

const bots = require("./lib/bots")({
  databaseUrl: DATABASE_URL,
  dir: __dirname,
  ashbyReadKey: ASHBY_READ_KEY,
  slackBotToken: SLACK_BOT_TOKEN,
  slackChannelId: SLACK_CHANNEL_ID,
  // The readiness sweep works from the tracker's own rows.
  getCandidates: () => store.all(),
  // Bot 10 fills empty fields, and keeps three of them matching the sheet.
  // Deliberately only put — no del is handed over,
  // so no bot can remove a tracker row.
  putCandidate: (c) => store.put(c),
});

app.listen(PORT, () => {
  console.log("Work Trial Tracker listening on :" + PORT);
  bots.start();
});
