// index.js — VOLRYX Backend (Concierge wired: Google + Meta FB/IG + LinkedIn + HubSpot + Twilio/Slack/Calendly)
// -----------------------------------------------------------------

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Core SDKs
const admin = require("firebase-admin");
const OpenAI = require("openai");
const Stripe = require("stripe");
const { google } = require("googleapis");
const ExcelJS = require("exceljs");
const puppeteer = require("puppeteer-core");

// Optional providers (guarded)
const Twilio = (() => {
  try { return require("twilio"); } catch { return null; }
})();
const { WebClient: SlackWebClient } = (() => {
  try { return require("@slack/web-api"); } catch { return { WebClient: null }; }
})();

// App
const app = express();
app.use(cors());
app.use(express.json());

// ---- Helpers
function resolveChromeExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const platform = os.platform();
  const candidates = [];
  if (platform === "win32") {
    candidates.push(
      "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe",
      "C:\\\\Program Files (x86)\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe",
      "C:\\\\Program Files\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe",
      "C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe"
    );
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/snap/bin/chromium"
    );
  }
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
  throw new Error("Chrome/Edge executable not found. Set PUPPETEER_EXECUTABLE_PATH env var.");
}
function mask(v){ if(!v) return 'MISSING'; const s=String(v); return s.length<=12 ? s : s.slice(0,6)+'…'+s.slice(-4); }

// ---- Firebase Admin
const serviceAccount = {
  project_id: process.env.FIREBASE_PROJECT_ID,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
};
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
const TENANT_ID = process.env.TENANT_ID || "default";

// ---- OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- Stripe
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ---- Diagnostics
app.get("/test", (_req, res) => res.send("🔥 VOLRYX Backend is Live!"));
app.get("/diag/puppeteer", (_req, res) => {
  try { return res.json({ ok: true, executablePath: resolveChromeExecutablePath() }); }
  catch (e) { return res.status(500).json({ ok: false, error: String(e) }); }
});

// 🔎 Firebase diag + Firestore write test
app.get("/diag/firebase", (_req, res) => {
  res.json({
    projectId: process.env.FIREBASE_PROJECT_ID || null,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || null,
    hasPrivateKey: !!process.env.FIREBASE_PRIVATE_KEY,
  });
});

app.get("/test-firestore-write", async (_req, res) => {
  try {
    await db.collection("test").doc("demo").set({
      hello: "world",
      time: new Date().toISOString(),
    });
    res.send("✅ Firestore write successful");
  } catch (e) {
    console.error("❌ Firestore write failed:", e);
    res.status(500).send("Firestore write failed: " + e.message);
  }
});

// ---- Simple AI passthrough
app.post("/ask-ai", async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "Prompt is required" });
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    });
    res.json({ response: completion.choices?.[0]?.message?.content || "" });
  } catch (e) {
    console.error("OpenAI error:", e);
    res.status(500).json({ error: "OpenAI failed" });
  }
});

// ---- Stripe checkout
app.post("/create-checkout-session", async (req, res) => {
  const { plan } = req.body || {};
  const priceMap = {
    essentials: "price_1RqvABPrfvwv1fLzVAcd0dm8",
    pro:        "price_1RqvAePrfvwv1fLzBcfzJvOg",
    elite:      "price_1RqvAxPrfvwv1fLzAxAe4SZp",
  };
  const priceId = priceMap[plan?.toLowerCase()];
  if (!priceId) return res.status(400).json({ error: "Invalid plan" });
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: process.env.SUCCESS_URL || "http://localhost:5173/success",
      cancel_url: process.env.CANCEL_URL || "http://localhost:5173/cancel",
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("Stripe error:", e.message);
    res.status(500).json({ error: "Stripe session creation failed" });
  }
});

