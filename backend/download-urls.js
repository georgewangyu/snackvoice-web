"use strict";

const { createPrivateKey } = require("crypto");
const { getSignedUrl: getCloudFrontSignedUrl } = require("@aws-sdk/cloudfront-signer");

const CLOUDFRONT_ENV_KEYS = [
  "CLOUDFRONT_DOWNLOAD_DOMAIN",
  "CLOUDFRONT_KEY_PAIR_ID",
  "CLOUDFRONT_PRIVATE_KEY",
];
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function stripWrappingQuotes(value) {
  const match = value.match(/^(["'])([\s\S]*)\1$/);
  return match ? match[2] : value;
}

// Env vars often store a PEM on one line with literal "\n" sequences, and
// dotenv-style files may wrap the value in quotes.
function normalizePrivateKey(raw) {
  if (!raw || typeof raw !== "string") return "";
  return stripWrappingQuotes(raw.trim()).replace(/\\n/g, "\n").trim();
}

// Accepts a bare hostname, optionally with an https:// prefix or trailing
// slash. Anything else (path, port) is rejected.
function normalizeDomain(raw) {
  if (!raw || typeof raw !== "string") return "";
  const host = stripWrappingQuotes(raw.trim())
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  return HOSTNAME_PATTERN.test(host) ? host : "";
}

// Returns the CloudFront signing config, or null so callers fall back to S3
// presigned URLs. Null when all vars are unset (preview and local dev), and
// also, with a warning, when the config is partial or invalid, so a bad key
// never breaks downloads.
function getCloudFrontDownloadConfig(env = process.env, logger = console) {
  const present = CLOUDFRONT_ENV_KEYS.filter((name) => (env[name] || "").trim());
  if (!present.length) return null;
  const warn = (reason) => {
    logger.warn(
      `[download] CloudFront signing disabled (${reason}); using S3 presigned URLs`
    );
    return null;
  };
  if (present.length < CLOUDFRONT_ENV_KEYS.length) {
    const missing = CLOUDFRONT_ENV_KEYS.filter((name) => !present.includes(name));
    return warn(`missing ${missing.join(", ")}`);
  }

  const domain = normalizeDomain(env.CLOUDFRONT_DOWNLOAD_DOMAIN);
  if (!domain) return warn("CLOUDFRONT_DOWNLOAD_DOMAIN is not a bare hostname");
  const keyPairId = stripWrappingQuotes(env.CLOUDFRONT_KEY_PAIR_ID.trim()).trim();
  if (!keyPairId) return warn("CLOUDFRONT_KEY_PAIR_ID is empty");
  const privateKey = normalizePrivateKey(env.CLOUDFRONT_PRIVATE_KEY);
  let keyType = "";
  try {
    keyType = createPrivateKey(privateKey).asymmetricKeyType;
  } catch {
    return warn("CLOUDFRONT_PRIVATE_KEY is not a valid PEM private key");
  }
  // The distribution trusts an RSA public key; anything else would sign links
  // that CloudFront rejects.
  if (keyType !== "rsa") return warn("CLOUDFRONT_PRIVATE_KEY is not an RSA key");
  return { domain, keyPairId, privateKey };
}

function encodeKeyPath(key) {
  return String(key)
    .replace(/^\/+/, "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

// Builds a CloudFront canned-policy signed URL. `responseHeaders` become S3
// response-* overrides; the distribution's origin request policy forwards them.
function createCloudFrontSignedUrl(config, key, options = {}) {
  const { ttlSeconds, responseHeaders = {}, now = Date.now() } = options;
  const query = Object.entries(responseHeaders)
    .filter(([, value]) => value)
    .map(
      ([name, value]) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
    )
    .join("&");
  const url = `https://${config.domain}/${encodeKeyPath(key)}${
    query ? `?${query}` : ""
  }`;
  return getCloudFrontSignedUrl({
    url,
    keyPairId: config.keyPairId,
    privateKey: config.privateKey,
    dateLessThan: new Date(now + ttlSeconds * 1000),
  });
}

module.exports = {
  normalizePrivateKey,
  normalizeDomain,
  getCloudFrontDownloadConfig,
  createCloudFrontSignedUrl,
};
