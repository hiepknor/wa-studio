import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  internalLocalBuildEnvironment,
  internalLocalPreflightErrors,
} from "./internal-local-desktop.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const commit = "a".repeat(40);
const valid = {
  architecture: "arm64",
  environment: {},
  headCommit: commit,
  hostTarget: "aarch64-apple-darwin",
  mainCommit: commit,
  platform: "darwin",
  releaseChannel: "canary",
  worktreeStatus: "",
};

assert.deepEqual(internalLocalPreflightErrors(valid), []);
assert.match(
  internalLocalPreflightErrors({ ...valid, platform: "linux" })[0],
  /require macOS/u,
);
assert.match(
  internalLocalPreflightErrors({
    ...valid,
    architecture: "x64",
    hostTarget: "x86_64-apple-darwin",
  })[0],
  /aarch64-apple-darwin/u,
);
assert.match(
  internalLocalPreflightErrors({ ...valid, releaseChannel: "stable" })[0],
  /canary channel/u,
);
assert.match(
  internalLocalPreflightErrors({ ...valid, worktreeStatus: " M package.json" })[0],
  /clean worktree/u,
);
assert.match(
  internalLocalPreflightErrors({ ...valid, mainCommit: "b".repeat(40) })[0],
  /exact local origin\/main commit/u,
);
assert.match(
  internalLocalPreflightErrors({
    ...valid,
    environment: { WA_STUDIO_CONNECTOR_PLUGIN_URL: "https://example.test/connector.zip" },
  })[0],
  /sha256/u,
);
assert.deepEqual(internalLocalPreflightErrors({
  ...valid,
  environment: {
    WA_STUDIO_CONNECTOR_PLUGIN_URL:
      `https://example.test/connector.zip#sha256=${"a".repeat(64)}`,
  },
}), []);

const targetRoot = "/private/tmp/wa-studio-internal-test";
const isolated = internalLocalBuildEnvironment({
  APPLE_API_PRIVATE_KEY: "notarization-secret",
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Example",
  CARGO_ENCODED_RUSTFLAGS: "secret-build-flags",
  CARGO_TARGET_DIR: "/unexpected",
  GITHUB_TOKEN: "github-secret",
  PATH: "/usr/bin:/bin",
  RUSTFLAGS: "unexpected-build-flags",
  TAURI_SIGNING_PRIVATE_KEY: "updater-secret",
  WA_STUDIO_CONNECTOR_PLUGIN_URL:
    `https://example.test/connector.zip#sha256=${"b".repeat(64)}`,
  WA_STUDIO_UPDATER_ENDPOINT: "https://updates.example.test/latest.json",
}, targetRoot);
assert.equal(isolated.PATH, "/usr/bin:/bin");
assert.equal(isolated.CARGO_TARGET_DIR, targetRoot);
assert.equal(isolated.CARGO_INCREMENTAL, "0");
assert.equal(isolated.CI, "true");
assert.equal(isolated.MACOSX_DEPLOYMENT_TARGET, "13.5");
assert.match(isolated.WA_STUDIO_CONNECTOR_PLUGIN_URL, /^https:/u);
for (const forbidden of [
  "APPLE_API_PRIVATE_KEY",
  "APPLE_SIGNING_IDENTITY",
  "CARGO_ENCODED_RUSTFLAGS",
  "GITHUB_TOKEN",
  "RUSTFLAGS",
  "TAURI_SIGNING_PRIVATE_KEY",
  "WA_STUDIO_UPDATER_ENDPOINT",
]) {
  assert.equal(isolated[forbidden], undefined, `${forbidden} leaked into the internal build`);
}

const tauriConfig = JSON.parse(readFileSync(
  resolve(workspaceRoot, "apps/studio/src-tauri/tauri.internal-local.conf.json"),
  "utf8",
));
assert.deepEqual(tauriConfig.bundle.targets, ["app"]);
assert.equal(tauriConfig.bundle.createUpdaterArtifacts, false);
assert.equal(tauriConfig.bundle.macOS.signingIdentity, "-");

const packageJson = JSON.parse(readFileSync(resolve(workspaceRoot, "package.json"), "utf8"));
assert.equal(
  packageJson.scripts["build:desktop:internal-local"],
  "node tooling/release/internal-local-desktop.mjs build",
);
assert.equal(
  packageJson.scripts["verify:desktop:internal-local"],
  "node tooling/release/internal-local-desktop.mjs verify",
);
assert.equal(
  packageJson.scripts["clean:desktop:internal-local"],
  "node tooling/release/internal-local-desktop.mjs clean",
);
const releaseWorkflow = readFileSync(
  resolve(workspaceRoot, ".github/workflows/release.yml"),
  "utf8",
);
assert.doesNotMatch(
  releaseWorkflow,
  /internal-local/u,
  "the private internal-local lane must never enter the GitHub product release workflow",
);

process.stdout.write(
  "Internal-local desktop test passed: the private ARM64 app lane cannot inherit production signing or updater credentials.\n",
);
