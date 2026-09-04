import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { readProductionAcceptancePolicy } from "./production-acceptance.mjs";
import { verifyProductionPromotionDelta } from "./production-promotion.mjs";

const root = mkdtempSync(resolve(tmpdir(), "wa-production-promotion-test-"));
const receiptPath = resolve(root, "release/production-promotion.json");
const promotionCliPath = resolve(import.meta.dirname, "production-promotion.mjs");

function git(...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(path, value) {
  const target = resolve(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function studioPackage(version, dependencies = { react: "19.1.1" }) {
  return json({ name: "@wa/studio", private: true, version, dependencies });
}

function tauriConfiguration(version) {
  return json({ productName: "WA Studio", version, identifier: "cc.onio.wa-studio" });
}

function packageLock(version) {
  return json({
    name: "wa-studio-monorepo",
    lockfileVersion: 3,
    packages: {
      "": { name: "wa-studio-monorepo" },
      "apps/studio": { name: "@wa/studio", version, dependencies: { react: "19.1.1" } },
    },
  });
}

function cargoToml(version) {
  return `[package]\nname = "wa-studio"\nversion = "${version}"\nedition = "2021"\n\n[dependencies]\ntauri = "2"\n`;
}

function cargoLock(version) {
  return `version = 4\n\n[[package]]\nname = "tauri"\nversion = "2.0.0"\n\n[[package]]\nname = "wa-studio"\nversion = "${version}"\ndependencies = [\n "tauri",\n]\n`;
}

function components(version, releaseChannel) {
  return json({
    schemaVersion: 1,
    product: "wa-studio",
    releaseChannel,
    runtimeService: "wa-runtime",
    studioVersion: version,
    runtimeVersion: "1.0.0",
    runtimeContractVersion: "1.0.0",
    connectorPluginVersion: "1.0.0",
    connectorProtocolVersion: 1,
    connectorJournalSchemaVersion: 1,
    openwaReleaseTag: "0.23.3",
    openwaContractSha256: "a".repeat(64),
  });
}

function writeVersionFiles(version, releaseChannel) {
  write("apps/studio/package.json", studioPackage(version));
  write("apps/studio/src-tauri/tauri.conf.json", tauriConfiguration(version));
  write("apps/studio/src-tauri/Cargo.toml", cargoToml(version));
  write("apps/studio/src-tauri/Cargo.lock", cargoLock(version));
  write("package-lock.json", packageLock(version));
  write("release/components.json", components(version, releaseChannel));
}

function commit(message) {
  git("add", ".");
  git("commit", "-m", message);
  return git("rev-parse", "HEAD");
}

try {
  git("init", "-b", "main");
  git("config", "user.name", "WA Studio release test");
  git("config", "user.email", "release-test@example.invalid");

  writeVersionFiles("1.0.0", "canary");
  const sourceCommit = commit("canary");
  const policy = readProductionAcceptancePolicy();
  const receipt = {
    schemaVersion: 1,
    product: "wa-studio",
    issuedAt: "2026-09-02T00:00:00.000Z",
    acceptedRelease: {
      repository: "example/wa-studio",
      tag: "v1.0.0",
      gitCommit: sourceCommit,
      releaseChannel: "canary",
      deploymentManifestSha256: "b".repeat(64),
      eventInboxImageDigest: `sha256:${"c".repeat(64)}`,
      connectorArtifactSha256: "d".repeat(64),
    },
    acceptance: {
      policyVersion: policy.identity.version,
      policySha256: policy.identity.sha256,
      operationalSnapshotSha256: "e".repeat(64),
      acceptanceRecordSha256: "f".repeat(64),
      evidenceArchiveSha256: "1".repeat(64),
      decidedAt: "2026-09-01T23:59:00.000Z",
    },
    target: { repository: "example/wa-studio", tag: "v1.0.1" },
  };

  writeVersionFiles("1.0.1", "stable");
  write("release/production-promotion.json", json(receipt));
  const targetCommit = commit("promote stable");
  const result = verifyProductionPromotionDelta({
    receiptPath,
    repository: "example/wa-studio",
    tag: "v1.0.1",
    targetCommit,
    workspaceRoot: root,
  });
  assert.equal(result.sourceCommit, sourceCommit);
  assert.match(execFileSync(process.execPath, [
    promotionCliPath,
    "verify-delta",
    "--receipt", receiptPath,
    "--repository", "example/wa-studio",
    "--tag", "v1.0.1",
    "--target-commit", targetCommit,
    "--workspace-root", root,
  ], { encoding: "utf8" }), /"changedFileCount":7/u);
  assert.deepEqual(result.changedFiles.sort(), [
    "apps/studio/package.json",
    "apps/studio/src-tauri/Cargo.lock",
    "apps/studio/src-tauri/Cargo.toml",
    "apps/studio/src-tauri/tauri.conf.json",
    "package-lock.json",
    "release/components.json",
    "release/production-promotion.json",
  ]);

  git("update-index", "--chmod=+x", "apps/studio/package.json");
  git("commit", "-m", "change version file mode");
  const executableCommit = git("rev-parse", "HEAD");
  assert.throws(
    () => verifyProductionPromotionDelta({
      receiptPath,
      repository: "example/wa-studio",
      tag: "v1.0.1",
      targetCommit: executableCommit,
      workspaceRoot: root,
    }),
    /must remain a regular non-executable file/u,
  );
  git("update-index", "--chmod=-x", "apps/studio/package.json");
  git("commit", "-m", "restore version file mode");

  write("apps/studio/package.json", studioPackage("1.0.1", {
    react: "19.1.1",
    "unreviewed-package": "1.0.0",
  }));
  const dependencyCommit = commit("hide dependency in version file");
  assert.throws(
    () => verifyProductionPromotionDelta({
      receiptPath,
      repository: "example/wa-studio",
      tag: "v1.0.1",
      targetCommit: dependencyCommit,
      workspaceRoot: root,
    }),
    /changed non-version content/u,
  );

  write("src/unreviewed.js", "export const unreviewed = true;\n");
  const codeCommit = commit("add unreviewed code");
  assert.throws(
    () => verifyProductionPromotionDelta({
      receiptPath,
      repository: "example/wa-studio",
      tag: "v1.0.1",
      targetCommit: codeCommit,
      workspaceRoot: root,
    }),
    /contains unaccepted changes/u,
  );

  assert.throws(
    () => verifyProductionPromotionDelta({
      receiptPath,
      repository: "example/wa-studio",
      tag: "v1.0.1",
      targetCommit: "0".repeat(40),
      workspaceRoot: root,
    }),
    /must descend from the accepted canary/u,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
  "Production promotion test passed: stable is a descendant with a version-only canary delta.\n",
);
