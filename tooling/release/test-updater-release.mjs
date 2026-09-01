import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  canonicalUpdaterEndpoint,
  stageUpdaterRelease,
  verifyUpdaterRelease,
} from "./updater-release.mjs";

const root = mkdtempSync(resolve(tmpdir(), "wa-studio-updater-release-"));
try {
  const bundleRoot = resolve(root, "bundle");
  const outputRoot = resolve(root, "output");
  const packagePath = resolve(root, "package.json");
  const sbomPath = resolve(root, "wa-studio.spdx.json");
  mkdirSync(resolve(bundleRoot, "macos"), { recursive: true });
  mkdirSync(resolve(bundleRoot, "dmg"), { recursive: true });
  writeFileSync(resolve(bundleRoot, "macos/WA Studio.app.tar.gz"), "signed archive");
  writeFileSync(resolve(bundleRoot, "macos/WA Studio.app.tar.gz.sig"), "signed-archive-signature\n");
  writeFileSync(resolve(bundleRoot, "dmg/WA Studio_1.2.3_aarch64.dmg"), "notarized installer");
  writeFileSync(packagePath, JSON.stringify({ version: "1.2.3" }));
  const sbom = {
    spdxVersion: "SPDX-2.3",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "WA Studio 1.2.3",
    packages: [{ SPDXID: "SPDXRef-Package-wa-studio", name: "wa-studio", versionInfo: "1.2.3" }],
  };
  writeFileSync(sbomPath, JSON.stringify(sbom));

  const metadata = stageUpdaterRelease({
    bundleRoot,
    outputRoot,
    packagePath,
    sbomPath,
    repository: "hiepknor/wa-studio",
    tag: "v1.2.3",
    publishedAt: "2026-08-26T12:00:00.000Z",
    notes: "Verified release",
  });
  assert.equal(metadata.assets.updater, "WA-Studio_1.2.3_aarch64.app.tar.gz");
  assert.equal(metadata.assets.sbom, "WA-Studio_1.2.3_sbom.spdx.json");
  assert.equal(
    canonicalUpdaterEndpoint("hiepknor/wa-studio"),
    "https://github.com/hiepknor/wa-studio/releases/latest/download/latest.json",
  );

  const manifest = JSON.parse(readFileSync(resolve(outputRoot, "latest.json"), "utf8"));
  assert.deepEqual(manifest, {
    version: "1.2.3",
    notes: "Verified release",
    pub_date: "2026-08-26T12:00:00.000Z",
    platforms: {
      "darwin-aarch64": {
        signature: "signed-archive-signature",
        url: "https://github.com/hiepknor/wa-studio/releases/download/v1.2.3/WA-Studio_1.2.3_aarch64.app.tar.gz",
      },
    },
  });
  assert.equal(verifyUpdaterRelease({
    directory: outputRoot,
    repository: "hiepknor/wa-studio",
    tag: "v1.2.3",
  }).version, "1.2.3");

  writeFileSync(resolve(outputRoot, metadata.assets.sbom), JSON.stringify({
    ...sbom,
    packages: [],
  }));
  assert.throws(() => verifyUpdaterRelease({
    directory: outputRoot,
    repository: "hiepknor/wa-studio",
    tag: "v1.2.3",
  }), /non-empty SPDX 2.3/u);
  writeFileSync(resolve(outputRoot, metadata.assets.sbom), JSON.stringify(sbom));
  const checksummedNames = [
    metadata.assets.updater,
    metadata.assets.signature,
    metadata.assets.installer,
    metadata.assets.sbom,
    metadata.assets.manifest,
  ];
  const checksums = checksummedNames.map(name => {
    const digest = createHash("sha256").update(readFileSync(resolve(outputRoot, name))).digest("hex");
    return `${digest}  ${name}`;
  }).join("\n");
  writeFileSync(resolve(outputRoot, metadata.assets.checksums), `${checksums}\n`);

  writeFileSync(resolve(outputRoot, "latest.json"), `${JSON.stringify({
    ...manifest,
    platforms: {
      "darwin-aarch64": {
        ...manifest.platforms["darwin-aarch64"],
        signature: "tampered-signature",
      },
    },
  })}\n`);
  assert.throws(() => verifyUpdaterRelease({
    directory: outputRoot,
    repository: "hiepknor/wa-studio",
    tag: "v1.2.3",
  }), /does not match the staged signed archive/u);

  assert.throws(() => stageUpdaterRelease({
    bundleRoot,
    outputRoot: resolve(root, "wrong-tag"),
    packagePath,
    sbomPath,
    repository: "hiepknor/wa-studio",
    tag: "v1.2.4",
  }), /does not match Studio version/u);
  assert.throws(
    () => canonicalUpdaterEndpoint("not-a-repository"),
    /owner\/name/u,
  );

  const releaseWorkflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/release.yml"), "utf8");
  for (const requiredReleaseGate of [
    "needs: [connector-plugin, event-inbox-image, desktop]",
    "needs: [verify, connector-plugin]",
    "npm run check:connector",
    "packages/openwa-connector-plugin/build/*.zip",
    "WA_STUDIO_CONNECTOR_PLUGIN_URL=https://github.com/",
    "environment: release",
    "contents: write",
    "release:verify-updater",
    "gh release create \"$GITHUB_REF_NAME\" --draft",
    "gh release upload \"$GITHUB_REF_NAME\"",
    "require('./release/components.json').releaseChannel",
    "gh release edit \"$GITHUB_REF_NAME\" --draft=false --prerelease=true",
    "gh release edit \"$GITHUB_REF_NAME\" --draft=false --prerelease=false --latest",
    "actions/attest-build-provenance@",
    "anchore/sbom-action@",
  ]) {
    assert.match(releaseWorkflow, new RegExp(requiredReleaseGate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
  "Updater release staging test passed: manifest, signatures, checksums and tag identity fail closed.\n",
);
