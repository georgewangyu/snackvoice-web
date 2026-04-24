"use strict";

/**
 * SnackVoice Web — Puppeteer QA
 * Run: node scripts/qa.js
 * Requires the dev server to be running on PORT (default 4200)
 */

const puppeteer = require("puppeteer");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.APP_URL || "http://localhost:4200";
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}`);
    failed++;
  }
}

async function run() {
  const chromeFromEnv = process.env.PUPPETEER_EXECUTABLE_PATH || "";
  const chromeDefaultPath = path.join(
    os.homedir(),
    ".cache/puppeteer/chrome/mac-127.0.6533.88/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
  );
  const executablePath = chromeFromEnv
    ? chromeFromEnv
    : fs.existsSync(chromeDefaultPath)
      ? chromeDefaultPath
      : undefined;
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // ── Landing page ─────────────────────────────────────────────────────────
  console.log("\n[1] Landing page");
  await page.goto(BASE, { waitUntil: "networkidle0" });

  const title = await page.title();
  assert("Page title contains SnackVoice", title.includes("SnackVoice"));

  const h1 = await page.$eval("h1", (el) => el.textContent.trim());
  assert("Hero headline present", h1.length > 0);

  const nav = await page.$("nav");
  assert("Nav bar present", !!nav);

  const navDownload = await page.$("#nav-download");
  assert("Nav download button present", !!navDownload);

  const heroDownload = await page.$("#hero-download");
  assert("Hero download button present", !!heroDownload);

  const pricingDownload = await page.$("#pricing-download");
  assert("Pricing download button present", !!pricingDownload);

  const featCards = await page.$$(".feature-card");
  assert("6 feature cards rendered", featCards.length === 6);

  const howSteps = await page.$$(".how-step");
  assert("3 how-it-works steps rendered", howSteps.length === 3);

  const pricingCard = await page.$(".pricing-card");
  assert("Pricing card present", !!pricingCard);

  const priceAmount = await page.$eval(".price-amount", (el) => el.textContent.trim());
  assert("Price shows monthly 14.99", priceAmount.includes("14.99"));

  // ── Plan switching ────────────────────────────────────────────────────────
  console.log("\n[2] Plan switch");
  await page.click('[data-plan-option="annual"]');
  await new Promise((r) => setTimeout(r, 80));

  const pricingAmountAnnual = await page.$eval("#pricing-plan-price", (el) =>
    el.textContent.trim()
  );
  assert("Pricing amount updates to annual", pricingAmountAnnual.includes("149.99"));

  const pricingSubtitle = await page.$eval("#pricing-plan-subtitle", (el) =>
    el.textContent.trim()
  );
  assert("Pricing subtitle updates to annual", pricingSubtitle.includes("Annual"));

  // ── Auth modal + sign-in smoke ────────────────────────────────────────────
  console.log("\n[3] Auth modal + account");
  await page.click("#nav-account-btn");
  await new Promise((r) => setTimeout(r, 120));

  const modalVisibleAfterCta = await page.$eval("#auth-modal", (el) => !el.hidden);
  assert("Unauthenticated account action opens auth modal", modalVisibleAfterCta);

  const qaEmail = `qa+${Date.now()}@example.com`;
  const qaPassword = "password123";
  await page.type("#auth-email", qaEmail);
  await page.type("#auth-password", qaPassword);
  await page.click("#auth-signup-submit");
  await new Promise((r) => setTimeout(r, 180));

  const modalHiddenAfterVerify = await page.$eval("#auth-modal", (el) => el.hidden);
  assert("Password auth closes auth modal", modalHiddenAfterVerify);

  const accountSummary = await page.$eval("#account-summary", (el) => el.textContent.trim());
  assert("Account panel updates after sign-in", !accountSummary.includes("Already subscribed"));

  // ── Download API route shape ──────────────────────────────────────────────
  console.log("\n[4] Download API shape");
  const apiRes = await page.evaluate(async (base) => {
    try {
      const r = await fetch(`${base}/api/download/latest?arch=arm64`, {
        method: "GET",
        redirect: "manual",
      });
      const contentType = r.headers.get("content-type") || "";
      let body = {};
      if (contentType.includes("application/json")) {
        body = await r.json();
      }
      return {
        status: r.status,
        location: r.headers.get("location") || "",
        body,
      };
    } catch (e) {
      return { error: e.message };
    }
  }, BASE);
  assert(
    "GET /api/download/latest returns known status",
    apiRes.status === 302 || apiRes.status === 503
  );
  const downloadHasExpectedPayload =
    (apiRes.status === 302 && apiRes.location.length > 0) ||
    (apiRes.status === 503 && typeof apiRes.body?.error === "string");
  assert("Download API returns redirect or structured error", downloadHasExpectedPayload);

  // ── Success page ──────────────────────────────────────────────────────────
  console.log("\n[5] Success page");
  await page.goto(`${BASE}/success.html`, { waitUntil: "networkidle0" });

  const successH1 = await page.$eval("h1", (el) => el.textContent.trim());
  assert("Success page h1 present", successH1.length > 0);

  const orderPanel = await page.$("#order-panel");
  assert("Order status panel shown", !!orderPanel);

  // ── Responsive (mobile) ───────────────────────────────────────────────────
  console.log("\n[6] Mobile viewport");
  await page.setViewport({ width: 375, height: 812 });
  await page.goto(BASE, { waitUntil: "networkidle0" });

  const mobileH1 = await page.$eval("h1", (el) => el.textContent.trim());
  assert("Hero headline visible on mobile", mobileH1.length > 0);

  const mobileCta = await page.$("#hero-download");
  const mobilCtaVisible = await mobileCta.isIntersectingViewport();
  assert("Hero download button visible on mobile", mobilCtaVisible);

  // ── Results ───────────────────────────────────────────────────────────────
  await browser.close();
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\x1b[31mQA FAILED\x1b[0m");
    process.exit(1);
  } else {
    console.log("\x1b[32mQA PASSED\x1b[0m");
  }
}

run().catch((err) => {
  console.error("QA runner crashed:", err);
  process.exit(1);
});
