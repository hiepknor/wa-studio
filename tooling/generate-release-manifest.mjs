import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { verifyOpenWAServerRelease } from "./openwa-server-release.mjs";

const workspaceRoot = resolve(import.meta.dirname, "..");

function readJson(path) {
  return JSON.parse(readFileSync(resolve(workspaceRoot, path), "utf8"));
}

function captured(source, pattern, label) {
  const value = source.match(pattern)?.[1];
  assert(value, `Could not read ${label}`);
  return value;
}

function validateComponents() {
  const components = readJson("release/components.json");
  const openwa = verifyOpenWAServerRelease({ workspaceRoot });
  const studioPackage = readJson("apps/studio/package.json");
  const tauri = readJson("apps/studio/src-tauri/tauri.conf.json");
  const runtimePackage = readJson("services/runtime/package.json");
  const contractPackage = readJson("packages/runtime-contract/package.json");
  const cargo = readFileSync(resolve(workspaceRoot, "apps/studio/src-tauri/Cargo.toml"), "utf8");
  const runtimeRelease = readFileSync(
    resolve(workspaceRoot, "services/runtime/src/core/release/runtime-release.ts"),
    "utf8",
  );

  assert.equal(components.schemaVersion, 4);
  assert.equal(components.product, "wa-studio");
  assert(["canary", "stable"].includes(components.releaseChannel),
    "release/components.json must declare releaseChannel as canary or stable");
  assert.equal(components.runtimeService, "wa-runtime");
  assert.equal(studioPackage.name, "@wa/studio");
  assert.equal(runtimePackage.name, "@wa/runtime");
  assert.equal(contractPackage.name, "@wa/runtime-contract");
  assert.equal(tauri.productName, "WA Studio");
  assert.equal(tauri.identifier, "dev.hiepknor.wastudio");
  assert(tauri.bundle.externalBin.includes("binaries/wa-runtime"));
  assert.equal(
    components.product,
    captured(cargo, /^name = "([^"\n]+)"/mu, "Cargo package name"),
  );
  assert.equal(
    components.runtimeService,
    captured(runtimeRelease, /RUNTIME_SERVICE = '([^']+)'/u, "Runtime service name"),
  );
  assert.equal(components.studioVersion, studioPackage.version);
  assert.equal(components.studioVersion, tauri.version);
  assert.equal(
    components.studioVersion,
    captured(cargo, /^version = "([^"]+)"/mu, "Cargo package version"),
  );
  assert.equal(components.runtimeVersion, runtimePackage.version);
  assert.equal(
    components.runtimeVersion,
    captured(runtimeRelease, /RUNTIME_VERSION = '([^']+)'/u, "Runtime release version"),
  );
  assert.equal(
    components.runtimeContractVersion,
    `v${String(contractPackage.version).split(".")[0]}`,
  );
  assert.equal(
    components.runtimeContractVersion,
    captured(runtimeRelease, /RUNTIME_CONTRACT_VERSION = '([^']+)'/u, "Runtime contract version"),
  );
  assert.equal(components.openwaReleaseTag, openwa.releaseTag);
  assert.equal(components.openwaContractSha256, openwa.contractSha256);
  return components;
}

const components = validateComponents();
if (process.argv.includes("--check")) {
  process.stdout.write("Release component versions are consistent.\n");
} else {
  const output = resolve(workspaceRoot, "dist/release-manifest.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({
    ...components,
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    }).trim(),
  }, null, 2)}\n`);
  process.stdout.write(`Generated ${output}\n`);
}
