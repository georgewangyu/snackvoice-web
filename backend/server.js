"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const https = require("https");

// ── Env ──────────────────────────────────────────────────────────────────────
const ENV_PATH = path.join(__dirname, ".env");
function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  fs.readFileSync(ENV_PATH, "utf8")
    .split("\n")
    .forEach((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      const sep = t.indexOf("=");
      if (sep <= 0) return;
      const k = t.slice(0, sep).trim();
      const v = t.slice(sep + 1).trim();
      if (!(k in process.env)) process.env[k] = v;
    });
}
loadEnv();

const PORT             = Number(process.env.PORT || 4200);
const STRIPE_SECRET    = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK   = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_ID  = process.env.STRIPE_PRICE_ID || "";   // one-time price id
const KEYGEN_TOKEN     = process.env.KEYGEN_ACCOUNT_TOKEN || "";
const KEYGEN_ACCOUNT   = process.env.KEYGEN_ACCOUNT_ID || "";
const KEYGEN_POLICY    = process.env.KEYGEN_POLICY_ID || "";
const SMTP_HOST        = process.env.SMTP_HOST || "";
const SMTP_PORT        = Number(process.env.SMTP_PORT || 587);
const SMTP_USER        = process.env.SMTP_USER || "";
const SMTP_PASS        = process.env.SMTP_PASS || "";
const FROM_EMAIL       = process.env.FROM_EMAIL || "noreply@snackvoice.app";
const APP_URL          = process.env.APP_URL || `http://localhost:${PORT}`;
const DOWNLOAD_URL     = process.env.DOWNLOAD_URL || ""; // e.g. GitHub release URL for .dmg
const REPO_ROOT        = path.resolve(__dirname, "..");

// ── Static file helpers ───────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

