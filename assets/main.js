"use strict";

// Wire up all CTA buttons to the checkout endpoint
const CTA_IDS = ["nav-cta", "hero-cta", "pricing-cta"];

function setLoading(btn, loading) {
  if (loading) {
    btn.dataset.originalText = btn.textContent;
    btn.textContent = "Loading…";
    btn.classList.add("btn-loading");
  } else {
    btn.textContent = btn.dataset.originalText || "Get SnackVoice — $49";
    btn.classList.remove("btn-loading");
  }
}

async function startCheckout(btn) {
  setLoading(btn, true);
  try {
    const res = await fetch("/api/create-checkout", { method: "POST" });
    if (!res.ok) throw new Error("Server error");
    const { url } = await res.json();
    window.location.href = url;
  } catch (err) {
    console.error("Checkout error:", err);
    alert("Something went wrong. Please try again or contact support@snackvoice.app");
    setLoading(btn, false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  CTA_IDS.forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener("click", () => startCheckout(btn));
  });
});
