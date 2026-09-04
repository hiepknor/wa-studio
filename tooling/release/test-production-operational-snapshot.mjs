import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  buildProductionOperationalSnapshot,
  captureProductionOperationalSnapshot,
  verifyProductionOperationalSnapshot,
} from "./production-operational-snapshot.mjs";

const root = mkdtempSync(resolve(tmpdir(), "wa-production-operational-snapshot-"));
const deploymentPath = resolve(root, "wa-studio-deployment.json");
const snapshotPath = resolve(root, "operational-snapshot.json");
const capturedSnapshotPath = resolve(root, "captured-operational-snapshot.json");
const scriptPath = resolve(import.meta.dirname, "production-operational-snapshot.mjs");
const capturedAt = "2026-08-28T12:00:00.000Z";
const heartbeatAt = "2026-08-28T11:59:50.000Z";
const sessionId = "00000000-0000-4000-8000-000000000001";
const deployment = {
  schemaVersion: 1,
  product: "wa-studio",
  releaseScope: "product",
  releaseChannel: "canary",
  repository: "example/wa-studio",
  tag: "v0.2.2",
  gitCommit: "a".repeat(40),
  components: {
    studio: { version: "0.2.2" },
    acceptance: { policyVersion: 1, policySha256: "f".repeat(64) },
    runtime: { service: "wa-runtime", version: "0.1.0", contractVersion: "v1" },
    eventInbox: { imageDigest: `sha256:${"b".repeat(64)}` },
    connector: {
      version: "0.1.0",
      protocolVersion: 1,
      journalSchemaVersion: 1,
      artifact: { sha256: "c".repeat(64) },
    },
    openwa: { releaseTag: "0.23.3" },
  },
};
const connectorVerification = {
  status: "verified",
  openwaRelease: "0.23.3",
  pluginVersion: "0.1.0",
  protocolVersion: 1,
  journalSchemaVersion: 1,
  sessionId,
  connectorId: "00000000-0000-4000-8000-000000000002",
  instanceId: "wa-studio-00000000-0000-4000-8000-000000000002",
  tokenGeneration: 3,
  bindingGeneration: 5,
  heartbeatObservedAt: heartbeatAt,
  heartbeatAgeMs: 10_000,
  verifiedAt: capturedAt,
  pendingCount: 0,
  storageUtilization: 0.1,
};
const live = { status: "ok", service: "wa-runtime", version: "0.1.0" };
const ready = {
  status: "ready",
  dependencies: { postgres: true, queue: { backend: "postgres", ready: true } },
  processes: { worker: "healthy", scheduler: "healthy" },
  liveSendsEnabled: true,
  openwaRelease: "0.23.3",
  allowedSessionCount: 1,
};
const operational = {
  status: "operational",
  service: "wa-runtime",
  version: "0.1.0",
  instanceId: "runtime-canary",
  dependencies: { postgres: true, queue: { backend: "postgres", ready: true } },
  processes: { worker: "healthy", scheduler: "healthy" },
  components: {
    openwa: {
      status: "COMPATIBLE",
      expectedRelease: "0.23.3",
      observedRelease: "0.23.3",
    },
    connector: {
      status: "HEALTHY",
      requiredForLiveSends: true,
      healthySessionCount: 1,
      sessionCount: 1,
      sessions: [{
        sessionId,
        state: "HEALTHY",
        reason: null,
        pluginVersion: "0.1.0",
        heartbeatObservedAt: heartbeatAt,
        leaseExpiresAt: "2026-08-28T12:00:10.000Z",
        pendingCount: 0,
        storageUtilization: 0.1,
      }],
    },
  },
};

function build(overrides = {}) {
  return buildProductionOperationalSnapshot({
    deploymentManifestPath: deploymentPath,
    connectorVerification,
    live,
    ready,
    operational,
    capturedAt,
    ...overrides,
  });
}