// ---------------------------------------------------------------------
// GOOGLE OAUTH (Gmail send + Sheets append) with diagnostics + local fallback
// ---------------------------------------------------------------------
const GOOGLE = {
  CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || "http://localhost:5002/api/auth/google/callback",
  SCOPES: [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/calendar.readonly",
    // If you plan to upload YouTube later, add this scope and re-connect:
    // "https://www.googleapis.com/auth/youtube.upload",
    "openid", "email", "profile",
  ],
};
const googleDocRef = db.collection("tenants").doc(TENANT_ID).collection("integrations").doc("google");
const LOCAL_TOKENS_PATH = path.join(process.cwd(), "google_tokens.json");

function getOAuth2Client() {
  return new google.auth.OAuth2(GOOGLE.CLIENT_ID, GOOGLE.CLIENT_SECRET, GOOGLE.REDIRECT_URI);
}

function readLocalTokensSafe() {
  try {
    if (fs.existsSync(LOCAL_TOKENS_PATH)) {
      return JSON.parse(fs.readFileSync(LOCAL_TOKENS_PATH, "utf8"));
    }
  } catch (e) {
    console.error("[GOOGLE TOKENS] Failed to read local tokens:", e.message);
  }
  return null;
}

async function getAuthorizedGoogleClient() {
  // Try Firestore first
  let data = null;
  try {
    const snap = await googleDocRef.get();
    data = snap.exists ? snap.data() : null;
  } catch (e) {
    console.warn("[GOOGLE TOKENS] Firestore read failed, will try local file:", e.message);
  }

  // Fallback to local file if no Firestore tokens
  if (!data || !data.tokens) {
    const local = readLocalTokensSafe();
    if (!local || !local.tokens) {
      throw new Error("Google not connected. Visit /api/auth/google/init");
    }
    data = local;
  }

  const oAuth2Client = getOAuth2Client();
  oAuth2Client.setCredentials(data.tokens);

  // Persist refreshed tokens back to Firestore and local file
  oAuth2Client.on("tokens", async (tokens) => {
    try {
      const merged = { tokens: { ...(data.tokens || {}), ...tokens } };
      await googleDocRef.set(merged, { merge: true });
      fs.writeFileSync(LOCAL_TOKENS_PATH, JSON.stringify(merged, null, 2));
    } catch (e) {
      console.error("[GOOGLE TOKENS] Failed to persist refreshed tokens:", e.message);
    }
  });

  return oAuth2Client;
}

// Diagnostics
app.get("/diag/google-config", (_req, res) => {
  res.json({
    CLIENT_ID: mask(process.env.GOOGLE_CLIENT_ID),
    CLIENT_SECRET_SET: !!process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
    SCOPES: GOOGLE.SCOPES,
  });
});

// Start OAuth
app.get("/api/auth/google/init", async (_req, res) => {
  try {
    console.log("[GOOGLE INIT] Using", {
      CLIENT_ID: mask(process.env.GOOGLE_CLIENT_ID),
      REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
      SCOPES_COUNT: GOOGLE.SCOPES.length,
    });
    const oAuth2Client = getOAuth2Client();
    const url = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: GOOGLE.SCOPES,
    });
    res.redirect(url);
  } catch (e) {
    console.error("[GOOGLE INIT] error:", e);
    res.status(500).json({ error: "Failed to initiate Google auth", detail: String(e) });
  }
});

