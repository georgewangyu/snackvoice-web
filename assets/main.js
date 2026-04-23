"use strict";

const CTA_IDS = ["nav-cta", "hero-cta", "pricing-cta", "bottom-cta"];
const PLAN_SWITCH_SELECTOR = "[data-plan-option]";
const REVEAL_SELECTOR = ".reveal";
const TRANSCRIPT_SELECTOR = "[data-transcript-line]";
const SESSION_STORAGE_KEY = "snackvoice.session.token";
const PENDING_CHECKOUT_KEY = "snackvoice.pending.checkout";
const PENDING_CHECKOUT_TTL_MS = 30 * 60 * 1000;

const PLAN_META = {
  monthly: {
    ctaLabel: "Start Monthly — $14.99",
    pricingSubtitle: "Monthly · Unlimited words",
  },
  annual: {
    ctaLabel: "Start Annual — $149.99",
    pricingSubtitle: "Annual · $149.99/year · Unlimited words",
  },
};

const state = {
  selectedPlan: "monthly",
  sessionToken: "",
  account: null,
};

function authHeaders(includeJson = false) {
  const headers = {};
  if (includeJson) headers["Content-Type"] = "application/json";
  if (state.sessionToken) headers.Authorization = `Bearer ${state.sessionToken}`;
  return headers;
}

function setLoading(btn, loading) {
  if (loading) {
    btn.dataset.originalText = btn.textContent;
    btn.textContent = "Starting checkout…";
    btn.classList.add("btn-loading");
  } else {
    btn.textContent = btn.dataset.originalText || PLAN_META[state.selectedPlan].ctaLabel;
    btn.classList.remove("btn-loading");
  }
}

function setAuthStatus(message) {
  const el = document.getElementById("auth-email-status");
  if (el) el.textContent = message;
}

function setSessionToken(token) {
  state.sessionToken = typeof token === "string" ? token.trim() : "";
  if (state.sessionToken) {
    localStorage.setItem(SESSION_STORAGE_KEY, state.sessionToken);
  } else {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  }
}

function selectedPlan() {
  if (state.selectedPlan === "annual") return "annual";
  return "monthly";
}

function rememberPendingCheckout() {
  const payload = {
    plan: selectedPlan(),
    at: Date.now(),
  };
  localStorage.setItem(PENDING_CHECKOUT_KEY, JSON.stringify(payload));
}

function consumePendingCheckout() {
  const raw = localStorage.getItem(PENDING_CHECKOUT_KEY);
  if (!raw) return null;
  localStorage.removeItem(PENDING_CHECKOUT_KEY);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const at = Number(parsed.at || 0);
    if (!Number.isFinite(at) || Date.now() - at > PENDING_CHECKOUT_TTL_MS) {
      return null;
    }
    const plan = parsed.plan === "annual" ? "annual" : "monthly";
    return { plan };
  } catch {
    return null;
  }
}

function openAuthModal() {
  const modal = document.getElementById("auth-modal");
  if (!modal) return;
  modal.hidden = false;
}

function closeAuthModal() {
  const modal = document.getElementById("auth-modal");
  if (!modal) return;
  modal.hidden = true;
  setAuthStatus("");
}

function updatePlanUI() {
  const plan = selectedPlan();
  document.querySelectorAll(PLAN_SWITCH_SELECTOR).forEach((node) => {
    const button = node;
    const isActive = button.dataset.planOption === plan;
    button.classList.toggle("plan-switch-btn-active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  const pricingSubtitle = document.getElementById("pricing-plan-subtitle");
  if (pricingSubtitle) {
    pricingSubtitle.textContent = PLAN_META[plan].pricingSubtitle;
  }

  CTA_IDS.forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.textContent = PLAN_META[plan].ctaLabel;
  });
}

function updateAccountUI() {
  const authenticated = !!state.account?.authenticated;
  const navAccountBtn = document.getElementById("nav-account-btn");
  const accountSignInBtn = document.getElementById("account-signin-btn");
  const accountManageBtn = document.getElementById("account-manage-btn");
  const accountSignOutBtn = document.getElementById("account-signout-btn");
  const accountSummary = document.getElementById("account-summary");
  const accountMeta = document.getElementById("account-meta");

  if (navAccountBtn) {
    navAccountBtn.textContent = authenticated
      ? (state.account.user?.email || "Account")
      : "Sign in";
  }
  if (accountSignInBtn) accountSignInBtn.hidden = authenticated;
  if (accountManageBtn) accountManageBtn.hidden = !authenticated;
  if (accountSignOutBtn) accountSignOutBtn.hidden = !authenticated;

  if (!accountSummary || !accountMeta) return;

  if (!authenticated) {
    accountSummary.textContent = "Sign in required before checkout.";
    accountMeta.textContent =
      "Use one email account across devices to keep usage and subscription status in sync.";
    return;
  }

  const entitlement = state.account.entitlement || {};
  const status = entitlement.accountStatus || "free";
  const plan = entitlement.subscription?.plan || "free";
  const weekly = entitlement.weeklyQuota || {};

  accountSummary.textContent = `${status} · ${plan}`;
  if (entitlement.isUnlimited) {
    accountMeta.textContent = "Unlimited words active for this account.";
  } else {
    accountMeta.textContent = `Free tier: ${weekly.remaining ?? 0}/${weekly.limit ?? 0} words remaining this week.`;
  }
}

async function refreshSession() {
  if (!state.sessionToken) {
    state.account = { authenticated: false };
    updateAccountUI();
    return;
  }
  try {
    const res = await fetch("/api/auth/session", {
      method: "GET",
      headers: authHeaders(false),
    });
    const body = await res.json();
    if (!body?.authenticated) {
      setSessionToken("");
      state.account = { authenticated: false };
      updateAccountUI();
      return;
    }
    state.account = body;
    updateAccountUI();
  } catch (error) {
    console.error("Session check failed:", error);
  }
}

async function startCheckout(btn) {
  if (!state.account?.authenticated) {
    rememberPendingCheckout();
    openAuthModal();
    return;
  }

  if (btn) setLoading(btn, true);
  try {
    const res = await fetch("/api/create-checkout", {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ plan: selectedPlan() }),
    });
    const payload = await res.json();
    if (!res.ok || !payload?.url) {
      throw new Error(payload?.error || "Checkout failed");
    }
    window.location.href = payload.url;
  } catch (error) {
    console.error("Checkout error:", error);
    alert(
      "Unable to start checkout. Make sure you are signed in, then try again.",
    );
    if (btn) setLoading(btn, false);
  }
}

