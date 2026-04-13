"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { createHash, createHmac } = require("crypto");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const DEFAULT_ENV_PATH = path.join(__dirname, ".env");
const ENV_PATH = process.env.ENV_FILE
  ? path.resolve(path.join(__dirname, ".."), process.env.ENV_FILE)
  : DEFAULT_ENV_PATH;

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

const PORT = Number(process.env.PORT || 4200);
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "";
const APP_URL = process.env.APP_URL || "";
const DOWNLOAD_URL_ARM64 = process.env.DOWNLOAD_URL_ARM64 || process.env.DOWNLOAD_URL || "";
const DOWNLOAD_URL_X64 = process.env.DOWNLOAD_URL_X64 || "";
const S3_BUCKET = process.env.S3_BUCKET || "";
const S3_KEY_ARM64 = process.env.S3_KEY_ARM64 || process.env.S3_KEY || "";
const S3_KEY_X64 = process.env.S3_KEY_X64 || "";
const S3_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "";
const S3_URL_TTL = Number(process.env.S3_SIGNED_URL_TTL_SECONDS || 86400);
const REPO_ROOT = path.resolve(__dirname, "..");
const HAS_S3_DOWNLOAD = !!(S3_BUCKET && S3_REGION);
const ORDERS_PATH = path.join(__dirname, "data", "orders.json");

let s3Client = null;
function getS3Client() {
  if (!HAS_S3_DOWNLOAD) return null;
  if (!s3Client) s3Client = new S3Client({ region: S3_REGION });
  return s3Client;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
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

function stripeRequest(method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? new URLSearchParams(body).toString() : "";
    const options = {
      hostname: "api.stripe.com",
      path: requestPath,
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
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function createCheckoutSession(customerEmail, baseUrl) {
  const params = {
    "line_items[0][price]": STRIPE_PRICE_ID,
    "line_items[0][quantity]": "1",
    mode: "payment",
    success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/`,
    allow_promotion_codes: "true",
    billing_address_collection: "required",
    "phone_number_collection[enabled]": "true",
    customer_creation: "always",
    "name_collection[business][enabled]": "false",
    "name_collection[individual][enabled]": "true",
  };
  if (customerEmail) params.customer_email = customerEmail;
  const { body } = await stripeRequest("POST", "/v1/checkout/sessions", params);
  return body;
}

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = sigHeader.split(",").reduce((acc, part) => {
    const [k, v] = part.split("=");
    acc[k] = v;
    return acc;
  }, {});
  const payload = `${parts.t}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const tolerance = 300;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > tolerance) return false;
  return expected === parts.v1;
}

async function createSignedDownloadUrl(key, filename) {
  if (!HAS_S3_DOWNLOAD || !key) return "";
  const client = getS3Client();
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ResponseContentType: "application/x-apple-diskimage",
    ResponseContentDisposition: `attachment; filename="${filename}"`,
  });
  return getSignedUrl(client, command, { expiresIn: S3_URL_TTL });
}

async function createDownloadLinks() {
  if (HAS_S3_DOWNLOAD) {
    return {
      appleSilicon: await createSignedDownloadUrl(S3_KEY_ARM64, "SnackVoice-Apple-Silicon.dmg"),
      intel: await createSignedDownloadUrl(S3_KEY_X64, "SnackVoice-Intel.dmg"),
    };
  }

  return {
    appleSilicon: DOWNLOAD_URL_ARM64,
    intel: DOWNLOAD_URL_X64,
  };
}

function loadOrders() {
  if (!fs.existsSync(ORDERS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(ORDERS_PATH, "utf8"));
  } catch {
    return [];
  }
}

function saveOrder(order) {
  const orders = loadOrders();
  const nextOrder = { ...order, created_at: new Date().toISOString() };
  const existingIndex = orders.findIndex((item) => item.stripeSessionId === order.stripeSessionId);
  if (existingIndex >= 0) {
    orders[existingIndex] = { ...orders[existingIndex], ...nextOrder };
  } else {
    orders.push(nextOrder);
  }
  fs.mkdirSync(path.dirname(ORDERS_PATH), { recursive: true });
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(orders, null, 2));
}

function getStoredOrderBySessionId(sessionId) {
  return loadOrders().find((order) => order.stripeSessionId === sessionId) || null;
}

