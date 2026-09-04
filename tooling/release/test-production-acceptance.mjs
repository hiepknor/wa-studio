import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  attachProductionRecoveryEvidence,
  attachProductionOperationalSnapshot,
  productionAcceptanceTemplate,
  readProductionAcceptancePolicy,
  verifyProductionAcceptance,
} from "./production-acceptance.mjs";
import {
  createProductionPromotionReceipt,
  verifyProductionPromotionSource,
  verifyProductionPromotionTarget,
} from "./production-promotion.mjs";

const root = mkdtempSync(resolve(tmpdir(), "wa-production-acceptance-test-"));
const deploymentPath = resolve(root, "wa-studio-deployment.json");
const recordPath = resolve(root, "production-acceptance.json");
const snapshotPath = resolve(root, "production-operational-snapshot.json");
const recoveryEvidencePath = resolve(root, "production-recovery-evidence.json");
const promotionPath = resolve(root, "production-promotion.json");
const cliPromotionPath = resolve(root, "production-promotion-cli.json");
const absentPromotionPath = resolve(root, "no-production-promotion.json");
const cliRecordPath = resolve(root, "production-acceptance-cli.json");
const cliPath = resolve(import.meta.dirname, "production-acceptance.mjs");
const promotionCliPath = resolve(import.meta.dirname, "production-promotion.mjs");
const promotionPrivateKeyPath = resolve(root, "production-promotion-private.pem");
const promotionPublicKeyPath = resolve(root, "production-promotion-public.pem");
const untrustedPublicKeyPath = resolve(root, "untrusted-production-promotion-public.pem");
const acceptancePolicy = readProductionAcceptancePolicy();
const deployment = {
  schemaVersion: 1,
  product: "wa-studio",
  releaseScope: "product",
  releaseChannel: "canary",
  repository: "example/wa-studio",
  tag: "v0.2.2",
  gitCommit: "a".repeat(40),
  components: {
    acceptance: {
      policyVersion: acceptancePolicy.identity.version,
      policySha256: acceptancePolicy.identity.sha256,
    },
    connector: {
      version: "0.1.0",
      protocolVersion: 2,
      journalSchemaVersion: 1,
      artifact: { sha256: "b".repeat(64) },
    },
    eventInbox: {
      imageDigest: `sha256:${"c".repeat(64)}`,
      migrationHead: {
        name: "015_event_inbox_recovery_watermark.sql",
        setSha256: "f".repeat(64),
      },
    },
    runtime: { version: "0.1.0" },
    openwa: { releaseTag: "0.23.3" },
  },
};

