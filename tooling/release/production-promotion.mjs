import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  readProductionAcceptancePolicy,
  readProductionDeploymentIdentity,
  verifyProductionAcceptance,
} from "./production-acceptance.mjs";

const defaultPolicyPath = resolve(
  import.meta.dirname,
  "../../release/production-acceptance-policy.json",
);
const defaultReceiptPath = resolve(
  import.meta.dirname,
  "../../release/production-promotion.json",
);
const digestPattern = /^[0-9a-f]{64}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const versionPattern = /^v([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?$/u;
const promotionFiles = new Set([
  "apps/studio/package.json",
  "apps/studio/src-tauri/Cargo.lock",
  "apps/studio/src-tauri/Cargo.toml",
  "apps/studio/src-tauri/tauri.conf.json",
  "package-lock.json",
  "release/components.json",
  "release/production-promotion.json",
]);

function required(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > 512) throw new Error(`${label} is too long.`);
  return normalized;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(object(value, label)).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} contains missing or unexpected fields.`);
  }
}

function timestamp(value, label) {
  const normalized = required(value, label);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp.`);
  }
  return { normalized, parsed };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseVersion(value, label) {
  const normalized = required(value, label);
  const match = normalized.match(versionPattern);
  if (!match) throw new Error(`${label} must be a semantic version tag.`);
  const core = match.slice(1, 4).map(Number);
  if (core.some(part => !Number.isSafeInteger(part))) {
    throw new Error(`${label} is outside the supported version range.`);
  }
  return { normalized, core, prerelease: match[4] ?? null };
}

function targetIsNewer(sourceTag, targetTag) {
  const source = parseVersion(sourceTag, "Accepted release tag");
  const target = parseVersion(targetTag, "Promotion target tag");
  for (let index = 0; index < source.core.length; index += 1) {
    if (target.core[index] > source.core[index]) return true;
    if (target.core[index] < source.core[index]) return false;
  }
  return source.prerelease !== null && target.prerelease === null;
}

function versionFromTag(tag, label) {
  return parseVersion(tag, label).core.join(".");
}

