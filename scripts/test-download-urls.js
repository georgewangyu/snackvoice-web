"use strict";

// Unit tests for download link signing: CloudFront signed URLs when configured,
// S3 presigned URLs as the fallback.

const assert = require("assert");
const crypto = require("crypto");

// Keep a developer's backend/.env from leaking real values into the tests.
process.env.ENV_FILE = "scripts/.no-such-env-file";

process.env.S3_BUCKET = "fixture-bucket";
process.env.AWS_REGION = "us-west-2";
process.env.S3_KEY_ARM64 = "SnackVoice-Apple-Silicon.dmg";
process.env.S3_SIGNED_URL_TTL_SECONDS = "600";
process.env.AWS_ACCESS_KEY_ID = "AKIAFIXTUREFIXTURE00";
process.env.AWS_SECRET_ACCESS_KEY = "fixture-secret";
delete process.env.CLOUDFRONT_DOWNLOAD_DOMAIN;
delete process.env.CLOUDFRONT_KEY_PAIR_ID;
delete process.env.CLOUDFRONT_PRIVATE_KEY;

const {
  normalizePrivateKey,
  getCloudFrontDownloadConfig,
  createCloudFrontSignedUrl,
} = require("../backend/download-urls");
const {
  createSignedDownloadUrl,
  createSignedUpdaterArchiveUrl,
  serveUpdaterManifest,
  serveUpdaterArchiveRedirect,
} = require("../backend/app");

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const oneLinePem = privateKey.replace(/\n/g, "\\n");

// CloudFront base64 variant: + -> -, = -> _, / -> ~
function decodeCloudFrontBase64(value) {
  return Buffer.from(
    value.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"),
    "base64"
  );
}

function verifyCannedSignature(signedUrl) {
  const url = new URL(signedUrl);
  const expires = Number(url.searchParams.get("Expires"));
  const signature = url.searchParams.get("Signature");
  const resource = signedUrl.slice(0, signedUrl.lastIndexOf("Expires=") - 1);
  const policy = JSON.stringify({
    Statement: [
      {
        Resource: resource,
        Condition: { DateLessThan: { "AWS:EpochTime": expires } },
      },
    ],
  });
  return crypto.verify(
    "RSA-SHA1",
    Buffer.from(policy),
    publicKey,
    decodeCloudFrontBase64(signature)
  );
}

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status, headers = {}) {
      this.status = status;
      Object.assign(this.headers, headers);
    },
    end(body = "") {
      this.body += body;
    },
  };
}

function captureLogger() {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(message) };
}

// Built like backend/app.js builds the S3 origin, from bucket and region.
const S3_FIXTURE_HOST = `${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`;