function captureFixture() {
  const requests = [];
  const runtimeOrigin = "http://127.0.0.1:43123";
  const openwaOrigin = "https://openwa.example.test";
  const eventInboxOrigin = "https://events.example.test";
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    requests.push({ url: url.toString(), headers: init.headers });
    let value;
    if (url.origin === openwaOrigin && url.pathname === "/.well-known/wa-studio") {
      assert.equal(init.headers["x-api-key"], undefined);
      value = { protocolVersion: 2, eventInboxUrl: eventInboxOrigin };
    } else if (url.origin === openwaOrigin && url.pathname === "/api/health") {
      assert.equal(init.headers["x-api-key"], "openwa-secret");
      value = { status: "ok", version: "0.23.3" };
    } else if (url.origin === openwaOrigin && url.pathname === "/api/sessions") {
      assert.equal(init.headers["x-api-key"], "openwa-secret");
      value = [{ id: sessionId }];
    } else if (url.origin === openwaOrigin
      && url.pathname === "/api/plugins/wa-studio-connector") {
      assert.equal(init.headers["x-api-key"], "openwa-secret");
      value = {
        id: "wa-studio-connector",
        version: "0.1.0",
        status: "enabled",
        ingressCapable: true,
        sessionScoped: true,
        activeSessions: [sessionId],
      };
    } else if (url.origin === openwaOrigin
      && url.pathname === "/api/plugins/wa-studio-connector/health") {
      assert.equal(init.headers["x-api-key"], "openwa-secret");
      value = { healthy: true };
    } else if (url.origin === openwaOrigin
      && url.pathname === "/api/integration/plugins/wa-studio-connector/instances") {
      assert.equal(init.headers["x-api-key"], "openwa-secret");
      value = [{
        pluginId: "wa-studio-connector",
        instanceId: connectorVerification.instanceId,
        sessionScope: sessionId,
        enabled: true,
      }];
    } else if (url.origin === eventInboxOrigin
      && url.pathname === "/api/v1/event-inbox/connectors/status") {
      assert.equal(init.headers.authorization, "Bearer device-secret");
      value = {
        protocolVersion: 1,
        generatedAt: capturedAt,
        sessions: [{
          sessionId,
          binding: {
            connectorId: connectorVerification.connectorId,
            generation: 5,
          },
          connector: {
            connectorId: connectorVerification.connectorId,
            tokenGeneration: 3,
            pluginVersion: "0.1.0",
            protocolVersion: 1,
            journalSchemaVersion: 1,
            bindingGeneration: 5,
            pendingCount: 0,
            storageUtilization: 0.1,
            blockedReason: null,
            observedAt: heartbeatAt,
          },
        }],
      };
    } else if (url.origin === runtimeOrigin && url.pathname === "/api/v1/health/live") {
      assert.equal(init.headers["x-runtime-key"], undefined);
      value = live;
    } else if (url.origin === runtimeOrigin && url.pathname === "/api/v1/health/ready") {
      assert.equal(init.headers["x-runtime-key"], "runtime-secret");
      value = ready;
    } else if (url.origin === runtimeOrigin && url.pathname === "/api/v1/health/operational") {
      assert.equal(init.headers["x-runtime-key"], "runtime-secret");
      value = operational;
    } else {
      return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    }
    const body = JSON.stringify(value);
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(Buffer.byteLength(body)) },
    });
  };
  return { fetchImpl, requests, runtimeOrigin };
}

