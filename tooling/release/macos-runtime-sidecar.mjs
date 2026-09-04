import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const requiredEntitlement = "com.apple.security.cs.allow-jit";
const manifestTimeoutMs = 15_000;

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout,
    env: options.environment,
  });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`${command} ${arguments_.join(" ")} timed out.`);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    const outcome = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
    throw new Error(
      `${command} ${arguments_.join(" ")} failed with ${outcome}.`
      + (detail ? `\n${detail}` : ""),
    );
  }
  return {
    stderr: String(result.stderr ?? "").trim(),
    stdout: String(result.stdout ?? "").trim(),
  };
}

function inspectionEnvironment(environment = process.env) {
  return {
    LANG: "C",
    LC_ALL: "C",
    PATH: environment.PATH || "/usr/bin:/bin",
    TMPDIR: environment.TMPDIR || tmpdir(),
  };
}

function entitlementKeys(output) {
  return [...output.matchAll(/^\s*\[Key\]\s+(.+)$/gmu)].map(match => match[1].trim());
}

export function runtimeSidecarValidationErrors({ entitlements, manifest }, expected) {
  const errors = [];
  const keys = entitlementKeys(entitlements);
  if (keys.length !== 1 || keys[0] !== requiredEntitlement
    || !entitlements.includes("[Bool] true")) {
    errors.push(
      `WA Runtime sidecar must have only the ${requiredEntitlement} entitlement enabled.`,
    );
  }
  const requiredManifest = {
    schemaVersion: 2,
    service: expected.runtimeService,
    version: expected.runtimeVersion,
    contractVersion: expected.runtimeContractVersion,
    openwaReleaseTag: expected.openwaReleaseTag,
    openwaContractSha256: expected.openwaContractSha256,
  };
  for (const [field, value] of Object.entries(requiredManifest)) {
    if (manifest?.[field] !== value) {
      errors.push(`WA Runtime manifest ${field} does not match the bundled release manifest.`);
    }
  }
  if (!Array.isArray(manifest?.profiles) || !manifest.profiles.includes("desktop-managed")
    || !Array.isArray(manifest?.roles) || !manifest.roles.includes("desktop")
    || !Array.isArray(manifest?.databaseBackends)
    || !manifest.databaseBackends.includes("postgres")) {
    errors.push("WA Runtime manifest does not advertise the required desktop-managed capabilities.");
  }
  return errors;
}

export function inspectMacRuntimeSidecar(
  runtimeSidecar,
  expectedRelease,
  expectedArchitecture = "arm64",
) {
  run("codesign", ["--verify", "--strict", runtimeSidecar]);
  const signature = run("codesign", ["-dv", "--verbose=4", runtimeSidecar]);
  if (!/^CodeDirectory.*flags=.*\bruntime\b/mu.test(signature.stderr)) {
    throw new Error("WA Runtime sidecar must retain Hardened Runtime code signing.");
  }
  const architecture = run("lipo", ["-archs", runtimeSidecar]).stdout;
  if (architecture !== expectedArchitecture) {
    throw new Error(
      `WA Runtime sidecar must contain only ${expectedArchitecture}; received ${architecture}.`,
    );
  }
  const entitlements = run(
    "codesign",
    ["-d", "--entitlements", "-", runtimeSidecar],
  ).stdout;
  const runtimeManifestOutput = run(runtimeSidecar, ["manifest"], {
    environment: inspectionEnvironment(),
    timeout: manifestTimeoutMs,
  }).stdout;
  let manifest;
  try {
    manifest = JSON.parse(runtimeManifestOutput);
  } catch {
    throw new Error("WA Runtime sidecar returned an invalid manifest.");
  }
  const errors = runtimeSidecarValidationErrors({ entitlements, manifest }, expectedRelease);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return manifest;
}