async function main() {
  // Config parsing
  const quiet = captureLogger();
  assert.strictEqual(getCloudFrontDownloadConfig({}, quiet), null);
  assert.strictEqual(quiet.warnings.length, 0, "fully unset is silent");

  const partial = captureLogger();
  assert.strictEqual(
    getCloudFrontDownloadConfig(
      { CLOUDFRONT_DOWNLOAD_DOMAIN: "cdn.example.com", CLOUDFRONT_KEY_PAIR_ID: "KFIXTURE" },
      partial
    ),
    null,
    "missing private key disables CloudFront"
  );
  assert.match(partial.warnings[0], /missing CLOUDFRONT_PRIVATE_KEY/);

  const badKey = captureLogger();
  assert.strictEqual(
    getCloudFrontDownloadConfig(
      {
        CLOUDFRONT_DOWNLOAD_DOMAIN: "cdn.example.com",
        CLOUDFRONT_KEY_PAIR_ID: "KFIXTURE",
        CLOUDFRONT_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\\nnot-a-key\\n-----END RSA PRIVATE KEY-----",
      },
      badKey
    ),
    null,
    "invalid PEM falls back to S3"
  );
  assert.match(badKey.warnings[0], /not a valid PEM/);

  const badDomain = captureLogger();
  assert.strictEqual(
    getCloudFrontDownloadConfig(
      {
        CLOUDFRONT_DOWNLOAD_DOMAIN: "cdn.example.com/downloads",
        CLOUDFRONT_KEY_PAIR_ID: "KFIXTURE",
        CLOUDFRONT_PRIVATE_KEY: oneLinePem,
      },
      badDomain
    ),
    null,
    "domain with a path is rejected"
  );
  assert.match(badDomain.warnings[0], /bare hostname/);

  const ecPem = crypto
    .generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    })
    .privateKey;
  const ecKey = captureLogger();
  assert.strictEqual(
    getCloudFrontDownloadConfig(
      {
        CLOUDFRONT_DOWNLOAD_DOMAIN: "cdn.example.com",
        CLOUDFRONT_KEY_PAIR_ID: "KFIXTURE",
        CLOUDFRONT_PRIVATE_KEY: ecPem,
      },
      ecKey
    ),
    null,
    "non-RSA key falls back to S3"
  );
  assert.match(ecKey.warnings[0], /not an RSA key/);

  const emptyId = captureLogger();
  assert.strictEqual(
    getCloudFrontDownloadConfig(
      {
        CLOUDFRONT_DOWNLOAD_DOMAIN: "cdn.example.com",
        CLOUDFRONT_KEY_PAIR_ID: '""',
        CLOUDFRONT_PRIVATE_KEY: oneLinePem,
      },
      emptyId
    ),
    null,
    "empty quoted key pair id falls back to S3"
  );
  assert.match(emptyId.warnings[0], /CLOUDFRONT_KEY_PAIR_ID is empty/);

  // Quoted values, as written in dotenv-style files, are accepted.
  const quoted = getCloudFrontDownloadConfig(
    {
      CLOUDFRONT_DOWNLOAD_DOMAIN: '"cdn.example.com"',
      CLOUDFRONT_KEY_PAIR_ID: '"KFIXTURE"',
      CLOUDFRONT_PRIVATE_KEY: `"${oneLinePem}"`,
    },
    captureLogger()
  );
  assert.ok(quoted, "quoted env values are unwrapped");
  assert.strictEqual(quoted.privateKey, privateKey.trim());
  assert.strictEqual(quoted.domain, "cdn.example.com");
  assert.strictEqual(quoted.keyPairId, "KFIXTURE");

  const config = getCloudFrontDownloadConfig(
    {
      CLOUDFRONT_DOWNLOAD_DOMAIN: "https://cdn.example.com/",
      CLOUDFRONT_KEY_PAIR_ID: " KFIXTURE ",
      CLOUDFRONT_PRIVATE_KEY: oneLinePem,
    },
    captureLogger()
  );
  assert.deepStrictEqual(
    { domain: config.domain, keyPairId: config.keyPairId },
    { domain: "cdn.example.com", keyPairId: "KFIXTURE" }
  );
  assert.strictEqual(config.privateKey, privateKey.trim());
  assert.strictEqual(normalizePrivateKey(privateKey), privateKey.trim());

  // Direct CloudFront signing: filename override, expiry, valid signature
  const now = Date.UTC(2026, 0, 1);
  const direct = createCloudFrontSignedUrl(config, "beta/Snack Voice.dmg", {
    ttlSeconds: 600,
    now,
    responseHeaders: {
      "response-content-disposition": 'attachment; filename="SnackVoice_1.2.3_aarch64.dmg"',
      "response-content-type": "application/x-apple-diskimage",
      "response-cache-control": "",
    },
  });
  const directUrl = new URL(direct);
  assert.strictEqual(directUrl.host, "cdn.example.com");
  assert.strictEqual(directUrl.pathname, "/beta/Snack%20Voice.dmg");
  assert.strictEqual(
    directUrl.searchParams.get("response-content-disposition"),
    'attachment; filename="SnackVoice_1.2.3_aarch64.dmg"'
  );
  assert.ok(!directUrl.searchParams.has("response-cache-control"));
  assert.strictEqual(directUrl.searchParams.get("Expires"), String(now / 1000 + 600));
  assert.strictEqual(directUrl.searchParams.get("Key-Pair-Id"), "KFIXTURE");
  assert.ok(verifyCannedSignature(direct), "signature verifies with public key");

  // App-level DMG link via CloudFront: no bucket, region, or access key id
  const cfLink = await createSignedDownloadUrl(
    "SnackVoice-Apple-Silicon.dmg",
    "SnackVoice_1.2.3_aarch64.dmg",
    { cloudFront: config }
  );
  const cfUrl = new URL(cfLink);
  assert.strictEqual(cfUrl.host, "cdn.example.com");
  assert.strictEqual(cfUrl.pathname, "/SnackVoice-Apple-Silicon.dmg");
  assert.strictEqual(
    cfUrl.searchParams.get("response-content-disposition"),
    'attachment; filename="SnackVoice_1.2.3_aarch64.dmg"'
  );
  assert.strictEqual(
    cfUrl.searchParams.get("response-content-type"),
    "application/x-apple-diskimage"
  );
  const expiresIn = Number(cfUrl.searchParams.get("Expires")) - Date.now() / 1000;
  assert.ok(expiresIn > 590 && expiresIn <= 601, "uses S3_SIGNED_URL_TTL_SECONDS");
  for (const leak of ["fixture-bucket", "amazonaws.com", "X-Amz-Credential", "AKIA"]) {
    assert.ok(!cfLink.includes(leak), `CloudFront link must not contain ${leak}`);
  }
  assert.ok(verifyCannedSignature(cfLink));

  const cfArchive = await createSignedUpdaterArchiveUrl(
    "updater-beta/macos/aarch64/SnackVoice.app.tar.gz",
    { cloudFront: config }
  );
  const cfArchiveUrl = new URL(cfArchive);
  assert.strictEqual(cfArchiveUrl.host, "cdn.example.com");
  assert.ok(!cfArchiveUrl.searchParams.has("response-content-disposition"));
  assert.ok(verifyCannedSignature(cfArchive));

  // Fallback: no CloudFront config -> S3 presigned URL (preview/dev)
  const s3Link = await createSignedDownloadUrl(
    "SnackVoice-Apple-Silicon.dmg",
    "SnackVoice_1.2.3_aarch64.dmg"
  );
  const s3Url = new URL(s3Link);
  assert.strictEqual(s3Url.host, S3_FIXTURE_HOST);
  assert.strictEqual(s3Url.searchParams.get("X-Amz-Expires"), "600");
  assert.strictEqual(
    s3Url.searchParams.get("response-content-disposition"),
    'attachment; filename="SnackVoice_1.2.3_aarch64.dmg"'
  );
  const s3Archive = await createSignedUpdaterArchiveUrl(
    "updater-beta/macos/aarch64/SnackVoice.app.tar.gz",
    { cloudFront: null }
  );
  assert.ok(s3Archive.startsWith(`https://${S3_FIXTURE_HOST}/`));

  assert.strictEqual(await createSignedDownloadUrl("", "x.dmg"), "");

  // Special characters in keys and filenames round-trip and still verify.
  const special = createCloudFrontSignedUrl(config, "beta/a+b%c's.dmg", {
    ttlSeconds: 600,
    responseHeaders: {
      "response-content-disposition": 'attachment; filename="Snack+Voice 100%\'s Expires=1.dmg"',
    },
  });
  const specialUrl = new URL(special);
  assert.strictEqual(decodeURIComponent(specialUrl.pathname), "/beta/a+b%c's.dmg");
  assert.strictEqual(
    specialUrl.searchParams.get("response-content-disposition"),
    'attachment; filename="Snack+Voice 100%\'s Expires=1.dmg"'
  );
  assert.ok(verifyCannedSignature(special));

  // Updater manifest and archive redirect with CloudFront signing enabled.
  const origin = `https://${S3_FIXTURE_HOST}`;
  const updaterKeys = {
    manifestKey: "updater/macos/aarch64/latest.json",
    archiveKey: "updater/macos/aarch64/SnackVoice.app.tar.gz",
    platformKey: "darwin-aarch64",
  };
  const archiveKey = "updater/macos/aarch64/releases/v1.0.16/SnackVoice.app.tar.gz";
  const readManifest = async () =>
    JSON.stringify({
      version: "1.0.16",
      platforms: {
        "darwin-aarch64": { signature: "fixture", url: `${origin}/${archiveKey}` },
      },
    });
  const signArchive = (key) => createSignedUpdaterArchiveUrl(key, { cloudFront: config });

  const manifestRes = fakeResponse();
  await serveUpdaterManifest(manifestRes, updaterKeys, {
    readManifest,
    signArchive,
    expectedS3Origin: origin,
  });
  assert.strictEqual(manifestRes.status, 200);
  const served = JSON.parse(manifestRes.body);
  const servedUrl = served.platforms["darwin-aarch64"].url;
  assert.ok(servedUrl.startsWith(`https://cdn.example.com/${archiveKey}?`));
  assert.ok(!servedUrl.includes("fixture-bucket"));
  assert.ok(verifyCannedSignature(servedUrl));

  const redirectRes = fakeResponse();
  await serveUpdaterArchiveRedirect(redirectRes, updaterKeys, {
    readManifest,
    signArchive,
    expectedS3Origin: origin,
  });
  assert.strictEqual(redirectRes.status, 302);
  assert.ok(redirectRes.headers.Location.startsWith(`https://cdn.example.com/${archiveKey}?`));

  console.log("download url tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