// OAuth callback with deep logging + fallback save
app.get("/api/auth/google/callback", async (req, res) => {
  const code = req.query.code;
  const providerErr = req.query.error;
  if (providerErr) {
    console.error("[GOOGLE CB] Provider error:", providerErr, "rawQuery:", req.url);
    return res.status(400).send(`Google returned error: ${providerErr}`);
  }
  if (!code) {
    console.error("[GOOGLE CB] Missing ?code. rawQuery:", req.url);
    return res.status(400).send("Missing ?code in callback URL.");
  }
  try {
    console.log("[GOOGLE CB] Exchanging code. redirect_uri:", process.env.GOOGLE_REDIRECT_URI);
    const oAuth2Client = getOAuth2Client();
    const { tokens } = await oAuth2Client.getToken(code);
    console.log("[GOOGLE CB] Token exchange OK:", {
      access_token: !!tokens.access_token, refresh_token: !!tokens.refresh_token, expiry_date: tokens.expiry_date,
    });

    const payload = { tokens };
    // Try Firestore first
    try {
      await googleDocRef.set(payload, { merge: true });
      console.log("[GOOGLE CB] Tokens saved to Firestore at tenants/%s/integrations/google", TENANT_ID);
      // Also mirror locally
      fs.writeFileSync(LOCAL_TOKENS_PATH, JSON.stringify(payload, null, 2));
      return res.send("<h2>✅ Google connected. You can close this tab.</h2>");
    } catch (saveErr) {
      console.error("[GOOGLE CB] Firestore save failed:", { message: saveErr?.message, name: saveErr?.name });
      // Fallback to local file so Concierge still works
      try {
        fs.writeFileSync(LOCAL_TOKENS_PATH, JSON.stringify(payload, null, 2));
        console.log("[GOOGLE CB] Tokens saved locally at", LOCAL_TOKENS_PATH);
        return res.send("<h2>✅ Google connected (token exchange OK). Firestore save failed — using local tokens. You can close this tab.</h2>");
      } catch (fileErr) {
        console.error("[GOOGLE CB] Local token save failed:", fileErr);
        return res.status(500).send("Google auth succeeded but saving tokens failed (Firestore + local). Check server logs.");
      }
    }
  } catch (e) {
    const respData = e?.response?.data || e?.data;
    console.error("[GOOGLE CB] EXCEPTION during token exchange:", {
      message: e?.message, name: e?.name,
      stack: e?.stack?.split("\n").slice(0,3).join(" | "),
      responseData: respData,
    });
    return res.status(500).send("Google auth failed. Check server logs for details.");
  }
});

// Gmail send
async function gmailSend({ to, subject, html }) {
  const auth = await getAuthorizedGoogleClient();
  const gmail = google.gmail({ version: "v1", auth });
  const parts = [
    `To: ${to}`,
    "Content-Type: text/html; charset=utf-8",
    "MIME-Version: 1.0",
    `Subject: ${subject}`,
    "", html,
  ];
  const raw = Buffer.from(parts.join("\n")).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  const { data } = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  return { id: data.id };
}

// Sheets append
async function sheetsAppend({ spreadsheetId, sheetName="Leads", values=[] }) {
  const auth = await getAuthorizedGoogleClient();
  const sheets = google.sheets({ version: "v4", auth });
  const range = `${sheetName}!A:Z`;
  const { data } = await sheets.spreadsheets.values.append({
    spreadsheetId, range, valueInputOption: "USER_ENTERED", requestBody: { values: [values] },
  });
  return { spreadsheetId, sheetName, updates: data.updates };
}

// ---------------------------------------------------------------------
// META (Facebook Page + Instagram Business) — Posting
// ---------------------------------------------------------------------
const META = {
  GRAPH_VERSION: process.env.META_GRAPH_VERSION || "v18.0",
  PAGE_ID: process.env.META_PAGE_ID,
  PAGE_TOKEN: process.env.META_PAGE_TOKEN, // Page access token with pages_manage_posts, pages_read_engagement
  IG_BUSINESS_ID: process.env.IG_BUSINESS_ID, // connected IG business user id
};
// Facebook text post
async function metaPostFacebook({ message }) {
  if (!META.PAGE_ID || !META.PAGE_TOKEN) throw new Error("Meta/Facebook not configured");
  const url = `https://graph.facebook.com/${META.GRAPH_VERSION}/${META.PAGE_ID}/feed`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, access_token: META.PAGE_TOKEN }),
  });
  if (!resp.ok) throw new Error(`Facebook post error: ${resp.status} ${await resp.text()}`);
  return await resp.json();
}
// Instagram photo with caption (URL-based)
async function metaPostInstagram({ imageUrl, caption }) {
  if (!META.IG_BUSINESS_ID || !META.PAGE_TOKEN) throw new Error("Meta/Instagram not configured");
  // 1) create container
  const containerRes = await fetch(`https://graph.facebook.com/${META.GRAPH_VERSION}/${META.IG_BUSINESS_ID}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: imageUrl, caption, access_token: META.PAGE_TOKEN }),
  });
  if (!containerRes.ok) throw new Error(`Instagram container error: ${containerRes.status} ${await containerRes.text()}`);
  const container = await containerRes.json();
  // 2) publish
  const publishRes = await fetch(`https://graph.facebook.com/${META.GRAPH_VERSION}/${META.IG_BUSINESS_ID}/media_publish?creation_id=${container.id}&access_token=${META.PAGE_TOKEN}`, {
    method: "POST",
  });
  if (!publishRes.ok) throw new Error(`Instagram publish error: ${publishRes.status} ${await publishRes.text()}`);
  return await publishRes.json();
}

