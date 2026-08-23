import assert from "node:assert/strict";
import { releasePreflightErrors } from "./build-updater-release.mjs";

const updaterSecrets = {
  WA_STUDIO_UPDATER_ENDPOINT: "https://updates.example.test/wa-studio/{{target}}",
  WA_STUDIO_UPDATER_PUBLIC_KEY: "public-key-with-more-than-thirty-two-characters",
  TAURI_SIGNING_PRIVATE_KEY: "private-updater-test-value-must-not-leak",
};

const missing = releasePreflightErrors({}, "linux");
assert.equal(missing.length, 1);
assert.match(missing[0], /WA_STUDIO_UPDATER_ENDPOINT/u);
assert.match(missing[0], /TAURI_SIGNING_PRIVATE_KEY/u);

const invalidEndpoint = releasePreflightErrors({
  ...updaterSecrets,
  WA_STUDIO_UPDATER_ENDPOINT: "http://user:password@example.test/update",
}, "linux");
assert.deepEqual(invalidEndpoint, [
  "WA_STUDIO_UPDATER_ENDPOINT must be HTTPS and cannot contain credentials.",
]);

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

const allErrors = [missing, invalidEndpoint, unsignedMac, adHocMac].flat().join("\n");
for (const secret of [
  updaterSecrets.TAURI_SIGNING_PRIVATE_KEY,
  "apple-test-secret",
  "certificate-test-secret",
]) {
  assert.equal(allErrors.includes(secret), false, "preflight errors exposed a secret value");
}

process.stdout.write(
  "Signed release preflight test passed: updater, Developer ID and notarization gates fail closed.\n",
);
