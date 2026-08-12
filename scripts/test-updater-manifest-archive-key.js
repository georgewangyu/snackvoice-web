"use strict";

const assert = require("assert");
const { resolveUpdaterArchiveKey } = require("../backend/updater-manifest");

const keys = {
  manifestKey: "updater/macos/aarch64/latest.json",
  archiveKey: "updater/macos/aarch64/SnackVoice.app.tar.gz",
  platformKey: "darwin-aarch64",
};
const origin = "https://downloads.example.s3.us-west-2.amazonaws.com";

function manifest(version, url) {
  return {
    version,
    platforms: {
      "darwin-aarch64": { signature: "fixture", url },
    },
  };
}

assert.strictEqual(
  resolveUpdaterArchiveKey(
    manifest(
      "1.0.11",
      `${origin}/updater/macos/aarch64/releases/v1.0.11/SnackVoice.app.tar.gz`,
    ),
    keys,
    origin,
  ),
  "updater/macos/aarch64/releases/v1.0.11/SnackVoice.app.tar.gz",
);

assert.strictEqual(
  resolveUpdaterArchiveKey(
    manifest("1.0.10", `${origin}/${keys.archiveKey}`),
    keys,
    origin,
  ),
  keys.archiveKey,
);

for (const version of ["1.0.11", "999.0.0"]) {
  assert.throws(() =>
    resolveUpdaterArchiveKey(
      manifest(version, `${origin}/${keys.archiveKey}`),
      keys,
      origin,
    ),
  );
}

for (const version of ["1.0.11?", "garbage1.0.11"]) {
  assert.throws(() =>
    resolveUpdaterArchiveKey(
      manifest(
        version,
        `${origin}/updater/macos/aarch64/releases/v1.0.11/SnackVoice.app.tar.gz`,
      ),
      keys,
      origin,
    ),
  );
}

for (const version of ["v1.0.10", "1.0.10?"]) {
  assert.throws(() =>
    resolveUpdaterArchiveKey(
      manifest(version, `${origin}/${keys.archiveKey}`),
      keys,
      origin,
    ),
  );
}

for (const url of [
  "https://evil.example/updater/macos/aarch64/releases/v1.0.11/SnackVoice.app.tar.gz",
  `${origin}/updater/macos/aarch64/releases/v1.0.10/SnackVoice.app.tar.gz`,
  `${origin}/updater/macos/aarch64/releases/v1.0.11/Other.app.tar.gz`,
  `${origin}/updater/macos/aarch64/releases/v1.0.11/SnackVoice.app.tar.gz?token=secret`,
  `${origin}/updater/macos/aarch64/releases/v1.0.11/SnackVoice.app.tar.gz?`,
  `${origin}/updater/macos/aarch64/releases/v1.0.11%2FSnackVoice.app.tar.gz`,
  `${origin}/evil/%2e%2e/updater/macos/aarch64/releases/v1.0.11/SnackVoice.app.tar.gz`,
  `${origin}/updater/macos/aarch64/releases/v1.0.11/foo/../SnackVoice.app.tar.gz`,
  `${origin}//updater/macos/aarch64/releases/v1.0.11/SnackVoice.app.tar.gz`,
]) {
  assert.throws(() =>
    resolveUpdaterArchiveKey(manifest("1.0.11", url), keys, origin),
  );
}