// ---------------------------------------------------------------------
// LINKEDIN — Simple UGC post (organization or personal)
// ---------------------------------------------------------------------
const LINKEDIN = {
  ACCESS_TOKEN: process.env.LINKEDIN_ACCESS_TOKEN, // from your LinkedIn app OAuth (member token)
  ORGANIZATION_URN: process.env.LINKEDIN_ORGANIZATION_URN, // e.g. urn:li:organization:123456
  PERSON_URN: process.env.LINKEDIN_PERSON_URN, // e.g. urn:li:person:abcdef
};
async function linkedinPost({ text }) {
  if (!LINKEDIN.ACCESS_TOKEN) throw new Error("LinkedIn not configured");
  const author = LINKEDIN.ORGANIZATION_URN || LINKEDIN.PERSON_URN;
  if (!author) throw new Error("LinkedIn author URN missing (ORG or PERSON)");
  const resp = await fetch("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${LINKEDIN.ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text },
          shareMediaCategory: "NONE",
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    }),
  });
  if (!resp.ok) throw new Error(`LinkedIn post error: ${resp.status} ${await resp.text()}`);
  return await resp.json();
}

// ---------------------------------------------------------------------
// HUBSPOT — Create Contact (Private App token)
// ---------------------------------------------------------------------
const HUBSPOT = {
  TOKEN: process.env.HUBSPOT_TOKEN, // Private App token
};
async function hubspotCreateContact({ email, firstName, lastName, phone }) {
  if (!HUBSPOT.TOKEN) throw new Error("HubSpot not configured");
  const resp = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${HUBSPOT.TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        email,
        firstname: firstName || "",
        lastname: lastName || "",
        phone: phone || "",
        lifecyclestage: "lead",
      },
    }),
  });
  if (!resp.ok) throw new Error(`HubSpot create contact error: ${resp.status} ${await resp.text()}`);
  return await resp.json();
}

