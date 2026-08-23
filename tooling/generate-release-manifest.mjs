import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
  const studioPackage = readJson("apps/studio/package.json");
  const tauri = readJson("apps/studio/src-tauri/tauri.conf.json");
  const runtimePackage = readJson("services/runtime/package.json");
  const contractPackage = readJson("packages/runtime-contract/package.json");
  const cargo = readFileSync(resolve(workspaceRoot, "apps/studio/src-tauri/Cargo.toml"), "utf8");
  const runtimeRelease = readFileSync(
    resolve(workspaceRoot, "services/runtime/src/core/release/runtime-release.ts"),
    "utf8",
  );

  assert.equal(components.schemaVersion, 1);
  assert.equal(components.product, "wa-studio");
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
  assert(
    existsSync(resolve(
      workspaceRoot,
      `services/runtime/contracts/openwa/${components.openwaReleaseTag}/openapi.json`,
    )),
    `OpenWA ${components.openwaReleaseTag} contract snapshot is missing`,
  );
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