// ── Stripe helpers ────────────────────────────────────────────────────────────
function stripeRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? new URLSearchParams(body).toString() : "";
    const options = {
      hostname: "api.stripe.com",
      path,
      method,
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function createCheckoutSession(customerEmail) {
  const params = {
    "line_items[0][price]":    STRIPE_PRICE_ID,
    "line_items[0][quantity]": "1",
    mode:                      "payment",
    success_url:               `${APP_URL}/success.html`,
    cancel_url:                `${APP_URL}/`,
    allow_promotion_codes:     "true",
  };
  if (customerEmail) params.customer_email = customerEmail;
  const { body } = await stripeRequest("POST", "/v1/checkout/sessions", params);
  return body;
}

// ── Stripe webhook signature verification ─────────────────────────────────────
const { createHmac } = require("crypto");
function verifyStripeSignature(rawBody, sigHeader, secret) {
  const parts = sigHeader.split(",").reduce((acc, part) => {
    const [k, v] = part.split("=");
    acc[k] = v;
    return acc;
  }, {});
  const payload = `${parts.t}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const tolerance = 300; // 5 min
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > tolerance) return false;
  return expected === parts.v1;
}

// ── Keygen helpers ────────────────────────────────────────────────────────────
function keygenRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const options = {
      hostname: "api.keygen.sh",
      path:     `/v1/accounts/${KEYGEN_ACCOUNT}${endpoint}`,
      method,
      headers: {
        Authorization:  `Bearer ${KEYGEN_TOKEN}`,
        "Content-Type": "application/vnd.api+json",
        Accept:         "application/vnd.api+json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function createLicense(customerEmail, customerName) {
  const { body } = await keygenRequest("POST", "/licenses", {
    data: {
      type: "licenses",
      attributes: {
        name:     customerName || customerEmail,
        metadata: { email: customerEmail },
      },
      relationships: {
        policy: { data: { type: "policies", id: KEYGEN_POLICY } },
      },
    },
  });
  if (!body.data) throw new Error(`Keygen error: ${JSON.stringify(body)}`);
  return body.data.attributes.key;
}

// ── Email helpers (SMTP via nodemailer if available, else log) ─────────────────
async function sendDeliveryEmail(toEmail, licenseKey) {
  const subject = "Your SnackVoice license & download link";
  const text = `
Hi,

Thanks for purchasing SnackVoice! Here's everything you need:

DOWNLOAD LINK:
${DOWNLOAD_URL}

LICENSE KEY:
${licenseKey}

HOW TO GET STARTED:
1. Download the .dmg from the link above
2. Open it and drag SnackVoice to your Applications folder
3. Launch SnackVoice — it will ask for your license key on first run
4. Paste the key above and you're done

Hold your push-to-talk shortcut, speak, release. Your words appear wherever your cursor is.

Need help? Reply to this email or reach us at support@snackvoice.app

— The SnackVoice team
`.trim();

  try {
    // Try to use nodemailer if installed
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransporter({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    await transporter.sendMail({ from: FROM_EMAIL, to: toEmail, subject, text });
    console.log(`[email] Sent delivery email to ${toEmail}`);
  } catch (err) {
    // Fallback: log the details so you can send manually during dev
    console.warn("[email] nodemailer not available or send failed:", err.message);
    console.log("=== DELIVERY EMAIL (would be sent) ===");
    console.log("To:", toEmail);
    console.log("Subject:", subject);
    console.log(text);
    console.log("======================================");
  }
}

// ── Order log ─────────────────────────────────────────────────────────────────
const ORDERS_PATH = path.join(__dirname, "data", "orders.json");
function loadOrders() {
  if (!fs.existsSync(ORDERS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(ORDERS_PATH, "utf8")); }
  catch { return []; }
}
function saveOrder(order) {
  const orders = loadOrders();
  orders.push({ ...order, created_at: new Date().toISOString() });
  fs.mkdirSync(path.dirname(ORDERS_PATH), { recursive: true });
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(orders, null, 2));
}

// ── Request body helpers ──────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── Webhook handler ───────────────────────────────────────────────────────────
async function handleWebhook(req, res) {
  const rawBody = await readBody(req);
  const sig = req.headers["stripe-signature"];

  if (STRIPE_WEBHOOK && !verifyStripeSignature(rawBody.toString(), sig, STRIPE_WEBHOOK)) {
    console.warn("[webhook] Invalid signature");
    return json(res, 400, { error: "Invalid signature" });
  }

  let event;
  try { event = JSON.parse(rawBody.toString()); }
  catch { return json(res, 400, { error: "Invalid JSON" }); }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;
    const name  = session.customer_details?.name || "";
    const stripeSessionId = session.id;

    console.log(`[webhook] Payment completed for ${email} (session: ${stripeSessionId})`);

    try {
      const licenseKey = await createLicense(email, name);
      console.log(`[keygen] License created: ${licenseKey}`);

      await sendDeliveryEmail(email, licenseKey);

      saveOrder({ email, name, stripeSessionId, licenseKey });
      console.log(`[order] Saved order for ${email}`);
    } catch (err) {
      console.error("[webhook] Fulfillment error:", err);
      // Return 200 so Stripe doesn't retry — log and handle manually
    }
  }

  json(res, 200, { received: true });
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  try {
    // API routes
    if (req.method === "POST" && url.pathname === "/api/create-checkout") {
      if (!STRIPE_SECRET || !STRIPE_PRICE_ID) {
        console.warn("[checkout] STRIPE_SECRET_KEY or STRIPE_PRICE_ID not set — returning mock URL");
        return json(res, 200, { url: `${APP_URL}/success.html?mock=1` });
      }
      const session = await createCheckoutSession();
      return json(res, 200, { url: session.url });
    }

    if (req.method === "POST" && url.pathname === "/api/webhook") {
      return await handleWebhook(req, res);
    }

    // Static files
    let filePath = path.join(REPO_ROOT, url.pathname === "/" ? "index.html" : url.pathname);
    // Prevent directory traversal
    if (!filePath.startsWith(REPO_ROOT)) {
      res.writeHead(403); return res.end("Forbidden");
    }
    serveStatic(res, filePath);

  } catch (err) {
    console.error("[server] Unhandled error:", err);
    json(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`SnackVoice backend running at http://localhost:${PORT}`);
  console.log(`  Stripe configured: ${!!STRIPE_SECRET}`);
  console.log(`  Keygen configured: ${!!KEYGEN_TOKEN}`);
  console.log(`  Email configured:  ${!!SMTP_HOST}`);
});
