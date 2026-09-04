import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadManagedConnectorProfile,
  verifyConnectorDeployment,
} from "../verify-connector-deployment.mjs";

const digestPattern = /^[0-9a-f]{64}$/u;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/u;
const maximumResponseBytes = 1024 * 1024;
const requestTimeoutMs = 15_000;
const maximumConnectorVerificationAgeMs = 5 * 60 * 1_000;
const maximumClockSkewMs = 30_000;
const maximumHeartbeatAgeMs = 5 * 60 * 1_000;
const maximumReleaseEvidenceAgeMs = 30_000;
const maximumActiveWebhookAgeSeconds = 5 * 60;
const managedRuntimeOrigin = "http://127.0.0.1:34100";

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

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function fraction(value, label) {
  if (!Number.isFinite(value) || value < 0 || value >= 0.75) {
    throw new Error(`${label} must be a finite number below the production limit.`);
  }
  return value;
}

function nullableNonnegativeNumber(value, label) {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be null or a finite non-negative number.`);
  }
  return value;
}

function zero(value, label) {
  if (nonnegativeInteger(value, label) !== 0) {
    throw new Error(`${label} must be zero for production release evidence.`);
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

function assertPrivateFile(path, label) {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o400) === 0 || (mode & 0o177) !== 0) {
    throw new Error(`${label} must be a private, non-executable owner-readable file.`);
  }
}

function deploymentIdentity(path) {
  const manifestPath = resolve(required(path, "Deployment manifest path"));
  const deployment = object(readJson(manifestPath, "Deployment manifest"), "Deployment manifest");
  if (deployment.schemaVersion !== 1
    || deployment.product !== "wa-studio"
    || deployment.releaseScope !== "product"
    || !["canary", "stable"].includes(deployment.releaseChannel)) {
    throw new Error("Deployment manifest is not a coordinated WA Studio product release.");
  }
  const components = object(deployment.components, "Deployment components");
  const runtime = object(components.runtime, "Deployment Runtime component");
  const eventInbox = object(components.eventInbox, "Deployment Event Inbox component");
  const connector = object(components.connector, "Deployment connector component");
  const connectorArtifact = object(connector.artifact, "Deployment connector artifact");
  const openwa = object(components.openwa, "Deployment OpenWA component");
  const acceptance = object(components.acceptance, "Deployment acceptance component");
  const deploymentManifestSha256 = sha256(manifestPath);
  const eventInboxImageDigest = required(eventInbox.imageDigest, "Event Inbox image digest");
  const connectorArtifactSha256 = required(connectorArtifact.sha256, "Connector artifact digest");
  const policySha256 = required(acceptance.policySha256, "Acceptance policy digest");
  if (!digestPattern.test(deploymentManifestSha256)
    || !imageDigestPattern.test(eventInboxImageDigest)
    || !digestPattern.test(connectorArtifactSha256)
    || !digestPattern.test(policySha256)) {
    throw new Error("Deployment manifest contains an invalid release digest.");
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
      deploymentManifestSha256,
      eventInboxImageDigest,
      connectorArtifactSha256,
    },
    policy: {
      version: positiveInteger(acceptance.policyVersion, "Acceptance policy version"),
      sha256: policySha256,
    },
    components: {
      runtimeVersion: required(runtime.version, "Runtime version"),
      openwaRelease: required(openwa.releaseTag, "OpenWA release"),
      connectorPluginVersion: required(connector.version, "Connector plugin version"),
      connectorProtocolVersion: positiveInteger(connector.protocolVersion, "Connector protocol version"),
      connectorJournalSchemaVersion: positiveInteger(
        connector.journalSchemaVersion,
        "Connector journal schema version",
      ),
    },
  };
}

function validateRuntimeHealth({ identity, connector, live, ready, operational, capturedAt }) {
  const publicHealth = object(live, "Runtime public health");
  const readiness = object(ready, "Runtime readiness");
  const health = object(operational, "Runtime operational health");
  const processes = object(health.processes, "Runtime process health");
  const dependencies = object(health.dependencies, "Runtime dependencies");
  const queue = object(dependencies.queue, "Runtime queue readiness");
  const components = object(health.components, "Runtime operational components");
  const openwa = object(components.openwa, "Runtime OpenWA health");
  const runtimeConnector = object(components.connector, "Runtime connector health");
  const sessions = Array.isArray(runtimeConnector.sessions) ? runtimeConnector.sessions : [];
  if (publicHealth.status !== "ok"
    || publicHealth.service !== "wa-runtime"
    || publicHealth.version !== identity.components.runtimeVersion
    || readiness.status !== "ready"
    || health.status !== "operational"
    || health.service !== "wa-runtime"
    || health.version !== identity.components.runtimeVersion) {
    throw new Error("Runtime is not operational for the coordinated release.");
  }
  if (readiness.liveSendsEnabled !== true || readiness.allowedSessionCount !== 1) {
    throw new Error("Runtime must have live sends enabled for exactly one accepted session.");
  }
  if (readiness.openwaRelease !== identity.components.openwaRelease
    || processes.worker !== "healthy"
    || processes.scheduler !== "healthy"
    || dependencies.postgres !== true
    || queue.ready !== true
    || !["postgres", "redis"].includes(queue.backend)) {
    throw new Error("Runtime dependencies or background processes are not healthy.");
  }
  if (openwa.status !== "COMPATIBLE"
    || openwa.expectedRelease !== identity.components.openwaRelease
    || openwa.observedRelease !== identity.components.openwaRelease) {
    throw new Error("Runtime OpenWA compatibility is not current.");
  }
  if (runtimeConnector.status !== "HEALTHY"
    || runtimeConnector.requiredForLiveSends !== true
    || runtimeConnector.healthySessionCount !== 1
    || runtimeConnector.sessionCount !== 1
    || sessions.length !== 1) {
    throw new Error("Runtime connector projection is not exclusively healthy.");
  }
  const session = object(sessions[0], "Runtime connector session");
  if (session.sessionId !== connector.sessionId
    || session.state !== "HEALTHY"
    || session.pluginVersion !== identity.components.connectorPluginVersion
    || session.pendingCount !== 0) {
    throw new Error("Runtime connector session is stale, mismatched, or not drained.");
  }
  fraction(session.storageUtilization, "Runtime connector storage utilization");
  const heartbeat = timestamp(session.heartbeatObservedAt, "Runtime connector heartbeat");
  if (heartbeat.parsed > capturedAt + maximumClockSkewMs
    || capturedAt - heartbeat.parsed > maximumHeartbeatAgeMs) {
    throw new Error("Runtime connector heartbeat is outside the accepted capture window.");
  }
  return {
    instanceId: required(health.instanceId, "Runtime instance ID"),
    version: health.version,
    queueBackend: queue.backend,
    worker: processes.worker,
    scheduler: processes.scheduler,
    liveSendsEnabled: readiness.liveSendsEnabled,
    allowedSessionCount: readiness.allowedSessionCount,
    openwaStatus: openwa.status,
    connectorStatus: runtimeConnector.status,
  };
}

function validateConnector({ identity, connectorVerification, capturedAt }) {
  const connector = object(connectorVerification, "Connector verification");
  const verified = timestamp(connector.verifiedAt, "Connector verification time");
  if (connector.status !== "verified"
    || connector.openwaRelease !== identity.components.openwaRelease
    || connector.pluginVersion !== identity.components.connectorPluginVersion
    || connector.protocolVersion !== identity.components.connectorProtocolVersion
    || connector.journalSchemaVersion !== identity.components.connectorJournalSchemaVersion) {
    throw new Error("Connector verification does not match the coordinated release.");
  }
  if (verified.parsed > capturedAt + maximumClockSkewMs
    || capturedAt - verified.parsed > maximumConnectorVerificationAgeMs) {
    throw new Error("Connector verification is outside the accepted capture window.");
  }
  if (nonnegativeInteger(connector.pendingCount, "Connector pending count") !== 0) {
    throw new Error("Connector journal must be drained before capturing production evidence.");
  }
  const heartbeat = timestamp(connector.heartbeatObservedAt, "Connector heartbeat time");
  const heartbeatAgeMs = nonnegativeInteger(connector.heartbeatAgeMs, "Connector heartbeat age");
  if (heartbeatAgeMs > maximumHeartbeatAgeMs) {
    throw new Error("Connector heartbeat is too old for production evidence.");
  }
  return {
    sessionId: required(connector.sessionId, "Connector session ID"),
    connectorId: required(connector.connectorId, "Connector ID"),
    instanceId: required(connector.instanceId, "Connector instance ID"),
    tokenGeneration: positiveInteger(connector.tokenGeneration, "Connector token generation"),
    bindingGeneration: positiveInteger(connector.bindingGeneration, "Connector binding generation"),
    verifiedAt: verified.normalized,
    heartbeatObservedAt: heartbeat.normalized,
    heartbeatAgeMs,
    pendingCount: connector.pendingCount,
    storageUtilization: fraction(connector.storageUtilization, "Connector storage utilization"),
  };
}

function validateReleaseEvidence(value, capturedAt) {
  const evidence = object(value, "Runtime release evidence");
  exactKeys(
    evidence,
    ["schemaVersion", "status", "generatedAt", "openwaSafety", "webhookSpool"],
    "Runtime release evidence",
  );
  if (evidence.schemaVersion !== 1 || evidence.status !== "complete") {
    throw new Error("Runtime release evidence is incomplete or incompatible.");
  }
  const generated = timestamp(evidence.generatedAt, "Runtime release evidence time");
  if (generated.parsed > capturedAt + maximumClockSkewMs
    || capturedAt - generated.parsed > maximumReleaseEvidenceAgeMs) {
    throw new Error("Runtime release evidence is outside the accepted capture window.");
  }

  const safety = object(evidence.openwaSafety, "Runtime OpenWA safety evidence");
  exactKeys(safety, [
    "openCircuitScopes", "halfOpenCircuitScopes", "manualBlockedScopes", "throttledScopes",
    "deferredMessageJobs", "unknownMessageJobs", "oldestUnknownMessageJobAgeSeconds",
  ], "Runtime OpenWA safety evidence");
  for (const [key, label] of [
    ["openCircuitScopes", "Open circuit scopes"],
    ["halfOpenCircuitScopes", "Half-open circuit scopes"],
    ["manualBlockedScopes", "Manually blocked safety scopes"],
    ["throttledScopes", "Throttled safety scopes"],
    ["deferredMessageJobs", "Deferred Message Jobs"],
    ["unknownMessageJobs", "Unknown Message Jobs"],
  ]) zero(safety[key], label);
  if (nullableNonnegativeNumber(
    safety.oldestUnknownMessageJobAgeSeconds,
    "Oldest unknown Message Job age",
  ) !== null) {
    throw new Error("Unknown Message Job age must be null when no unknown jobs remain.");
  }

  const spool = object(evidence.webhookSpool, "Runtime webhook spool evidence");
  exactKeys(spool, [
    "storedEvents", "storedBytes", "maxStoredEvents", "maxStoredBytes",
    "maximumIncomingEventBytes", "activeEvents", "deadEvents", "oldestActiveAgeSeconds",
    "oldestDeadAgeSeconds", "utilization", "admissionAvailable",
  ], "Runtime webhook spool evidence");
  const storedEvents = nonnegativeInteger(spool.storedEvents, "Stored webhook events");
  const storedBytes = nonnegativeInteger(spool.storedBytes, "Stored webhook bytes");
  const maxStoredEvents = positiveInteger(spool.maxStoredEvents, "Webhook event capacity");
  const maxStoredBytes = positiveInteger(spool.maxStoredBytes, "Webhook byte capacity");
  const maximumIncomingEventBytes = positiveInteger(
    spool.maximumIncomingEventBytes,
    "Maximum incoming webhook bytes",
  );
  const activeEvents = nonnegativeInteger(spool.activeEvents, "Active webhook events");
  const deadEvents = nonnegativeInteger(spool.deadEvents, "Dead webhook events");
  if (storedEvents !== activeEvents + deadEvents) {
    throw new Error("Runtime webhook spool counts are inconsistent.");
  }
  zero(deadEvents, "Dead webhook events");
  const utilization = Math.max(storedEvents / maxStoredEvents, storedBytes / maxStoredBytes);
  if (Math.abs(spool.utilization - utilization) > Number.EPSILON * 4) {
    throw new Error("Runtime webhook spool utilization is inconsistent with its ledger.");
  }
  const admissionAvailable = storedEvents + 1 <= maxStoredEvents
    && storedBytes + maximumIncomingEventBytes <= maxStoredBytes;
  if (spool.admissionAvailable !== admissionAvailable) {
    throw new Error("Runtime webhook spool admission state is inconsistent with its ledger.");
  }
  if (!admissionAvailable) {
    throw new Error("Runtime webhook spool must retain maximum-event admission capacity.");
  }
  fraction(spool.utilization, "Runtime webhook spool utilization");
  const oldestActiveAge = nullableNonnegativeNumber(
    spool.oldestActiveAgeSeconds,
    "Oldest active webhook age",
  );
  if ((activeEvents === 0) !== (oldestActiveAge === null)) {
    throw new Error("Runtime active webhook age does not match the active event count.");
  }
  if (oldestActiveAge !== null && oldestActiveAge > maximumActiveWebhookAgeSeconds) {
    throw new Error("Runtime webhook processing is stalled at release evidence capture time.");
  }
  if (nullableNonnegativeNumber(
    spool.oldestDeadAgeSeconds,
    "Oldest dead webhook age",
  ) !== null) {
    throw new Error("Dead webhook age must be null when no dead events remain.");
  }
  return evidence;
}

export function buildProductionOperationalSnapshot({
  deploymentManifestPath,
  connectorVerification,
  live,
  ready,
  operational,
  releaseEvidence,
  capturedAt = new Date(),
}) {
  const identity = deploymentIdentity(deploymentManifestPath);
  const capture = timestamp(
    capturedAt instanceof Date ? capturedAt.toISOString() : capturedAt,
    "Operational snapshot capture time",
  );
  const connector = validateConnector({ identity, connectorVerification, capturedAt: capture.parsed });
  const runtime = validateRuntimeHealth({
    identity,
    connector,
    live,
    ready,
    operational,
    capturedAt: capture.parsed,
  });
  const runtimeEvidence = validateReleaseEvidence(releaseEvidence, capture.parsed);
  return {
    schemaVersion: 2,
    product: "wa-studio",
    capturedAt: capture.normalized,
    release: identity.release,
    policy: identity.policy,
    components: identity.components,
    runtime,
    runtimeEvidence,
    connector,
  };
}

function verifySnapshotShape(snapshot, identity) {
  exactKeys(
    snapshot,
    [
      "schemaVersion", "product", "capturedAt", "release", "policy", "components", "runtime",
      "runtimeEvidence", "connector",
    ],
    "Production operational snapshot",
  );
  if (snapshot.schemaVersion !== 2 || snapshot.product !== "wa-studio") {
    throw new Error("Production operational snapshot schema is incompatible.");
  }
  timestamp(snapshot.capturedAt, "Operational snapshot capture time");
  exactKeys(snapshot.release, Object.keys(identity.release), "Operational snapshot release identity");
  exactKeys(snapshot.policy, Object.keys(identity.policy), "Operational snapshot policy identity");
  exactKeys(snapshot.components, Object.keys(identity.components), "Operational snapshot components");
  for (const [label, actual, expected] of [
    ["release", snapshot.release, identity.release],
    ["policy", snapshot.policy, identity.policy],
    ["components", snapshot.components, identity.components],
  ]) {
    if (Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
      throw new Error(`Operational snapshot ${label} does not match the deployment manifest.`);
    }
  }
  exactKeys(snapshot.runtime, [
    "instanceId", "version", "queueBackend", "worker", "scheduler", "liveSendsEnabled",
    "allowedSessionCount", "openwaStatus", "connectorStatus",
  ], "Operational snapshot Runtime health");
  exactKeys(snapshot.connector, [
    "sessionId", "connectorId", "instanceId", "tokenGeneration", "bindingGeneration",
    "verifiedAt", "heartbeatObservedAt", "heartbeatAgeMs", "pendingCount", "storageUtilization",
  ], "Operational snapshot connector health");
  if (snapshot.runtime.version !== identity.components.runtimeVersion
    || !["postgres", "redis"].includes(snapshot.runtime.queueBackend)
    || snapshot.runtime.worker !== "healthy"
    || snapshot.runtime.scheduler !== "healthy"
    || snapshot.runtime.liveSendsEnabled !== true
    || snapshot.runtime.allowedSessionCount !== 1
    || snapshot.runtime.openwaStatus !== "COMPATIBLE"
    || snapshot.runtime.connectorStatus !== "HEALTHY") {
    throw new Error("Operational snapshot does not contain accepted Runtime health.");
  }
  required(snapshot.runtime.instanceId, "Runtime instance ID");
  required(snapshot.connector.sessionId, "Connector session ID");
  required(snapshot.connector.connectorId, "Connector ID");
  required(snapshot.connector.instanceId, "Connector instance ID");
  positiveInteger(snapshot.connector.tokenGeneration, "Connector token generation");
  positiveInteger(snapshot.connector.bindingGeneration, "Connector binding generation");
  zeroPending(snapshot.connector.pendingCount);
  fraction(snapshot.connector.storageUtilization, "Connector storage utilization");
  const capture = timestamp(snapshot.capturedAt, "Operational snapshot capture time");
  validateReleaseEvidence(snapshot.runtimeEvidence, capture.parsed);
  const verified = timestamp(snapshot.connector.verifiedAt, "Connector verification time");
  const heartbeat = timestamp(snapshot.connector.heartbeatObservedAt, "Connector heartbeat time");
  const heartbeatAgeMs = nonnegativeInteger(snapshot.connector.heartbeatAgeMs, "Connector heartbeat age");
  if (verified.parsed > capture.parsed + maximumClockSkewMs
    || capture.parsed - verified.parsed > maximumConnectorVerificationAgeMs
    || verified.parsed - heartbeat.parsed !== heartbeatAgeMs
    || heartbeatAgeMs > maximumHeartbeatAgeMs
    || heartbeat.parsed > capture.parsed + maximumClockSkewMs
    || capture.parsed - heartbeat.parsed > maximumHeartbeatAgeMs) {
    throw new Error("Operational snapshot connector heartbeat is outside the accepted window.");
  }
}

function zeroPending(value) {
  if (nonnegativeInteger(value, "Connector pending count") !== 0) {
    throw new Error("Operational snapshot connector journal is not drained.");
  }
}

export function verifyProductionOperationalSnapshot({ deploymentManifestPath, snapshotPath }) {
  const identity = deploymentIdentity(deploymentManifestPath);
  const resolvedPath = resolve(required(snapshotPath, "Operational snapshot path"));
  assertPrivateFile(resolvedPath, "Production operational snapshot");
  const snapshot = object(
    readJson(resolvedPath, "Production operational snapshot"),
    "Production operational snapshot",
  );
  verifySnapshotShape(snapshot, identity);
  return { snapshot, sha256: sha256(resolvedPath) };
}

function normalizeRuntimeOrigin(value) {
  let url;
  try {
    url = new URL(required(value, "Runtime URL"));
  } catch {
    throw new Error("Runtime URL must be a valid HTTP(S) origin.");
  }
  const loopback = ["127.0.0.1", "::1", "[::1]", "localhost"].includes(
    url.hostname.toLowerCase(),
  );
  if (!["http:", "https:"].includes(url.protocol)
    || (url.protocol !== "https:" && !loopback)
    || url.username || url.password || url.search || url.hash
    || !["", "/"].includes(url.pathname)) {
    throw new Error("Runtime URL must be a credential-free HTTPS or loopback HTTP origin.");
  }
  return url.origin;
}

async function readBoundedJson(response, label) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumResponseBytes) {
    await response.body?.cancel();
    throw new Error(`${label} exceeds ${maximumResponseBytes} bytes.`);
  }
  if (!response.body) throw new Error(`${label} returned an empty response.`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumResponseBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds ${maximumResponseBytes} bytes.`);
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

