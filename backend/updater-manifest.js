"use strict";

function requireCanonicalVersion(value) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  ) {
    throw new Error("Updater manifest version is not canonical");
  }
  return value;
}

function resolveUpdaterArchiveKey(manifest, keys, expectedOrigin) {
  const platform = manifest?.platforms?.[keys.platformKey];
  if (!platform || typeof platform.url !== "string") {
    throw new Error(`Updater manifest is missing ${keys.platformKey}`);
  }

  const version = requireCanonicalVersion(manifest.version);
  const updaterPrefix = keys.manifestKey.replace(/\/latest\.json$/, "");
  const expectedVersionedKey = `${updaterPrefix}/releases/v${version}/SnackVoice.app.tar.gz`;
  const approvedKeys = [expectedVersionedKey];
  const isStableLegacyManifest =
    /^updater\/macos\/(aarch64|x64)\/latest\.json$/.test(keys.manifestKey) &&
    keys.archiveKey ===
      keys.manifestKey.replace(/latest\.json$/, "SnackVoice.app.tar.gz");
  if (version === "1.0.10" && isStableLegacyManifest) {
    approvedKeys.push(keys.archiveKey);
  }

  for (const approvedKey of approvedKeys) {
    if (platform.url === `${expectedOrigin}/${approvedKey}`) {
      return approvedKey;
    }
  }

  throw new Error(
    "Updater manifest does not reference its exact approved archive URL",
  );
}

module.exports = { resolveUpdaterArchiveKey };
