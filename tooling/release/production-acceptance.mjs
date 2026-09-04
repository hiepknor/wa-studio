import { createHash } from "node:crypto";
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { verifyProductionOperationalSnapshot } from "./production-operational-snapshot.mjs";
import { verifyProductionRecoveryEvidence } from "./production-recovery-evidence.mjs";

const defaultPolicyPath = resolve(
  import.meta.dirname,
  "../../release/production-acceptance-policy.json",
);
const digestPattern = /^[0-9a-f]{64}$/u;
const forbiddenKeyNames = new Set([
  "apikey",
  "credential",
  "devicetoken",
  "mastersecret",
  "password",
  "passphrase",
  "privatekey",
  "secret",
  "token",
]);

function required(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > 512) throw new Error(`${label} is too long.`);
  return normalized;
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

function assertPrivateRecord(path) {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o400) === 0 || (mode & 0o177) !== 0) {
    throw new Error("Production acceptance record must be a private, non-executable owner-readable file.");
  }
}

function atomicPrivateWrite(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporaryPath, value, { flag: "wx", mode: 0o600 });
  try {
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write error; a later operator cleanup may remove the temp file.
    }
    throw error;
  }
}

export function readProductionAcceptancePolicy(path = defaultPolicyPath) {
  const policyPath = resolve(required(path, "Production acceptance policy path"));
  const policy = object(
    readJson(policyPath, "Production acceptance policy"),
    "Production acceptance policy",
  );
  exactKeys(
    policy,
    [
      "schemaVersion", "product", "policyVersion", "callbackIncident", "canary",
      "managedStorage",
    ],
    "Production acceptance policy",
  );
  if (policy.schemaVersion !== 1 || policy.product !== "wa-studio") {
    throw new Error("Production acceptance policy schema is incompatible.");
  }
  exactKeys(
    policy.callbackIncident,
    ["id", "requiredObservedFailureSlice"],
    "Callback incident policy",
  );
  exactKeys(
    policy.canary,
    ["minimumObservationSeconds", "maximumFinalEvidenceAgeSeconds"],
    "Canary policy",
  );
  exactKeys(
    policy.managedStorage,
    ["minimumAvailableBytes", "maximumAutomaticRecoveryUtilization"],
    "Managed storage policy",
  );
  const policyVersion = positiveInteger(policy.policyVersion, "Acceptance policy version");
  const minimumObservationSeconds = positiveInteger(
    policy.canary.minimumObservationSeconds,
    "Minimum canary observation seconds",
  );
  if (minimumObservationSeconds < 24 * 60 * 60 || minimumObservationSeconds > 30 * 24 * 60 * 60) {
    throw new Error("Canary policy must require between 24 hours and 30 days of observation.");
  }
  const maximumFinalEvidenceAgeSeconds = positiveInteger(
    policy.canary.maximumFinalEvidenceAgeSeconds,
    "Maximum final evidence age seconds",
  );
  if (maximumFinalEvidenceAgeSeconds > 60 * 60) {
    throw new Error("Final evidence policy cannot allow evidence older than one hour.");
  }
  return {
    identity: {
      version: policyVersion,
      sha256: sha256(policyPath),
      callbackIncidentId: required(policy.callbackIncident.id, "Callback incident policy ID"),
    },
    requirements: {
      requiredObservedFailureSlice: positiveInteger(
        policy.callbackIncident.requiredObservedFailureSlice,
        "Required callback failure slice",
      ),
      minimumObservationSeconds,
      maximumFinalEvidenceAgeSeconds,
      minimumManagedStorageAvailableBytes: positiveInteger(
        policy.managedStorage.minimumAvailableBytes,
        "Minimum managed storage available bytes",
      ),
      maximumAutomaticRecoveryUtilization: proportion(
        policy.managedStorage.maximumAutomaticRecoveryUtilization,
        "Maximum automatic recovery utilization",
      ),
    },
  };
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
  return parsed;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function proportion(value, label) {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${label} must be greater than zero and no greater than one.`);
  }
  return value;
}

function trueValue(value, label) {
  if (value !== true) throw new Error(`${label} must be true.`);
}

function withinWindow(value, label, start, end) {
  const parsed = timestamp(value, label);
  if (parsed < start || parsed > end) {
    throw new Error(`${label} must fall within the recorded canary window.`);
  }
  return parsed;
}

function nearWindowEnd(value, label, start, end, maximumAgeMs) {
  const parsed = withinWindow(value, label, start, end);
  if (end - parsed > maximumAgeMs) {
    throw new Error(`${label} is too old to represent the end of the recorded canary window.`);
  }
  return parsed;
}

function zero(value, label) {
  if (nonnegativeInteger(value, label) !== 0) {
    throw new Error(`${label} must be zero for a GO decision.`);
  }
}

function rejectSensitiveMaterial(value, path = "record") {
  if (typeof value === "string") {
    if (/https?:\/\/[^/@\s:]+:[^/@\s]+@/u.test(value)) {
      throw new Error(`${path} must not contain a URL with embedded credentials.`);
    }
    if (value.length > 512) throw new Error(`${path} contains an unexpectedly large string.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSensitiveMaterial(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
    if (forbiddenKeyNames.has(normalizedKey)) {
      throw new Error(`${path}.${key} is a forbidden sensitive-data field.`);
    }
    rejectSensitiveMaterial(entry, `${path}.${key}`);
  }
}

export function readProductionDeploymentIdentity(path, policyPath = defaultPolicyPath) {
  const manifestPath = resolve(required(path, "Deployment manifest path"));
  const deployment = object(readJson(manifestPath, "Deployment manifest"), "Deployment manifest");
  if (deployment.schemaVersion !== 1
    || deployment.product !== "wa-studio"
    || deployment.releaseScope !== "product"
    || !["canary", "stable"].includes(deployment.releaseChannel)) {
    throw new Error("Deployment manifest is not a coordinated WA Studio product release.");
  }
  const connector = object(deployment.components?.connector, "Deployment connector component");
  const eventInbox = object(deployment.components?.eventInbox, "Deployment Event Inbox component");
  const runtime = object(deployment.components?.runtime, "Deployment Runtime component");
  const openwa = object(deployment.components?.openwa, "Deployment OpenWA component");
  const acceptance = object(deployment.components?.acceptance, "Deployment acceptance component");
  const policy = readProductionAcceptancePolicy(policyPath);
  const artifact = object(connector.artifact, "Deployment connector artifact");
  const imageDigest = required(eventInbox.imageDigest, "Event Inbox image digest");
  const connectorDigest = required(artifact.sha256, "Connector artifact digest");
  if (!/^sha256:[0-9a-f]{64}$/u.test(imageDigest) || !digestPattern.test(connectorDigest)) {
    throw new Error("Deployment component digests are invalid.");
  }
  if (acceptance.policyVersion !== policy.identity.version
    || acceptance.policySha256 !== policy.identity.sha256) {
    throw new Error("Deployment acceptance policy does not match the reviewed policy.");
  }
  const repository = required(deployment.repository, "Deployment repository");
  const tag = required(deployment.tag, "Deployment tag");
  const gitCommit = required(deployment.gitCommit, "Deployment commit");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
    || !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(tag)
    || !/^[0-9a-f]{40}$/u.test(gitCommit)) {
    throw new Error("Deployment release identity is invalid.");
  }
  return {
    release: {
      repository,
      tag,
      gitCommit,
      releaseChannel: deployment.releaseChannel,
      deploymentManifestSha256: sha256(manifestPath),
      eventInboxImageDigest: imageDigest,
      connectorArtifactSha256: connectorDigest,
    },
    connector: {
      protocolVersion: positiveInteger(connector.protocolVersion, "Connector protocol version"),
      journalSchemaVersion: positiveInteger(
        connector.journalSchemaVersion,
        "Connector journal schema version",
      ),
    },
    operational: {
      runtimeVersion: required(runtime.version, "Deployment Runtime version"),
      openwaRelease: required(openwa.releaseTag, "Deployment OpenWA release"),
      connectorPluginVersion: required(connector.version, "Deployment connector version"),
    },
    policy,
  };
}