// ---------------------------------------------------------------------
// OPTIONAL PROVIDERS (do not crash if not configured)
// ---------------------------------------------------------------------
const twilio =
  (Twilio && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
    ? Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

async function twilioSendSMS({ to, body }) {
  if (!twilio) throw new Error("Twilio not configured");
  const from = process.env.TWILIO_FROM;
  if (!from) throw new Error("TWILIO_FROM missing");
  const msg = await twilio.messages.create({ to, from, body });
  return { sid: msg.sid };
}

const slack = process.env.SLACK_BOT_TOKEN ? new SlackWebClient(process.env.SLACK_BOT_TOKEN) : null;
async function slackPostMessage({ channel, text }) {
  if (!slack) throw new Error("Slack not configured");
  const { ts } = await slack.chat.postMessage({ channel, text });
  return { ts, channel };
}

// Calendly (stubbed — update endpoint/flow as needed)
async function calendlyCreateInvitee({ eventType, email, name }) {
  const token = process.env.CALENDLY_TOKEN;
  if (!token) throw new Error("Calendly not configured");
  const resp = await fetch(
    process.env.CALENDLY_INVITEE_ENDPOINT || "https://api.calendly.com/scheduled_events",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ email, name: name || "Guest", eventType }),
    }
  );
  if (!resp.ok) throw new Error(`Calendly error: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return { invitee: data };
}

// ---------------------------------------------------------------------
// CONCIERGE CORE (unified command + health)
// ---------------------------------------------------------------------
const connectors = {
  gmail: { sendEmail: gmailSend },
  sheets: { appendRow: sheetsAppend },
  twilio: { sendSMS: twilioSendSMS },
  calendly: { createInvitee: calendlyCreateInvitee },
  slack: { postMessage: slackPostMessage },
  meta: { postFacebook: metaPostFacebook, postInstagram: metaPostInstagram },
  linkedin: { post: linkedinPost },
  hubspot: { createContact: hubspotCreateContact },
};

app.post("/api/concierge/command", async (req, res) => {
  try {
    const { command, params = {} } = req.body || {};
    if (!command) return res.status(400).json({ ok: false, error: "Missing command" });

    switch (command) {
      case "send_email": {
        const { to, subject, html } = params;
        if (!to || !subject || !html) return res.status(400).json({ ok: false, error: "to, subject, html required" });
        const result = await connectors.gmail.sendEmail({ to, subject, html });
        return res.json({ ok: true, result });
      }
      case "add_lead_to_sheet": {
        const { spreadsheetId, sheetName="Leads", values=[] } = params;
        if (!sheetId || !values.length) { /* safeguard unused var */ }
        if (!spreadsheetId || !values.length) return res.status(400).json({ ok: false, error: "spreadsheetId, values required" });
        const result = await connectors.sheets.appendRow({ spreadsheetId, sheetName, values });
        return res.json({ ok: true, result });
      }
      case "send_sms": {
        const { to, body } = params;
        if (!to || !body) return res.status(400).json({ ok: false, error: "to, body required" });
        const result = await connectors.twilio.sendSMS({ to, body });
        return res.json({ ok: true, result });
      }
      case "book_meeting": {
        const { eventType, email, name } = params;
        if (!eventType || !email) return res.status(400).json({ ok: false, error: "eventType, email required" });
        const result = await connectors.calendly.createInvitee({ eventType, email, name });
        return res.json({ ok: true, result });
      }
      case "notify_slack": {
        const { channel, text } = params;
        if (!channel || !text) return res.status(400).json({ ok: false, error: "channel, text required" });
        const result = await connectors.slack.postMessage({ channel, text });
        return res.json({ ok: true, result });
      }
      // --- Social posting
      case "post_facebook": {
        const { message } = params;
        if (!message) return res.status(400).json({ ok: false, error: "message required" });
        const result = await connectors.meta.postFacebook({ message });
        return res.json({ ok: true, result });
      }
      case "post_instagram": {
        const { imageUrl, caption } = params;
        if (!imageUrl) return res.status(400).json({ ok: false, error: "imageUrl required" });
        const result = await connectors.meta.postInstagram({ imageUrl, caption: caption || "" });
        return res.json({ ok: true, result });
      }
      case "post_linkedin": {
        const { text } = params;
        if (!text) return res.status(400).json({ ok: false, error: "text required" });
        const result = await connectors.linkedin.post({ text });
        return res.json({ ok: true, result });
      }
      // --- CRM
      case "create_hubspot_contact": {
        const { email, firstName, lastName, phone } = params;
        if (!email) return res.status(400).json({ ok: false, error: "email required" });
        const result = await connectors.hubspot.createContact({ email, firstName, lastName, phone });
        return res.json({ ok: true, result });
      }
      default:
        return res.status(400).json({ ok: false, error: `Unknown command: ${command}` });
    }
  } catch (err) {
    console.error("Concierge command error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Command failed" });
  }
});

app.get("/api/concierge/health", async (_req, res) => {
  const googleOk = await googleDocRef.get().then(d => !!(d.exists && d.data()?.tokens)).catch(() => false);
  res.json({
    ok: true,
    connectors: Object.keys(connectors),
    googleConnected: googleOk || !!readLocalTokensSafe(),
    twilioConfigured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM),
    calendlyConfigured: !!process.env.CALENDLY_TOKEN,
    slackConfigured: !!process.env.SLACK_BOT_TOKEN,
    metaConfigured: !!(process.env.META_PAGE_ID && process.env.META_PAGE_TOKEN) || !!(process.env.IG_BUSINESS_ID && process.env.META_PAGE_TOKEN),
    linkedinConfigured: !!process.env.LINKEDIN_ACCESS_TOKEN && (!!process.env.LINKEDIN_ORGANIZATION_URN || !!process.env.LINKEDIN_PERSON_URN),
    hubspotConfigured: !!process.env.HUBSPOT_TOKEN,
    tokenSource: googleOk ? "firestore" : (readLocalTokensSafe() ? "local" : "none"),
  });
});

// Generic webhooks placeholder
app.post("/api/webhooks/:provider", async (req, res) => {
  // TODO: verify signatures per provider
  res.status(200).json({ ok: true });
});

// ---------------------------------------------------------------------
// AUTOMATION (XLSX)
// ---------------------------------------------------------------------
async function askAI(prompt) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
  });
  return resp.choices?.[0]?.message?.content || "";
}

app.post("/api/automation/run", async (req, res) => {
  try {
    const {
      niche = "", location = "", count = 10,
      tone = "Professional", persona = "Advisor", offer = "",
    } = req.body || {};

    if (!niche || !location) {
      return res.status(400).json({ error: "niche and location are required." });
    }

    const autoPrompt = `
Return ONLY valid minified JSON (no markdown) like:
type Row = {
  businessName: string;
  email: string;
  subject: string;
  personalization: string;
  emailBody: string;
  followUp1: string;
  followUp2: string;
  dmVariant: string;
  bookingScript: string;
};
Row[];

Task: Create ${count} realistic prospects for "${niche}" in "${location}" and for each, generate:
- subject (<=7 words),
- personalization (1 sentence),
- emailBody (<=120 words, ${tone} tone, from ${persona}, ${offer ? `offer: "${offer}"` : "no specific offer"}),
- followUp1 (<=50 words),
- followUp2 (<=45 words),
- dmVariant (<=240 chars),
- bookingScript (5–7 DM steps).
Reply ONLY with minified JSON array of Row.
    `.trim();

    let raw = await askAI(autoPrompt);
    let rowsJson;
    try {
      rowsJson = JSON.parse((raw || "").replace(/```json|```/g, "").trim());
      if (!Array.isArray(rowsJson)) throw new Error("not array");
    } catch {
      const retry = await askAI("STRICT: reply ONLY minified JSON Row[] for the previous request.");
      rowsJson = JSON.parse((retry || "").replace(/```json|```/g, "").trim());
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Campaign", { views: [{ state: "frozen", ySplit: 1 }] });
    const columns = [
      { header: "Business Name", key: "businessName", width: 28 },
      { header: "Email", key: "email", width: 30 },
      { header: "Subject Line", key: "subject", width: 36 },
      { header: "First-Line Personalization", key: "personalization", width: 48 },
      { header: "Outreach Message", key: "emailBody", width: 70 },
      { header: "Follow-Up 1", key: "followUp1", width: 50 },
      { header: "Follow-Up 2", key: "followUp2", width: 50 },
      { header: "DM Variant", key: "dmVariant", width: 46 },
      { header: "Booking Script", key: "bookingScript", width: 70 },
      { header: "Booking Link", key: "bookingLink", width: 36 },
    ];
    ws.columns = columns;
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: "middle" };
    ws.getRow(1).height = 22;
    ws.getRow(1).eachCell((c) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
      c.border = { bottom: { style: "thin", color: { argb: "FFE2E8F0" } } };
    });

    rowsJson.forEach((r) => {
      ws.addRow({
        businessName: (r.businessName || "").trim(),
        email: (r.email || "").trim(),
        subject: (r.subject || "").trim(),
        personalization: (r.personalization || "").trim(),
        emailBody: (r.emailBody || "").trim(),
        followUp1: (r.followUp1 || "").trim(),
        followUp2: (r.followUp2 || "").trim(),
        dmVariant: (r.dmVariant || "").trim(),
        bookingScript: (r.bookingScript || "").trim(),
        bookingLink: "https://calendly.com/your-booking-link",
      });
    });

    for (let i = 2; i <= ws.rowCount; i++) {
      if (i % 2 === 0) {
        ws.getRow(i).eachCell((c) => {
          c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAFAFA" } };
        });
      }
      ws.getRow(i).alignment = { wrapText: true, vertical: "top" };
    }

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Disposition", `attachment; filename="volryx_outreach_${Date.now()}.xlsx"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Length", Buffer.byteLength(buf));
    return res.status(200).send(Buffer.from(buf));
  } catch (err) {
    console.error("Automation error:", err);
    return res.status(500).json({ error: "Automation failed" });
  }
});

