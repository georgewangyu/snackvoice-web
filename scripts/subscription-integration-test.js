"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");
const { spawn } = require("child_process");

const PORT = 4312;
const BASE = `http://localhost:${PORT}`;
const TEST_EMAIL = "integration-user@test.com";
const TEST_PASSWORD = "password123";

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok || res.status === 404) return;
    } catch {
      // retry
    }
    await sleep(150);
  }
  throw new Error("Server did not start in time");
}

async function api(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, options);
  let json = {};
  try {
    json = await res.json();
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

function check(label, condition, details = "") {
  if (!condition) {
    console.log(`  ${FAIL} ${label}${details ? ` — ${details}` : ""}`);
    throw new Error(label);
  }
  console.log(`  ${PASS} ${label}`);
}

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snackvoice-sub-it-"));
  const billingPath = path.join(tmpDir, "billing.json");
  const ordersPath = path.join(tmpDir, "orders.json");

  const env = {
    ...process.env,
    PORT: String(PORT),
    APP_URL: BASE,
    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: "",
    SUPABASE_DB_URL: "",
    DATABASE_URL: "",
    STRIPE_SECRET_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    STRIPE_PRICE_ID_MONTHLY: "",
    STRIPE_PRICE_ID_ANNUAL: "",
    STRIPE_DEFAULT_PLAN: "monthly",
    FREE_WEEKLY_WORD_QUOTA: "1000",
    WEEKLY_RESET_DAY_UTC: "1",
    OUTAGE_GRACE_HOURS: "12",
    SNACKVOICE_AUTH_SECRET: "integration-test-secret",
    SESSION_TTL_DAYS: "30",
    ALLOW_DEV_EMAIL_AUTH: "true",
    ORDERS_DATA_PATH: ordersPath,
    BILLING_DATA_PATH: billingPath,
  };

  const server = spawn("node", ["backend/server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});

  try {
    await waitForServer();
    console.log("\n[1] Auth + Session");

    const signUpRes = await api("/api/auth/sign-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    check("sign-up returns 200", signUpRes.status === 200);
    check(
      "sign-up returns session token",
      typeof signUpRes.json.token === "string" &&
        signUpRes.json.token.length > 20
    );
    const sessionToken = signUpRes.json.token;

    const signInRes = await api("/api/auth/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    check("sign-in returns 200", signInRes.status === 200);
    check(
      "sign-in returns session token",
      typeof signInRes.json.token === "string" && signInRes.json.token.length > 20
    );
    const secondSessionToken = signInRes.json.token;

    console.log("\n[2] Entitlement + Quota Thresholds");

    const ent0 = await api("/api/entitlement", {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    check("entitlement returns 200", ent0.status === 200);
    check(
      "initial free quota is 1000",
      ent0.json.entitlement?.weeklyQuota?.limit === 1000
    );

    const consumeA = await api("/api/usage/consume-words", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ words: 850 }),
    });
    check("consume 850 returns 200", consumeA.status === 200);
    check(
      "warning reaches warn_20",
      consumeA.json.entitlement?.weeklyQuota?.warningLevel === "warn_20"
    );

    const consumeB = await api("/api/usage/consume-words", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secondSessionToken}`,
      },
      body: JSON.stringify({ words: 60 }),
    });
    check("second device consume returns 200", consumeB.status === 200);
    check(
      "warning reaches low_10",
      consumeB.json.entitlement?.weeklyQuota?.warningLevel === "low_10"
    );

    const consumeC = await api("/api/usage/consume-words", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ words: 50 }),
    });
    check("consume to <=5% returns 200", consumeC.status === 200);
    check(
      "warning reaches critical_5",
      consumeC.json.entitlement?.weeklyQuota?.warningLevel === "critical_5"
    );

    const consumeD = await api("/api/usage/consume-words", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ words: 100 }),
    });
    check("consume over remaining returns 402", consumeD.status === 402);
    check(
      "quota ends at exhausted",
      consumeD.json.entitlement?.weeklyQuota?.warningLevel === "exhausted"
    );

    console.log("\n[3] Paid Entitlement Simulation");

    const billing = JSON.parse(fs.readFileSync(billingPath, "utf8"));
    const user = billing.users.find((row) => row.email === TEST_EMAIL);
    assert(user, "User record should exist in billing file");
    billing.subscriptions.push({
      stripeSubscriptionId: "sub_integration_active",
      stripeCustomerId: "cus_integration_active",
      userId: user.userId,
      email: TEST_EMAIL,
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      cancelAtPeriodEnd: false,
      canceledAt: "",
      planId: "prod_integration",
      priceId: "price_monthly_integration",
      sourceEventId: "evt_integration_seed",
      sourceEventType: "integration.seed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    fs.writeFileSync(billingPath, JSON.stringify(billing, null, 2));

    const entPaid = await api("/api/entitlement", {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    check("paid entitlement returns 200", entPaid.status === 200);
    check("paid account is unlimited", entPaid.json.entitlement?.isUnlimited === true);

    const consumePaid = await api("/api/usage/consume-words", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ words: 2000 }),
    });
    check("paid consume returns 200", consumePaid.status === 200);
    check("paid consume is not blocked", consumePaid.json.blocked === false);
    check(
      "paid response keeps quota remaining null",
      consumePaid.json.entitlement?.weeklyQuota?.remaining === null
    );

    console.log("\n[4] Manage Subscription + Webhook Idempotency");

    const manage = await api("/api/manage-subscription", {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    check("manage-subscription returns 200", manage.status === 200);
    check(
      "manage-subscription returns URL",
      typeof manage.json.url === "string" && manage.json.url.length > 0
    );

    const fakeEvent = {
      id: "evt_integration_duplicate",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_integration_duplicate",
          mode: "subscription",
          status: "complete",
          payment_status: "paid",
          customer_details: { email: "dup@test.com", name: "Dup", phone: "" },
          customer: "cus_dup_test",
          subscription: "sub_dup_test",
        },
      },
    };
    const firstWebhook = await api("/api/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fakeEvent),
    });
    check("first duplicate webhook event returns 200", firstWebhook.status === 200);

    const secondWebhook = await api("/api/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fakeEvent),
    });
    check("second duplicate webhook event returns 200", secondWebhook.status === 200);
    check(
      "second duplicate webhook is flagged as duplicate",
      secondWebhook.json.duplicate === true
    );

    console.log("\n[5] Desktop Browser Auth Handoff");

    const desktopStart = await api("/api/auth/desktop/start", {
      method: "POST",
    });
    check("desktop auth start returns 200", desktopStart.status === 200);
    check(
      "desktop auth start returns requestId and pollKey",
      typeof desktopStart.json.requestId === "string" &&
        desktopStart.json.requestId.length > 10 &&
        typeof desktopStart.json.pollKey === "string" &&
        desktopStart.json.pollKey.length > 10
    );
    check(
      "desktop auth start returns browser URL",
      typeof desktopStart.json.browserUrl === "string" &&
        desktopStart.json.browserUrl.includes("/desktop-auth")
    );

    const desktopRequestId = desktopStart.json.requestId;
    const desktopPollKey = desktopStart.json.pollKey;

    const desktopPending = await api(
      `/api/auth/desktop/status?requestId=${encodeURIComponent(desktopRequestId)}`
    );
    check("desktop auth status returns 200", desktopPending.status === 200);
    check(
      "desktop auth status is pending before completion",
      desktopPending.json.status === "pending"
    );

    const desktopCompleteNoAuth = await api("/api/auth/desktop/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: desktopRequestId }),
    });
    check(
      "desktop complete without auth is rejected",
      desktopCompleteNoAuth.status === 401
    );

    const desktopComplete = await api("/api/auth/desktop/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ requestId: desktopRequestId }),
    });
    check("desktop complete with auth returns 200", desktopComplete.status === 200);
    check(
      "desktop complete marks request as ready",
      desktopComplete.json.status === "ready"
    );

    const desktopReadyNoPollKey = await api(
      `/api/auth/desktop/status?requestId=${encodeURIComponent(desktopRequestId)}`
    );
    check(
      "desktop ready status works without pollKey",
      desktopReadyNoPollKey.status === 200 &&
        desktopReadyNoPollKey.json.status === "ready"
    );
    check(
      "desktop ready without pollKey omits completion code",
      typeof desktopReadyNoPollKey.json.completionCode === "undefined"
    );

    const desktopReady = await api(
      `/api/auth/desktop/status?requestId=${encodeURIComponent(
        desktopRequestId
      )}&pollKey=${encodeURIComponent(desktopPollKey)}`
    );
    check("desktop ready status with pollKey returns 200", desktopReady.status === 200);
    check(
      "desktop ready status with pollKey returns completion code",
      desktopReady.json.status === "ready" &&
        typeof desktopReady.json.completionCode === "string" &&
        desktopReady.json.completionCode.length > 20
    );

    const desktopExchangeWrongPoll = await api("/api/auth/desktop/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: desktopRequestId,
        pollKey: "wrong-poll-key",
        completionCode: desktopReady.json.completionCode,
      }),
    });
    check(
      "desktop exchange with wrong poll key is rejected",
      desktopExchangeWrongPoll.status === 401
    );

    const desktopExchange = await api("/api/auth/desktop/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: desktopRequestId,
        pollKey: desktopPollKey,
        completionCode: desktopReady.json.completionCode,
      }),
    });
    check("desktop exchange returns 200", desktopExchange.status === 200);
    check(
      "desktop exchange returns session token",
      typeof desktopExchange.json.token === "string" &&
        desktopExchange.json.token.length > 20
    );

    const desktopExchangeAgain = await api("/api/auth/desktop/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: desktopRequestId,
        pollKey: desktopPollKey,
        completionCode: desktopReady.json.completionCode,
      }),
    });
    check(
      "desktop exchange can only be consumed once",
      desktopExchangeAgain.status === 409
    );

    const desktopConsumed = await api(
      `/api/auth/desktop/status?requestId=${encodeURIComponent(
        desktopRequestId
      )}&pollKey=${encodeURIComponent(desktopPollKey)}`
    );
    check(
      "desktop status transitions to consumed after exchange",
      desktopConsumed.status === 200 && desktopConsumed.json.status === "consumed"
    );

    const desktopSession = await api("/api/auth/session", {
      headers: { Authorization: `Bearer ${desktopExchange.json.token}` },
    });
    check("desktop exchanged token can fetch auth session", desktopSession.status === 200);
    check(
      "desktop exchanged token is authenticated",
      desktopSession.json.authenticated === true
    );

    console.log(`\n${PASS} Subscription integration test passed`);
  } finally {
    server.kill("SIGINT");
    await sleep(250);
    if (!server.killed) server.kill("SIGTERM");
  }
}

run().catch((err) => {
  console.error(`\n${FAIL} Subscription integration test failed`);
  console.error(err);
  process.exit(1);
});
