import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseIndependentEnvironment } from "./build-updater-release.mjs";
import { inspectMacRuntimeSidecar } from "./macos-runtime-sidecar.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const studioRoot = resolve(workspaceRoot, "apps/studio");
const distRoot = resolve(workspaceRoot, "dist");
const outputRoot = resolve(distRoot, "internal-local");
const outputApp = resolve(outputRoot, "WA Studio.app");
const metadataPath = resolve(outputRoot, "internal-local-build.json");
const internalConfig = resolve(studioRoot, "src-tauri/tauri.internal-local.conf.json");
const componentsPath = resolve(workspaceRoot, "release/components.json");
const requiredArchitecture = "arm64";
const requiredTarget = "aarch64-apple-darwin";
const requiredMinimumSystemVersion = "13.5";
const requiredIdentifier = "dev.hiepknor.wastudio";

const buildOverridePrefixes = [
  "APPLE_",
  "TAURI_SIGNING_",
  "WA_STUDIO_UPDATER_",
];
const buildOverrideNames = new Set([
  "CARGO_ENCODED_RUSTFLAGS",
  "CARGO_INCREMENTAL",
  "CARGO_TARGET_DIR",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "MACOSX_DEPLOYMENT_TARGET",
  "RUSTFLAGS",
  "TAURI_CONFIG",
]);