try {
  writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);
  const snapshot = build();
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  const verified = verifyProductionOperationalSnapshot({
    deploymentManifestPath: deploymentPath,
    snapshotPath,
  });
  assert.equal(verified.snapshot.runtime.connectorStatus, "HEALTHY");
  assert.match(verified.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(snapshot).includes("apiKey"), false);
  assert.equal(JSON.stringify(snapshot).includes("deviceToken"), false);

  const capture = captureFixture();
  const captured = await captureProductionOperationalSnapshot({
    deploymentManifestPath: deploymentPath,
    runtimeUrl: capture.runtimeOrigin,
    outputPath: capturedSnapshotPath,
    environment: {
      RUNTIME_API_KEY: "runtime-secret",
      OPENWA_BASE_URL: "https://openwa.example.test",
      OPENWA_API_KEY: "openwa-secret",
      EVENT_INBOX_DEVICE_TOKEN: "device-secret",
      WA_STUDIO_CONNECTOR_ID: connectorVerification.connectorId,
      WA_STUDIO_CONNECTOR_INSTANCE_ID: connectorVerification.instanceId,
      WA_STUDIO_SESSION_ID: sessionId,
      WA_STUDIO_CONNECTOR_TOKEN_GENERATION: "3",
    },
    fetchImpl: capture.fetchImpl,
    now: () => new Date(capturedAt),
  });
  assert.equal(captured.connector.verifiedAt, capturedAt);
  assert.equal(capture.requests.length, 10);
  assert.equal(statSync(capturedSnapshotPath).mode & 0o077, 0);
  const capturedText = readFileSync(capturedSnapshotPath, "utf8");
  assert.equal(capturedText.includes("runtime-secret"), false);
  assert.equal(capturedText.includes("openwa-secret"), false);
  assert.equal(capturedText.includes("device-secret"), false);
  await assert.rejects(
    captureProductionOperationalSnapshot({
      deploymentManifestPath: deploymentPath,
      runtimeUrl: capture.runtimeOrigin,
      outputPath: capturedSnapshotPath,
      environment: {},
      fetchImpl: capture.fetchImpl,
    }),
    /output already exists/u,
  );

  assert.match(execFileSync(process.execPath, [
    scriptPath,
    "verify",
    "--deployment", deploymentPath,
    "--snapshot", snapshotPath,
  ], { encoding: "utf8" }), /"status":"verified"/u);
  assert.notEqual(spawnSync(process.execPath, [
    scriptPath,
    "verify",
    "--deployment", deploymentPath,
    "--snapshot", snapshotPath,
    "--unknown", "value",
  ]).status, 0);

  const inconsistentHeartbeatAge = structuredClone(snapshot);
  inconsistentHeartbeatAge.connector.heartbeatAgeMs = 9_000;
  writeFileSync(snapshotPath, `${JSON.stringify(inconsistentHeartbeatAge, null, 2)}\n`);
  assert.throws(
    () => verifyProductionOperationalSnapshot({ deploymentManifestPath: deploymentPath, snapshotPath }),
    /heartbeat is outside the accepted window/u,
  );
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

  assert.throws(
    () => build({ ready: { ...ready, liveSendsEnabled: false } }),
    /live sends enabled/u,
  );
  assert.throws(
    () => build({
      connectorVerification: {
        ...connectorVerification,
        verifiedAt: "2026-08-28T11:50:00.000Z",
      },
    }),
    /outside the accepted capture window/u,
  );
  assert.throws(
    () => build({
      operational: {
        ...operational,
        components: {
          ...operational.components,
          connector: {
            ...operational.components.connector,
            sessions: [{ ...operational.components.connector.sessions[0], pendingCount: 1 }],
          },
        },
      },
    }),
    /not drained/u,
  );

  writeFileSync(deploymentPath, `${JSON.stringify({
    ...deployment,
    gitCommit: "not-a-release-commit",
  }, null, 2)}\n`);
  assert.throws(() => build(), /release identity is invalid/u);
  writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);

  chmodSync(snapshotPath, 0o644);
  assert.throws(
    () => verifyProductionOperationalSnapshot({ deploymentManifestPath: deploymentPath, snapshotPath }),
    /private, non-executable owner-readable/u,
  );
  chmodSync(snapshotPath, 0o600);

  const tampered = structuredClone(snapshot);
  tampered.release.gitCommit = "d".repeat(40);
  writeFileSync(snapshotPath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(
    () => verifyProductionOperationalSnapshot({ deploymentManifestPath: deploymentPath, snapshotPath }),
    /does not match the deployment manifest/u,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
  "Production operational snapshot test passed: release, Runtime and connector health fail closed.\n",
);