export function productionAcceptanceTemplate(
  deploymentManifestPath,
  now = new Date(),
  policyPath = defaultPolicyPath,
) {
  const identity = readProductionDeploymentIdentity(deploymentManifestPath, policyPath);
  return {
    schemaVersion: 2,
    product: "wa-studio",
    recordCreatedAt: now.toISOString(),
    release: identity.release,
    policy: identity.policy.identity,
    operationalSnapshot: {
      sha256: null,
      capturedAt: null,
    },
    evidenceArchive: {
      objectKey: null,
      sha256: null,
    },
    callbackIncident: {
      observedFailureSlice: identity.policy.requirements.requiredObservedFailureSlice,
      classifiedFailures: null,
      unclassifiedFailures: null,
      cumulativeLedgerCount: null,
      capturedAt: null,
      acknowledgedAt: null,
    },
    canary: {
      startedAt: null,
      endedAt: null,
      candidateUnchanged: null,
      criticalAlerts: null,
      callbackLoss: null,
      duplicateOutboundEffects: null,
      unknownDeliveries: null,
      terminalWebhookFailureDelta: null,
      recurringCooldowns: null,
    },
    managedStorage: {
      verifiedAt: null,
      pressure: null,
      filesystemAvailableBytes: null,
      recoveryPointCount: null,
      recoveryFreshness: null,
      integrityFreshness: null,
      automaticRecoveryBytes: null,
      automaticRecoveryBudgetBytes: null,
    },
    connector: {
      ...identity.connector,
      credentialGeneration: null,
      bindingGeneration: null,
      exclusive: null,
      healthy: null,
      verifiedAt: null,
    },
    recovery: {
      objectKey: null,
      sha256: null,
      backupVerifiedAt: null,
      restoreDrillAt: null,
      restoreSucceeded: null,
      evidenceSha256: null,
    },
    uat: {
      runId: null,
      testGroupId: null,
      targetCount: null,
      resolvedCount: null,
      unknownMessageJobs: null,
      completedAt: null,
    },
    drills: {
      offlineDrainAt: null,
      connectorPreSendRestartAt: null,
      connectorPostSendRestartAt: null,
      safetyFenceAt: null,
      rateLimitRecoveryAt: null,
      pairingRevocationAt: null,
      alertRoundTripAt: null,
    },
    operations: {
      authoritativeSyncAt: null,
      projectionsReconciled: null,
      eventInboxGaps: null,
      eventInboxDeadEvents: null,
      unownedSessions: null,
      publicHealthVerifiedAt: null,
      privateHealthVerifiedAt: null,
    },
    decision: {
      outcome: "PENDING",
      operator: null,
      decidedAt: null,
      acknowledged: false,
    },
  };
}

