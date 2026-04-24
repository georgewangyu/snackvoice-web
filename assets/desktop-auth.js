"use strict";

const SESSION_STORAGE_KEY = "snackvoice.session.token";

const state = {
  requestId: "",
  sessionToken: "",
  hasAttemptedAutoOpen: false,
};

function setSessionToken(token) {
  state.sessionToken = typeof token === "string" ? token.trim() : "";
  if (state.sessionToken) {
    localStorage.setItem(SESSION_STORAGE_KEY, state.sessionToken);
  } else {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  }
}

function setStatus(message) {
  const node = document.getElementById("desktop-auth-status");
  if (node) {
    node.textContent = message || "";
  }
}

function setStage(stage) {
  const stages = {
    form: document.getElementById("desktop-auth-form-stage"),
    verify: document.getElementById("desktop-auth-verify-stage"),
    success: document.getElementById("desktop-auth-success-stage"),
    error: document.getElementById("desktop-auth-error-stage"),
  };

  Object.entries(stages).forEach(([name, node]) => {
    if (!node) return;
    node.hidden = name !== stage;
  });
}

function openSnackVoiceApp(auto = false) {
  const openUrl = resolveOpenAppUrl();
  if (!openUrl) return;
  if (auto && state.hasAttemptedAutoOpen) return;
  if (auto) {
    state.hasAttemptedAutoOpen = true;
  }
  window.location.assign(openUrl);
}

function showSuccessState({ autoOpenApp = false } = {}) {
  setStage("success");
  setStatus("");
  if (autoOpenApp) {
    window.setTimeout(() => {
      openSnackVoiceApp(true);
    }, 250);
  }
}

function setErrorCopy(message) {
  const node = document.getElementById("desktop-auth-error-copy");
  if (node) {
    node.textContent = message;
  }
}

function setFormBusy(isBusy) {
  document
    .querySelectorAll("#desktop-auth-form button, #desktop-auth-form input")
    .forEach((node) => {
      node.disabled = isBusy;
    });
}

async function jsonRequest(path, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  return { ok: response.ok, status: response.status, payload };
}

async function signIn(email, password) {
  const result = await jsonRequest("/api/auth/sign-in", {
    method: "POST",
    body: { email, password },
  });
  if (!result.ok || !result.payload?.token) {
    throw new Error(result.payload?.error || "Unable to sign in");
  }
  return result.payload;
}

async function signUp(email, password) {
  const result = await jsonRequest("/api/auth/sign-up", {
    method: "POST",
    body: { email, password },
  });
  if (!result.ok) {
    throw new Error(result.payload?.error || "Unable to create account");
  }
  return result.payload;
}

async function completeDesktopAuth(token) {
  const result = await jsonRequest("/api/auth/desktop/complete", {
    method: "POST",
    token,
    body: { requestId: state.requestId },
  });
  if (!result.ok) {
    throw new Error(
      result.payload?.error || "Unable to complete desktop sign-in handoff",
    );
  }
}

async function checkDesktopRequest() {
  const query = new URLSearchParams({ requestId: state.requestId });
  const result = await jsonRequest(`/api/auth/desktop/status?${query.toString()}`);
  const status = result.payload?.status || "invalid";

  if (status === "pending") {
    setStage("form");
    return;
  }
  if (status === "ready" || status === "consumed") {
    showSuccessState({ autoOpenApp: true });
    return;
  }
  if (status === "expired") {
    setStage("error");
    setErrorCopy("This desktop sign-in request expired. Start again from SnackVoice.");
    return;
  }

  setStage("error");
  setErrorCopy("This desktop sign-in request is invalid. Start again from SnackVoice.");
}

function bindCloseButton() {
  document
    .getElementById("desktop-auth-close-window")
    ?.addEventListener("click", () => {
      window.close();
      setStatus("You can close this tab manually if it stays open.");
    });
}

function bindOpenAppButton() {
  document
    .getElementById("desktop-auth-open-app")
    ?.addEventListener("click", () => {
      openSnackVoiceApp(false);
    });
}

function resolveOpenAppUrl() {
  const query = new URLSearchParams(window.location.search);
  const value = query.get("openAppUrl");
  return value && value.trim() ? value.trim() : "snackvoice://";
}

function applyOpenAppUrl() {
  const openLink = document.getElementById("desktop-auth-open-app");
  if (!openLink) return;
  const nextUrl = resolveOpenAppUrl();
  openLink.setAttribute("href", nextUrl);
}

function bindForm() {
  const form = document.getElementById("desktop-auth-form");
  const emailInput = document.getElementById("desktop-auth-email");
  const passwordInput = document.getElementById("desktop-auth-password");
  if (!form || !emailInput || !passwordInput) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const submitter = event.submitter;
    const mode = submitter?.dataset?.authMode === "signup" ? "signup" : "signin";

    if (!email || !password) {
      setStatus("Email and password are required.");
      return;
    }

    setFormBusy(true);
    setStatus(mode === "signup" ? "Creating account..." : "Signing in...");
    try {
      const payload =
        mode === "signup" ? await signUp(email, password) : await signIn(email, password);
      if (payload?.requiresEmailConfirmation) {
        setStage("verify");
        setStatus("");
        return;
      }
      const token = String(payload?.token || "").trim();
      if (!token) {
        throw new Error("Missing session token");
      }
      setSessionToken(token);
      await completeDesktopAuth(token);
      showSuccessState({ autoOpenApp: true });
    } catch (error) {
      setStage("form");
      setStatus(error instanceof Error ? error.message : "Unable to finish sign-in");
    } finally {
      setFormBusy(false);
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  const query = new URLSearchParams(window.location.search);
  state.requestId = (query.get("requestId") || "").trim();
  setSessionToken(localStorage.getItem(SESSION_STORAGE_KEY) || "");
  applyOpenAppUrl();
  bindForm();
  bindCloseButton();
  bindOpenAppButton();

  if (!state.requestId) {
    setStage("error");
    setErrorCopy("Missing desktop sign-in request. Start again from SnackVoice.");
    return;
  }

  try {
    await checkDesktopRequest();
  } catch {
    setStage("error");
    setErrorCopy("Could not load desktop sign-in state. Refresh and try again.");
  }
});
