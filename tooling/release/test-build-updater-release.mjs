import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  releaseIndependentEnvironment,
  releasePreflightErrors,
} from "./build-updater-release.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const tauriConfig = JSON.parse(readFileSync(
  resolve(workspaceRoot, "apps/studio/src-tauri/tauri.conf.json"),
  "utf8",
));
assert.equal(
  tauriConfig.bundle?.macOS?.minimumSystemVersion,
  "13.5",
  "macOS deployment target must remain compatible with the packaged Runtime sidecar",
);

const updaterSecrets = {
  WA_STUDIO_CONNECTOR_PLUGIN_URL: `https://github.com/hiepknor/wa-studio/releases/download/v1.2.3/wa-studio-connector-0.1.0.zip#sha256=${"a".repeat(64)}`,
  WA_STUDIO_UPDATER_ENDPOINT: "https://updates.example.test/wa-studio/{{target}}",
  WA_STUDIO_UPDATER_PUBLIC_KEY: "public-key-with-more-than-thirty-two-characters",
  TAURI_SIGNING_PRIVATE_KEY: "private-updater-test-value-must-not-leak",
};

const missing = releasePreflightErrors({}, "linux");
assert.equal(missing.length, 1);
assert.match(missing[0], /WA_STUDIO_CONNECTOR_PLUGIN_URL/u);
assert.match(missing[0], /WA_STUDIO_UPDATER_ENDPOINT/u);
assert.match(missing[0], /TAURI_SIGNING_PRIVATE_KEY/u);

const invalidEndpoint = releasePreflightErrors({
  ...updaterSecrets,
  WA_STUDIO_UPDATER_ENDPOINT: "http://user:password@example.test/update",
}, "linux");
assert.deepEqual(invalidEndpoint, [
  "WA_STUDIO_UPDATER_ENDPOINT must be HTTPS and cannot contain credentials.",
]);

const unpinnedConnector = releasePreflightErrors({
  ...updaterSecrets,
  WA_STUDIO_CONNECTOR_PLUGIN_URL: "https://example.test/connector.zip",
}, "linux");
assert.deepEqual(unpinnedConnector, [
  "WA_STUDIO_CONNECTOR_PLUGIN_URL must be an HTTPS .zip URL pinned with #sha256=<64 hex>.",
]);

const mismatchedPublishedEndpoint = releasePreflightErrors({
  ...updaterSecrets,
  GITHUB_REPOSITORY: "hiepknor/wa-studio",
}, "linux");
assert.deepEqual(mismatchedPublishedEndpoint, [
  "WA_STUDIO_UPDATER_ENDPOINT must publish from https://github.com/hiepknor/wa-studio/releases/download/wa-studio-canary/latest.json.",
]);

assert.deepEqual(releasePreflightErrors({
  ...updaterSecrets,
  GITHUB_REPOSITORY: "hiepknor/wa-studio",
  WA_STUDIO_UPDATER_ENDPOINT: "https://github.com/hiepknor/wa-studio/releases/download/wa-studio-canary/latest.json",
}, "linux"), []);

assert.deepEqual(releasePreflightErrors({
  ...updaterSecrets,
  GITHUB_REPOSITORY: "hiepknor/wa-studio",
  WA_STUDIO_UPDATER_ENDPOINT: "https://github.com/hiepknor/wa-studio/releases/latest/download/latest.json",
}, "linux", "stable"), []);

const unsignedMac = releasePreflightErrors(updaterSecrets, "darwin");
assert.equal(unsignedMac.length, 2);
assert.match(unsignedMac[0], /non-ad-hoc APPLE_SIGNING_IDENTITY/u);
assert.match(unsignedMac[1], /release notarization requires/u);

const adHocMac = releasePreflightErrors({
  ...updaterSecrets,
  APPLE_SIGNING_IDENTITY: "-",
  APPLE_ID: "release@example.test",
  APPLE_PASSWORD: "apple-test-secret",
  APPLE_TEAM_ID: "TESTTEAM01",
}, "darwin");
assert.equal(adHocMac.length, 1);
assert.match(adHocMac[0], /non-ad-hoc APPLE_SIGNING_IDENTITY/u);

assert.deepEqual(releasePreflightErrors({
  ...updaterSecrets,
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Example (TESTTEAM01)",
  APPLE_ID: "release@example.test",
  APPLE_PASSWORD: "apple-test-secret",
  APPLE_TEAM_ID: "TESTTEAM01",
}, "darwin"), []);

assert.deepEqual(releasePreflightErrors({
  ...updaterSecrets,
  APPLE_CERTIFICATE: "base64-test-certificate",
  APPLE_CERTIFICATE_PASSWORD: "certificate-test-secret",
  APPLE_API_ISSUER: "issuer-test-id",
  APPLE_API_KEY: "key-test-id",
  APPLE_API_KEY_PATH: "/secure/ci/AuthKey_key-test-id.p8",
}, "darwin"), []);

const allErrors = [
  missing,
  invalidEndpoint,
  mismatchedPublishedEndpoint,
  unsignedMac,
  adHocMac,
].flat().join("\n");
for (const secret of [
  updaterSecrets.TAURI_SIGNING_PRIVATE_KEY,
  "apple-test-secret",
  "certificate-test-secret",
]) {
  assert.equal(allErrors.includes(secret), false, "preflight errors exposed a secret value");
}

const isolatedEnvironment = releaseIndependentEnvironment({
  APPLE_API_PRIVATE_KEY: "private-notarization-key",
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Example",
  GITHUB_TOKEN: "github-job-token",
  PATH: "/usr/bin:/bin",
  TAURI_SIGNING_PRIVATE_KEY: updaterSecrets.TAURI_SIGNING_PRIVATE_KEY,
  WA_STUDIO_UPDATER_PUBLIC_KEY: updaterSecrets.WA_STUDIO_UPDATER_PUBLIC_KEY,
});
assert.deepEqual(isolatedEnvironment, { PATH: "/usr/bin:/bin" });

process.stdout.write(
  "Signed release preflight test passed: updater, Developer ID and notarization gates fail closed with step-isolated secrets.\n",
);