function verifyShape(record, expectedRelease, expectedPolicy) {
  exactKeys(record, [
    "schemaVersion", "product", "recordCreatedAt", "release", "policy", "operationalSnapshot",
    "evidenceArchive",
    "callbackIncident", "canary", "managedStorage", "connector", "recovery", "uat", "drills",
    "operations", "decision",
  ], "Production acceptance record");
  if (record.schemaVersion !== 2 || record.product !== "wa-studio") {
    throw new Error("Production acceptance record schema is incompatible.");
  }
  timestamp(record.recordCreatedAt, "Record creation time");
  exactKeys(record.release, [
    "repository", "tag", "gitCommit", "releaseChannel", "deploymentManifestSha256",
    "eventInboxImageDigest", "connectorArtifactSha256",
  ], "Release identity");
  for (const [key, expected] of Object.entries(expectedRelease)) {
    if (record.release[key] !== expected) {
      throw new Error("Production acceptance record does not match the deployment manifest.");
    }
  }
  exactKeys(record.policy, ["version", "sha256", "callbackIncidentId"], "Policy identity");
  for (const [key, expected] of Object.entries(expectedPolicy)) {
    if (record.policy[key] !== expected) {
      throw new Error("Production acceptance record does not match the reviewed policy.");
    }
  }
  exactKeys(record.operationalSnapshot, ["sha256", "capturedAt"], "Operational snapshot evidence");
  exactKeys(record.evidenceArchive, ["objectKey", "sha256"], "Evidence archive");
  exactKeys(record.callbackIncident, [
    "observedFailureSlice", "classifiedFailures", "unclassifiedFailures",
    "cumulativeLedgerCount", "capturedAt", "acknowledgedAt",
  ], "Callback incident evidence");
  exactKeys(record.canary, [
    "startedAt", "endedAt", "candidateUnchanged", "criticalAlerts", "callbackLoss",
    "duplicateOutboundEffects", "unknownDeliveries", "terminalWebhookFailureDelta",
    "recurringCooldowns",
  ], "Canary evidence");
  exactKeys(record.managedStorage, [
    "verifiedAt", "pressure", "filesystemAvailableBytes", "recoveryPointCount",
    "recoveryFreshness", "integrityFreshness", "automaticRecoveryBytes",
    "automaticRecoveryBudgetBytes",
  ], "Managed storage evidence");
  exactKeys(record.connector, [
    "protocolVersion", "journalSchemaVersion", "credentialGeneration", "bindingGeneration",
    "exclusive", "healthy", "verifiedAt",
  ], "Connector evidence");
  exactKeys(record.recovery, [
    "objectKey", "sha256", "backupVerifiedAt", "restoreDrillAt", "restoreSucceeded",
    "evidenceSha256",
  ], "Recovery evidence");
  exactKeys(record.uat, [
    "runId", "testGroupId", "targetCount", "resolvedCount", "unknownMessageJobs", "completedAt",
  ], "UAT evidence");
  exactKeys(record.drills, [
    "offlineDrainAt", "connectorPreSendRestartAt", "connectorPostSendRestartAt", "safetyFenceAt",
    "rateLimitRecoveryAt", "pairingRevocationAt", "alertRoundTripAt",
  ], "Drill evidence");
  exactKeys(record.operations, [
    "authoritativeSyncAt", "projectionsReconciled", "eventInboxGaps", "eventInboxDeadEvents",
    "unownedSessions", "publicHealthVerifiedAt", "privateHealthVerifiedAt",
  ], "Operational evidence");
  exactKeys(record.decision, ["outcome", "operator", "decidedAt", "acknowledged"], "Decision");
  if (!["PENDING", "GO", "NO_GO"].includes(record.decision.outcome)) {
    throw new Error("Decision outcome must be PENDING, GO, or NO_GO.");
  }
  rejectSensitiveMaterial(record);
}

