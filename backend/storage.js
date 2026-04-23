"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
let Pool = null;

try {
  ({ Pool } = require("pg"));
} catch {
  Pool = null;
}

const SUPABASE_DB_URL =
  process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "";
const SUPABASE_DB_SSL = process.env.SUPABASE_DB_SSL;
const USE_POSTGRES = !!(SUPABASE_DB_URL && Pool);

function resolveSslConfig() {
  if (SUPABASE_DB_SSL === "false") return false;
  if (SUPABASE_DB_SSL === "true") return { rejectUnauthorized: false };
  if (SUPABASE_DB_URL.includes("localhost")) return false;
  return { rejectUnauthorized: false };
}

function loadJsonFileSync(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) return fallbackValue;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallbackValue;
  }
}

async function saveJsonFile(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2));
}

function ensureObject(value) {
  return value && typeof value === "object" ? value : {};
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

class FileStorage {
  constructor({ billingPath, ordersPath }) {
    this.billingPath = billingPath;
    this.ordersPath = ordersPath;
  }

  async loadBilling() {
    return ensureObject(loadJsonFileSync(this.billingPath, {}));
  }

  async saveBilling(billing) {
    await saveJsonFile(this.billingPath, ensureObject(billing));
  }

  async loadOrders() {
    return ensureArray(loadJsonFileSync(this.ordersPath, []));
  }

  async saveOrder(order) {
    const orders = await this.loadOrders();
    const existingIndex = orders.findIndex(
      (item) => item.stripeSessionId === order.stripeSessionId
    );
    const nextOrder = { ...order };
    if (existingIndex >= 0) {
      orders[existingIndex] = { ...orders[existingIndex], ...nextOrder };
    } else {
      orders.push(nextOrder);
    }
    await saveJsonFile(this.ordersPath, orders);
  }

  async getStoredOrderBySessionId(sessionId) {
    const orders = await this.loadOrders();
    return orders.find((order) => order.stripeSessionId === sessionId) || null;
  }
}

class PostgresStorage {
  constructor() {
    this.pool = new Pool({
      connectionString: SUPABASE_DB_URL,
      ssl: resolveSslConfig(),
      max: Number(process.env.SUPABASE_DB_POOL_MAX || 8),
    });
    this.schemaReady = null;
  }

  async ensureSchema() {
    if (this.schemaReady) return this.schemaReady;
    this.schemaReady = this.pool.query(`
      create table if not exists snackvoice_kv_users (
        id text primary key,
        payload jsonb not null,
        updated_at timestamptz not null default now()
      );
      create table if not exists snackvoice_kv_subscriptions (
        id text primary key,
        payload jsonb not null,
        updated_at timestamptz not null default now()
      );
      create table if not exists snackvoice_kv_checkout_sessions (
        id text primary key,
        payload jsonb not null,
        updated_at timestamptz not null default now()
      );
      create table if not exists snackvoice_kv_webhook_events (
        id text primary key,
        payload jsonb not null,
        updated_at timestamptz not null default now()
      );
      create table if not exists snackvoice_kv_sessions (
        id text primary key,
        payload jsonb not null,
        updated_at timestamptz not null default now()
      );
      create table if not exists snackvoice_kv_orders (
        id text primary key,
        payload jsonb not null,
        updated_at timestamptz not null default now()
      );
    `);
    return this.schemaReady;
  }

  async readCollection(table) {
    await this.ensureSchema();
    const result = await this.pool.query(
      `select payload from ${table} order by updated_at asc`
    );
    return result.rows.map((row) => row.payload);
  }

  async replaceCollection(table, idField, items) {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from ${table}`);
      for (const item of items) {
        const id = String(item?.[idField] || "");
        if (!id) continue;
        await client.query(
          `insert into ${table} (id, payload, updated_at) values ($1, $2::jsonb, now())`,
          [id, JSON.stringify(item)]
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async loadBilling() {
    const [
      users,
      subscriptions,
      checkoutSessions,
      webhookEvents,
      sessions,
    ] = await Promise.all([
      this.readCollection("snackvoice_kv_users"),
      this.readCollection("snackvoice_kv_subscriptions"),
      this.readCollection("snackvoice_kv_checkout_sessions"),
      this.readCollection("snackvoice_kv_webhook_events"),
      this.readCollection("snackvoice_kv_sessions"),
    ]);

    return {
      users,
      subscriptions,
      checkoutSessions,
      webhookEvents,
      sessions,
    };
  }

  async saveBilling(billing) {
    const safe = ensureObject(billing);
    await Promise.all([
      this.replaceCollection(
        "snackvoice_kv_users",
        "userId",
        ensureArray(safe.users)
      ),
      this.replaceCollection(
        "snackvoice_kv_subscriptions",
        "stripeSubscriptionId",
        ensureArray(safe.subscriptions)
      ),
      this.replaceCollection(
        "snackvoice_kv_checkout_sessions",
        "stripeSessionId",
        ensureArray(safe.checkoutSessions)
      ),
      this.replaceCollection(
        "snackvoice_kv_webhook_events",
        "eventId",
        ensureArray(safe.webhookEvents)
      ),
      this.replaceCollection(
        "snackvoice_kv_sessions",
        "sessionId",
        ensureArray(safe.sessions)
      ),
    ]);
  }

  async loadOrders() {
    return this.readCollection("snackvoice_kv_orders");
  }

  async saveOrder(order) {
    await this.ensureSchema();
    const id = String(order?.stripeSessionId || "");
    if (!id) return;
    await this.pool.query(
      `
        insert into snackvoice_kv_orders (id, payload, updated_at)
        values ($1, $2::jsonb, now())
        on conflict (id)
        do update set payload = excluded.payload, updated_at = now()
      `,
      [id, JSON.stringify(order)]
    );
  }

  async getStoredOrderBySessionId(sessionId) {
    await this.ensureSchema();
    const result = await this.pool.query(
      `select payload from snackvoice_kv_orders where id = $1 limit 1`,
      [sessionId]
    );
    if (!result.rows.length) return null;
    return result.rows[0].payload || null;
  }
}

function createStorage(paths) {
  if (USE_POSTGRES) return new PostgresStorage();
  return new FileStorage(paths);
}

module.exports = {
  createStorage,
  USE_POSTGRES,
};
