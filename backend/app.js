"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} = require("crypto");
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
const { createStorage } = require("./storage");

const PORT = Number(process.env.PORT || 4200);
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "";
const STRIPE_PRICE_ID_MONTHLY =
  process.env.STRIPE_PRICE_ID_MONTHLY || STRIPE_PRICE_ID;
const STRIPE_PRICE_ID_ANNUAL = process.env.STRIPE_PRICE_ID_ANNUAL || "";
const STRIPE_DEFAULT_PLAN = (
  process.env.STRIPE_DEFAULT_PLAN || "monthly"
).toLowerCase();
const APP_URL = process.env.APP_URL || "";
const S3_BUCKET = process.env.S3_BUCKET || "";
const S3_KEY_ARM64 =
  process.env.S3_KEY_ARM64 ||
  process.env.S3_KEY ||
  "SnackVoice-Apple-Silicon.dmg";
const S3_KEY_X64 = process.env.S3_KEY_X64 || "SnackVoice-Intel.dmg";
const S3_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "";
const S3_URL_TTL = Number(process.env.S3_SIGNED_URL_TTL_SECONDS || 86400);
const FREE_WEEKLY_WORD_QUOTA = Number(process.env.FREE_WEEKLY_WORD_QUOTA || 1000);
const WEEKLY_RESET_DAY_UTC = Number(process.env.WEEKLY_RESET_DAY_UTC || 1); // 0=Sun, 1=Mon
const OUTAGE_GRACE_HOURS = Number(process.env.OUTAGE_GRACE_HOURS || 12);
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || "").trim();
const SUPABASE_AUTH_ENABLED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
const SUPABASE_SIGNUP_AUTO_SIGNIN =
  process.env.SUPABASE_SIGNUP_AUTO_SIGNIN === "true";
const ALLOW_DEV_EMAIL_AUTH =
  process.env.ALLOW_DEV_EMAIL_AUTH === "true" ||
  process.env.NODE_ENV !== "production";
const MIN_PASSWORD_LENGTH = Number(process.env.MIN_PASSWORD_LENGTH || 8);
const AUTH_SECRET =
  process.env.SNACKVOICE_AUTH_SECRET ||
  process.env.SNACKVOICE_ENTITLEMENT_SECRET ||
  STRIPE_WEBHOOK ||
  STRIPE_SECRET ||
  "snackvoice-dev-auth-secret";

const REPO_ROOT = path.resolve(__dirname, "..");
const HAS_S3_DOWNLOAD = !!(S3_BUCKET && S3_REGION && S3_KEY_ARM64);
const ORDERS_PATH = process.env.ORDERS_DATA_PATH
  ? path.resolve(REPO_ROOT, process.env.ORDERS_DATA_PATH)
  : path.join(__dirname, "data", "orders.json");
const BILLING_PATH = process.env.BILLING_DATA_PATH
  ? path.resolve(REPO_ROOT, process.env.BILLING_DATA_PATH)
  : path.join(__dirname, "data", "billing.json");
const MAX_STORED_WEBHOOK_EVENTS = 5000;
const MAX_STORED_SESSIONS = 10000;
const MAX_STORED_DESKTOP_AUTH_REQUESTS = 10000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const storage = createStorage({
  billingPath: BILLING_PATH,
  ordersPath: ORDERS_PATH,
});

