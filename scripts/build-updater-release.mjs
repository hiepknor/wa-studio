import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const commonRequired = [
  "WA_STUDIO_UPDATER_ENDPOINT",
  "WA_STUDIO_UPDATER_PUBLIC_KEY",
  "TAURI_SIGNING_PRIVATE_KEY",
];

const present = (environment, name) => Boolean(environment[name]?.trim());

export function releasePreflightErrors(environment, platform = process.platform) {
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
  if (present(environment, "WA_STUDIO_UPDATER_PUBLIC_KEY")
    && environment.WA_STUDIO_UPDATER_PUBLIC_KEY.trim().length < 32) {
    errors.push("WA_STUDIO_UPDATER_PUBLIC_KEY is too short.");
  }

  if (platform === "darwin") {
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

function run(command, args) {
  const result = spawnSync(command, args, { env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function assertMacReleaseArtifact() {
  const targetRoot = resolve(process.env.CARGO_TARGET_DIR ?? "src-tauri/target");
  const app = resolve(targetRoot, "release/bundle/macos/WA Studio.app");
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

  run("npm", ["run", "runtime:sidecar:prepare"]);
  run("npm", [
    "exec",
    "tauri",
    "--",
    "build",
    "--config",
    "src-tauri/tauri.updater.conf.json",
  ]);
  if (process.platform === "darwin") assertMacReleaseArtifact();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) main();