function verifyGo(
  record,
  expectedConnector,
  policyRequirements,
  operationalSnapshot,
  recoveryEvidence,
) {
  const incident = record.callbackIncident;
  const requiredFailureSlice = policyRequirements.requiredObservedFailureSlice;
  if (incident.observedFailureSlice !== requiredFailureSlice
    || nonnegativeInteger(
      incident.classifiedFailures,
      "Classified callback failures",
    ) !== requiredFailureSlice) {
    throw new Error("The policy-bound callback incident slice must be fully classified.");
  }
  zero(incident.unclassifiedFailures, "Unclassified callback failures");
  if (nonnegativeInteger(
    incident.cumulativeLedgerCount,
    "Cumulative callback failure ledger",
  ) < requiredFailureSlice) {
    throw new Error("Cumulative callback failure ledger cannot be smaller than the incident slice.");
  }
  const incidentCapturedAt = timestamp(incident.capturedAt, "Callback ledger capture time");
  const incidentAcknowledgedAt = timestamp(
    incident.acknowledgedAt,
    "Callback incident acknowledgement time",
  );

  const canaryStart = timestamp(record.canary.startedAt, "Canary start time");
  const canaryEnd = timestamp(record.canary.endedAt, "Canary end time");
  if (incidentCapturedAt > incidentAcknowledgedAt || incidentAcknowledgedAt > canaryStart) {
    throw new Error("The callback incident must be captured and acknowledged before canary begins.");
  }
  const minimumCanaryMs = policyRequirements.minimumObservationSeconds * 1_000;
  if (canaryEnd - canaryStart < minimumCanaryMs) {
    throw new Error(
      `Canary observation must cover at least ${policyRequirements.minimumObservationSeconds} seconds.`,
    );
  }
  const maximumFinalEvidenceAgeMs = policyRequirements.maximumFinalEvidenceAgeSeconds * 1_000;
  nearWindowEnd(
    operationalSnapshot.capturedAt,
    "Final operational snapshot",
    canaryStart,
    canaryEnd,
    maximumFinalEvidenceAgeMs,
  );
  trueValue(record.canary.candidateUnchanged, "Unchanged canary candidate evidence");
  for (const [key, label] of [
    ["criticalAlerts", "Canary critical alerts"],
    ["callbackLoss", "Canary callback loss"],
    ["duplicateOutboundEffects", "Canary duplicate outbound effects"],
    ["unknownDeliveries", "Canary unknown deliveries"],
    ["terminalWebhookFailureDelta", "New terminal webhook failures"],
    ["recurringCooldowns", "Recurring OpenWA cooldowns"],
  ]) zero(record.canary[key], label);

  const managedStorage = record.managedStorage;
  nearWindowEnd(
    managedStorage.verifiedAt,
    "Managed storage verification time",
    canaryStart,
    canaryEnd,
    maximumFinalEvidenceAgeMs,
  );
  if (managedStorage.pressure !== "normal") {
    throw new Error("Managed storage pressure must be normal for a GO decision.");
  }
  const filesystemAvailableBytes = nonnegativeInteger(
    managedStorage.filesystemAvailableBytes,
    "Managed filesystem available bytes",
  );
  if (filesystemAvailableBytes < policyRequirements.minimumManagedStorageAvailableBytes) {
    throw new Error(
      `Managed filesystem must have at least ${policyRequirements.minimumManagedStorageAvailableBytes} available bytes.`,
    );
  }
  positiveInteger(managedStorage.recoveryPointCount, "Managed recovery point count");
  if (managedStorage.recoveryFreshness !== "fresh") {
    throw new Error("Managed recovery protection must be fresh for a GO decision.");
  }
  if (managedStorage.integrityFreshness !== "fresh") {
    throw new Error("Managed database integrity verification must be fresh for a GO decision.");
  }
  const automaticRecoveryBytes = nonnegativeInteger(
    managedStorage.automaticRecoveryBytes,
    "Automatic recovery bytes",
  );
  const automaticRecoveryBudgetBytes = positiveInteger(
    managedStorage.automaticRecoveryBudgetBytes,
    "Automatic recovery budget bytes",
  );
  if (automaticRecoveryBytes / automaticRecoveryBudgetBytes
    > policyRequirements.maximumAutomaticRecoveryUtilization) {
    throw new Error("Automatic recovery storage exceeds the managed storage policy budget.");
  }

  required(record.evidenceArchive.objectKey, "Private evidence archive object key");
  if (!digestPattern.test(required(record.evidenceArchive.sha256, "Private evidence archive checksum"))) {
    throw new Error("Private evidence archive checksum must be a SHA-256 digest.");
  }

  if (record.connector.protocolVersion !== expectedConnector.protocolVersion
    || record.connector.journalSchemaVersion !== expectedConnector.journalSchemaVersion) {
    throw new Error("Connector evidence does not match the coordinated release.");
  }
  positiveInteger(record.connector.credentialGeneration, "Connector credential generation");
  positiveInteger(record.connector.bindingGeneration, "Connector binding generation");
  trueValue(record.connector.exclusive, "Exclusive connector evidence");
  trueValue(record.connector.healthy, "Healthy connector evidence");
  nearWindowEnd(
    record.connector.verifiedAt,
    "Connector verification time",
    canaryStart,
    canaryEnd,
    maximumFinalEvidenceAgeMs,
  );
  if (record.connector.credentialGeneration !== operationalSnapshot.connector.tokenGeneration
    || record.connector.bindingGeneration !== operationalSnapshot.connector.bindingGeneration
    || record.connector.verifiedAt !== operationalSnapshot.connector.verifiedAt) {
    throw new Error("Connector acceptance evidence does not match the operational snapshot.");
  }

  required(record.recovery.objectKey, "Off-device backup object key");
  if (!digestPattern.test(required(record.recovery.sha256, "Off-device backup checksum"))) {
    throw new Error("Off-device backup checksum must be a SHA-256 digest.");
  }
  withinWindow(record.recovery.backupVerifiedAt, "Backup verification time", canaryStart, canaryEnd);
  withinWindow(record.recovery.restoreDrillAt, "Restore drill time", canaryStart, canaryEnd);
  trueValue(record.recovery.restoreSucceeded, "Restore drill result");
  if (!recoveryEvidence
    || record.recovery.evidenceSha256 !== recoveryEvidence.sha256
    || record.recovery.objectKey !== recoveryEvidence.evidence.backup.objectKey
    || record.recovery.sha256 !== recoveryEvidence.evidence.backup.sha256
    || record.recovery.backupVerifiedAt !== recoveryEvidence.evidence.restore.completedAt
    || record.recovery.restoreDrillAt !== recoveryEvidence.evidence.restore.completedAt) {
    throw new Error("Recovery acceptance fields do not match the verified restore-drill evidence.");
  }

  required(record.uat.runId, "UAT run ID");
  required(record.uat.testGroupId, "UAT test group ID");
  const targets = positiveInteger(record.uat.targetCount, "UAT target count");
  if (positiveInteger(record.uat.resolvedCount, "UAT resolved target count") !== targets) {
    throw new Error("Every UAT target must have a terminal result.");
  }
  zero(record.uat.unknownMessageJobs, "UAT unknown Message Jobs");
  withinWindow(record.uat.completedAt, "UAT completion time", canaryStart, canaryEnd);

  for (const [key, label] of [
    ["offlineDrainAt", "Offline drain drill"],
    ["connectorPreSendRestartAt", "Pre-send connector restart drill"],
    ["connectorPostSendRestartAt", "Post-send connector restart drill"],
    ["safetyFenceAt", "Safety fence drill"],
    ["rateLimitRecoveryAt", "Rate-limit recovery drill"],
    ["pairingRevocationAt", "Pairing revocation drill"],
    ["alertRoundTripAt", "Alert round-trip drill"],
  ]) withinWindow(record.drills[key], label, canaryStart, canaryEnd);

  withinWindow(
    record.operations.authoritativeSyncAt,
    "Authoritative sync time",
    canaryStart,
    canaryEnd,
  );
  if (record.operations.publicHealthVerifiedAt !== operationalSnapshot.capturedAt
    || record.operations.privateHealthVerifiedAt !== operationalSnapshot.capturedAt) {
    throw new Error("Runtime health evidence does not match the operational snapshot.");
  }
  trueValue(record.operations.projectionsReconciled, "Projection reconciliation evidence");
  zero(record.operations.eventInboxGaps, "Event Inbox delivery gaps");
  zero(record.operations.eventInboxDeadEvents, "Unexpected Event Inbox dead events");
  zero(record.operations.unownedSessions, "Unowned Event Inbox sessions");
  withinWindow(
    record.operations.publicHealthVerifiedAt,
    "Public health verification time",
    canaryStart,
    canaryEnd,
  );
  withinWindow(
    record.operations.privateHealthVerifiedAt,
    "Private health verification time",
    canaryStart,
    canaryEnd,
  );

  if (record.decision.outcome !== "GO") {
    throw new Error("Production acceptance decision is not GO.");
  }
  required(record.decision.operator, "Decision operator");
  const decidedAt = timestamp(record.decision.decidedAt, "Decision time");
  if (decidedAt < canaryEnd) throw new Error("GO decision cannot predate the canary observation.");
  trueValue(record.decision.acknowledged, "Operator acknowledgement");
}