async function requestRuntimeHealth(fetchImpl, origin, path, runtimeApiKey, isPublic = false) {
  const response = await fetchImpl(new URL(path, origin), {
    headers: {
      accept: "application/json",
      "user-agent": "wa-studio-production-operational-snapshot",
      ...(isPublic ? {} : { "x-runtime-key": required(runtimeApiKey, "RUNTIME_API_KEY") }),
    },
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Runtime ${path} returned HTTP ${response.status}.`);
  }
  return readBoundedJson(response, `Runtime ${path}`);
}

function environmentProfile(environment) {
  return {
    runtimeApiKey: environment.RUNTIME_API_KEY,
    openwaBaseUrl: environment.OPENWA_BASE_URL,
    openwaApiKey: environment.OPENWA_API_KEY,
    eventInboxDeviceToken: environment.EVENT_INBOX_DEVICE_TOKEN,
    connectorId: environment.WA_STUDIO_CONNECTOR_ID,
    instanceId: environment.WA_STUDIO_CONNECTOR_INSTANCE_ID,
    sessionId: environment.WA_STUDIO_SESSION_ID,
    tokenGeneration: environment.WA_STUDIO_CONNECTOR_TOKEN_GENERATION,
  };
}

export async function captureProductionOperationalSnapshot({
  deploymentManifestPath,
  runtimeUrl,
  outputPath,
  managedProfile = false,
  environment = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  const resolvedOutput = resolve(required(outputPath, "Operational snapshot output path"));
  if (existsSync(resolvedOutput)) {
    throw new Error("Operational snapshot output already exists.");
  }
  const suppliedRuntimeOrigin = runtimeUrl === undefined
    ? undefined
    : normalizeRuntimeOrigin(runtimeUrl);
  if (managedProfile && suppliedRuntimeOrigin && suppliedRuntimeOrigin !== managedRuntimeOrigin) {
    throw new Error(`Managed Runtime evidence must use ${managedRuntimeOrigin}.`);
  }
  const origin = managedProfile
    ? managedRuntimeOrigin
    : normalizeRuntimeOrigin(suppliedRuntimeOrigin);
  const profile = managedProfile
    ? loadManagedConnectorProfile()
    : environmentProfile(environment);
  const connectorVerification = {
    status: "verified",
    ...await verifyConnectorDeployment({ ...profile, fetchImpl }),
  };
  const [live, ready, operational, releaseEvidence] = await Promise.all([
    requestRuntimeHealth(fetchImpl, origin, "/api/v1/health/live", profile.runtimeApiKey, true),
    requestRuntimeHealth(fetchImpl, origin, "/api/v1/health/ready", profile.runtimeApiKey),
    requestRuntimeHealth(fetchImpl, origin, "/api/v1/health/operational", profile.runtimeApiKey),
    requestRuntimeHealth(fetchImpl, origin, "/api/v1/health/release-evidence", profile.runtimeApiKey),
  ]);
  const snapshot = buildProductionOperationalSnapshot({
    deploymentManifestPath,
    connectorVerification,
    live,
    ready,
    operational,
    releaseEvidence,
    capturedAt: now(),
  });
  writeFileSync(resolvedOutput, `${JSON.stringify(snapshot, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return snapshot;
}

function parseArguments(argv) {
  const [command, ...values] = argv;
  if (!["capture", "verify"].includes(command)) {
    throw new Error("Usage: production-operational-snapshot.mjs <capture|verify> [options]");
  }
  const allowed = command === "capture"
    ? new Set(["deployment", "runtime-url", "output", "managed-profile"])
    : new Set(["deployment", "snapshot"]);
  const options = { command, managedProfile: false };
  for (let index = 0; index < values.length;) {
    const flag = values[index];
    if (!flag?.startsWith("--")) throw new Error(`Invalid argument: ${flag ?? "<missing>"}.`);
    const name = flag.slice(2);
    if (!allowed.has(name)) throw new Error(`Unsupported option: ${flag}.`);
    if (name === "managed-profile") {
      if (options.managedProfile) throw new Error(`Duplicate option: ${flag}.`);
      options.managedProfile = true;
      index += 1;
      continue;
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--") || Object.hasOwn(options, name)) {
      throw new Error(`Invalid or duplicate option: ${flag}.`);
    }
    options[name] = value;
    index += 2;
  }
  return options;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.command === "capture") {
    const snapshot = await captureProductionOperationalSnapshot({
      deploymentManifestPath: options.deployment,
      runtimeUrl: options["runtime-url"],
      outputPath: options.output,
      managedProfile: options.managedProfile,
    });
    process.stdout.write(`${JSON.stringify({
      status: "captured",
      release: snapshot.release.tag,
      capturedAt: snapshot.capturedAt,
    })}\n`);
    return;
  }
  const verified = verifyProductionOperationalSnapshot({
    deploymentManifestPath: options.deployment,
    snapshotPath: options.snapshot,
  });
  process.stdout.write(`${JSON.stringify({
    status: "verified",
    release: verified.snapshot.release.tag,
    capturedAt: verified.snapshot.capturedAt,
    sha256: verified.sha256,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
