"use strict";

/**
 * SnackVoice Web — Puppeteer QA
 * Run: node scripts/qa.js
 * Requires the dev server to be running on PORT (default 4200)
 */

const puppeteer = require("puppeteer");

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
  const browser = await puppeteer.launch({ headless: "new" });
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

  const navCta = await page.$("#nav-cta");
  assert("Nav CTA button present", !!navCta);

  const heroCta = await page.$("#hero-cta");
  assert("Hero CTA button present", !!heroCta);

  const pricingCta = await page.$("#pricing-cta");
  assert("Pricing CTA button present", !!pricingCta);

  const featCards = await page.$$(".feature-card");
  assert("6 feature cards rendered", featCards.length === 6);

  const howSteps = await page.$$(".how-step");
  assert("3 how-it-works steps rendered", howSteps.length === 3);

  const pricingCard = await page.$(".pricing-card");
  assert("Pricing card present", !!pricingCard);

  const priceAmount = await page.$eval(".price-amount", (el) => el.textContent.trim());
  assert("Price shows $49", priceAmount.includes("49"));

  // ── Checkout API ──────────────────────────────────────────────────────────
  console.log("\n[2] Checkout API");
  const apiRes = await page.evaluate(async (base) => {
    try {
      const r = await fetch(`${base}/api/create-checkout`, { method: "POST" });
      return { status: r.status, body: await r.json() };
    } catch (e) {
      return { error: e.message };
    }
  }, BASE);

  assert("POST /api/create-checkout returns 200", apiRes.status === 200);
  assert("Response has url field", typeof apiRes.body?.url === "string");

  // ── CTA click → loading state ─────────────────────────────────────────────
  console.log("\n[3] CTA interactions");
  await page.goto(BASE, { waitUntil: "networkidle0" });

  // Intercept fetch so we can test loading state without actually redirecting
  await page.setRequestInterception(true);
  page.once("request", (req) => {
    if (req.url().includes("/api/create-checkout")) {
      // Hold response briefly so we can observe the loading state
      setTimeout(() => req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ url: "#" }) }), 500);
    } else {
      req.continue();
    }
  });

  await page.click("#hero-cta");
  await new Promise((r) => setTimeout(r, 80));
  const btnText = await page.$eval("#hero-cta", (el) => el.textContent.trim());
  assert("CTA shows loading state on click", btnText === "Loading…");

  // Wait for interception to complete, then disable
  await new Promise((r) => setTimeout(r, 600));
  await page.setRequestInterception(false);

  // ── Success page ──────────────────────────────────────────────────────────
  console.log("\n[4] Success page");
  await page.goto(`${BASE}/success.html`, { waitUntil: "networkidle0" });

  const successH1 = await page.$eval("h1", (el) => el.textContent.trim());
  assert("Success page h1 present", successH1.length > 0);

  const successSteps = await page.$$(".success-step");
  assert("4 success steps shown", successSteps.length === 4);

  // ── Responsive (mobile) ───────────────────────────────────────────────────
  console.log("\n[5] Mobile viewport");
  await page.setViewport({ width: 375, height: 812 });
  await page.goto(BASE, { waitUntil: "networkidle0" });

  const mobileH1 = await page.$eval("h1", (el) => el.textContent.trim());
  assert("Hero headline visible on mobile", mobileH1.length > 0);

  const mobileCta = await page.$("#hero-cta");
  const mobilCtaVisible = await mobileCta.isIntersectingViewport();
  assert("Hero CTA visible on mobile", mobilCtaVisible);

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
