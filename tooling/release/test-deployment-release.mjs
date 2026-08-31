import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  createDeploymentManifest,
  verifyDeploymentManifest,
} from "./deployment-release.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const components = JSON.parse(readFileSync(
  resolve(workspaceRoot, "release/components.json"),
  "utf8",
));
const root = mkdtempSync(resolve(tmpdir(), "wa-studio-deployment-release-"));

try {
  const connectorDirectory = resolve(root, "connector");
  const updaterDirectory = resolve(root, "updater");
  const imageMetadataPath = resolve(root, "event-inbox-image.txt");
  const outputPath = resolve(root, "wa-studio-deployment.json");
  const connectorName = `wa-studio-connector-${components.connectorPluginVersion}.zip`;
  const connectorPath = resolve(connectorDirectory, connectorName);
  mkdirSync(connectorDirectory);
  mkdirSync(updaterDirectory);
  writeFileSync(connectorPath, "verified connector archive");
  const connectorDigest = createHash("sha256")
    .update(readFileSync(connectorPath))
    .digest("hex");
  writeFileSync(`${connectorPath}.sha256`, `${connectorDigest}  ${connectorName}\n`);
  const imageDigest = "a".repeat(64);
  writeFileSync(
    imageMetadataPath,
    `ghcr.io/hiepknor/wa-event-inbox@sha256:${imageDigest}\n`,
  );
  writeFileSync(resolve(updaterDirectory, "release-checksums.txt"), "desktop checksums\n");
  writeFileSync(resolve(updaterDirectory, "release-assets.json"), `${JSON.stringify({
    schemaVersion: 1,
    repository: "hiepknor/wa-studio",
    tag: `v${components.studioVersion}`,
    version: components.studioVersion,
  })}\n`);
  const common = {
    workspaceRoot,
    repository: "hiepknor/wa-studio",
    tag: `v${components.studioVersion}`,
    gitCommit: "b".repeat(40),
    imageMetadataPath,
    connectorDirectory,
    updaterDirectory,
  };

  const manifest = createDeploymentManifest({ ...common, outputPath });
  assert.equal(manifest.components.eventInbox.imageDigest, `sha256:${imageDigest}`);
  assert.equal(manifest.components.eventInbox.migrationHead.name, "011_legacy_primary_compatibility.sql");
  assert.equal(manifest.components.eventInbox.migrationHead.count, 11);
  assert.match(manifest.components.eventInbox.migrationHead.setSha256, /^[0-9a-f]{64}$/u);
  assert.equal(manifest.components.connector.artifact.sha256, connectorDigest);
  assert.match(manifest.components.studio.releaseChecksumsSha256, /^[0-9a-f]{64}$/u);
  assert.equal(manifest.components.openwa.releaseTag, components.openwaReleaseTag);
  assert.deepEqual(
    verifyDeploymentManifest({ ...common, manifestPath: outputPath }),
    manifest,
  );
  const cliOutput = resolve(root, "wa-studio-deployment-cli.json");
  const cliArguments = [
    "--repository", common.repository,
    "--tag", common.tag,
    "--git-commit", common.gitCommit,
    "--image-file", imageMetadataPath,
    "--connector-directory", connectorDirectory,
    "--updater-directory", updaterDirectory,
  ];
  assert.match(execFileSync(process.execPath, [
    resolve(import.meta.dirname, "deployment-release.mjs"),
    "create",
    ...cliArguments,
    "--output", cliOutput,
  ], { encoding: "utf8" }), /Created coordinated deployment manifest/u);
  assert.match(execFileSync(process.execPath, [
    resolve(import.meta.dirname, "deployment-release.mjs"),
    "verify",
    ...cliArguments,
    "--manifest", cliOutput,
  ], { encoding: "utf8" }), /Verified coordinated deployment manifest/u);

  const tampered = JSON.parse(readFileSync(outputPath, "utf8"));
  tampered.components.connector.protocolVersion += 1;
  writeFileSync(outputPath, `${JSON.stringify(tampered)}\n`);
  assert.throws(
    () => verifyDeploymentManifest({ ...common, manifestPath: outputPath }),
    /does not match coordinated release inputs/u,
  );
  assert.throws(
    () => createDeploymentManifest({
      ...common,
      outputPath: resolve(root, "wrong-tag.json"),
      tag: "v999.0.0",
    }),
    /Release tag must be/u,
  );
  writeFileSync(
    imageMetadataPath,
    `ghcr.io/another-owner/wa-event-inbox@sha256:${imageDigest}\n`,
  );
  assert.throws(
    () => createDeploymentManifest({
      ...common,
      outputPath: resolve(root, "wrong-owner.json"),
    }),
    /repository owner's immutable GHCR digest/u,
  );

  const releaseWorkflow = readFileSync(
    resolve(workspaceRoot, ".github/workflows/release.yml"),
    "utf8",
  );
  for (const gate of [
    "Create coordinated deployment manifest",
    "Attest coordinated deployment manifest",
    "deployment-release.mjs verify",
    "--updater-directory dist/updater-release",
    "gh attestation verify dist/release-metadata/wa-studio-deployment.json",
    "dist/release-metadata/* dist/connector-plugin/* --clobber",
    "-eq 11",
  ]) {
    assert.ok(releaseWorkflow.includes(gate), `Release workflow is missing: ${gate}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
  "Coordinated deployment release test passed: image, connector, migration and source identity fail closed.\n",
);