async function signUp(email, password) {
  const res = await fetch("/api/auth/sign-up", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload?.error || "Unable to create account");
  }
  if (payload?.requiresEmailConfirmation) {
    return payload;
  }
  if (!payload?.token) {
    throw new Error("Unable to create account");
  }
  return payload;
}

async function signIn(email, password) {
  const res = await fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const payload = await res.json();
  if (!res.ok || !payload?.token) {
    throw new Error(payload?.error || "Unable to sign in");
  }
  return payload;
}

async function manageSubscription() {
  if (!state.account?.authenticated) {
    openAuthModal();
    return;
  }
  try {
    const res = await fetch("/api/manage-subscription", {
      method: "POST",
      headers: authHeaders(false),
    });
    const payload = await res.json();
    if (!res.ok || !payload?.url) {
      throw new Error(payload?.error || "Unable to open billing portal");
    }
    window.location.href = payload.url;
  } catch (error) {
    alert("Unable to open billing portal right now.");
    console.error("Manage subscription failed:", error);
  }
}

async function signOut() {
  if (!state.sessionToken) return;
  try {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: authHeaders(false),
    });
  } catch (error) {
    console.warn("Sign-out request failed:", error);
  } finally {
    setSessionToken("");
    state.account = { authenticated: false };
    updateAccountUI();
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

function bindAuthUi() {
  const authModal = document.getElementById("auth-modal");
  const authForm = document.getElementById("auth-form");
  const authEmailInput = document.getElementById("auth-email");
  const authPasswordInput = document.getElementById("auth-password");

  document.getElementById("auth-modal-close")?.addEventListener("click", closeAuthModal);
  authModal?.querySelector("[data-auth-close]")?.addEventListener("click", closeAuthModal);

  authForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = authEmailInput?.value?.trim() || "";
    const password = authPasswordInput?.value || "";
    const submitter = event.submitter;
    const mode = submitter?.dataset?.authMode === "signup" ? "signup" : "signin";
    if (!email || !password) return;
    setAuthStatus(mode === "signup" ? "Creating account..." : "Signing in...");
    try {
      const payload =
        mode === "signup" ? await signUp(email, password) : await signIn(email, password);
      if (payload.requiresEmailConfirmation) {
        setAuthStatus(
          payload.message ||
            "Account created. Check your email to confirm your account, then sign in.",
        );
        return;
      }
      setSessionToken(payload.token);
      await refreshSession();
      closeAuthModal();
      const pending = consumePendingCheckout();
      if (pending) {
        state.selectedPlan = pending.plan;
        updatePlanUI();
        await startCheckout(null);
      }
    } catch (error) {
      setAuthStatus(error.message);
    }
  });

  document.getElementById("nav-account-btn")?.addEventListener("click", () => {
    if (state.account?.authenticated) {
      void manageSubscription();
    } else {
      openAuthModal();
    }
  });
  document.getElementById("account-signin-btn")?.addEventListener("click", openAuthModal);
  document.getElementById("account-manage-btn")?.addEventListener("click", () => {
    void manageSubscription();
  });
  document.getElementById("account-signout-btn")?.addEventListener("click", () => {
    void signOut();
  });
}

function bindPlanSwitches() {
  document.querySelectorAll(PLAN_SWITCH_SELECTOR).forEach((node) => {
    node.addEventListener("click", () => {
      const plan = node.dataset.planOption === "annual" ? "annual" : "monthly";
      state.selectedPlan = plan;
      updatePlanUI();
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  const storedToken = localStorage.getItem(SESSION_STORAGE_KEY) || "";
  setSessionToken(storedToken);

  CTA_IDS.forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener("click", () => void startCheckout(btn));
  });

  bindPlanSwitches();
  bindAuthUi();
  initReveals();
  initTranscriptCycle();
  updatePlanUI();
  await refreshSession();
});