// ---------------------------------------------------------------------
// BLUEPRINT PDF (puppeteer-core)
// ---------------------------------------------------------------------
app.post("/api/blueprint/generate", async (req, res) => {
  const {
    businessName = "Client", niche = "", goal = "", icpNotes = "",
    tone = "Professional", persona = "Advisor",
  } = req.body || {};
  if (!niche || !goal || !businessName) {
    return res.status(400).json({ error: "businessName, niche and goal are required." });
  }

  const jsonPrompt = `
Return ONLY valid minified JSON (no markdown) matching:
type Blueprint = {
  summary: string[];
  foundations: { offerCreation: string[]; kpis: string[]; };
  execution: { outreachCampaigns: string[]; adAngles: string[]; socialCalendar: string[]; };
  scale: { plan: string[]; kpis: string[]; };
};
Generate a 90-day blueprint for "${businessName}" (niche: "${niche}") with goal "${goal}".
Notes: "${icpNotes || "n/a"}". Tone: ${tone}. Persona: ${persona}.
  `.trim();

  let blueprint;
  try {
    const raw = await askAI(jsonPrompt);
    const cleaned = (raw || "").replace(/```json|```/g, "").trim();
    blueprint = JSON.parse(cleaned);
    if (!blueprint || typeof blueprint !== "object") throw new Error("Invalid JSON object");
  } catch (e1) {
    try {
      const retry = await askAI("STRICT: Reply ONLY minified JSON for the previous request.");
      blueprint = JSON.parse((retry || "").replace(/```json|```/g, "").trim());
    } catch (e2) {
      console.error("Blueprint JSON parse failed:", e2);
      return res.status(500).json({ error: "Blueprint generation failed (invalid AI JSON)." });
    }
  }

  const css = `
    *{box-sizing:border-box} body{font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color:#0f172a; margin:0}
    .page{width:794px;padding:48px 56px;margin:0 auto;background:#fff}
    .brandbar{height:4px;background:#0f172a;border-radius:999px;margin:8px 0 24px}
    h1{font-size:28px;letter-spacing:0.02em;margin:0 0 6px}
    h2{font-size:18px;margin:32px 0 10px}
    h3{font-size:14px;margin:20px 0 8px}
    p,li{font-size:12.5px;line-height:1.6;color:#334155}
    .subtle{color:#64748b}
    .center{text-align:center}
    .divider{height:1px;background:#e2e8f0;margin:18px 0}
    ul{margin:6px 0 0 18px;padding:0}
    .title{font-size:22px;font-weight:600;margin-top:12px}
    .meta{font-size:12.5px;color:#475569}
    .footer{font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:8px;margin-top:24px}
    .pill{display:inline-block;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:999px;padding:4px 10px;margin:4px 8px 0 0;font-size:11.5px;color:#0f172a}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
    .card{border:1px solid #e2e8f0;border-radius:16px;padding:16px;background:#fff}
  `;
  const esc = (s = "") =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

  const html = `
<!doctype html><html><head><meta charset="utf-8"/><style>${css}</style></head>
<body>
  <section class="page">
    <div class="brandbar"></div>
    <h1 class="center">VOLRYX — V-Concierge 90-Day Blueprint</h1>
    <p class="center meta">${esc(businessName)} • ${esc(niche)} • Goal: ${esc(goal)}</p>
    <div class="divider"></div>
    <p class="center title">Your 90-Day Growth Plan</p>
    <p class="center subtle">Execution-first blueprint covering offers, outreach, ads, content, and KPIs.</p>
    <div class="footer center">© ${new Date().getFullYear()} VOLRYX — Elite AI Systems</div>
  </section>

  <section class="page">
    <div class="brandbar"></div>
    <h2>Executive Summary</h2>
    <ul>${(blueprint.summary || []).map((li) => `<li>${esc(li)}</li>`).join("")}</ul>
    <div class="footer center">© ${new Date().getFullYear()} VOLRYX — Elite AI Systems</div>
  </section>

  <section class="page">
    <div class="brandbar"></div>
    <h2>Weeks 1–2: Foundations</h2>
    <div class="grid">
      <div class="card"><h3>Offer Creation</h3><ul>${(blueprint.foundations?.offerCreation || []).map((li) => `<li>${esc(li)}</li>`).join("")}</ul></div>
      <div class="card"><h3>KPIs to Track</h3>${(blueprint.foundations?.kpis || []).map((k) => `<span class="pill">${esc(k)}</span>`).join("")}</div>
    </div>
    <div class="footer center">© ${new Date().getFullYear()} VOLRYX — Elite AI Systems</div>
  </section>

  <section class="page">
    <div class="brandbar"></div>
    <h2>Weeks 3–6: Execution</h2>
    <div class="grid">
      <div className="card"><h3>Outreach Campaigns</h3><ul>${(blueprint.execution?.outreachCampaigns || []).map((li) => `<li>${esc(li)}</li>`).join("")}</ul></div>
      <div className="card"><h3>Ad Angles</h3><ul>${(blueprint.execution?.adAngles || []).map((li) => `<li>${esc(li)}</li>`).join("")}</ul></div>
    </div>
    <h3 style="margin-top:16px">30-Day Social Calendar</h3>
    <ul>${(blueprint.execution?.socialCalendar || []).map((li) => `<li>${esc(li)}</li>`).join("")}</ul>
    <div className="footer center">© ${new Date().getFullYear()} VOLRYX — Elite AI Systems</div>
  </section>

  <section class="page">
    <div class="brandbar"></div>
    <h2>Weeks 7–12: Scale</h2>
    <div class="grid">
      <div class="card"><h3>Scale Plan</h3><ul>${(blueprint.scale?.plan || []).map((li) => `<li>${esc(li)}</li>`).join("")}</ul></div>
      <div className="card"><h3>KPIs to Track</h3>${(blueprint.scale?.kpis || []).map((k) => `<span class="pill">${esc(k)}</span>`).join("")}</div>
    </div>
    <div className="footer center">© ${new Date().getFullYear()} VOLRYX — Elite AI Systems</div>
  </section>
</body></html>
  `;

  res.setHeader("Content-Disposition", `attachment; filename="volryx_blueprint_${Date.now()}.pdf"`);
  res.setHeader("Content-Type", "application/pdf");

  try {
    const executablePath = resolveChromeExecutablePath();
    const browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.emulateMediaType("screen");
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 60000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", right: "10mm", bottom: "12mm", left: "10mm" },
    });
    await browser.close();

    res.setHeader("Content-Length", Buffer.byteLength(pdf));
    return res.status(200).send(pdf);
  } catch (e) {
    console.error("Puppeteer PDF error:", e);
    return res.status(500).json({ error: "Blueprint PDF rendering failed." });
  }
});
// ---------------------------------------------------------------------
// META WEBHOOK — Verification + IG/FB Message Handler
// ---------------------------------------------------------------------
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "volryx_secret_token";

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ META Webhook verified");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
});

// ✅ META WEBHOOK VERIFICATION (GET)
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = "volryx_secret_token"; // You can move this to process.env later

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ WEBHOOK VERIFIED");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }

  res.sendStatus(400);
});

// ✅ META WEBHOOK HANDLER (POST)
app.post("/webhook", (req, res) => {
  console.log("📩 Webhook received:", JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});


// ---------------------------------------------------------------------
const PORT = process.env.PORT || 5002;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