export function verifyProductionAcceptance({
  deploymentManifestPath,
  operationalSnapshotPath,
  recoveryEvidencePath,
  policyPath = defaultPolicyPath,
  recordPath,
  requireGo = false,
}) {
  const identity = readProductionDeploymentIdentity(deploymentManifestPath, policyPath);
  const resolvedRecordPath = resolve(required(recordPath, "Acceptance record path"));
  assertPrivateRecord(resolvedRecordPath);
  const record = object(
    readJson(resolvedRecordPath, "Production acceptance record"),
    "Production acceptance record",
  );
  verifyShape(record, identity.release, identity.policy.identity);
  const hasSnapshotDigest = record.operationalSnapshot.sha256 !== null;
  const hasSnapshotTimestamp = record.operationalSnapshot.capturedAt !== null;
  if (hasSnapshotDigest !== hasSnapshotTimestamp) {
    throw new Error("Operational snapshot evidence must be either complete or empty.");
  }
  let verifiedSnapshot;
  if (hasSnapshotDigest || requireGo || record.decision.outcome === "GO") {
    verifiedSnapshot = verifyProductionOperationalSnapshot({
      deploymentManifestPath,
      snapshotPath: required(operationalSnapshotPath, "Operational snapshot path"),
    });
    if (record.operationalSnapshot.sha256 !== verifiedSnapshot.sha256
      || record.operationalSnapshot.capturedAt !== verifiedSnapshot.snapshot.capturedAt) {
      throw new Error("Production acceptance record does not match the operational snapshot.");
    }
  }
  const recoveryValues = Object.values(record.recovery);
  const hasAnyRecoveryEvidence = recoveryValues.some(value => value !== null);
  const hasCompleteRecoveryEvidence = recoveryValues.every(value => value !== null);
  if (hasAnyRecoveryEvidence !== hasCompleteRecoveryEvidence) {
    throw new Error("Recovery evidence must be either complete or empty.");
  }
  let verifiedRecovery;
  if (hasCompleteRecoveryEvidence || requireGo || record.decision.outcome === "GO") {
    verifiedRecovery = verifyProductionRecoveryEvidence({
      deploymentManifestPath,
      evidencePath: required(recoveryEvidencePath, "Recovery evidence path"),
    });
    if (record.recovery.evidenceSha256 !== verifiedRecovery.sha256) {
      throw new Error("Production acceptance record does not match the recovery evidence.");
    }
  }
  if (requireGo || record.decision.outcome === "GO") {
    verifyGo(
      record,
      identity.connector,
      identity.policy.requirements,
      verifiedSnapshot.snapshot,
      verifiedRecovery,
    );
  }
  return record;
}