async function fetchStripeOrderBySessionId(sessionId) {
  if (!STRIPE_SECRET) return null;
  const { status, body } = await stripeRequest("GET", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (status !== 200 || !body || body.object !== "checkout.session") return null;
  const paid = body.payment_status === "paid" || body.status === "complete";
  if (!paid) {
    return {
      email: body.customer_details?.email || body.customer_email || "",
      name: body.customer_details?.name || "",
      phone: body.customer_details?.phone || "",
      stripeSessionId: body.id,
      downloadUrls: null,
      fulfillmentStatus: "pending",
      fulfillmentError: "",
      created_at: body.created ? new Date(body.created * 1000).toISOString() : "",
    };
  }
  return {
    email: body.customer_details?.email || body.customer_email || "",
    name: body.customer_details?.name || "",
    phone: body.customer_details?.phone || "",
    stripeSessionId: body.id,
    downloadUrls: null,
    fulfillmentStatus: "fulfilled",
    fulfillmentError: "",
    created_at: body.created ? new Date(body.created * 1000).toISOString() : "",
  };
}

async function getOrderBySessionId(sessionId) {
  const storedOrder = getStoredOrderBySessionId(sessionId);
  if (storedOrder) return storedOrder;
  return fetchStripeOrderBySessionId(sessionId);
}

async function publicOrder(order) {
  if (!order) return null;
  let downloadUrls = order.downloadUrls || null;
  if (order.fulfillmentStatus === "fulfilled") {
    downloadUrls = await createDownloadLinks();
  }
  return {
    email: order.email,
    name: order.name,
    phone: order.phone || "",
    stripeSessionId: order.stripeSessionId,
    downloadUrls,
    fulfillmentStatus: order.fulfillmentStatus || "pending",
    fulfillmentError: order.fulfillmentError || "",
    createdAt: order.created_at || "",
  };
}

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

function getBaseUrl(req) {
  if (APP_URL) return APP_URL;
  const protoHeader = req?.headers?.["x-forwarded-proto"];
  const protocol = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader || "http";
  const hostHeader = req?.headers?.["x-forwarded-host"] || req?.headers?.host;
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (host) return `${protocol}://${host}`;
  return `http://localhost:${PORT}`;
}

async function handleCreateCheckout(req, res) {
  const baseUrl = getBaseUrl(req);
  if (!STRIPE_SECRET || !STRIPE_PRICE_ID) {
    console.warn("[checkout] STRIPE_SECRET_KEY or STRIPE_PRICE_ID not set — returning mock URL");
    return json(res, 200, { url: `${baseUrl}/success.html?mock=1` });
  }
  const session = await createCheckoutSession(undefined, baseUrl);
  return json(res, 200, { url: session.url });
}

async function handleWebhook(req, res) {
  const rawBody = await readBody(req);
  const sig = req.headers["stripe-signature"];

  if (STRIPE_WEBHOOK && !verifyStripeSignature(rawBody.toString(), sig, STRIPE_WEBHOOK)) {
    console.warn("[webhook] Invalid signature");
    return json(res, 400, { error: "Invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch {
    return json(res, 400, { error: "Invalid JSON" });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;
    const name = session.customer_details?.name || "";
    const phone = session.customer_details?.phone || "";
    const stripeSessionId = session.id;

    console.log(`[webhook] Payment completed for ${email} (session: ${stripeSessionId})`);

    try {
      const downloadUrls = await createDownloadLinks();

      saveOrder({
        email,
        name,
        phone,
        stripeSessionId,
        downloadUrls,
        fulfillmentStatus: "fulfilled",
      });
      console.log(`[order] Saved order for ${email}`);
    } catch (err) {
      console.error("[webhook] Fulfillment error:", err);
      saveOrder({
        email,
        name,
        phone,
        stripeSessionId,
        fulfillmentStatus: "failed",
        fulfillmentError: err.message,
      });
    }
  }

  return json(res, 200, { received: true });
}

async function handleOrderStatus(req, res) {
  const url = new URL(req.url, getBaseUrl(req));
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) return json(res, 400, { error: "Missing session_id" });
  const order = await getOrderBySessionId(sessionId);
  if (!order) return json(res, 404, { error: "Order not found" });
  return json(res, 200, { order: await publicOrder(order) });
}

async function handleStaticRequest(req, res) {
  const url = new URL(req.url, getBaseUrl(req));
  let filePath = path.join(REPO_ROOT, url.pathname === "/" ? "index.html" : url.pathname);
  if (!filePath.startsWith(REPO_ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  return serveStatic(res, filePath);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, getBaseUrl(req));
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (req.method === "POST" && url.pathname === "/api/create-checkout") {
      return await handleCreateCheckout(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/webhook") {
      return await handleWebhook(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/order-status") {
      return await handleOrderStatus(req, res);
    }
    return await handleStaticRequest(req, res);
  } catch (err) {
    console.error("[server] Unhandled error:", err);
    return json(res, 500, { error: "Internal server error" });
  }
}

module.exports = {
  APP_URL,
  PORT,
  STRIPE_SECRET,
  getBaseUrl,
  handleRequest,
  handleCreateCheckout,
  handleWebhook,
  handleOrderStatus,
};