let s3Client = null;

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function normalizeEmail(value) {
  if (!value || typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function randomId(prefix) {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function buildUserId(email) {
  return `usr_${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
}

function toIsoFromEpochSeconds(value) {
  if (!value || Number.isNaN(Number(value))) return "";
  return new Date(Number(value) * 1000).toISOString();
}

function toIsoFromMs(value) {
  if (!value || Number.isNaN(Number(value))) return "";
  return new Date(Number(value)).toISOString();
}

function parseIsoToMs(value) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizePositiveInt(value, fallbackValue) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallbackValue;
  return Math.floor(n);
}

function clampIntRange(value, min, max, fallbackValue) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallbackValue;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function clampWarningDay(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 6) return 6;
  return Math.floor(n);
}

const SAFE_WEEKLY_RESET_DAY_UTC = clampWarningDay(WEEKLY_RESET_DAY_UTC);
const SAFE_FREE_WEEKLY_WORD_QUOTA = normalizePositiveInt(FREE_WEEKLY_WORD_QUOTA, 1000);
const SAFE_OUTAGE_GRACE_HOURS = normalizePositiveInt(OUTAGE_GRACE_HOURS, 12);
const SAFE_SESSION_TTL_DAYS = normalizePositiveInt(SESSION_TTL_DAYS, 30);
const DESKTOP_AUTH_REQUEST_TTL_MS = clampIntRange(
  process.env.DESKTOP_AUTH_REQUEST_TTL_MS || 5 * 60 * 1000,
  60 * 1000,
  5 * 60 * 1000,
  5 * 60 * 1000
);
const DESKTOP_AUTH_POLL_INTERVAL_MS = clampIntRange(
  process.env.DESKTOP_AUTH_POLL_INTERVAL_MS || 2000,
  500,
  5000,
  2000
);
const DESKTOP_AUTH_OPEN_APP_URL = (
  process.env.DESKTOP_AUTH_OPEN_APP_URL || "snackvoice://"
).trim();

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

function ensureBillingShape(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  if (!Array.isArray(data.users)) data.users = [];
  if (!Array.isArray(data.subscriptions)) data.subscriptions = [];
  if (!Array.isArray(data.checkoutSessions)) data.checkoutSessions = [];
  if (!Array.isArray(data.webhookEvents)) data.webhookEvents = [];
  if (!Array.isArray(data.sessions)) data.sessions = [];
  if (!Array.isArray(data.desktopAuthRequests)) data.desktopAuthRequests = [];
  return data;
}

async function loadBilling() {
  return ensureBillingShape(await storage.loadBilling());
}

async function saveBilling(billing) {
  await storage.saveBilling(ensureBillingShape(billing));
}

async function loadOrders() {
  return await storage.loadOrders();
}

async function saveOrder(order) {
  const nextOrder = { ...order, created_at: order.created_at || nowIso() };
  await storage.saveOrder(nextOrder);
}

async function getStoredOrderBySessionId(sessionId) {
  return await storage.getStoredOrderBySessionId(sessionId);
}

function findUserByEmail(billing, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return billing.users.find((user) => user.email === normalized) || null;
}

function findUserByCustomerId(billing, stripeCustomerId) {
  if (!stripeCustomerId) return null;
  return (
    billing.users.find((user) => user.stripeCustomerId === stripeCustomerId) ||
    null
  );
}

function findUserByUserId(billing, userId) {
  if (!userId) return null;
  return billing.users.find((user) => user.userId === userId) || null;
}

function findUserByAuthProviderId(billing, authProviderUserId) {
  if (!authProviderUserId) return null;
  return (
    billing.users.find(
      (user) => user.authProviderUserId === authProviderUserId
    ) || null
  );
}

function ensureUserQuotaWindow(user, currentMs) {
  let dirty = false;
  const limit = normalizePositiveInt(user.weeklyWordQuota, SAFE_FREE_WEEKLY_WORD_QUOTA);
  if (user.weeklyWordQuota !== limit) {
    user.weeklyWordQuota = limit;
    dirty = true;
  }

  if (!Number.isFinite(Number(user.weeklyWordsUsed)) || user.weeklyWordsUsed < 0) {
    user.weeklyWordsUsed = 0;
    dirty = true;
  }

  const window = getFixedWeeklyWindow(currentMs);
  const startMs = parseIsoToMs(user.quotaWindowStart);
  const endMs = parseIsoToMs(user.quotaWindowEnd);
  if (
    !startMs ||
    !endMs ||
    currentMs < startMs ||
    currentMs >= endMs ||
    startMs !== window.startMs ||
    endMs !== window.endMs
  ) {
    user.weeklyWordsUsed = 0;
    user.quotaWindowStart = toIsoFromMs(window.startMs);
    user.quotaWindowEnd = toIsoFromMs(window.endMs);
    dirty = true;
  }

  return dirty;
}

function upsertUser(
  billing,
  { email, stripeCustomerId, userId, authProvider, authProviderUserId }
) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail && !stripeCustomerId && !userId && !authProviderUserId) {
    return null;
  }

  const now = nowIso();
  let user =
    findUserByUserId(billing, userId) ||
    findUserByAuthProviderId(billing, authProviderUserId) ||
    findUserByEmail(billing, normalizedEmail) ||
    findUserByCustomerId(billing, stripeCustomerId);

  if (!user) {
    user = {
      userId: userId
        ? String(userId)
        : normalizedEmail
        ? buildUserId(normalizedEmail)
        : `usr_${createHash("sha256")
            .update(`${stripeCustomerId || now}`)
            .digest("hex")
            .slice(0, 16)}`,
      authProvider: authProvider || "",
      authProviderUserId: authProviderUserId || "",
      email: normalizedEmail,
      stripeCustomerId: stripeCustomerId || "",
      weeklyWordQuota: SAFE_FREE_WEEKLY_WORD_QUOTA,
      weeklyWordsUsed: 0,
      quotaWindowStart: "",
      quotaWindowEnd: "",
      passwordHash: "",
      passwordSalt: "",
      passwordSetAt: "",
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
    ensureUserQuotaWindow(user, nowMs());
    billing.users.push(user);
    return user;
  }

  if (normalizedEmail && !user.email) user.email = normalizedEmail;
  if (stripeCustomerId && !user.stripeCustomerId) {
    user.stripeCustomerId = stripeCustomerId;
  }
  if (userId && !user.userId) user.userId = String(userId);
  if (authProviderUserId && user.authProviderUserId !== authProviderUserId) {
    user.authProviderUserId = authProviderUserId;
  }
  if (authProvider && user.authProvider !== authProvider) {
    user.authProvider = authProvider;
  }
  if (typeof user.authProvider !== "string") user.authProvider = "";
  if (typeof user.authProviderUserId !== "string") user.authProviderUserId = "";
  if (typeof user.passwordHash !== "string") user.passwordHash = "";
  if (typeof user.passwordSalt !== "string") user.passwordSalt = "";
  if (typeof user.passwordSetAt !== "string") user.passwordSetAt = "";
  user.updatedAt = now;
  user.lastSeenAt = now;
  ensureUserQuotaWindow(user, nowMs());
  return user;
}

function upsertSubscription(
  billing,
  {
    stripeSubscriptionId,
    stripeCustomerId,
    userId,
    email,
    status,
    currentPeriodEnd,
    cancelAtPeriodEnd,
    canceledAt,
    planId,
    priceId,
    sourceEventId,
    sourceEventType,
  }
) {
  if (!stripeSubscriptionId) return null;
  const now = nowIso();
  let subscription =
    billing.subscriptions.find(
      (item) => item.stripeSubscriptionId === stripeSubscriptionId
    ) || null;

  if (!subscription) {
    subscription = {
      stripeSubscriptionId,
      stripeCustomerId: stripeCustomerId || "",
      userId: userId || "",
      email: normalizeEmail(email),
      status: status || "unknown",
      currentPeriodEnd: currentPeriodEnd || "",
      cancelAtPeriodEnd: !!cancelAtPeriodEnd,
      canceledAt: canceledAt || "",
      planId: planId || "",
      priceId: priceId || "",
      sourceEventId: sourceEventId || "",
      sourceEventType: sourceEventType || "",
      createdAt: now,
      updatedAt: now,
    };
    billing.subscriptions.push(subscription);
    return subscription;
  }

  if (stripeCustomerId) subscription.stripeCustomerId = stripeCustomerId;
  if (userId) subscription.userId = userId;
  if (email) subscription.email = normalizeEmail(email);
  if (status) subscription.status = status;
  if (currentPeriodEnd) subscription.currentPeriodEnd = currentPeriodEnd;
  if (typeof cancelAtPeriodEnd === "boolean") {
    subscription.cancelAtPeriodEnd = cancelAtPeriodEnd;
  }
  if (canceledAt) subscription.canceledAt = canceledAt;
  if (planId) subscription.planId = planId;
  if (priceId) subscription.priceId = priceId;
  if (sourceEventId) subscription.sourceEventId = sourceEventId;
  if (sourceEventType) subscription.sourceEventType = sourceEventType;
  subscription.updatedAt = now;
  return subscription;
}

function upsertCheckoutSession(billing, payload) {
  const now = nowIso();
  let row =
    billing.checkoutSessions.find(
      (item) => item.stripeSessionId === payload.stripeSessionId
    ) || null;
  if (!row) {
    row = { ...payload, createdAt: now, updatedAt: now };
    billing.checkoutSessions.push(row);
    return row;
  }
  Object.assign(row, payload, { updatedAt: now });
  return row;
}

function isWebhookEventProcessed(billing, eventId) {
  if (!eventId) return false;
  return billing.webhookEvents.some((item) => item.eventId === eventId);
}

function markWebhookEventProcessed(billing, { eventId, eventType }) {
  if (!eventId) return;
  billing.webhookEvents.push({
    eventId,
    eventType: eventType || "",
    processedAt: nowIso(),
  });
  if (billing.webhookEvents.length > MAX_STORED_WEBHOOK_EVENTS) {
    billing.webhookEvents = billing.webhookEvents.slice(
      billing.webhookEvents.length - MAX_STORED_WEBHOOK_EVENTS
    );
  }
}

function cleanupExpiredAuthRecords(billing, currentMs) {
  const nowTimestamp = currentMs || nowMs();
  const now = toIsoFromMs(nowTimestamp);

  billing.sessions = billing.sessions.filter((row) => {
    const expMs = parseIsoToMs(row.expiresAt);
    if (row.revokedAt) {
      return nowTimestamp - parseIsoToMs(row.revokedAt) < SEVEN_DAYS_MS;
    }
    return expMs > nowTimestamp;
  });
  if (billing.sessions.length > MAX_STORED_SESSIONS) {
    billing.sessions = billing.sessions.slice(
      billing.sessions.length - MAX_STORED_SESSIONS
    );
  }

  billing.desktopAuthRequests = billing.desktopAuthRequests.filter((row) => {
    const expiresAtMs = parseIsoToMs(row.expiresAt);
    const consumedAtMs = parseIsoToMs(row.consumedAt);
    const completedAtMs = parseIsoToMs(row.completedAt);

    if (consumedAtMs) {
      return nowTimestamp - consumedAtMs <= SEVEN_DAYS_MS;
    }
    if (expiresAtMs && expiresAtMs <= nowTimestamp) {
      return nowTimestamp - expiresAtMs <= SEVEN_DAYS_MS;
    }
    if (completedAtMs) {
      return nowTimestamp - completedAtMs <= SEVEN_DAYS_MS;
    }
    return true;
  });
  if (billing.desktopAuthRequests.length > MAX_STORED_DESKTOP_AUTH_REQUESTS) {
    billing.desktopAuthRequests = billing.desktopAuthRequests.slice(
      billing.desktopAuthRequests.length - MAX_STORED_DESKTOP_AUTH_REQUESTS
    );
  }

  billing.users.forEach((user) => {
    ensureUserQuotaWindow(user, nowTimestamp);
    user.updatedAt = user.updatedAt || now;
  });
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqualString(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString("hex");
}

function setUserPassword(user, password) {
  const salt = randomBytes(16).toString("hex");
  user.passwordSalt = salt;
  user.passwordHash = hashPassword(password, salt);
  user.passwordSetAt = nowIso();
  user.updatedAt = nowIso();
}

function verifyUserPassword(user, password) {
  if (!user?.passwordHash || !user?.passwordSalt || !password) return false;
  return safeEqualString(hashPassword(password, user.passwordSalt), user.passwordHash);
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    return "Password is required";
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return "";
}

function createSignedToken(payload, secret) {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function verifySignedToken(token, secret) {
  if (!token || typeof token !== "string") return { valid: false };
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false };
  const [encodedPayload, providedSignature] = parts;
  const expectedSignature = createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
  if (!safeEqualString(expectedSignature, providedSignature)) {
    return { valid: false };
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload || typeof payload !== "object") return { valid: false };
    const expMs = Number(payload.exp || 0);
    if (!expMs || expMs <= nowMs()) return { valid: false, expired: true };
    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}

async function supabaseAuthRequest(method, pathWithQuery, body, accessToken) {
  if (!SUPABASE_AUTH_ENABLED) {
    return { ok: false, status: 503, body: { error: "Supabase auth is not configured" } };
  }
  const baseUrl = SUPABASE_URL.endsWith("/") ? SUPABASE_URL : `${SUPABASE_URL}/`;
  const url = new URL(pathWithQuery.replace(/^\//, ""), baseUrl);
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    "Content-Type": "application/json",
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = {};
  try {
    payload = await res.json();
  } catch {
    payload = {};
  }
  return { ok: res.ok, status: res.status, body: payload };
}

async function supabaseSignInWithPassword(email, password) {
  return supabaseAuthRequest(
    "POST",
    "/auth/v1/token?grant_type=password",
    { email, password },
    ""
  );
}

async function supabaseSignUpWithPassword(email, password) {
  return supabaseAuthRequest(
    "POST",
    "/auth/v1/signup",
    { email, password },
    ""
  );
}

async function supabaseGetUser(accessToken) {
  return supabaseAuthRequest("GET", "/auth/v1/user", null, accessToken);
}

async function supabaseSignOut(accessToken) {
  return supabaseAuthRequest("POST", "/auth/v1/logout", null, accessToken);
}

function resolvePriceId(plan) {
  const normalizedPlan = (plan || STRIPE_DEFAULT_PLAN || "monthly")
    .toString()
    .toLowerCase();
  if (normalizedPlan === "annual" || normalizedPlan === "yearly") {
    return { plan: "annual", priceId: STRIPE_PRICE_ID_ANNUAL };
  }
  return { plan: "monthly", priceId: STRIPE_PRICE_ID_MONTHLY };
}

function planFromPriceId(priceId) {
  if (!priceId) return "unknown";
  if (STRIPE_PRICE_ID_ANNUAL && priceId === STRIPE_PRICE_ID_ANNUAL) {
    return "annual";
  }
  if (STRIPE_PRICE_ID_MONTHLY && priceId === STRIPE_PRICE_ID_MONTHLY) {
    return "monthly";
  }
  return "unknown";
}

function getFixedWeeklyWindow(currentMs) {
  const currentDate = new Date(currentMs);
  const currentDay = currentDate.getUTCDay();
  const daysSinceReset =
    (currentDay - SAFE_WEEKLY_RESET_DAY_UTC + 7) % 7;
  const startMs = Date.UTC(
    currentDate.getUTCFullYear(),
    currentDate.getUTCMonth(),
    currentDate.getUTCDate() - daysSinceReset,
    0,
    0,
    0,
    0
  );
  return { startMs, endMs: startMs + SEVEN_DAYS_MS };
}

function computeWarningLevel(limit, remaining) {
  if (remaining <= 0) return "exhausted";
  if (!limit || limit <= 0) return "none";
  const ratio = remaining / limit;
  if (ratio <= 0.05) return "critical_5";
  if (ratio <= 0.1) return "low_10";
  if (ratio <= 0.2) return "warn_20";
  return "none";
}

function subscriptionStatusRank(status) {
  switch ((status || "").toLowerCase()) {
    case "active":
    case "trialing":
      return 0;
    case "past_due":
      return 1;
    case "unpaid":
    case "incomplete":
    case "incomplete_expired":
      return 2;
    case "canceled":
    case "cancelled":
      return 3;
    default:
      return 4;
  }
}

function getUserSubscriptions(billing, user) {
  const email = normalizeEmail(user.email);
  return billing.subscriptions.filter((sub) => {
    if (sub.userId && sub.userId === user.userId) return true;
    if (email && normalizeEmail(sub.email) === email) return true;
    if (user.stripeCustomerId && sub.stripeCustomerId === user.stripeCustomerId) {
      return true;
    }
    return false;
  });
}

function pickCurrentSubscription(billing, user) {
  const subs = getUserSubscriptions(billing, user);
  if (!subs.length) return null;
  return subs
    .slice()
    .sort((a, b) => {
      const rankDiff =
        subscriptionStatusRank(a.status) - subscriptionStatusRank(b.status);
      if (rankDiff !== 0) return rankDiff;
      const endDiff =
        parseIsoToMs(b.currentPeriodEnd) - parseIsoToMs(a.currentPeriodEnd);
      if (endDiff !== 0) return endDiff;
      return parseIsoToMs(b.updatedAt) - parseIsoToMs(a.updatedAt);
    })[0];
}

function evaluateAccessState(subscription, currentMs) {
  if (!subscription) {
    return {
      accountStatus: "free",
      isUnlimited: false,
      reason: "no_subscription",
    };
  }

  const status = (subscription.status || "").toLowerCase();
  const periodEndMs = parseIsoToMs(subscription.currentPeriodEnd);
  const isBeforePeriodEnd = periodEndMs > currentMs;

  if (status === "active" || status === "trialing") {
    return {
      accountStatus: "paid_active",
      isUnlimited: true,
      reason: status,
    };
  }

  if ((status === "canceled" || status === "cancelled") && isBeforePeriodEnd) {
    return {
      accountStatus: "paid_active",
      isUnlimited: true,
      reason: "canceled_pending_period_end",
    };
  }

  if (status === "past_due") {
    return {
      accountStatus: "past_due",
      isUnlimited: false,
      reason: "past_due",
    };
  }

  if (
    status === "unpaid" ||
    status === "incomplete" ||
    status === "incomplete_expired"
  ) {
    return {
      accountStatus: "past_due",
      isUnlimited: false,
      reason: status,
    };
  }

  if (status === "canceled" || status === "cancelled") {
    return {
      accountStatus: "canceled",
      isUnlimited: false,
      reason: "period_ended",
    };
  }

  return {
    accountStatus: "free",
    isUnlimited: false,
    reason: status || "unknown",
  };
}

function buildEntitlementPayload({ billing, user, currentMs }) {
  const dirty = ensureUserQuotaWindow(user, currentMs);
  const subscription = pickCurrentSubscription(billing, user);
  const accessState = evaluateAccessState(subscription, currentMs);

  const weeklyLimit = normalizePositiveInt(
    user.weeklyWordQuota,
    SAFE_FREE_WEEKLY_WORD_QUOTA
  );
  const weeklyUsed = Math.max(0, Number(user.weeklyWordsUsed) || 0);
  const weeklyRemaining = Math.max(weeklyLimit - weeklyUsed, 0);
  const warningLevel = accessState.isUnlimited
    ? "none"
    : computeWarningLevel(weeklyLimit, weeklyRemaining);

  const plan = subscription ? planFromPriceId(subscription.priceId) : "free";
  const response = {
    user: {
      userId: user.userId,
      email: user.email,
    },
    accountStatus: accessState.accountStatus,
    reason: accessState.reason,
    isUnlimited: accessState.isUnlimited,
    subscription: subscription
      ? {
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          status: subscription.status,
          currentPeriodEnd: subscription.currentPeriodEnd || "",
          cancelAtPeriodEnd: !!subscription.cancelAtPeriodEnd,
          canceledAt: subscription.canceledAt || "",
          planId: subscription.planId || "",
          priceId: subscription.priceId || "",
          plan,
        }
      : null,
    weeklyQuota: {
      limit: weeklyLimit,
      used: accessState.isUnlimited ? null : weeklyUsed,
      remaining: accessState.isUnlimited ? null : weeklyRemaining,
      warningLevel,
      windowStart: user.quotaWindowStart || "",
      windowEnd: user.quotaWindowEnd || "",
      resetAt: user.quotaWindowEnd || "",
      resetDayUtc: SAFE_WEEKLY_RESET_DAY_UTC,
    },
    outageGraceHours: SAFE_OUTAGE_GRACE_HOURS,
    entitlementCheckedAt: toIsoFromMs(currentMs),
    cacheValidUntil: accessState.isUnlimited
      ? toIsoFromMs(currentMs + SAFE_OUTAGE_GRACE_HOURS * 60 * 60 * 1000)
      : toIsoFromMs(currentMs),
  };

  response.signature = createHmac("sha256", AUTH_SECRET)
    .update(JSON.stringify(response))
    .digest("hex");

  return { entitlement: response, dirty };
}

function findActiveSession(billing, token) {
  const tokenHash = hashToken(token);
  const current = nowMs();
  const currentIso = toIsoFromMs(current);
  const session =
    billing.sessions.find((row) => row.tokenHash === tokenHash) || null;
  if (!session) return null;
  if (session.revokedAt) return null;
  if (parseIsoToMs(session.expiresAt) <= current) return null;
  session.lastSeenAt = currentIso;
  return session;
}

function createSessionForUser(billing, user) {
  const sessionExpiresMs = nowMs() + SAFE_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  const sessionPayload = {
    type: "session",
    userId: user.userId,
    email: user.email,
    nonce: randomBytes(8).toString("hex"),
    exp: sessionExpiresMs,
  };
  const sessionToken = createSignedToken(sessionPayload, AUTH_SECRET);
  billing.sessions.push({
    sessionId: randomId("sess"),
    userId: user.userId,
    email: user.email,
    tokenHash: hashToken(sessionToken),
    expiresAt: toIsoFromMs(sessionExpiresMs),
    revokedAt: "",
    createdAt: nowIso(),
    lastSeenAt: nowIso(),
  });
  return {
    token: sessionToken,
    expiresAt: toIsoFromMs(sessionExpiresMs),
    user: { userId: user.userId, email: user.email },
  };
}

function findDesktopAuthRequest(billing, requestId) {
  if (!requestId) return null;
  return (
    billing.desktopAuthRequests.find((row) => row.requestId === requestId) || null
  );
}

function isDesktopAuthExpired(request, currentMs) {
  if (!request) return true;
  return parseIsoToMs(request.expiresAt) <= currentMs;
}

function isDesktopAuthConsumed(request) {
  return !!parseIsoToMs(request?.consumedAt);
}

function hasDesktopAuthPollKey(request, pollKey) {
  if (!request?.pollKeyHash || !pollKey) return false;
  return safeEqualString(request.pollKeyHash, hashToken(pollKey));
}

function createDesktopAuthRequest(billing, baseUrl) {
  const requestId = randomId("dreq");
  const pollKey = randomBytes(18).toString("base64url");
  const createdAt = nowIso();
  const expiresAt = toIsoFromMs(nowMs() + DESKTOP_AUTH_REQUEST_TTL_MS);
  const authUrl = new URL("/desktop-auth", baseUrl);
  authUrl.searchParams.set("requestId", requestId);
  if (DESKTOP_AUTH_OPEN_APP_URL) {
    authUrl.searchParams.set("openAppUrl", DESKTOP_AUTH_OPEN_APP_URL);
  }
  billing.desktopAuthRequests.push({
    requestId,
    pollKeyHash: hashToken(pollKey),
    completionNonce: "",
    status: "pending",
    userId: "",
    email: "",
    createdAt,
    completedAt: "",
    consumedAt: "",
    updatedAt: createdAt,
    expiresAt,
  });
  return {
    requestId,
    pollKey,
    expiresAt,
    browserUrl: authUrl.toString(),
    pollIntervalMs: DESKTOP_AUTH_POLL_INTERVAL_MS,
  };
}

function createDesktopCompletionCode(request) {
  if (!request?.requestId || !request?.completionNonce) return "";
  const expiresAtMs = parseIsoToMs(request.expiresAt);
  if (!expiresAtMs || expiresAtMs <= nowMs()) return "";
  return createSignedToken(
    {
      type: "desktop_completion",
      requestId: request.requestId,
      nonce: request.completionNonce,
      exp: expiresAtMs,
    },
    AUTH_SECRET
  );
}

function buildDesktopAuthStatusPayload({
  request,
  currentMs,
  includeCompletionCode,
}) {
  if (!request) {
    return { status: "invalid" };
  }
  if (isDesktopAuthConsumed(request)) {
    return { status: "consumed", expiresAt: request.expiresAt || "" };
  }
  if (isDesktopAuthExpired(request, currentMs)) {
    return { status: "expired", expiresAt: request.expiresAt || "" };
  }
  if (request.status === "ready" && request.completionNonce) {
    const response = {
      status: "ready",
      expiresAt: request.expiresAt || "",
      retryAfterMs: DESKTOP_AUTH_POLL_INTERVAL_MS,
    };
    if (includeCompletionCode) {
      const completionCode = createDesktopCompletionCode(request);
      if (!completionCode) {
        return { status: "expired", expiresAt: request.expiresAt || "" };
      }
      response.completionCode = completionCode;
    }
    return response;
  }
  return {
    status: "pending",
    expiresAt: request.expiresAt || "",
    retryAfterMs: DESKTOP_AUTH_POLL_INTERVAL_MS,
  };
}

function parseBearerToken(req) {
  const value = req.headers.authorization || req.headers.Authorization || "";
  if (!value || typeof value !== "string") return "";
  if (!value.toLowerCase().startsWith("bearer ")) return "";
  return value.slice(7).trim();
}

async function getAuthContext(req, billing) {
  const token = parseBearerToken(req);
  if (token) {
    const verified = verifySignedToken(token, AUTH_SECRET);
    if (verified.valid && verified.payload && verified.payload.type === "session") {
      const session = findActiveSession(billing, token);
      if (!session) {
        return { ok: false, status: 401, error: "Session expired or revoked" };
      }

      const user =
        findUserByUserId(billing, verified.payload.userId) ||
        findUserByEmail(billing, verified.payload.email);
      if (!user) return { ok: false, status: 401, error: "User not found" };
      user.lastSeenAt = nowIso();
      user.updatedAt = nowIso();
      return { ok: true, user, authMode: "session", needsSave: true };
    }

    if (SUPABASE_AUTH_ENABLED) {
      const response = await supabaseGetUser(token);
      if (!response.ok || !response.body?.id) {
        return { ok: false, status: 401, error: "Invalid Supabase session token" };
      }
      const authUser = response.body;
      const email = normalizeEmail(authUser.email || "");
      const user = upsertUser(billing, {
        email,
        stripeCustomerId: "",
        authProvider: "supabase",
        authProviderUserId: authUser.id,
      });
      if (!user) return { ok: false, status: 401, error: "User not found" };
      user.lastSeenAt = nowIso();
      user.updatedAt = nowIso();
      return { ok: true, user, authMode: "supabase", needsSave: true };
    }

    return { ok: false, status: 401, error: "Invalid session token" };
  }

  if (ALLOW_DEV_EMAIL_AUTH) {
    const devEmail = normalizeEmail(req.headers["x-snackvoice-email"] || "");
    if (devEmail) {
      const user = upsertUser(billing, { email: devEmail, stripeCustomerId: "" });
      return { ok: true, user, authMode: "dev_email", needsSave: true };
    }
  }

  return { ok: false, status: 401, error: "Authentication required" };
}

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

async function createCheckoutSession({
  customerEmail,
  customerId,
  baseUrl,
  priceId,
}) {
  const params = {
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    mode: "subscription",
    success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/`,
    allow_promotion_codes: "true",
    billing_address_collection: "required",
    "phone_number_collection[enabled]": "true",
    "name_collection[business][enabled]": "false",
    "name_collection[individual][enabled]": "true",
    "subscription_data[metadata][product]": "snackvoice",
  };
  if (customerId) {
    params.customer = customerId;
  } else {
    if (customerEmail) params.customer_email = customerEmail;
  }
  return stripeRequest("POST", "/v1/checkout/sessions", params);
}

async function createPortalSession({ customerId, returnUrl }) {
  return stripeRequest("POST", "/v1/billing_portal/sessions", {
    customer: customerId,
    return_url: returnUrl,
  });
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

function getS3DownloadConfigError() {
  if (!S3_BUCKET) {
    return "Missing S3 download config: S3_BUCKET";
  }
  if (!S3_REGION) {
    return "Missing S3 download config: AWS_REGION (or AWS_DEFAULT_REGION)";
  }
  if (!S3_KEY_ARM64) {
    return "Missing S3 download config: S3_KEY_ARM64";
  }
  return "";
}

async function createDownloadLinks() {
  const configError = getS3DownloadConfigError();
  if (configError) {
    throw new Error(configError);
  }

  return {
    appleSilicon: await createSignedDownloadUrl(
      S3_KEY_ARM64,
      "SnackVoice-Apple-Silicon.dmg"
    ),
    intel: await createSignedDownloadUrl(S3_KEY_X64, "SnackVoice-Intel.dmg"),
  };
}

async function fetchStripeCheckoutSessionById(sessionId) {
  if (!STRIPE_SECRET) return null;
  const { status, body } = await stripeRequest(
    "GET",
    `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`
  );
  if (status !== 200 || !body || body.object !== "checkout.session") return null;
  return body;
}

async function fetchStripeOrderBySessionId(sessionId) {
  const session = await fetchStripeCheckoutSessionById(sessionId);
  if (!session) return null;
  const complete = session.status === "complete";
  const paymentCompleted =
    session.payment_status === "paid" ||
    (session.mode === "subscription" && complete);
  return {
    email: session.customer_details?.email || session.customer_email || "",
    name: session.customer_details?.name || "",
    phone: session.customer_details?.phone || "",
    stripeSessionId: session.id,
    downloadUrls: null,
    fulfillmentStatus: paymentCompleted ? "fulfilled" : "pending",
    fulfillmentError: "",
    created_at: toIsoFromEpochSeconds(session.created),
  };
}

async function fetchStripeSubscriptionById(subscriptionId) {
  if (!STRIPE_SECRET || !subscriptionId) return null;
  const { status, body } = await stripeRequest(
    "GET",
    `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`
  );
  if (status !== 200 || !body || body.object !== "subscription") return null;
  return body;
}

async function fetchStripeCustomerById(customerId) {
  if (!STRIPE_SECRET || !customerId) return null;
  const { status, body } = await stripeRequest(
    "GET",
    `/v1/customers/${encodeURIComponent(customerId)}`
  );
  if (status !== 200 || !body || body.object !== "customer") return null;
  return body;
}

async function getOrderBySessionId(sessionId) {
  const storedOrder = await getStoredOrderBySessionId(sessionId);
  if (storedOrder) return storedOrder;
  return fetchStripeOrderBySessionId(sessionId);
}

async function publicOrder(order) {
  if (!order) return null;
  let downloadUrls = order.downloadUrls || null;
  let fulfillmentStatus = order.fulfillmentStatus || "pending";
  let fulfillmentError = order.fulfillmentError || "";
  if (order.fulfillmentStatus === "fulfilled") {
    try {
      downloadUrls = await createDownloadLinks();
    } catch (error) {
      downloadUrls = null;
      fulfillmentStatus = "failed";
      fulfillmentError =
        error instanceof Error ? error.message : "Download is not configured yet";
    }
  }
  return {
    email: order.email,
    name: order.name,
    phone: order.phone || "",
    stripeSessionId: order.stripeSessionId,
    downloadUrls,
    fulfillmentStatus,
    fulfillmentError,
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

function parseJsonBuffer(buffer) {
  if (!buffer || buffer.length === 0) return {};
  const raw = buffer.toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
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

async function applySubscriptionSnapshotFromStripe({
  billing,
  subscriptionId,
  sourceEventId,
  sourceEventType,
}) {
  if (!subscriptionId) return;
  const stripeSubscription = await fetchStripeSubscriptionById(subscriptionId);
  if (!stripeSubscription) return;

  const customerId =
    typeof stripeSubscription.customer === "string"
      ? stripeSubscription.customer
      : stripeSubscription.customer?.id || "";

  let user = findUserByCustomerId(billing, customerId);
  if (!user && customerId) {
    const customer = await fetchStripeCustomerById(customerId);
    user = upsertUser(billing, {
      email: customer?.email || "",
      stripeCustomerId: customerId,
    });
  }

  const firstItem =
    stripeSubscription.items?.data && stripeSubscription.items.data.length > 0
      ? stripeSubscription.items.data[0]
      : null;
  const priceId = firstItem?.price?.id || "";
  const productId = firstItem?.price?.product || "";

  upsertSubscription(billing, {
    stripeSubscriptionId: stripeSubscription.id,
    stripeCustomerId: customerId,
    userId: user?.userId || "",
    email: user?.email || "",
    status: stripeSubscription.status,
    currentPeriodEnd: toIsoFromEpochSeconds(stripeSubscription.current_period_end),
    cancelAtPeriodEnd: !!stripeSubscription.cancel_at_period_end,
    canceledAt: toIsoFromEpochSeconds(stripeSubscription.canceled_at),
    planId: productId,
    priceId,
    sourceEventId,
    sourceEventType,
  });
}

async function handleCreateCheckout(req, res) {
  const baseUrl = getBaseUrl(req);
  const body = parseJsonBuffer(await readBody(req));
  const { plan, priceId } = resolvePriceId(body.plan);

  if (!STRIPE_SECRET || !priceId) {
    console.warn("[checkout] Stripe checkout not configured, returning mock URL");
    return json(res, 200, { url: `${baseUrl}/success.html?mock=1` });
  }

  if (plan === "annual" && !STRIPE_PRICE_ID_ANNUAL) {
    return json(res, 400, { error: "Annual plan is not configured yet" });
  }

  const billing = await loadBilling();
  cleanupExpiredAuthRecords(billing, nowMs());
  const auth = await getAuthContext(req, billing);
  if (!auth.ok) return json(res, auth.status, { error: auth.error });
  const customerId = auth.user.stripeCustomerId || "";
  const email = normalizeEmail(auth.user.email);
  if (!email) {
    return json(res, 400, { error: "Authenticated account is missing email" });
  }
  const sessionResponse = await createCheckoutSession({
    customerEmail: email,
    customerId,
    baseUrl,
    priceId,
  });

  if (sessionResponse.status < 200 || sessionResponse.status >= 300) {
    return json(res, 400, {
      error: sessionResponse.body?.error?.message || "Stripe checkout failed",
    });
  }

  upsertCheckoutSession(billing, {
    stripeSessionId: sessionResponse.body.id,
    userId: auth.user.userId || "",
    email,
    stripeCustomerId: customerId,
    stripeSubscriptionId: "",
    mode: "subscription",
    plan,
    priceId,
    paymentStatus: "pending",
    checkoutStatus: "created",
    fulfillmentStatus: "pending",
    source: "checkout_create",
  });
  await saveBilling(billing);
  return json(res, 200, { url: sessionResponse.body.url });
}

async function handleCreatePortalSession(req, res) {
  const baseUrl = getBaseUrl(req);
  if (!STRIPE_SECRET) return json(res, 200, { url: `${baseUrl}/` });

  const billing = await loadBilling();
  cleanupExpiredAuthRecords(billing, nowMs());
  const auth = await getAuthContext(req, billing);
  if (!auth.ok) return json(res, auth.status, { error: auth.error });
  const customerId = auth.user.stripeCustomerId || "";

  if (!customerId) {
    return json(res, 400, { error: "No Stripe customer found for this account" });
  }

  const portalResponse = await createPortalSession({
    customerId,
    returnUrl: `${baseUrl}/`,
  });

  if (portalResponse.status < 200 || portalResponse.status >= 300) {
    return json(res, 400, {
      error:
        portalResponse.body?.error?.message ||
        "Failed to create billing portal session",
    });
  }
  await saveBilling(billing);
  return json(res, 200, { url: portalResponse.body.url });
}

async function handleAuthSession(req, res) {
  const billing = await loadBilling();
  cleanupExpiredAuthRecords(billing, nowMs());
  const auth = await getAuthContext(req, billing);
  if (!auth.ok) return json(res, 200, { authenticated: false });

  const result = buildEntitlementPayload({
    billing,
    user: auth.user,
    currentMs: nowMs(),
  });
  if (result.dirty || auth.needsSave) {
    await saveBilling(billing);
  }
  return json(res, 200, {
    authenticated: true,
    user: {
      userId: auth.user.userId,
      email: auth.user.email,
    },
    entitlement: result.entitlement,
  });
}

async function handleSignOut(req, res) {
  const token = parseBearerToken(req);
  if (!token) return json(res, 400, { error: "Missing auth token" });

  const billing = await loadBilling();
  cleanupExpiredAuthRecords(billing, nowMs());
  const sessionToken = verifySignedToken(token, AUTH_SECRET);
  if (sessionToken.valid && sessionToken.payload?.type === "session") {
    const session = findActiveSession(billing, token);
    if (session) {
      session.revokedAt = nowIso();
      session.updatedAt = nowIso();
    }
    await saveBilling(billing);
    return json(res, 200, { ok: true });
  }

  if (SUPABASE_AUTH_ENABLED) {
    // Supabase invalidates the refresh token chain. Access tokens remain valid
    // until expiration, which is expected for JWT-based auth systems.
    await supabaseSignOut(token);
    return json(res, 200, { ok: true });
  }

  const auth = await getAuthContext(req, billing);
  if (!auth.ok) return json(res, auth.status, { error: auth.error });
  const localSession = findActiveSession(billing, token);
  if (localSession) {
    localSession.revokedAt = nowIso();
    localSession.updatedAt = nowIso();
  }
  await saveBilling(billing);
  return json(res, 200, { ok: true });
}

async function handleManageSubscription(req, res) {
  if (!STRIPE_SECRET) return json(res, 200, { url: `${getBaseUrl(req)}/` });

  const billing = await loadBilling();
  cleanupExpiredAuthRecords(billing, nowMs());
  const auth = await getAuthContext(req, billing);
  if (!auth.ok) return json(res, auth.status, { error: auth.error });

  if (!auth.user.stripeCustomerId) {
    return json(res, 400, {
      error: "No Stripe customer is linked to this account yet",
    });
  }

  const portalResponse = await createPortalSession({
    customerId: auth.user.stripeCustomerId,
    returnUrl: `${getBaseUrl(req)}/`,
  });
  if (portalResponse.status < 200 || portalResponse.status >= 300) {
    return json(res, 400, {
      error:
        portalResponse.body?.error?.message ||
        "Failed to create billing portal session",
    });
  }
  await saveBilling(billing);
  return json(res, 200, { url: portalResponse.body.url });
}

async function handleSignUp(req, res) {
  const body = parseJsonBuffer(await readBody(req));
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !email.includes("@")) {
    return json(res, 400, { error: "Valid email is required" });
  }
  const passwordError = validatePassword(password);
  if (passwordError) return json(res, 400, { error: passwordError });

  if (SUPABASE_AUTH_ENABLED) {
    const signUpResponse = await supabaseSignUpWithPassword(email, password);
    if (!signUpResponse.ok) {
      return json(res, signUpResponse.status, {
        error:
          signUpResponse.body?.msg ||
          signUpResponse.body?.error_description ||
          signUpResponse.body?.error ||
          "Failed to create account",
      });
    }

    let sessionPayload = signUpResponse.body || {};
    if (!sessionPayload.access_token && SUPABASE_SIGNUP_AUTO_SIGNIN) {
      const signInResponse = await supabaseSignInWithPassword(email, password);
      if (signInResponse.ok && signInResponse.body?.access_token) {
        sessionPayload = signInResponse.body;
      }
    }

    const token = sessionPayload?.access_token || "";
    const billing = await loadBilling();
    cleanupExpiredAuthRecords(billing, nowMs());
    const authUser = sessionPayload.user || signUpResponse.body?.user || {};
    upsertUser(billing, {
      email,
      stripeCustomerId: "",
      authProvider: "supabase",
      authProviderUserId: authUser.id || "",
    });
    await saveBilling(billing);

    if (!token) {
      return json(res, 200, {
        ok: true,
        requiresEmailConfirmation: true,
        message:
          "Account created. Check your email to confirm your account, then sign in.",
      });
    }

    return json(res, 200, {
      ok: true,
      token,
      refreshToken: sessionPayload.refresh_token || "",
      expiresIn: Number(sessionPayload.expires_in) || 0,
      tokenType: sessionPayload.token_type || "bearer",
    });
  }

  const billing = await loadBilling();
  cleanupExpiredAuthRecords(billing, nowMs());
  const existingUser = findUserByEmail(billing, email);
  if (existingUser?.passwordHash) {
    return json(res, 409, { error: "An account with this email already exists" });
  }

  const user = existingUser || upsertUser(billing, { email, stripeCustomerId: "" });
  setUserPassword(user, password);
  const session = createSessionForUser(billing, user);
  await saveBilling(billing);
  return json(res, 200, { ok: true, ...session });
}

async function handleSignIn(req, res) {
  const body = parseJsonBuffer(await readBody(req));
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return json(res, 400, { error: "Email and password are required" });
  }

  if (SUPABASE_AUTH_ENABLED) {
    const response = await supabaseSignInWithPassword(email, password);
    if (!response.ok) {
      return json(res, response.status, {
        error:
          response.body?.msg ||
          response.body?.error_description ||
          response.body?.error ||
          "Invalid email or password",
      });
    }
    const payload = response.body || {};
    if (!payload.access_token) {
      return json(res, 401, { error: "Supabase did not return an access token" });
    }

    const billing = await loadBilling();
    cleanupExpiredAuthRecords(billing, nowMs());
    upsertUser(billing, {
      email,
      stripeCustomerId: "",
      authProvider: "supabase",
      authProviderUserId: payload.user?.id || "",
    });
    await saveBilling(billing);
    return json(res, 200, {
      ok: true,
      token: payload.access_token,
      refreshToken: payload.refresh_token || "",
      expiresIn: Number(payload.expires_in) || 0,
      tokenType: payload.token_type || "bearer",
    });
  }

  const billing = await loadBilling();
  cleanupExpiredAuthRecords(billing, nowMs());
  const user = findUserByEmail(billing, email);
  if (!verifyUserPassword(user, password)) {
    return json(res, 401, { error: "Invalid email or password" });
  }
  user.lastSeenAt = nowIso();
  user.updatedAt = nowIso();
  const session = createSessionForUser(billing, user);
  await saveBilling(billing);
  return json(res, 200, {
    ok: true,
    ...session,
  });
}

async function handleDesktopAuthStart(req, res) {
  const billing = await loadBilling();
  cleanupExpiredAuthRecords(billing, nowMs());
  const desktopRequest = createDesktopAuthRequest(billing, getBaseUrl(req));
  await saveBilling(billing);
  return json(res, 200, {
    ok: true,
    requestId: desktopRequest.requestId,
    pollKey: desktopRequest.pollKey,
    browserUrl: desktopRequest.browserUrl,
    expiresAt: desktopRequest.expiresAt,
    pollIntervalMs: desktopRequest.pollIntervalMs,
    openAppUrl: DESKTOP_AUTH_OPEN_APP_URL,
  });
}

async function handleDesktopAuthStatus(req, res) {
  const url = new URL(req.url, getBaseUrl(req));
  const requestId = String(url.searchParams.get("requestId") || "").trim();
  const pollKey = String(url.searchParams.get("pollKey") || "").trim();
  if (!requestId) {
    return json(res, 400, { status: "invalid", error: "Missing requestId" });
  }

  const billing = await loadBilling();
  const currentMs = nowMs();
  cleanupExpiredAuthRecords(billing, currentMs);
  const request = findDesktopAuthRequest(billing, requestId);

  if (!request) {
    return json(res, 404, { status: "invalid" });
  }

  const includeCompletionCode = hasDesktopAuthPollKey(request, pollKey);
  const payload = buildDesktopAuthStatusPayload({
    request,
    currentMs,
    includeCompletionCode,
  });

  if (payload.status === "expired" && request.status !== "expired") {
    request.status = "expired";
    request.updatedAt = nowIso();
    await saveBilling(billing);
  }
  return json(res, 200, payload);
}

async function handleDesktopAuthComplete(req, res) {
  const body = parseJsonBuffer(await readBody(req));
  const requestId = String(body.requestId || "").trim();
  if (!requestId) return json(res, 400, { error: "Missing requestId" });

  const billing = await loadBilling();
  const currentMs = nowMs();
  cleanupExpiredAuthRecords(billing, currentMs);
  const request = findDesktopAuthRequest(billing, requestId);
  if (!request) {
    return json(res, 404, { error: "Invalid desktop auth request" });
  }
  if (isDesktopAuthConsumed(request)) {
    return json(res, 409, { error: "Desktop auth request already consumed" });
  }
  if (isDesktopAuthExpired(request, currentMs)) {
    request.status = "expired";
    request.updatedAt = nowIso();
    await saveBilling(billing);
    return json(res, 410, { error: "Desktop auth request expired" });
  }

  const auth = await getAuthContext(req, billing);
  if (!auth.ok) {
    return json(res, auth.status, { error: auth.error });
  }

  request.status = "ready";
  request.userId = auth.user.userId;
  request.email = auth.user.email;
  request.completionNonce = randomBytes(16).toString("hex");
  request.completedAt = nowIso();
  request.updatedAt = nowIso();
  await saveBilling(billing);

  return json(res, 200, {
    ok: true,
    status: "ready",
    expiresAt: request.expiresAt,
    openAppUrl: DESKTOP_AUTH_OPEN_APP_URL,
  });
}

async function handleDesktopAuthExchange(req, res) {
  const body = parseJsonBuffer(await readBody(req));
  const requestId = String(body.requestId || "").trim();
  const pollKey = String(body.pollKey || "").trim();
  const completionCode = String(body.completionCode || "").trim();
  if (!requestId || !pollKey || !completionCode) {
    return json(res, 400, { error: "requestId, pollKey, and completionCode are required" });
  }

  const billing = await loadBilling();
  const currentMs = nowMs();
  cleanupExpiredAuthRecords(billing, currentMs);
  const request = findDesktopAuthRequest(billing, requestId);
  if (!request) {
    return json(res, 404, { error: "Invalid desktop auth request" });
  }
  if (!hasDesktopAuthPollKey(request, pollKey)) {
    return json(res, 401, { error: "Invalid desktop auth poll key" });
  }
  if (isDesktopAuthConsumed(request)) {
    return json(res, 409, { error: "Desktop auth request already consumed" });
  }
  if (isDesktopAuthExpired(request, currentMs)) {
    request.status = "expired";
    request.updatedAt = nowIso();
    await saveBilling(billing);
    return json(res, 410, { error: "Desktop auth request expired" });
  }
  if (request.status !== "ready" || !request.completionNonce) {
    return json(res, 409, { error: "Desktop auth request is not ready yet" });
  }

  const verifiedCode = verifySignedToken(completionCode, AUTH_SECRET);
  if (
    !verifiedCode.valid ||
    !verifiedCode.payload ||
    verifiedCode.payload.type !== "desktop_completion" ||
    !safeEqualString(String(verifiedCode.payload.requestId || ""), request.requestId) ||
    !safeEqualString(String(verifiedCode.payload.nonce || ""), request.completionNonce)
  ) {
    return json(res, 401, { error: "Invalid completion code" });
  }

  const user =
    findUserByUserId(billing, request.userId) || findUserByEmail(billing, request.email);
  if (!user) {
    return json(res, 404, { error: "User not found for this desktop auth request" });
  }

  const session = createSessionForUser(billing, user);
  request.status = "consumed";
  request.completionNonce = "";
  request.consumedAt = nowIso();
  request.updatedAt = nowIso();
  await saveBilling(billing);

  return json(res, 200, {
    ok: true,
    ...session,
  });
}

async function handleEntitlement(req, res) {
  const billing = await loadBilling();
  cleanupExpiredAuthRecords(billing, nowMs());
  const auth = await getAuthContext(req, billing);
  if (!auth.ok) return json(res, auth.status, { error: auth.error });

  const result = buildEntitlementPayload({
    billing,
    user: auth.user,
    currentMs: nowMs(),
  });
  if (result.dirty || auth.needsSave) {
    await saveBilling(billing);
  }
  return json(res, 200, { entitlement: result.entitlement });
}

async function handleConsumeWords(req, res) {
  const body = parseJsonBuffer(await readBody(req));
  const words = Number(body.words);
  if (!Number.isFinite(words) || words <= 0) {
    return json(res, 400, { error: "words must be a positive number" });
  }

  const billing = await loadBilling();
  cleanupExpiredAuthRecords(billing, nowMs());
  const auth = await getAuthContext(req, billing);
  if (!auth.ok) return json(res, auth.status, { error: auth.error });

  const consumedRequested = Math.floor(words);
  const before = buildEntitlementPayload({
    billing,
    user: auth.user,
    currentMs: nowMs(),
  });

  if (before.entitlement.isUnlimited) {
    await saveBilling(billing);
    return json(res, 200, {
      consumedWords: consumedRequested,
      blocked: false,
      entitlement: before.entitlement,
    });
  }

  const remainingBefore = before.entitlement.weeklyQuota.remaining || 0;
  if (remainingBefore <= 0) {
    await saveBilling(billing);
    return json(res, 402, {
      consumedWords: 0,
      blocked: true,
      error: "Weekly free-tier quota exhausted",
      entitlement: before.entitlement,
    });
  }

  const accepted = Math.min(consumedRequested, remainingBefore);
  auth.user.weeklyWordsUsed =
    (Number(auth.user.weeklyWordsUsed) || 0) + accepted;
  auth.user.updatedAt = nowIso();

  const after = buildEntitlementPayload({
    billing,
    user: auth.user,
    currentMs: nowMs(),
  });
  await saveBilling(billing);

  if (accepted < consumedRequested) {
    return json(res, 402, {
      consumedWords: accepted,
      blocked: true,
      error: "Quota reached during this request",
      entitlement: after.entitlement,
    });
  }

  return json(res, 200, {
    consumedWords: accepted,
    blocked: false,
    entitlement: after.entitlement,
  });
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

  const billing = await loadBilling();
  cleanupExpiredAuthRecords(billing, nowMs());
  if (event.id && isWebhookEventProcessed(billing, event.id)) {
    return json(res, 200, { received: true, duplicate: true });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = normalizeEmail(
        session.customer_details?.email || session.customer_email || ""
      );
      const name = session.customer_details?.name || "";
      const phone = session.customer_details?.phone || "";
      const stripeSessionId = session.id;
      const stripeCustomerId =
        typeof session.customer === "string"
          ? session.customer
          : session.customer?.id || "";
      const stripeSubscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id || "";

      const user = upsertUser(billing, { email, stripeCustomerId });
      upsertCheckoutSession(billing, {
        stripeSessionId,
        userId: user?.userId || "",
        email,
        stripeCustomerId,
        stripeSubscriptionId,
        mode: session.mode || "",
        plan: "",
        priceId: "",
        paymentStatus: session.payment_status || "",
        checkoutStatus: session.status || "",
        fulfillmentStatus: "pending",
        source: event.type,
      });

      try {
        const downloadUrls = await createDownloadLinks();
        await saveOrder({
          email,
          name,
          phone,
          stripeSessionId,
          downloadUrls,
          fulfillmentStatus: "fulfilled",
        });
        upsertCheckoutSession(billing, {
          stripeSessionId,
          userId: user?.userId || "",
          email,
          stripeCustomerId,
          stripeSubscriptionId,
          mode: session.mode || "",
          plan: "",
          priceId: "",
          paymentStatus: session.payment_status || "",
          checkoutStatus: session.status || "",
          fulfillmentStatus: "fulfilled",
          source: event.type,
        });
      } catch (err) {
        console.error("[webhook] Fulfillment error:", err);
        await saveOrder({
          email,
          name,
          phone,
          stripeSessionId,
          fulfillmentStatus: "failed",
          fulfillmentError: err.message,
        });
        upsertCheckoutSession(billing, {
          stripeSessionId,
          userId: user?.userId || "",
          email,
          stripeCustomerId,
          stripeSubscriptionId,
          mode: session.mode || "",
          plan: "",
          priceId: "",
          paymentStatus: session.payment_status || "",
          checkoutStatus: session.status || "",
          fulfillmentStatus: "failed",
          source: event.type,
        });
      }

      if (stripeSubscriptionId) {
        await applySubscriptionSnapshotFromStripe({
          billing,
          subscriptionId: stripeSubscriptionId,
          sourceEventId: event.id,
          sourceEventType: event.type,
        });
      }
    } else if (
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const subscription = event.data.object;
      await applySubscriptionSnapshotFromStripe({
        billing,
        subscriptionId: subscription.id,
        sourceEventId: event.id,
        sourceEventType: event.type,
      });
    } else if (
      event.type === "invoice.paid" ||
      event.type === "invoice.payment_failed"
    ) {
      const invoice = event.data.object;
      const subscriptionId =
        typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.subscription?.id || "";
      if (subscriptionId) {
        await applySubscriptionSnapshotFromStripe({
          billing,
          subscriptionId,
          sourceEventId: event.id,
          sourceEventType: event.type,
        });
      }
    }

    markWebhookEventProcessed(billing, { eventId: event.id, eventType: event.type });
    await saveBilling(billing);
    return json(res, 200, { received: true });
  } catch (err) {
    console.error("[webhook] Processing error:", err);
    await saveBilling(billing);
    return json(res, 500, { error: "Webhook processing failed" });
  }
}

async function handleOrderStatus(req, res) {
  const url = new URL(req.url, getBaseUrl(req));
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) return json(res, 400, { error: "Missing session_id" });
  const order = await getOrderBySessionId(sessionId);
  if (!order) return json(res, 404, { error: "Order not found" });
  return json(res, 200, { order: await publicOrder(order) });
}

async function handleLatestDownload(req, res) {
  const url = new URL(req.url, getBaseUrl(req));
  const arch = String(url.searchParams.get("arch") || "arm64").toLowerCase();
  const preferIntel = arch === "x64" || arch === "intel";
  let links;
  try {
    links = await createDownloadLinks();
  } catch (error) {
    return json(res, 503, {
      error:
        error instanceof Error
          ? error.message
          : "Download is not configured yet",
    });
  }
  const targetUrl = preferIntel
    ? links.intel || links.appleSilicon
    : links.appleSilicon || links.intel;

  if (!targetUrl) {
    return json(res, 503, {
      error: "Download is not configured yet",
    });
  }

  res.writeHead(302, {
    Location: targetUrl,
    "Cache-Control": "no-store",
  });
  res.end();
}

async function handleStaticRequest(req, res) {
  const url = new URL(req.url, getBaseUrl(req));
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  let staticPath = requestedPath;
  if (!path.extname(staticPath)) {
    const htmlCandidate = `${staticPath}.html`;
    if (fs.existsSync(path.join(REPO_ROOT, htmlCandidate))) {
      staticPath = htmlCandidate;
    }
  }

  const filePath = path.join(REPO_ROOT, staticPath.replace(/^\/+/, ""));
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-SnackVoice-Email");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (req.method === "POST" && url.pathname === "/api/create-checkout") {
      return await handleCreateCheckout(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/create-portal-session") {
      return await handleCreatePortalSession(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/manage-subscription") {
      return await handleManageSubscription(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/auth/desktop/start") {
      return await handleDesktopAuthStart(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/auth/desktop/status") {
      return await handleDesktopAuthStatus(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/auth/desktop/complete") {
      return await handleDesktopAuthComplete(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/auth/desktop/exchange") {
      return await handleDesktopAuthExchange(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/auth/sign-up") {
      return await handleSignUp(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/auth/sign-in") {
      return await handleSignIn(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/auth/session") {
      return await handleAuthSession(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/auth/sign-out") {
      return await handleSignOut(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/entitlement") {
      return await handleEntitlement(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/usage/consume-words") {
      return await handleConsumeWords(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/webhook") {
      return await handleWebhook(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/order-status") {
      return await handleOrderStatus(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/download/latest") {
      return await handleLatestDownload(req, res);
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
  handleCreatePortalSession,
  handleManageSubscription,
  handleSignUp,
  handleSignIn,
  handleAuthSession,
  handleSignOut,
  handleEntitlement,
  handleConsumeWords,
  handleWebhook,
  handleOrderStatus,
  handleLatestDownload,
};