export function attachProductionRecoveryEvidence({
  deploymentManifestPath,
  evidencePath,
  policyPath = defaultPolicyPath,
  recordPath,
}) {
  const identity = readProductionDeploymentIdentity(deploymentManifestPath, policyPath);
  const resolvedRecordPath = resolve(required(recordPath, "Acceptance record path"));
  assertPrivateRecord(resolvedRecordPath);
  const record = object(
    readJson(resolvedRecordPath, "Production acceptance record"),
    "Production acceptance record",
  );
  verifyShape(record, identity.release, identity.policy.identity);
  if (record.decision.outcome !== "PENDING") {
    throw new Error("Recovery evidence can only be attached to a PENDING acceptance record.");
  }
  const verified = verifyProductionRecoveryEvidence({
    deploymentManifestPath,
    evidencePath: required(evidencePath, "Recovery evidence path"),
  });
  const proposed = {
    objectKey: verified.evidence.backup.objectKey,
    sha256: verified.evidence.backup.sha256,
    backupVerifiedAt: verified.evidence.restore.completedAt,
    restoreDrillAt: verified.evidence.restore.completedAt,
    restoreSucceeded: true,
    evidenceSha256: verified.sha256,
  };
  if (Object.values(record.recovery).some(value => value !== null)) {
    if (Object.entries(proposed).every(([key, value]) => record.recovery[key] === value)) {
      return record;
    }
    throw new Error("Acceptance record already contains different recovery evidence.");
  }
  record.recovery = proposed;
  atomicPrivateWrite(resolvedRecordPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function attachProductionOperationalSnapshot({
  deploymentManifestPath,
  operationalSnapshotPath,
  policyPath = defaultPolicyPath,
  recordPath,
}) {
  const identity = readProductionDeploymentIdentity(deploymentManifestPath, policyPath);
  const resolvedRecordPath = resolve(required(recordPath, "Acceptance record path"));
  assertPrivateRecord(resolvedRecordPath);
  const record = object(
    readJson(resolvedRecordPath, "Production acceptance record"),
    "Production acceptance record",
  );
  verifyShape(record, identity.release, identity.policy.identity);
  if (record.decision.outcome !== "PENDING") {
    throw new Error("Operational evidence can only be attached to a PENDING acceptance record.");
  }
  const verified = verifyProductionOperationalSnapshot({
    deploymentManifestPath,
    snapshotPath: required(operationalSnapshotPath, "Operational snapshot path"),
  });
  const proposed = {
    sha256: verified.sha256,
    capturedAt: verified.snapshot.capturedAt,
  };
  const existing = record.operationalSnapshot;
  if (existing.sha256 !== null || existing.capturedAt !== null) {
    if (existing.sha256 === proposed.sha256 && existing.capturedAt === proposed.capturedAt) {
      const evidenceIsConsistent = record.connector.credentialGeneration
          === verified.snapshot.connector.tokenGeneration
        && record.connector.bindingGeneration === verified.snapshot.connector.bindingGeneration
        && record.connector.exclusive === true
        && record.connector.healthy === true
        && record.connector.verifiedAt === verified.snapshot.connector.verifiedAt
        && record.operations.publicHealthVerifiedAt === verified.snapshot.capturedAt
        && record.operations.privateHealthVerifiedAt === verified.snapshot.capturedAt;
      if (evidenceIsConsistent) return record;
      throw new Error("Attached operational evidence is inconsistent with its snapshot.");
    }
    throw new Error("Acceptance record already contains a different operational snapshot.");
  }
  for (const [value, label] of [
    [record.connector.credentialGeneration, "Connector credential generation"],
    [record.connector.bindingGeneration, "Connector binding generation"],
    [record.connector.exclusive, "Exclusive connector evidence"],
    [record.connector.healthy, "Healthy connector evidence"],
    [record.connector.verifiedAt, "Connector verification time"],
    [record.operations.publicHealthVerifiedAt, "Public health verification time"],
    [record.operations.privateHealthVerifiedAt, "Private health verification time"],
  ]) {
    if (value !== null) throw new Error(`${label} must be empty before attaching operational evidence.`);
  }
  record.operationalSnapshot = proposed;
  record.connector.credentialGeneration = verified.snapshot.connector.tokenGeneration;
  record.connector.bindingGeneration = verified.snapshot.connector.bindingGeneration;
  record.connector.exclusive = true;
  record.connector.healthy = true;
  record.connector.verifiedAt = verified.snapshot.connector.verifiedAt;
  record.operations.publicHealthVerifiedAt = verified.snapshot.capturedAt;
  record.operations.privateHealthVerifiedAt = verified.snapshot.capturedAt;
  atomicPrivateWrite(resolvedRecordPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function parseArguments(argv) {
  const [command, ...values] = argv;
  const allowedFlags = command === "create"
    ? new Set(["deployment", "output", "policy"])
    : new Set([
      "deployment", "record", "policy", "operational-snapshot", "recovery-evidence",
    ]);
  if (!["create", "attach-operational", "attach-recovery", "verify", "verify-go"].includes(command)) {
    throw new Error(
      "Usage: production-acceptance.mjs <create|attach-operational|attach-recovery|verify|verify-go> "
      + "--deployment <manifest> --output|--record <path>",
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
    if (!allowedFlags.has(name)) throw new Error(`Unsupported option: ${flag}.`);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: ${flag}.`);
    options[name] = value;
  }
  return options;
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.command === "create") {
    const outputPath = resolve(required(options.output, "Acceptance record output path"));
    const record = productionAcceptanceTemplate(options.deployment, new Date(), options.policy);
    writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`Created private production acceptance template at ${outputPath}.\n`);
    return;
  }
  if (options.command === "verify" || options.command === "verify-go") {
    const record = verifyProductionAcceptance({
      deploymentManifestPath: options.deployment,
      operationalSnapshotPath: options["operational-snapshot"],
      recoveryEvidencePath: options["recovery-evidence"],
      policyPath: options.policy,
      recordPath: options.record,
      requireGo: options.command === "verify-go",
    });
    process.stdout.write(`${JSON.stringify({
      decision: record.decision.outcome,
      release: record.release.tag,
      schemaVersion: record.schemaVersion,
    })}\n`);
    return;
  }
  if (options.command === "attach-operational") {
    const record = attachProductionOperationalSnapshot({
      deploymentManifestPath: options.deployment,
      operationalSnapshotPath: options["operational-snapshot"],
      policyPath: options.policy,
      recordPath: options.record,
    });
    process.stdout.write(`${JSON.stringify({
      status: "attached",
      release: record.release.tag,
      capturedAt: record.operationalSnapshot.capturedAt,
    })}\n`);
    return;
  }
  if (options.command === "attach-recovery") {
    const record = attachProductionRecoveryEvidence({
      deploymentManifestPath: options.deployment,
      evidencePath: options["recovery-evidence"],
      policyPath: options.policy,
      recordPath: options.record,
    });
    process.stdout.write(`${JSON.stringify({
      status: "attached",
      release: record.release.tag,
      recoveryEvidenceSha256: record.recovery.evidenceSha256,
    })}\n`);
    return;
  }
  throw new Error("Unsupported production acceptance command.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