function command(commandName, arguments_, { environment, inherit = false } = {}) {
  const result = spawnSync(commandName, arguments_, {
    cwd: workspaceRoot,
    encoding: inherit ? undefined : "utf8",
    env: environment,
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = inherit
      ? ""
      : `\n${String(result.stderr || result.stdout || "").trim()}`;
    throw new Error(
      `${commandName} ${arguments_.join(" ")} failed with exit code ${result.status}.${detail}`,
    );
  }
  return inherit ? "" : String(result.stdout ?? "").trim();
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function bundleEntries(root, directory = root) {
  const entries = [];
  for (const name of readdirSync(directory).sort()) {
    const path = resolve(directory, name);
    const stats = lstatSync(path);
    const relativePath = relative(root, path).split(sep).join("/");
    if (stats.isDirectory()) {
      entries.push({ mode: stats.mode & 0o777, path, relativePath, type: "directory" });
      entries.push(...bundleEntries(root, path));
    } else if (stats.isSymbolicLink()) {
      entries.push({ mode: stats.mode & 0o777, path, relativePath, type: "symlink" });
    } else if (stats.isFile()) {
      entries.push({ mode: stats.mode & 0o777, path, relativePath, type: "file" });
    } else {
      throw new Error(`Internal app bundle contains an unsupported entry: ${relativePath}`);
    }
  }
  return entries;
}

function sha256Bundle(root) {
  const hash = createHash("sha256");
  for (const entry of bundleEntries(root)) {
    hash.update(`${entry.type}\0${entry.relativePath}\0${entry.mode.toString(8)}\0`);
    if (entry.type === "file") hash.update(readFileSync(entry.path));
    if (entry.type === "symlink") hash.update(readlinkSync(entry.path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function validateConnectorPackageUrl(value) {
  if (!String(value ?? "").trim()) return null;
  try {
    const url = new URL(value);
    const digest = url.hash.match(/^#sha256=([0-9a-f]{64})$/u)?.[1];
    if (url.protocol !== "https:"
      || !url.hostname
      || url.username
      || url.password
      || !url.pathname.endsWith(".zip")
      || !digest) {
      return "WA_STUDIO_CONNECTOR_PLUGIN_URL must be an HTTPS .zip URL pinned with #sha256=<64 lowercase hex>.";
    }
  } catch {
    return "WA_STUDIO_CONNECTOR_PLUGIN_URL must be a valid absolute URL.";
  }
  return null;
}

export function internalLocalBuildEnvironment(environment, targetRoot) {
  const isolated = releaseIndependentEnvironment(environment);
  for (const name of Object.keys(isolated)) {
    if (buildOverrideNames.has(name)
      || buildOverridePrefixes.some(prefix => name.startsWith(prefix))) {
      delete isolated[name];
    }
  }
  return {
    ...isolated,
    CARGO_INCREMENTAL: "0",
    CARGO_TARGET_DIR: targetRoot,
    CI: "true",
    MACOSX_DEPLOYMENT_TARGET: requiredMinimumSystemVersion,
  };
}

export function internalLocalPreflightErrors({
  architecture,
  environment,
  headCommit,
  hostTarget,
  mainCommit,
  platform,
  releaseChannel,
  worktreeStatus,
}) {
  const errors = [];
  if (platform !== "darwin") {
    errors.push(`Internal-local desktop builds require macOS; received ${platform}.`);
  }
  if (architecture !== requiredArchitecture || hostTarget !== requiredTarget) {
    errors.push(
      `Internal-local desktop builds require native ${requiredTarget}; received ${architecture}/${hostTarget}.`,
    );
  }
  if (releaseChannel !== "canary") {
    errors.push("Internal-local operational candidates must be built from the canary channel.");
  }
  if (worktreeStatus.trim()) {
    errors.push("Internal-local operational candidates require a clean worktree.");
  }
  if (!/^[0-9a-f]{40}$/u.test(headCommit) || headCommit !== mainCommit) {
    errors.push("Internal-local operational candidates must use the exact local origin/main commit.");
  }
  const connectorError = validateConnectorPackageUrl(environment.WA_STUDIO_CONNECTOR_PLUGIN_URL);
  if (connectorError) errors.push(connectorError);
  return errors;
}

function currentSourceState() {
  return {
    architecture: process.arch,
    environment: process.env,
    headCommit: command("git", ["rev-parse", "HEAD"]),
    hostTarget: command("rustc", ["--print", "host-tuple"]),
    mainCommit: command("git", ["rev-parse", "origin/main"]),
    platform: process.platform,
    releaseChannel: JSON.parse(readFileSync(componentsPath, "utf8")).releaseChannel,
    worktreeStatus: command("git", ["status", "--porcelain=v1", "--untracked-files=normal"]),
  };
}

function plistValue(infoPlist, key) {
  return command("plutil", ["-extract", key, "raw", "-o", "-", infoPlist]);
}

function assertSingleArchitecture(binary, label) {
  const architecture = command("lipo", ["-archs", binary]);
  if (architecture !== requiredArchitecture) {
    throw new Error(`${label} must contain only ${requiredArchitecture}; received ${architecture}.`);
  }
}

function inspectInternalApp(app, expectedCommit) {
  if (!existsSync(app) || !statSync(app).isDirectory()) {
    throw new Error(`Internal-local app bundle is missing: ${app}`);
  }
  const contents = resolve(app, "Contents");
  const infoPlist = resolve(contents, "Info.plist");
  const executableName = plistValue(infoPlist, "CFBundleExecutable");
  const binary = resolve(contents, "MacOS", executableName);
  const runtimeSidecar = resolve(contents, "MacOS", "wa-runtime");
  const releaseManifest = resolve(contents, "Resources", "release-manifest.json");

  if (plistValue(infoPlist, "CFBundleIdentifier") !== requiredIdentifier) {
    throw new Error(`Internal-local app identifier must remain ${requiredIdentifier}.`);
  }
  if (plistValue(infoPlist, "LSMinimumSystemVersion") !== requiredMinimumSystemVersion) {
    throw new Error(
      `Internal-local app minimum macOS version must be ${requiredMinimumSystemVersion}.`,
    );
  }
  assertSingleArchitecture(binary, "WA Studio");
  command("codesign", ["--verify", "--deep", "--strict", app]);
  const signature = spawnSync("codesign", ["-dv", "--verbose=4", app], {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (signature.error) throw signature.error;
  if (signature.status !== 0) {
    throw new Error("Internal-local app is not ad-hoc code signed.");
  }
  const signatureDetails = `${signature.stdout ?? ""}\n${signature.stderr ?? ""}`;
  if (!signatureDetails.includes("Signature=adhoc")
    || !signatureDetails.includes("TeamIdentifier=not set")) {
    throw new Error("Internal-local app must use only an ad-hoc signature.");
  }
  const codeDirectoryHash = signatureDetails.match(/^CDHash=([0-9a-f]+)$/mu)?.[1];
  if (!codeDirectoryHash) {
    throw new Error("Internal-local app code-directory identity is unavailable.");
  }

  const manifest = JSON.parse(readFileSync(releaseManifest, "utf8"));
  if (manifest.gitCommit !== expectedCommit) {
    throw new Error("Bundled release manifest does not match the internal candidate commit.");
  }
  const version = plistValue(infoPlist, "CFBundleShortVersionString");
  if (manifest.studioVersion !== version) {
    throw new Error("Bundled release manifest does not match the internal candidate version.");
  }
  inspectMacRuntimeSidecar(runtimeSidecar, manifest, requiredArchitecture);

  return {
    appBundleSha256: sha256Bundle(app),
    binarySha256: sha256File(binary),
    codeDirectoryHash,
    releaseManifestSha256: sha256File(releaseManifest),
    runtimeSidecarSha256: sha256File(runtimeSidecar),
    version,
  };
}

function readMetadata() {
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (metadata.schemaVersion !== 1
    || metadata.buildKind !== "internal-local"
    || metadata.distributionAllowed !== false
    || metadata.updaterEnabled !== false
    || metadata.signatureKind !== "adhoc"
    || metadata.target !== requiredTarget
    || metadata.minimumSystemVersion !== requiredMinimumSystemVersion
    || metadata.appPath !== basename(outputApp)) {
    throw new Error("Internal-local build metadata is invalid.");
  }
  return metadata;
}

function verifyInternalLocalOutput(sourceState = currentSourceState()) {
  const errors = internalLocalPreflightErrors(sourceState);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const metadata = readMetadata();
  if (metadata.sourceCommit !== sourceState.headCommit) {
    throw new Error("Internal-local app was built from a different source commit.");
  }
  const inspected = inspectInternalApp(outputApp, metadata.sourceCommit);
  for (const field of [
    "appBundleSha256",
    "binarySha256",
    "codeDirectoryHash",
    "releaseManifestSha256",
    "runtimeSidecarSha256",
    "version",
  ]) {
    if (metadata[field] !== inspected[field]) {
      throw new Error(`Internal-local app no longer matches recorded ${field}.`);
    }
  }
  process.stdout.write(
    `Verified internal-local WA Studio ${metadata.version} at ${outputApp}.\n`,
  );
  return metadata;
}

function buildInternalLocal() {
  const sourceState = currentSourceState();
  const errors = internalLocalPreflightErrors(sourceState);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  if (existsSync(outputRoot)) {
    const metadata = verifyInternalLocalOutput(sourceState);
    process.stdout.write(
      `Reusing the verified internal-local candidate for ${metadata.sourceCommit}.\n`,
    );
    return;
  }

  mkdirSync(distRoot, { recursive: true });
  const cargoTargetRoot = mkdtempSync(resolve(tmpdir(), "wa-studio-internal-cargo-"));
  const stagingRoot = mkdtempSync(resolve(distRoot, ".internal-local-stage-"));
  let staged = true;
  try {
    const environment = internalLocalBuildEnvironment(process.env, cargoTargetRoot);
    command("npm", ["run", "release:manifest"], { environment, inherit: true });
    command("npm", ["run", "sidecar:prepare"], { environment, inherit: true });
    command("npm", [
      "-w", "@wa/studio", "run", "tauri", "--", "build",
      "--ci",
      "--target", requiredTarget,
      "--bundles", "app",
      "--config", internalConfig,
    ], { environment, inherit: true });

    const builtApp = resolve(
      cargoTargetRoot,
      requiredTarget,
      "release/bundle/macos/WA Studio.app",
    );
    const inspected = inspectInternalApp(builtApp, sourceState.headCommit);
    const stagedApp = resolve(stagingRoot, basename(outputApp));
    if (process.platform === "darwin") {
      command("ditto", [builtApp, stagedApp]);
    } else {
      cpSync(builtApp, stagedApp, { recursive: true, preserveTimestamps: true });
    }
    const copied = inspectInternalApp(stagedApp, sourceState.headCommit);
    if (copied.appBundleSha256 !== inspected.appBundleSha256) {
      throw new Error("Staged internal-local app differs from the verified build output.");
    }
    const metadata = {
      schemaVersion: 1,
      buildKind: "internal-local",
      distributionAllowed: false,
      updaterEnabled: false,
      signatureKind: "adhoc",
      appPath: basename(outputApp),
      sourceCommit: sourceState.headCommit,
      target: requiredTarget,
      minimumSystemVersion: requiredMinimumSystemVersion,
      builtAt: new Date().toISOString(),
      connectorPackageEmbedded: Boolean(
        String(process.env.WA_STUDIO_CONNECTOR_PLUGIN_URL ?? "").trim(),
      ),
      ...copied,
    };
    const stagedMetadata = resolve(stagingRoot, basename(metadataPath));
    writeFileSync(stagedMetadata, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    chmodSync(stagedMetadata, 0o600);
    renameSync(stagingRoot, outputRoot);
    staged = false;
    verifyInternalLocalOutput(sourceState);
  } finally {
    rmSync(cargoTargetRoot, { recursive: true, force: true });
    if (staged) rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function cleanInternalLocal() {
  if (!existsSync(outputRoot)) {
    process.stdout.write("No internal-local desktop artifact exists.\n");
    return;
  }
  const canonicalDist = realpathSync(distRoot);
  const canonicalOutput = realpathSync(outputRoot);
  if (canonicalOutput !== resolve(canonicalDist, "internal-local")) {
    throw new Error("Refusing to clean an unexpected internal-local output path.");
  }
  rmSync(outputRoot, { recursive: true, force: false });
  process.stdout.write(`Removed rebuildable internal-local artifact ${outputRoot}.\n`);
}

function main() {
  const action = process.argv[2];
  if (action === "build") return buildInternalLocal();
  if (action === "verify") return verifyInternalLocalOutput();
  if (action === "clean") return cleanInternalLocal();
  throw new Error("Usage: internal-local-desktop.mjs <build|verify|clean>");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) main();
