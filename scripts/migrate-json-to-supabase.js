"use strict";

const fs = require("fs");
const path = require("path");
const { createStorage, USE_POSTGRES } = require("../backend/storage");

const repoRoot = path.resolve(__dirname, "..");
const billingPath = process.env.BILLING_DATA_PATH
  ? path.resolve(repoRoot, process.env.BILLING_DATA_PATH)
  : path.join(repoRoot, "backend", "data", "billing.json");
const ordersPath = process.env.ORDERS_DATA_PATH
  ? path.resolve(repoRoot, process.env.ORDERS_DATA_PATH)
  : path.join(repoRoot, "backend", "data", "orders.json");

function parseJsonFile(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) return fallbackValue;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallbackValue;
  }
}

function ensureBillingShape(raw) {
  const billing = raw && typeof raw === "object" ? raw : {};
  if (!Array.isArray(billing.users)) billing.users = [];
  if (!Array.isArray(billing.subscriptions)) billing.subscriptions = [];
  if (!Array.isArray(billing.checkoutSessions)) billing.checkoutSessions = [];
  if (!Array.isArray(billing.webhookEvents)) billing.webhookEvents = [];
  if (!Array.isArray(billing.magicLinks)) billing.magicLinks = [];
  if (!Array.isArray(billing.sessions)) billing.sessions = [];
  return billing;
}

async function main() {
  if (!USE_POSTGRES) {
    console.error(
      "Postgres storage is not enabled. Set SUPABASE_DB_URL or DATABASE_URL first."
    );
    process.exit(1);
  }

  const storage = createStorage({ billingPath, ordersPath });
  const billing = ensureBillingShape(parseJsonFile(billingPath, {}));
  const orders = parseJsonFile(ordersPath, []);

  await storage.saveBilling(billing);
  for (const order of Array.isArray(orders) ? orders : []) {
    await storage.saveOrder(order);
  }

  console.log("Migration complete.");
  console.log(`  users: ${billing.users.length}`);
  console.log(`  subscriptions: ${billing.subscriptions.length}`);
  console.log(`  checkoutSessions: ${billing.checkoutSessions.length}`);
  console.log(`  webhookEvents: ${billing.webhookEvents.length}`);
  console.log(`  magicLinks: ${billing.magicLinks.length}`);
  console.log(`  sessions: ${billing.sessions.length}`);
  console.log(`  orders: ${Array.isArray(orders) ? orders.length : 0}`);
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
