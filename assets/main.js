"use strict";

const CTA_IDS = ["nav-cta", "hero-cta", "pricing-cta", "bottom-cta"];
const REVEAL_SELECTOR = ".reveal";
const TRANSCRIPT_SELECTOR = "[data-transcript-line]";

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

function initReveals() {
  const nodes = document.querySelectorAll(REVEAL_SELECTOR);
  if (!nodes.length) return;

  if (!("IntersectionObserver" in window)) {
    nodes.forEach((node) => node.classList.add("in-view"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in-view");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.18, rootMargin: "0px 0px -8% 0px" }
  );

  nodes.forEach((node, index) => {
    node.style.setProperty("--reveal-delay", `${Math.min(index * 35, 240)}ms`);
    observer.observe(node);
  });
}

function initTranscriptCycle() {
  const lines = Array.from(document.querySelectorAll(TRANSCRIPT_SELECTOR));
  if (lines.length < 2) return;

  let activeIndex = 0;
  window.setInterval(() => {
    lines[activeIndex].classList.remove("transcript-line-active");
    activeIndex = (activeIndex + 1) % lines.length;
    lines[activeIndex].classList.add("transcript-line-active");
  }, 2600);
}

document.addEventListener("DOMContentLoaded", () => {
  CTA_IDS.forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener("click", () => startCheckout(btn));
  });

  initReveals();
  initTranscriptCycle();
});
