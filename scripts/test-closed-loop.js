"use strict";

const { spawn } = require("child_process");
const http = require("http");

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkServerOnce(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkServerOnce(url)) return true;
    await delay(300);
  }
  return false;
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill("SIGINT");
  const exited = await Promise.race([
    new Promise((resolve) => child.on("exit", () => resolve(true))),
    delay(3000).then(() => false),
  ]);
  if (!exited && !child.killed) child.kill("SIGKILL");
}

async function main() {
  const integration = await runProcess("npm", ["run", "test:subscription:integration"]);
  if (integration.code !== 0) process.exit(integration.code || 1);

  const server = spawn("npm", ["run", "dev"], { stdio: "inherit" });
  try {
    const ready = await waitForServer("http://localhost:4200", 15000);
    if (!ready) {
      console.error("Server did not become ready on http://localhost:4200");
      process.exit(1);
    }

    const qa = await runProcess("npm", ["run", "qa"]);
    process.exit(qa.code || 0);
  } finally {
    await stopServer(server);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
