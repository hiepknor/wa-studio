import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const digestPattern = /^[0-9a-f]{64}$/u;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/u;
const archivePattern = /^wa-event-inbox-[0-9]{8}T[0-9]{6}Z\.dump\.age$/u;

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

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function trueValue(value, label) {
  if (value !== true) throw new Error(`${label} must be true.`);
}

function readJsonArtifact(path, label) {
  const bytes = readFileSync(path);
  try {
    return {
      value: JSON.parse(bytes.toString("utf8")),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function assertPrivateFile(path, label) {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o400) === 0 || (mode & 0o177) !== 0) {
    throw new Error(`${label} must be a private, non-executable owner-readable file.`);
  }
}

function deploymentIdentity(path) {
  const manifestPath = resolve(required(path, "Deployment manifest path"));
  const manifest = readJsonArtifact(manifestPath, "Deployment manifest");
  const deployment = object(manifest.value, "Deployment manifest");
  const eventInbox = object(deployment.components?.eventInbox, "Deployment Event Inbox component");
  const migrationHead = object(eventInbox.migrationHead, "Deployment Event Inbox migration head");
  if (deployment.schemaVersion !== 1
    || deployment.product !== "wa-studio"
    || deployment.releaseScope !== "product") {
    throw new Error("Deployment manifest is not a coordinated WA Studio product release.");
  }
  const identity = {
    repository: required(deployment.repository, "Deployment repository"),
    tag: required(deployment.tag, "Deployment tag"),
    gitCommit: required(deployment.gitCommit, "Deployment commit"),
    deploymentManifestSha256: manifest.sha256,
    eventInboxImageDigest: required(eventInbox.imageDigest, "Event Inbox image digest"),
    eventInboxMigrationHead: required(migrationHead.name, "Event Inbox migration head"),
    eventInboxMigrationSetSha256: required(
      migrationHead.setSha256,
      "Event Inbox migration set digest",
    ),
  };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(identity.repository)
    || !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(identity.tag)
    || !/^[0-9a-f]{40}$/u.test(identity.gitCommit)
    || !digestPattern.test(identity.deploymentManifestSha256)
    || !imageDigestPattern.test(identity.eventInboxImageDigest)
    || !/^\d{3}_[a-z0-9_]+\.sql$/u.test(identity.eventInboxMigrationHead)
    || !digestPattern.test(identity.eventInboxMigrationSetSha256)) {
    throw new Error("Deployment manifest contains an invalid recovery identity.");
  }
  return identity;
}

function verifyShape(evidence, expected) {
  exactKeys(
    evidence,
    ["schemaVersion", "evidenceType", "recordedAt", "release", "backup", "restore", "result"],
    "Production recovery evidence",
  );
  if (evidence.schemaVersion !== 1
    || evidence.evidenceType !== "wa-studio-event-inbox-restore-drill"
    || evidence.result !== "PASS") {
    throw new Error("Production recovery evidence schema or result is incompatible.");
  }
  const recorded = timestamp(evidence.recordedAt, "Recovery evidence record time");
  exactKeys(evidence.release, Object.keys(expected), "Recovery evidence release identity");
  if (Object.entries(expected).some(([key, value]) => evidence.release[key] !== value)) {
    throw new Error("Production recovery evidence does not match the deployment manifest.");
  }
  exactKeys(evidence.backup, ["objectKey", "sha256"], "Recovery backup identity");
  const objectKey = required(evidence.backup.objectKey, "Recovery backup object key");
  if (!archivePattern.test(objectKey) || !digestPattern.test(required(
    evidence.backup.sha256,
    "Recovery backup checksum",
  ))) {
    throw new Error("Recovery backup identity is invalid.");
  }
  exactKeys(evidence.restore, [
    "startedAt", "completedAt", "durationSeconds", "isolation", "restoredMigrationHead",
    "checksumVerified", "archiveCatalogVerified", "schemaVerified", "usageLedgerVerified",
  ], "Recovery restore result");
  const started = timestamp(evidence.restore.startedAt, "Restore drill start time");
  const completed = timestamp(evidence.restore.completedAt, "Restore drill completion time");
  const durationSeconds = nonnegativeInteger(
    evidence.restore.durationSeconds,
    "Restore drill duration",
  );
  if (completed.parsed < started.parsed
    || Math.floor((completed.parsed - started.parsed) / 1_000) !== durationSeconds
    || recorded.parsed !== completed.parsed) {
    throw new Error("Restore drill timing is inconsistent.");
  }
  if (evidence.restore.isolation !== "temporary-database"
    || evidence.restore.restoredMigrationHead !== expected.eventInboxMigrationHead) {
    throw new Error("Restore drill isolation or migration head is invalid.");
  }
  for (const [key, label] of [
    ["checksumVerified", "Backup checksum verification"],
    ["archiveCatalogVerified", "Backup archive catalog verification"],
    ["schemaVerified", "Restored schema verification"],
    ["usageLedgerVerified", "Restored usage ledger verification"],
  ]) trueValue(evidence.restore[key], label);
}

export function verifyProductionRecoveryEvidence({ deploymentManifestPath, evidencePath }) {
  const expected = deploymentIdentity(deploymentManifestPath);
  const resolvedEvidencePath = resolve(required(evidencePath, "Recovery evidence path"));
  assertPrivateFile(resolvedEvidencePath, "Production recovery evidence");
  const artifact = readJsonArtifact(resolvedEvidencePath, "Production recovery evidence");
  const evidence = object(
    artifact.value,
    "Production recovery evidence",
  );
  verifyShape(evidence, expected);
  return { evidence, sha256: artifact.sha256 };
}

function parseArguments(argv) {
  const [command, ...values] = argv;
  if (command !== "verify") {
    throw new Error(
      "Usage: production-recovery-evidence.mjs verify --deployment <manifest> --evidence <path>",
    );
  }
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!["--deployment", "--evidence"].includes(flag)
      || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid argument near ${flag ?? "end of command"}.`);
    }
    const name = flag.slice(2);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: ${flag}.`);
    options[name] = value;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const verified = verifyProductionRecoveryEvidence({
      deploymentManifestPath: options.deployment,
      evidencePath: options.evidence,
    });
    process.stdout.write(`${JSON.stringify({
      status: "verified",
      backupObjectKey: verified.evidence.backup.objectKey,
      evidenceSha256: verified.sha256,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