function runGit(workspaceRoot, args) {
  return execFileSync("git", ["-C", workspaceRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitFile(workspaceRoot, commit, path) {
  try {
    return runGit(workspaceRoot, ["show", `${commit}:${path}`]);
  } catch {
    throw new Error(`Stable promotion file is missing: ${path}.`);
  }
}

function assertRegularPromotionFile(workspaceRoot, commit, path) {
  const entry = runGit(workspaceRoot, ["ls-tree", commit, "--", path]);
  if (!/^100644 blob [0-9a-f]+\t/u.test(entry)) {
    throw new Error(`Stable promotion file must remain a regular non-executable file: ${path}.`);
  }
}

function parseJsonText(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function normalizedVersionJson(value, path, expectedVersion) {
  const parsed = object(parseJsonText(value, path), path);
  if (path === "package-lock.json") {
    const studio = object(parsed.packages?.["apps/studio"], "Studio package-lock entry");
    if (studio.version !== expectedVersion) {
      throw new Error(`${path} does not match its release version.`);
    }
    studio.version = "<promotion-version>";
    return JSON.stringify(parsed);
  }
  if (parsed.version !== expectedVersion) {
    throw new Error(`${path} does not match its release version.`);
  }
  parsed.version = "<promotion-version>";
  return JSON.stringify(parsed);
}

function normalizedCargoToml(value, path, expectedVersion) {
  const packageEnd = value.indexOf("\n[", 1);
  const head = packageEnd === -1 ? value : value.slice(0, packageEnd);
  const match = head.match(/^version = "([^"]+)"$/mu);
  if (!match || match[1] !== expectedVersion) {
    throw new Error(`${path} does not match its release version.`);
  }
  return value.replace(
    /^version = "[^"]+"$/mu,
    "version = \"<promotion-version>\"",
  );
}

function normalizedCargoLock(value, path, expectedVersion) {
  const pattern = /(\[\[package\]\]\nname = "wa-studio"\nversion = ")([^"]+)(")/u;
  const match = value.match(pattern);
  if (!match || match[2] !== expectedVersion) {
    throw new Error(`${path} does not match its release version.`);
  }
  return value.replace(pattern, "$1<promotion-version>$3");
}

function normalizedComponents(value, path, expectedVersion, expectedChannel) {
  const parsed = object(parseJsonText(value, path), path);
  if (parsed.product !== "wa-studio"
    || parsed.studioVersion !== expectedVersion
    || parsed.releaseChannel !== expectedChannel) {
    throw new Error(`${path} does not match the expected promotion state.`);
  }
  parsed.studioVersion = "<promotion-version>";
  parsed.releaseChannel = "<promotion-channel>";
  return JSON.stringify(parsed);
}

function normalizedPromotionFile(value, path, expectedVersion, expectedChannel) {
  if (path === "apps/studio/package.json" || path === "apps/studio/src-tauri/tauri.conf.json"
    || path === "package-lock.json") {
    return normalizedVersionJson(value, path, expectedVersion);
  }
  if (path === "apps/studio/src-tauri/Cargo.toml") {
    return normalizedCargoToml(value, path, expectedVersion);
  }
  if (path === "apps/studio/src-tauri/Cargo.lock") {
    return normalizedCargoLock(value, path, expectedVersion);
  }
  if (path === "release/components.json") {
    return normalizedComponents(value, path, expectedVersion, expectedChannel);
  }
  throw new Error(`Unsupported stable promotion file: ${path}.`);
}

function verifyReceiptShape(receipt, policy) {
  exactKeys(
    receipt,
    ["schemaVersion", "product", "issuedAt", "acceptedRelease", "acceptance", "target"],
    "Production promotion receipt",
  );
  if (receipt.schemaVersion !== 1 || receipt.product !== "wa-studio") {
    throw new Error("Production promotion receipt schema is incompatible.");
  }
  const issuedAt = timestamp(receipt.issuedAt, "Promotion receipt issue time");
  exactKeys(receipt.acceptedRelease, [
    "repository", "tag", "gitCommit", "releaseChannel", "deploymentManifestSha256",
    "eventInboxImageDigest", "connectorArtifactSha256",
  ], "Accepted release identity");
  exactKeys(receipt.acceptance, [
    "policyVersion", "policySha256", "operationalSnapshotSha256", "acceptanceRecordSha256",
    "evidenceArchiveSha256", "recoveryEvidenceSha256", "decidedAt",
  ], "Production acceptance identity");
  exactKeys(receipt.target, ["repository", "tag"], "Promotion target");

  if (receipt.acceptedRelease.releaseChannel !== "canary") {
    throw new Error("Only an accepted canary release can authorize stable promotion.");
  }
  const repository = required(receipt.acceptedRelease.repository, "Accepted repository");
  const targetRepository = required(receipt.target.repository, "Target repository");
  if (!repositoryPattern.test(repository) || targetRepository !== repository) {
    throw new Error("Promotion repositories are invalid or do not match.");
  }
  parseVersion(receipt.acceptedRelease.tag, "Accepted release tag");
  const target = parseVersion(receipt.target.tag, "Promotion target tag");
  if (target.prerelease !== null || !targetIsNewer(receipt.acceptedRelease.tag, target.normalized)) {
    throw new Error("Stable promotion target must be newer than the accepted canary.");
  }
  if (!/^[0-9a-f]{40}$/u.test(required(receipt.acceptedRelease.gitCommit, "Accepted commit"))) {
    throw new Error("Accepted release commit is invalid.");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(
    required(receipt.acceptedRelease.eventInboxImageDigest, "Accepted Event Inbox digest"),
  )) {
    throw new Error("Accepted Event Inbox image digest is invalid.");
  }
  for (const [value, label] of [
    [receipt.acceptedRelease.deploymentManifestSha256, "Accepted deployment manifest digest"],
    [receipt.acceptedRelease.connectorArtifactSha256, "Accepted connector artifact digest"],
    [receipt.acceptance.policySha256, "Acceptance policy digest"],
    [receipt.acceptance.operationalSnapshotSha256, "Operational snapshot digest"],
    [receipt.acceptance.acceptanceRecordSha256, "Acceptance record digest"],
    [receipt.acceptance.evidenceArchiveSha256, "Evidence archive digest"],
    [receipt.acceptance.recoveryEvidenceSha256, "Recovery evidence digest"],
  ]) {
    if (!digestPattern.test(required(value, label))) throw new Error(`${label} is invalid.`);
  }
  if (receipt.acceptance.policyVersion !== policy.identity.version
    || receipt.acceptance.policySha256 !== policy.identity.sha256) {
    throw new Error("Promotion receipt does not match the reviewed acceptance policy.");
  }
  const decidedAt = timestamp(receipt.acceptance.decidedAt, "Acceptance decision time");
  if (issuedAt.parsed < decidedAt.parsed) {
    throw new Error("Promotion receipt cannot predate the acceptance decision.");
  }
  return receipt;
}

export function verifyProductionPromotionReceipt({
  receiptPath = defaultReceiptPath,
  policyPath = defaultPolicyPath,
}) {
  const resolvedReceiptPath = resolve(required(receiptPath, "Promotion receipt path"));
  const policy = readProductionAcceptancePolicy(policyPath);
  const receipt = object(
    readJson(resolvedReceiptPath, "Production promotion receipt"),
    "Production promotion receipt",
  );
  return verifyReceiptShape(receipt, policy);
}

export function createProductionPromotionReceipt({
  acceptedDeploymentManifestPath,
  operationalSnapshotPath,
  recoveryEvidencePath,
  acceptanceRecordPath,
  targetTag,
  outputPath = defaultReceiptPath,
  policyPath = defaultPolicyPath,
  now = new Date(),
}) {
  const resolvedRecordPath = resolve(required(acceptanceRecordPath, "Acceptance record path"));
  const resolvedSnapshotPath = resolve(required(
    operationalSnapshotPath,
    "Operational snapshot path",
  ));
  const recordDigestBefore = sha256(resolvedRecordPath);
  const snapshotDigestBefore = sha256(resolvedSnapshotPath);
  const resolvedRecoveryEvidencePath = resolve(required(
    recoveryEvidencePath,
    "Recovery evidence path",
  ));
  const recoveryEvidenceDigestBefore = sha256(resolvedRecoveryEvidencePath);
  const record = verifyProductionAcceptance({
    deploymentManifestPath: acceptedDeploymentManifestPath,
    operationalSnapshotPath: resolvedSnapshotPath,
    recoveryEvidencePath,
    policyPath,
    recordPath: resolvedRecordPath,
    requireGo: true,
  });
  if (sha256(resolvedRecordPath) !== recordDigestBefore
    || sha256(resolvedSnapshotPath) !== snapshotDigestBefore
    || sha256(resolvedRecoveryEvidencePath) !== recoveryEvidenceDigestBefore
    || record.operationalSnapshot.sha256 !== snapshotDigestBefore) {
    throw new Error("Production acceptance evidence changed while creating the promotion receipt.");
  }
  if (record.release.releaseChannel !== "canary") {
    throw new Error("Only an accepted canary release can authorize stable promotion.");
  }
  const target = parseVersion(targetTag, "Promotion target tag");
  if (target.prerelease !== null || !targetIsNewer(record.release.tag, target.normalized)) {
    throw new Error("Stable promotion target must be newer than the accepted canary.");
  }
  const issuedAt = timestamp(
    now instanceof Date ? now.toISOString() : now,
    "Promotion receipt issue time",
  );
  const receipt = verifyReceiptShape({
    schemaVersion: 1,
    product: "wa-studio",
    issuedAt: issuedAt.normalized,
    acceptedRelease: record.release,
    acceptance: {
      policyVersion: record.policy.version,
      policySha256: record.policy.sha256,
      operationalSnapshotSha256: record.operationalSnapshot.sha256,
      acceptanceRecordSha256: recordDigestBefore,
      evidenceArchiveSha256: record.evidenceArchive.sha256,
      recoveryEvidenceSha256: record.recovery.evidenceSha256,
      decidedAt: record.decision.decidedAt,
    },
    target: {
      repository: record.release.repository,
      tag: target.normalized,
    },
  }, readProductionAcceptancePolicy(policyPath));
  writeFileSync(
    resolve(required(outputPath, "Promotion receipt output path")),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx", mode: 0o644 },
  );
  return receipt;
}

export function verifyProductionPromotionTarget({
  receiptPath = defaultReceiptPath,
  repository,
  tag,
  releaseChannel,
  policyPath = defaultPolicyPath,
}) {
  const channel = required(releaseChannel, "Release channel");
  const resolvedReceiptPath = resolve(receiptPath);
  if (channel === "canary") {
    if (existsSync(resolvedReceiptPath)) {
      throw new Error("Canary releases must not carry a stale production promotion receipt.");
    }
    return { required: false, releaseChannel: channel };
  }
  if (channel !== "stable") throw new Error("Release channel must be canary or stable.");
  if (!existsSync(resolvedReceiptPath)) {
    throw new Error("Stable releases require a production promotion receipt.");
  }
  const receipt = verifyProductionPromotionReceipt({ receiptPath: resolvedReceiptPath, policyPath });
  if (receipt.target.repository !== required(repository, "Target repository")
    || receipt.target.tag !== required(tag, "Target tag")) {
    throw new Error("Production promotion receipt does not authorize this repository and tag.");
  }
  return { required: true, releaseChannel: channel, receipt };
}

export function verifyProductionPromotionSource({
  receiptPath = defaultReceiptPath,
  acceptedDeploymentManifestPath,
  repository,
  tag,
  policyPath = defaultPolicyPath,
}) {
  const target = verifyProductionPromotionTarget({
    receiptPath,
    repository,
    tag,
    releaseChannel: "stable",
    policyPath,
  });
  const identity = readProductionDeploymentIdentity(acceptedDeploymentManifestPath, policyPath);
  if (Object.entries(target.receipt.acceptedRelease).some(
    ([key, value]) => identity.release[key] !== value,
  )) {
    throw new Error("Accepted canary manifest does not match the production promotion receipt.");
  }
  return target.receipt;
}

export function verifyProductionPromotionDelta({
  receiptPath = defaultReceiptPath,
  repository,
  tag,
  targetCommit,
  workspaceRoot = resolve(import.meta.dirname, "../.."),
  policyPath = defaultPolicyPath,
}) {
  const receipt = verifyProductionPromotionTarget({
    receiptPath,
    repository,
    tag,
    releaseChannel: "stable",
    policyPath,
  }).receipt;
  const sourceCommit = receipt.acceptedRelease.gitCommit;
  const normalizedTargetCommit = required(targetCommit, "Stable target commit");
  if (!/^[0-9a-f]{40}$/u.test(normalizedTargetCommit)) {
    throw new Error("Stable target commit is invalid.");
  }
  const root = resolve(required(workspaceRoot, "Workspace root"));
  try {
    runGit(root, ["merge-base", "--is-ancestor", sourceCommit, normalizedTargetCommit]);
  } catch {
    throw new Error("Stable target must descend from the accepted canary commit.");
  }
  const changedFiles = runGit(root, [
    "diff", "--name-only", "--no-renames", `${sourceCommit}..${normalizedTargetCommit}`,
  ]).split("\n").filter(Boolean);
  const unexpected = changedFiles.filter(path => !promotionFiles.has(path));
  if (unexpected.length > 0) {
    throw new Error(`Stable promotion contains unaccepted changes: ${unexpected.join(", ")}.`);
  }
  for (const requiredPath of ["release/components.json", "release/production-promotion.json"]) {
    if (!changedFiles.includes(requiredPath)) {
      throw new Error(`Stable promotion must change ${requiredPath}.`);
    }
  }
  try {
    runGit(root, ["cat-file", "-e", `${sourceCommit}:release/production-promotion.json`]);
    throw new Error("Accepted canary commit contains a stale production promotion receipt.");
  } catch (error) {
    if (error instanceof Error && error.message.includes("stale production")) throw error;
  }

  const sourceVersion = versionFromTag(receipt.acceptedRelease.tag, "Accepted release tag");
  const targetVersion = versionFromTag(receipt.target.tag, "Promotion target tag");
  for (const path of [...promotionFiles].filter(path => path !== "release/production-promotion.json")) {
    assertRegularPromotionFile(root, sourceCommit, path);
    assertRegularPromotionFile(root, normalizedTargetCommit, path);
    const source = normalizedPromotionFile(
      gitFile(root, sourceCommit, path),
      path,
      sourceVersion,
      "canary",
    );
    const target = normalizedPromotionFile(
      gitFile(root, normalizedTargetCommit, path),
      path,
      targetVersion,
      "stable",
    );
    if (source !== target) {
      throw new Error(`Stable promotion changed non-version content in ${path}.`);
    }
  }
  assertRegularPromotionFile(
    root,
    normalizedTargetCommit,
    "release/production-promotion.json",
  );
  const committedReceiptText = gitFile(
    root,
    normalizedTargetCommit,
    "release/production-promotion.json",
  );
  const committedReceipt = object(parseJsonText(
    committedReceiptText,
    "Committed production promotion receipt",
  ), "Committed production promotion receipt");
  if (committedReceiptText !== JSON.stringify(receipt, null, 2)
    || JSON.stringify(committedReceipt) !== JSON.stringify(receipt)) {
    throw new Error("Committed production promotion receipt does not match the verified receipt.");
  }
  return { sourceCommit, targetCommit: normalizedTargetCommit, changedFiles };
}

function parseArguments(argv) {
  const [command, ...values] = argv;
  const allowed = command === "create"
    ? new Set([
      "accepted-deployment", "operational-snapshot", "acceptance-record", "target-tag",
      "recovery-evidence", "output", "policy",
    ])
    : command === "verify-target"
      ? new Set(["receipt", "repository", "tag", "release-channel", "policy"])
      : command === "verify-source"
        ? new Set(["receipt", "accepted-deployment", "repository", "tag", "policy"])
        : new Set(["receipt", "repository", "tag", "target-commit", "workspace-root", "policy"]);
  if (!["create", "verify-target", "verify-source", "verify-delta"].includes(command)) {
    throw new Error(
      "Usage: production-promotion.mjs <create|verify-target|verify-source|verify-delta> [options]",
    );
  }
  const options = { command };
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid argument near ${flag ?? "end of command"}.`);
    }
    const name = flag.slice(2);
    if (!allowed.has(name)) throw new Error(`Unsupported option: ${flag}.`);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: ${flag}.`);
    options[name] = value;
  }
  return options;
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.command === "create") {
    const receipt = createProductionPromotionReceipt({
      acceptedDeploymentManifestPath: options["accepted-deployment"],
      operationalSnapshotPath: options["operational-snapshot"],
      recoveryEvidencePath: options["recovery-evidence"],
      acceptanceRecordPath: options["acceptance-record"],
      targetTag: options["target-tag"],
      outputPath: options.output,
      policyPath: options.policy,
    });
    process.stdout.write(`${JSON.stringify({
      status: "created",
      acceptedTag: receipt.acceptedRelease.tag,
      targetTag: receipt.target.tag,
    })}\n`);
    return;
  }
  if (options.command === "verify-target") {
    const result = verifyProductionPromotionTarget({
      receiptPath: options.receipt,
      repository: options.repository,
      tag: options.tag,
      releaseChannel: options["release-channel"],
      policyPath: options.policy,
    });
    process.stdout.write(`${JSON.stringify({
      status: "verified",
      releaseChannel: result.releaseChannel,
      receiptRequired: result.required,
    })}\n`);
    return;
  }
  if (options.command === "verify-source") {
    const receipt = verifyProductionPromotionSource({
      receiptPath: options.receipt,
      acceptedDeploymentManifestPath: options["accepted-deployment"],
      repository: options.repository,
      tag: options.tag,
      policyPath: options.policy,
    });
    process.stdout.write(`${JSON.stringify({
      status: "verified",
      acceptedTag: receipt.acceptedRelease.tag,
      targetTag: receipt.target.tag,
    })}\n`);
    return;
  }
  const delta = verifyProductionPromotionDelta({
    receiptPath: options.receipt,
    repository: options.repository,
    tag: options.tag,
    targetCommit: options["target-commit"],
    workspaceRoot: options["workspace-root"],
    policyPath: options.policy,
  });
  process.stdout.write(`${JSON.stringify({
    status: "verified",
    sourceCommit: delta.sourceCommit,
    targetCommit: delta.targetCommit,
    changedFileCount: delta.changedFiles.length,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