function writeRecord(record) {
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function verifyRecord(options = {}) {
  return verifyProductionAcceptance({
    deploymentManifestPath: deploymentPath,
    operationalSnapshotPath: snapshotPath,
    recoveryEvidencePath,
    recordPath,
    ...options,
  });
}

try {
  const promotionKeyPair = generateKeyPairSync("ed25519");
  writeFileSync(promotionPrivateKeyPath, promotionKeyPair.privateKey.export({
    type: "pkcs8",
    format: "pem",
  }), { mode: 0o600 });
  writeFileSync(promotionPublicKeyPath, promotionKeyPair.publicKey.export({
    type: "spki",
    format: "pem",
  }), { mode: 0o644 });
  const untrustedKeyPair = generateKeyPairSync("ed25519");
  writeFileSync(untrustedPublicKeyPath, untrustedKeyPair.publicKey.export({
    type: "spki",
    format: "pem",
  }), { mode: 0o644 });
  writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);
  assert.match(execFileSync(process.execPath, [
    cliPath,
    "create",
    "--deployment", deploymentPath,
    "--output", cliRecordPath,
  ], { encoding: "utf8" }), /Created private production acceptance template/u);
  const cliMode = statSync(cliRecordPath).mode;
  assert.equal(cliMode & 0o077, 0, "Acceptance template must not be group/world accessible");
  assert.equal(cliMode & 0o600, 0o600, "Acceptance template must be owner-readable and writable");
  assert.match(execFileSync(process.execPath, [
    cliPath,
    "verify",
    "--deployment", deploymentPath,
    "--record", cliRecordPath,
  ], { encoding: "utf8" }), /"decision":"PENDING"/u);
  assert.notEqual(spawnSync(process.execPath, [
    cliPath,
    "create",
    "--deployment", deploymentPath,
    "--output", cliRecordPath,
  ]).status, 0, "Create must refuse to overwrite an existing acceptance record");
  assert.notEqual(spawnSync(process.execPath, [
    cliPath,
    "verify",
    "--deployment", deploymentPath,
    "--record", cliRecordPath,
    "--unknown", "value",
  ]).status, 0, "CLI must reject unknown options");

  let record = productionAcceptanceTemplate(
    deploymentPath,
    new Date("2026-08-28T00:00:00.000Z"),
  );
  const incompleteSnapshotEvidence = structuredClone(record);
  incompleteSnapshotEvidence.operationalSnapshot.sha256 = "f".repeat(64);
  writeRecord(incompleteSnapshotEvidence);
  assert.throws(
    () => verifyRecord(),
    /either complete or empty/u,
  );
  const snapshotCapturedAt = "2026-08-29T02:55:00.000Z";
  const operationalSnapshot = {
    schemaVersion: 2,
    product: "wa-studio",
    capturedAt: snapshotCapturedAt,
    release: record.release,
    policy: {
      version: record.policy.version,
      sha256: record.policy.sha256,
    },
    components: {
      runtimeVersion: "0.1.0",
      openwaRelease: "0.23.3",
      connectorPluginVersion: "0.1.0",
      connectorProtocolVersion: 2,
      connectorJournalSchemaVersion: 1,
    },
    runtime: {
      instanceId: "runtime-canary",
      version: "0.1.0",
      queueBackend: "postgres",
      worker: "healthy",
      scheduler: "healthy",
      liveSendsEnabled: true,
      allowedSessionCount: 1,
      openwaStatus: "COMPATIBLE",
      connectorStatus: "HEALTHY",
    },
    runtimeEvidence: {
      schemaVersion: 1,
      status: "complete",
      generatedAt: snapshotCapturedAt,
      openwaSafety: {
        openCircuitScopes: 0,
        halfOpenCircuitScopes: 0,
        manualBlockedScopes: 0,
        throttledScopes: 0,
        deferredMessageJobs: 0,
        unknownMessageJobs: 0,
        oldestUnknownMessageJobAgeSeconds: null,
      },
      webhookSpool: {
        storedEvents: 0,
        storedBytes: 0,
        maxStoredEvents: 10_000,
        maxStoredBytes: 10_485_760,
        maximumIncomingEventBytes: 1_048_576,
        activeEvents: 0,
        deadEvents: 0,
        oldestActiveAgeSeconds: null,
        oldestDeadAgeSeconds: null,
        utilization: 0,
        admissionAvailable: true,
      },
    },
    connector: {
      sessionId: "00000000-0000-4000-8000-000000000001",
      connectorId: "00000000-0000-4000-8000-000000000002",
      instanceId: "wa-studio-00000000-0000-4000-8000-000000000002",
      tokenGeneration: 4,
      bindingGeneration: 7,
      verifiedAt: snapshotCapturedAt,
      heartbeatObservedAt: "2026-08-29T02:54:50.000Z",
      heartbeatAgeMs: 10_000,
      pendingCount: 0,
      storageUtilization: 0.1,
    },
  };
  writeFileSync(
    snapshotPath,
    `${JSON.stringify(operationalSnapshot, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeRecord(record);
  record = attachProductionOperationalSnapshot({
    deploymentManifestPath: deploymentPath,
    operationalSnapshotPath: snapshotPath,
    recordPath,
  });
  assert.equal(record.connector.credentialGeneration, 4);
  assert.equal(record.connector.bindingGeneration, 7);
  assert.equal(record.connector.exclusive, true);
  assert.equal(record.connector.healthy, true);
  assert.equal(record.connector.verifiedAt, snapshotCapturedAt);
  assert.equal(record.operations.publicHealthVerifiedAt, snapshotCapturedAt);
  assert.equal(record.operations.privateHealthVerifiedAt, snapshotCapturedAt);
  assert.deepEqual(attachProductionOperationalSnapshot({
    deploymentManifestPath: deploymentPath,
    operationalSnapshotPath: snapshotPath,
    recordPath,
  }), record, "Attaching the same intact evidence must be idempotent");

  const inconsistentAttachment = structuredClone(record);
  inconsistentAttachment.connector.healthy = false;
  writeRecord(inconsistentAttachment);
  assert.throws(
    () => attachProductionOperationalSnapshot({
      deploymentManifestPath: deploymentPath,
      operationalSnapshotPath: snapshotPath,
      recordPath,
    }),
    /inconsistent with its snapshot/u,
  );
  writeRecord(record);

  assert.match(execFileSync(process.execPath, [
    cliPath,
    "attach-operational",
    "--deployment", deploymentPath,
    "--operational-snapshot", snapshotPath,
    "--record", cliRecordPath,
  ], { encoding: "utf8" }), /"status":"attached"/u);
  assert.equal(
    JSON.parse(readFileSync(cliRecordPath, "utf8")).connector.bindingGeneration,
    7,
  );
  assert.match(execFileSync(process.execPath, [
    cliPath,
    "verify",
    "--deployment", deploymentPath,
    "--operational-snapshot", snapshotPath,
    "--record", cliRecordPath,
  ], { encoding: "utf8" }), /"decision":"PENDING"/u);
  assert.notEqual(spawnSync(process.execPath, [
    cliPath,
    "verify",
    "--deployment", deploymentPath,
    "--record", cliRecordPath,
  ]).status, 0, "An attached snapshot must remain verified while the record is PENDING");

  const recoveryCompletedAt = "2026-08-28T04:00:00.000Z";
  const recoveryEvidence = {
    schemaVersion: 1,
    evidenceType: "wa-studio-event-inbox-restore-drill",
    recordedAt: recoveryCompletedAt,
    release: {
      repository: deployment.repository,
      tag: deployment.tag,
      gitCommit: deployment.gitCommit,
      deploymentManifestSha256: createHash("sha256")
        .update(readFileSync(deploymentPath))
        .digest("hex"),
      eventInboxImageDigest: deployment.components.eventInbox.imageDigest,
      eventInboxMigrationHead: deployment.components.eventInbox.migrationHead.name,
      eventInboxMigrationSetSha256: deployment.components.eventInbox.migrationHead.setSha256,
    },
    backup: {
      objectKey: "wa-event-inbox-20260828T035900Z.dump.age",
      sha256: "d".repeat(64),
    },
    restore: {
      startedAt: "2026-08-28T03:59:58.000Z",
      completedAt: recoveryCompletedAt,
      durationSeconds: 2,
      isolation: "temporary-database",
      restoredMigrationHead: deployment.components.eventInbox.migrationHead.name,
      checksumVerified: true,
      archiveCatalogVerified: true,
      schemaVerified: true,
      usageLedgerVerified: true,
    },
    result: "PASS",
  };
  writeFileSync(
    recoveryEvidencePath,
    `${JSON.stringify(recoveryEvidence, null, 2)}\n`,
    { mode: 0o600 },
  );
  record = attachProductionRecoveryEvidence({
    deploymentManifestPath: deploymentPath,
    evidencePath: recoveryEvidencePath,
    recordPath,
  });
  assert.equal(record.recovery.evidenceSha256, createHash("sha256")
    .update(readFileSync(recoveryEvidencePath))
    .digest("hex"));
  assert.deepEqual(attachProductionRecoveryEvidence({
    deploymentManifestPath: deploymentPath,
    evidencePath: recoveryEvidencePath,
    recordPath,
  }), record, "Attaching the same recovery evidence must be idempotent");
  assert.match(execFileSync(process.execPath, [
    cliPath,
    "attach-recovery",
    "--deployment", deploymentPath,
    "--recovery-evidence", recoveryEvidencePath,
    "--record", cliRecordPath,
  ], { encoding: "utf8" }), /"status":"attached"/u);
  Object.assign(record.evidenceArchive, {
    objectKey: "production/wa-studio-v0.2.2-acceptance.tar.age",
    sha256: "e".repeat(64),
  });
  Object.assign(record.callbackIncident, {
    classifiedFailures: 58,
    unclassifiedFailures: 0,
    cumulativeLedgerCount: 58,
    capturedAt: "2026-08-28T00:30:00.000Z",
    acknowledgedAt: "2026-08-28T01:00:00.000Z",
  });
  Object.assign(record.canary, {
    startedAt: "2026-08-28T02:00:00.000Z",
    endedAt: "2026-08-29T03:00:00.000Z",
    candidateUnchanged: true,
    criticalAlerts: 0,
    callbackLoss: 0,
    duplicateOutboundEffects: 0,
    unknownDeliveries: 0,
    terminalWebhookFailureDelta: 0,
    recurringCooldowns: 0,
  });
  Object.assign(record.managedStorage, {
    verifiedAt: "2026-08-29T02:50:00.000Z",
    pressure: "normal",
    filesystemAvailableBytes: 64 * 1_024 ** 3,
    recoveryPointCount: 2,
    recoveryFreshness: "fresh",
    integrityFreshness: "fresh",
    automaticRecoveryBytes: 512 * 1_024 ** 2,
    automaticRecoveryBudgetBytes: 2 * 1_024 ** 3,
  });
  Object.assign(record.uat, {
    runId: "canary-run-1",
    testGroupId: "dedicated-test-group",
    targetCount: 3,
    resolvedCount: 3,
    unknownMessageJobs: 0,
    completedAt: "2026-08-28T05:00:00.000Z",
  });
  Object.assign(record.drills, {
    offlineDrainAt: "2026-08-28T06:00:00.000Z",
    connectorPreSendRestartAt: "2026-08-28T07:00:00.000Z",
    connectorPostSendRestartAt: "2026-08-28T08:00:00.000Z",
    safetyFenceAt: "2026-08-28T09:00:00.000Z",
    rateLimitRecoveryAt: "2026-08-28T10:00:00.000Z",
    pairingRevocationAt: "2026-08-28T11:00:00.000Z",
    alertRoundTripAt: "2026-08-28T12:00:00.000Z",
  });
  Object.assign(record.operations, {
    authoritativeSyncAt: "2026-08-28T13:00:00.000Z",
    projectionsReconciled: true,
    eventInboxGaps: 0,
    eventInboxDeadEvents: 0,
    unownedSessions: 0,
  });
  Object.assign(record.decision, {
    outcome: "GO",
    operator: "release-operator",
    decidedAt: "2026-08-29T03:15:00.000Z",
    acknowledged: true,
  });
  writeRecord(record);

  assert.equal(verifyRecord({ requireGo: true }).decision.outcome, "GO");
  assert.match(execFileSync(process.execPath, [
    cliPath,
    "verify-go",
    "--deployment", deploymentPath,
    "--operational-snapshot", snapshotPath,
    "--recovery-evidence", recoveryEvidencePath,
    "--record", recordPath,
  ], { encoding: "utf8" }), /"decision":"GO"/u);

  const intactRecoveryEvidence = readFileSync(recoveryEvidencePath, "utf8");
  const failedRecoveryEvidence = JSON.parse(intactRecoveryEvidence);
  failedRecoveryEvidence.restore.usageLedgerVerified = false;
  writeFileSync(
    recoveryEvidencePath,
    `${JSON.stringify(failedRecoveryEvidence, null, 2)}\n`,
    { mode: 0o600 },
  );
  assert.throws(
    () => verifyRecord({ requireGo: true }),
    /usage ledger verification must be true/u,
  );
  writeFileSync(recoveryEvidencePath, intactRecoveryEvidence, { mode: 0o600 });

  const forgedRecovery = structuredClone(record);
  forgedRecovery.recovery.evidenceSha256 = "0".repeat(64);
  writeRecord(forgedRecovery);
  assert.throws(
    () => verifyRecord({ requireGo: true }),
    /does not match the recovery evidence/u,
  );
  writeRecord(record);

  const receipt = createProductionPromotionReceipt({
    acceptedDeploymentManifestPath: deploymentPath,
    operationalSnapshotPath: snapshotPath,
    recoveryEvidencePath,
    acceptanceRecordPath: recordPath,
    targetTag: "v0.2.3",
    outputPath: promotionPath,
    signingPrivateKeyPath: promotionPrivateKeyPath,
    now: new Date("2026-08-29T04:00:00.000Z"),
  });
  assert.equal(receipt.acceptedRelease.tag, "v0.2.2");
  assert.equal(receipt.target.tag, "v0.2.3");
  assert.equal(receipt.acceptance.operationalSnapshotSha256, record.operationalSnapshot.sha256);
  assert.equal(receipt.acceptance.evidenceArchiveSha256, record.evidenceArchive.sha256);
  assert.equal(statSync(promotionPath).mode & 0o111, 0);
  assert.match(execFileSync(process.execPath, [
    promotionCliPath,
    "create",
    "--accepted-deployment", deploymentPath,
    "--operational-snapshot", snapshotPath,
    "--recovery-evidence", recoveryEvidencePath,
    "--acceptance-record", recordPath,
    "--target-tag", "v0.2.3",
    "--output", cliPromotionPath,
    "--signing-private-key", promotionPrivateKeyPath,
  ], { encoding: "utf8" }), /"status":"created"/u);
  assert.equal(verifyProductionPromotionTarget({
    receiptPath: cliPromotionPath,
    repository: "example/wa-studio",
    tag: "v0.2.3",
    releaseChannel: "stable",
    verificationPublicKeyPath: promotionPublicKeyPath,
  }).required, true);
  assert.equal(verifyProductionPromotionTarget({
    receiptPath: promotionPath,
    repository: "example/wa-studio",
    tag: "v0.2.3",
    releaseChannel: "stable",
    verificationPublicKeyPath: promotionPublicKeyPath,
  }).required, true);
  assert.equal(verifyProductionPromotionTarget({
    receiptPath: absentPromotionPath,
    repository: "example/wa-studio",
    tag: "v0.2.3",
    verificationPublicKeyPath: promotionPublicKeyPath,
    releaseChannel: "canary",
  }).required, false);
  assert.throws(
    () => verifyProductionPromotionTarget({
      receiptPath: promotionPath,
      repository: "example/wa-studio",
      tag: "v0.2.3",
      releaseChannel: "canary",
    }),
    /must not carry a stale/u,
  );
  assert.equal(verifyProductionPromotionSource({
    receiptPath: promotionPath,
    acceptedDeploymentManifestPath: deploymentPath,
    repository: "example/wa-studio",
    tag: "v0.2.3",
    verificationPublicKeyPath: promotionPublicKeyPath,
  }).target.tag, "v0.2.3");
  assert.throws(
    () => verifyProductionPromotionTarget({
      receiptPath: promotionPath,
      repository: "example/wa-studio",
      tag: "v0.2.3",
      releaseChannel: "stable",
    }),
    /verification public key path is required/u,
  );
  assert.throws(
    () => verifyProductionPromotionTarget({
      receiptPath: promotionPath,
      repository: "example/wa-studio",
      tag: "v0.2.3",
      releaseChannel: "stable",
      verificationPublicKeyPath: untrustedPublicKeyPath,
    }),
    /uses an untrusted key/u,
  );
  assert.match(execFileSync(process.execPath, [
    promotionCliPath,
    "verify-target",
    "--receipt", promotionPath,
    "--repository", "example/wa-studio",
    "--tag", "v0.2.3",
    "--release-channel", "stable",
    "--verification-public-key", promotionPublicKeyPath,
  ], { encoding: "utf8" }), /"receiptRequired":true/u);
  assert.match(execFileSync(process.execPath, [
    promotionCliPath,
    "verify-source",
    "--receipt", promotionPath,
    "--accepted-deployment", deploymentPath,
    "--repository", "example/wa-studio",
    "--tag", "v0.2.3",
    "--verification-public-key", promotionPublicKeyPath,
  ], { encoding: "utf8" }), /"acceptedTag":"v0.2.2"/u);
  assert.throws(
    () => createProductionPromotionReceipt({
      acceptedDeploymentManifestPath: deploymentPath,
      operationalSnapshotPath: snapshotPath,
      recoveryEvidencePath,
      acceptanceRecordPath: recordPath,
      targetTag: "v0.2.2",
      outputPath: resolve(root, "invalid-promotion.json"),
      signingPrivateKeyPath: promotionPrivateKeyPath,
    }),
    /must be newer/u,
  );

  const tamperedReceipt = JSON.parse(readFileSync(promotionPath, "utf8"));
  tamperedReceipt.acceptedRelease.deploymentManifestSha256 = "0".repeat(64);
  writeFileSync(promotionPath, `${JSON.stringify(tamperedReceipt, null, 2)}\n`);
  assert.throws(
    () => verifyProductionPromotionSource({
      receiptPath: promotionPath,
      acceptedDeploymentManifestPath: deploymentPath,
      repository: "example/wa-studio",
      tag: "v0.2.3",
      verificationPublicKeyPath: promotionPublicKeyPath,
    }),
    /signature verification failed/u,
  );
  writeFileSync(promotionPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const unsignedLegacyReceipt = structuredClone(receipt);
  unsignedLegacyReceipt.schemaVersion = 1;
  delete unsignedLegacyReceipt.signature;
  writeFileSync(promotionPath, `${JSON.stringify(unsignedLegacyReceipt, null, 2)}\n`);
  assert.throws(
    () => verifyProductionPromotionTarget({
      receiptPath: promotionPath,
      repository: "example/wa-studio",
      tag: "v0.2.3",
      releaseChannel: "stable",
      verificationPublicKeyPath: promotionPublicKeyPath,
    }),
    /missing or unexpected fields/u,
  );
  writeFileSync(promotionPath, `${JSON.stringify(receipt, null, 2)}\n`);

  chmodSync(recordPath, 0o644);
  assert.throws(
    () => verifyRecord(),
    /private, non-executable owner-readable file/u,
  );
  chmodSync(recordPath, 0o600);

  const reordered = structuredClone(record);
  reordered.release = Object.fromEntries(Object.entries(reordered.release).reverse());
  writeRecord(reordered);
  assert.equal(verifyRecord({ requireGo: true }).decision.outcome, "GO");

  const tooShort = structuredClone(record);
  tooShort.canary.endedAt = "2026-08-28T23:00:00.000Z";
  tooShort.decision.decidedAt = "2026-08-28T23:15:00.000Z";
  writeRecord(tooShort);
  assert.throws(
    () => verifyRecord({ requireGo: true }),
    /at least 86400 seconds/u,
  );

  const unknown = structuredClone(record);
  unknown.uat.unknownMessageJobs = 1;
  writeRecord(unknown);
  assert.throws(
    () => verifyRecord(),
    /must be zero/u,
  );

  const lateIncident = structuredClone(record);
  lateIncident.callbackIncident.acknowledgedAt = "2026-08-28T02:30:00.000Z";
  writeRecord(lateIncident);
  assert.throws(
    () => verifyRecord(),
    /before canary begins/u,
  );

  const staleDrill = structuredClone(record);
  staleDrill.drills.safetyFenceAt = "2026-08-27T09:00:00.000Z";
  writeRecord(staleDrill);
  assert.throws(
    () => verifyRecord({ requireGo: true }),
    /within the recorded canary window/u,
  );

  const earlyOperationalSnapshot = structuredClone(operationalSnapshot);
  earlyOperationalSnapshot.capturedAt = "2026-08-28T14:05:00.000Z";
  earlyOperationalSnapshot.runtimeEvidence.generatedAt = earlyOperationalSnapshot.capturedAt;
  earlyOperationalSnapshot.connector.verifiedAt = "2026-08-28T14:05:00.000Z";
  earlyOperationalSnapshot.connector.heartbeatObservedAt = "2026-08-28T14:04:50.000Z";
  const earlyOperationalJson = `${JSON.stringify(earlyOperationalSnapshot, null, 2)}\n`;
  writeFileSync(snapshotPath, earlyOperationalJson, { mode: 0o600 });
  const staleOperationalEvidence = structuredClone(record);
  staleOperationalEvidence.operationalSnapshot = {
    sha256: createHash("sha256").update(earlyOperationalJson).digest("hex"),
    capturedAt: earlyOperationalSnapshot.capturedAt,
  };
  staleOperationalEvidence.connector.verifiedAt = earlyOperationalSnapshot.connector.verifiedAt;
  staleOperationalEvidence.operations.publicHealthVerifiedAt = earlyOperationalSnapshot.capturedAt;
  staleOperationalEvidence.operations.privateHealthVerifiedAt = earlyOperationalSnapshot.capturedAt;
  writeRecord(staleOperationalEvidence);
  assert.throws(
    () => verifyRecord({ requireGo: true }),
    /Final operational snapshot is too old/u,
  );
  writeFileSync(
    snapshotPath,
    `${JSON.stringify(operationalSnapshot, null, 2)}\n`,
    { mode: 0o600 },
  );

  const pressuredStorage = structuredClone(record);
  pressuredStorage.managedStorage.pressure = "warning";
  writeRecord(pressuredStorage);
  assert.throws(
    () => verifyRecord({ requireGo: true }),
    /storage pressure must be normal/u,
  );

  const insufficientStorage = structuredClone(record);
  insufficientStorage.managedStorage.filesystemAvailableBytes = 20 * 1_024 ** 3 - 1;
  writeRecord(insufficientStorage);
  assert.throws(
    () => verifyRecord({ requireGo: true }),
    /filesystem must have at least/u,
  );

  const staleRecovery = structuredClone(record);
  staleRecovery.managedStorage.recoveryFreshness = "due";
  writeRecord(staleRecovery);
  assert.throws(
    () => verifyRecord({ requireGo: true }),
    /recovery protection must be fresh/u,
  );

  const staleIntegrity = structuredClone(record);
  staleIntegrity.managedStorage.integrityFreshness = "due";
  writeRecord(staleIntegrity);
  assert.throws(
    () => verifyRecord({ requireGo: true }),
    /integrity verification must be fresh/u,
  );

  const overBudgetRecovery = structuredClone(record);
  overBudgetRecovery.managedStorage.automaticRecoveryBytes = 2 * 1_024 ** 3 + 1;
  writeRecord(overBudgetRecovery);
  assert.throws(
    () => verifyRecord({ requireGo: true }),
    /exceeds the managed storage policy budget/u,
  );

  const staleStorageEvidence = structuredClone(record);
  staleStorageEvidence.managedStorage.verifiedAt = "2026-08-28T13:30:00.000Z";
  writeRecord(staleStorageEvidence);
  assert.throws(
    () => verifyRecord({ requireGo: true }),
    /storage verification time is too old/u,
  );

  const pending = structuredClone(record);
  pending.decision.outcome = "PENDING";
  pending.decision.operator = null;
  pending.decision.decidedAt = null;
  pending.decision.acknowledged = false;
  writeRecord(pending);
  assert.equal(verifyRecord().decision.outcome, "PENDING");
  assert.throws(
    () => verifyRecord({ requireGo: true }),
    /decision is not GO/u,
  );

  const secretBearing = structuredClone(record);
  secretBearing.apiKey = "must-not-be-recorded";
  writeRecord(secretBearing);
  assert.throws(
    () => verifyRecord(),
    /missing or unexpected fields|forbidden sensitive-data field/u,
  );

  const changedPolicyPath = resolve(root, "changed-policy.json");
  const changedPolicy = JSON.parse(readFileSync(resolve(
    import.meta.dirname,
    "../../release/production-acceptance-policy.json",
  ), "utf8"));
  changedPolicy.canary.minimumObservationSeconds += 1;
  writeFileSync(changedPolicyPath, `${JSON.stringify(changedPolicy, null, 2)}\n`);
  writeRecord(record);
  assert.throws(
    () => verifyRecord({ policyPath: changedPolicyPath }),
    /does not match the reviewed policy/u,
  );

  writeFileSync(deploymentPath, readFileSync(deploymentPath, "utf8").replace("canary", "stable"));
  writeRecord(record);
  assert.throws(
    () => verifyRecord(),
    /does not match the deployment manifest/u,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
  "Production acceptance test passed: release identity, managed storage, 24-hour evidence and GO invariants fail closed.\n",
);