const betaKeys = {
  manifestKey: "updater-beta/macos/aarch64/latest.json",
  archiveKey: "updater-beta/macos/aarch64/SnackVoice.app.tar.gz",
  platformKey: "darwin-aarch64",
};
assert.strictEqual(
  resolveUpdaterArchiveKey(
    manifest(
      "1.0.11",
      `${origin}/updater-beta/macos/aarch64/releases/v1.0.11/SnackVoice.app.tar.gz`,
    ),
    betaKeys,
    origin,
  ),
  "updater-beta/macos/aarch64/releases/v1.0.11/SnackVoice.app.tar.gz",
);
assert.throws(() =>
  resolveUpdaterArchiveKey(
    manifest("1.0.11", `${origin}/${betaKeys.archiveKey}`),
    betaKeys,
    origin,
  ),
);
assert.throws(() =>
  resolveUpdaterArchiveKey(
    manifest("1.0.10", `${origin}/${betaKeys.archiveKey}`),
    betaKeys,
    origin,
  ),
);
const betaX64Keys = {
  manifestKey: "updater-beta/macos/x64/latest.json",
  archiveKey: "updater-beta/macos/x64/SnackVoice.app.tar.gz",
  platformKey: "darwin-x86_64",
};
assert.throws(() =>
  resolveUpdaterArchiveKey(
    {
      version: "1.0.10",
      platforms: {
        "darwin-x86_64": {
          signature: "fixture",
          url: `${origin}/${betaX64Keys.archiveKey}`,
        },
      },
    },
    betaX64Keys,
    origin,
  ),
);

async function testProtectedBetaDelivery() {
  const betaManifest = manifest(
    "1.0.11",
    `${origin}/updater-beta/macos/aarch64/releases/v1.0.11/SnackVoice.app.tar.gz`,
  );
  const signedKeys = [];
  const response = {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = "") {
      this.body = body;
    },
  };
  const appModule = require("../backend/app");

  await appModule.serveUpdaterManifest(response, betaKeys, {
    archiveUrl:
      "https://app.example/api/updater/beta/macos/aarch64/SnackVoice.app.tar.gz",
    expectedS3Origin: origin,
    readManifest: async () => JSON.stringify(betaManifest),
    signArchive: async (key) => {
      signedKeys.push(key);
      return "https://signed.example/archive";
    },
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(signedKeys.length, 0);

  response.status = null;
  response.headers = null;
  response.body = "";
  await appModule.serveUpdaterArchiveRedirect(response, betaKeys, {
    expectedS3Origin: origin,
    readManifest: async () => JSON.stringify(betaManifest),
    signArchive: async (key) => {
      signedKeys.push(key);
      return "https://signed.example/archive";
    },
  });
  assert.strictEqual(response.status, 302);
  assert.deepStrictEqual(signedKeys, [
    "updater-beta/macos/aarch64/releases/v1.0.11/SnackVoice.app.tar.gz",
  ]);

  const legacyBetaManifest = manifest(
    "1.0.10",
    `${origin}/${betaKeys.archiveKey}`,
  );
  await assert.rejects(() =>
    appModule.serveUpdaterManifest(response, betaKeys, {
      archiveUrl:
        "https://app.example/api/updater/beta/macos/aarch64/SnackVoice.app.tar.gz",
      expectedS3Origin: origin,
      readManifest: async () => JSON.stringify(legacyBetaManifest),
    }),
  );
  await assert.rejects(() =>
    appModule.serveUpdaterArchiveRedirect(response, betaKeys, {
      expectedS3Origin: origin,
      readManifest: async () => JSON.stringify(legacyBetaManifest),
      signArchive: async () => "https://signed.example/archive",
    }),
  );
}

async function testStableEndpointIgnoresBetaEligibleAuthentication() {
  const appModule = require("../backend/app");
  const response = {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = "") {
      this.body = body;
    },
  };
  let selectedKeys = null;

  await appModule.handleUnifiedUpdaterManifest(
    { headers: { authorization: "Bearer beta-eligible-fixture" } },
    response,
    "aarch64",
    {
      getConfigError: () => "",
      serveManifest: async (_res, candidateKeys) => {
        selectedKeys = candidateKeys;
        return "served";
      },
    },
  );

  assert.deepStrictEqual(selectedKeys, keys);
}

Promise.all([
  testProtectedBetaDelivery(),
  testStableEndpointIgnoresBetaEligibleAuthentication(),
])
  .then(() => console.log("SnackVoice updater archive-key tests passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
