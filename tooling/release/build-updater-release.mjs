import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalUpdaterEndpoint } from "./updater-release.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const studioRoot = resolve(workspaceRoot, "apps/studio");
const requiredMacArchitecture = "arm64";
const requiredMacMinimumSystemVersion = "13.5";
const releaseComponents = JSON.parse(
  readFileSync(resolve(workspaceRoot, "release/components.json"), "utf8"),
);

const commonRequired = [
  "WA_STUDIO_CONNECTOR_PLUGIN_URL",
  "WA_STUDIO_UPDATER_ENDPOINT",
  "WA_STUDIO_UPDATER_PUBLIC_KEY",
  "TAURI_SIGNING_PRIVATE_KEY",
];

const signedBuildOnlyEnvironment = new Set([
  "APPLE_API_ISSUER",
  "APPLE_API_KEY",
  "APPLE_API_KEY_PATH",
  "APPLE_API_PRIVATE_KEY",
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_TEAM_ID",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "WA_STUDIO_UPDATER_ENDPOINT",
  "WA_STUDIO_UPDATER_PUBLIC_KEY",
]);

const present = (environment, name) => Boolean(environment[name]?.trim());

export function releasePreflightErrors(
  environment,
  platform = process.platform,
  releaseChannel = releaseComponents.releaseChannel,
  architecture = process.arch,
) {
  const errors = [];
  const missing = commonRequired.filter(name => !present(environment, name));
  if (missing.length > 0) {
    errors.push(`Signed updater build is missing: ${missing.join(", ")}`);
  }

  if (present(environment, "WA_STUDIO_UPDATER_ENDPOINT")) {
    try {
      const endpoint = new URL(environment.WA_STUDIO_UPDATER_ENDPOINT);
      if (endpoint.protocol !== "https:" || !endpoint.hostname
        || endpoint.username || endpoint.password) {
        errors.push("WA_STUDIO_UPDATER_ENDPOINT must be HTTPS and cannot contain credentials.");
      }
    } catch {
      errors.push("WA_STUDIO_UPDATER_ENDPOINT must be a valid absolute URL.");
    }
  }
  if (present(environment, "GITHUB_REPOSITORY")
    && present(environment, "WA_STUDIO_UPDATER_ENDPOINT")) {
    try {
      const expected = canonicalUpdaterEndpoint(environment.GITHUB_REPOSITORY, releaseChannel);
      if (environment.WA_STUDIO_UPDATER_ENDPOINT.trim() !== expected) {
        errors.push(`WA_STUDIO_UPDATER_ENDPOINT must publish from ${expected}.`);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (present(environment, "WA_STUDIO_UPDATER_PUBLIC_KEY")
    && environment.WA_STUDIO_UPDATER_PUBLIC_KEY.trim().length < 32) {
    errors.push("WA_STUDIO_UPDATER_PUBLIC_KEY is too short.");
  }
  if (present(environment, "WA_STUDIO_CONNECTOR_PLUGIN_URL")) {
    try {
      const connectorUrl = new URL(environment.WA_STUDIO_CONNECTOR_PLUGIN_URL);
      const digest = connectorUrl.hash.match(/^#sha256=([0-9a-f]{64})$/u)?.[1];
      if (connectorUrl.protocol !== "https:"
        || !connectorUrl.hostname
        || connectorUrl.username
        || connectorUrl.password
        || !connectorUrl.pathname.endsWith(".zip")
        || !digest) {
        errors.push(
          "WA_STUDIO_CONNECTOR_PLUGIN_URL must be an HTTPS .zip URL pinned with #sha256=<64 hex>.",
        );
      }
    } catch {
      errors.push("WA_STUDIO_CONNECTOR_PLUGIN_URL must be a valid absolute URL.");
    }
  }

  if (platform === "darwin") {
    if (architecture !== requiredMacArchitecture) {
      errors.push(
        `macOS release builds require ${requiredMacArchitecture}; received ${architecture}.`,
      );
    }
    const signingIdentity = environment.APPLE_SIGNING_IDENTITY?.trim();
    const hasKeychainIdentity = Boolean(signingIdentity && signingIdentity !== "-");
    const hasImportedCertificate = present(environment, "APPLE_CERTIFICATE")
      && present(environment, "APPLE_CERTIFICATE_PASSWORD");
    if (!hasKeychainIdentity && !hasImportedCertificate) {
      errors.push(
        "macOS release signing requires a non-ad-hoc APPLE_SIGNING_IDENTITY or "
        + "APPLE_CERTIFICATE with APPLE_CERTIFICATE_PASSWORD.",
      );
    }

    const hasApiNotarization = present(environment, "APPLE_API_ISSUER")
      && present(environment, "APPLE_API_KEY")
      && present(environment, "APPLE_API_KEY_PATH");
    const hasAppleIdNotarization = present(environment, "APPLE_ID")
      && present(environment, "APPLE_PASSWORD")
      && present(environment, "APPLE_TEAM_ID");
    if (!hasApiNotarization && !hasAppleIdNotarization) {
      errors.push(
        "macOS release notarization requires APPLE_API_ISSUER, APPLE_API_KEY and "
        + "APPLE_API_KEY_PATH, or APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID.",
      );
    }
  }

  return errors;
}

export function releaseIndependentEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !signedBuildOnlyEnvironment.has(name)),
  );
}

function run(command, args, environment = releaseIndependentEnvironment(process.env)) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function assertMacReleaseArtifact() {
  const targetRoot = resolve(
    studioRoot,
    process.env.CARGO_TARGET_DIR ?? "src-tauri/target",
  );
  const app = resolve(targetRoot, "release/bundle/macos/WA Studio.app");
  const binary = resolve(app, "Contents/MacOS/wa-studio");
  const architecture = spawnSync("lipo", ["-archs", binary], { encoding: "utf8" });
  if (architecture.error) throw architecture.error;
  if (architecture.status !== 0) process.exit(architecture.status ?? 1);
  if (architecture.stdout.trim() !== requiredMacArchitecture) {
    throw new Error(
      `macOS release binary must contain only ${requiredMacArchitecture}; received ${architecture.stdout.trim()}.`,
    );
  }
  const minimumSystemVersion = spawnSync("plutil", [
    "-extract", "LSMinimumSystemVersion", "raw", "-o", "-", resolve(app, "Contents/Info.plist"),
  ], { encoding: "utf8" });
  if (minimumSystemVersion.error) throw minimumSystemVersion.error;
  if (minimumSystemVersion.status !== 0) process.exit(minimumSystemVersion.status ?? 1);
  if (minimumSystemVersion.stdout.trim() !== requiredMacMinimumSystemVersion) {
    throw new Error(
      `macOS release minimum system version must be ${requiredMacMinimumSystemVersion}; received ${minimumSystemVersion.stdout.trim()}.`,
    );
  }
  run("codesign", ["--verify", "--deep", "--strict", app]);
  const signature = spawnSync("codesign", ["-dv", "--verbose=4", app], {
    encoding: "utf8",
  });
  if (signature.error) throw signature.error;
  if (signature.status !== 0) process.exit(signature.status ?? 1);
  const details = `${signature.stdout ?? ""}\n${signature.stderr ?? ""}`;
  if (details.includes("Signature=adhoc") || details.includes("TeamIdentifier=not set")) {
    throw new Error("macOS release artifact is ad-hoc signed instead of Developer ID signed.");
  }
  run("xcrun", ["stapler", "validate", app]);
  process.stdout.write("Verified macOS Developer ID signature and stapled notarization ticket.\n");
}

function main() {
  const errors = releasePreflightErrors(process.env);
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exit(1);
  }
  if (process.argv.includes("--preflight-only")) {
    process.stdout.write("Signed release preflight passed.\n");
    return;
  }

  run("npm", ["run", "sidecar:prepare"]);
  run("npm", [
    "-w",
    "@wa/studio",
    "run",
    "tauri",
    "--",
    "build",
    "--config",
    resolve(studioRoot, "src-tauri/tauri.updater.conf.json"),
  ], process.env);
  if (process.platform === "darwin") assertMacReleaseArtifact();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) main();
