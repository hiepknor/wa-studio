import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const maximumResponseBytes = 1024 * 1024;
const requestTimeoutMs = 15_000;
const digestImagePattern = /^ghcr\.io\/[a-z0-9_.-]+\/wa-event-inbox@sha256:[0-9a-f]{64}$/u;

function required(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function normalizePrivateBaseUrl(value) {
  let url;
  try {
    url = new URL(required(value, "Candidate readiness URL"));
  } catch {
    throw new Error("Candidate readiness URL must be a valid loopback HTTP origin.");
  }
  if (url.protocol !== "http:"
    || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname.toLowerCase())
    || url.username || url.password || url.search || url.hash
    || !["", "/"].includes(url.pathname)) {
    throw new Error("Candidate readiness URL must be a credential-free loopback HTTP origin.");
  }
  return url.origin;
}

async function readBoundedJson(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumResponseBytes) {
    await response.body?.cancel();
    throw new Error("Candidate readiness response is too large.");
  }
  if (!response.body) throw new Error("Candidate readiness returned an empty response.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumResponseBytes) {
      await reader.cancel();
      throw new Error("Candidate readiness response is too large.");
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Candidate readiness returned invalid JSON.");
  }
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} does not match the deployment manifest.`);
}

function inspectContainer(container) {
  const format = "{{.Id}}\t{{.Config.Image}}\t{{.State.Running}}\t{{.State.StartedAt}}";
  const output = execFileSync(
    "docker",
    ["inspect", `--format=${format}`, required(container, "Candidate container")],
    { encoding: "utf8", maxBuffer: maximumResponseBytes },
  ).trim();
  const [containerId, image, running, startedAt, ...extra] = output.split("\t");
  if (extra.length > 0
    || !/^[0-9a-f]{64}$/u.test(containerId)
    || !digestImagePattern.test(image)
    || running !== "true"
    || Number.isNaN(Date.parse(startedAt))) {
    throw new Error("Candidate container inspection is invalid or not running.");
  }
  return { containerId, image, startedAt };
}

export function verifyEventInboxCandidate({ manifest, readiness, observedImage, readinessOrigin }) {
  const deployment = object(manifest, "Deployment manifest");
  const components = object(deployment.components, "Deployment components");
  const eventInbox = object(components.eventInbox, "Event Inbox deployment component");
  const runtime = object(components.runtime, "Runtime deployment component");
  const connector = object(components.connector, "Connector deployment component");
  const openwa = object(components.openwa, "OpenWA deployment component");
  const migration = object(eventInbox.migrationHead, "Event Inbox migration identity");
  const health = object(readiness, "Candidate readiness");
  const release = object(health.release, "Candidate release identity");
  const tag = required(deployment.tag, "Deployment tag");
  const gitCommit = required(deployment.gitCommit, "Deployment commit");

  if (deployment.schemaVersion !== 1
    || deployment.product !== "wa-studio"
    || !["server-candidate", "product"].includes(deployment.releaseScope)) {
    throw new Error("Deployment manifest schema is incompatible.");
  }
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(tag)
    || !/^[0-9a-f]{40}$/u.test(gitCommit)) {
    throw new Error("Deployment tag or commit identity is invalid.");
  }
  if (!digestImagePattern.test(eventInbox.image)) {
    throw new Error("Deployment manifest does not contain an immutable Event Inbox image.");
  }
  expectEqual(
    eventInbox.imageDigest,
    eventInbox.image.slice(eventInbox.image.indexOf("@") + 1),
    "Image digest",
  );
  if (!Number.isSafeInteger(migration.count) || migration.count < 1
    || !Number.isSafeInteger(connector.protocolVersion) || connector.protocolVersion < 1
    || !Number.isSafeInteger(connector.journalSchemaVersion) || connector.journalSchemaVersion < 1) {
    throw new Error("Deployment protocol or migration identity is invalid.");
  }
  expectEqual(required(observedImage, "Observed container image"), eventInbox.image, "Container image");
  expectEqual(health.status, "ready", "Candidate readiness status");
  expectEqual(health.service, "wa-event-inbox", "Candidate service");
  expectEqual(health.protocolVersion, 2, "Event Inbox protocol");
  const webhookAdmission = object(health.webhookAdmission, "Webhook admission status");
  expectEqual(webhookAdmission.available, true, "Webhook admission availability");
  if (!Number.isSafeInteger(webhookAdmission.eventSlotsRemaining)
    || webhookAdmission.eventSlotsRemaining < 1
    || !Number.isSafeInteger(webhookAdmission.byteHeadroom)
    || !Number.isSafeInteger(webhookAdmission.requiredByteHeadroom)
    || webhookAdmission.byteHeadroom < webhookAdmission.requiredByteHeadroom) {
    throw new Error("Webhook admission headroom is insufficient or invalid.");
  }
  expectEqual(release.runtimeVersion, runtime.version, "Runtime version");
  expectEqual(release.openwaReleaseTag, openwa.releaseTag, "OpenWA release");
  expectEqual(release.connectorProtocolVersion, connector.protocolVersion, "Connector protocol");
  expectEqual(
    release.connectorJournalSchemaVersion,
    connector.journalSchemaVersion,
    "Connector journal schema",
  );
  expectEqual(release.migrationHead, migration.name, "Event Inbox migration head");
  expectEqual(release.migrationCount, migration.count, "Event Inbox migration count");
  expectEqual(health.migrationHead, migration.name, "Readiness migration head");
  expectEqual(health.migrationCount, migration.count, "Readiness migration count");

  return {
    status: "verified",
    tag,
    gitCommit,
    readinessOrigin,
    image: eventInbox.image,
    runtimeVersion: runtime.version,
    openwaReleaseTag: openwa.releaseTag,
    connectorProtocolVersion: connector.protocolVersion,
    connectorJournalSchemaVersion: connector.journalSchemaVersion,
    migrationHead: migration.name,
    migrationCount: migration.count,
  };
}

function parseArguments(argv) {
  const names = new Map([
    ["--manifest", "manifestPath"],
    ["--readiness-url", "readinessUrl"],
    ["--container", "container"],
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    const value = argv[index + 1];
    if (!key || value === undefined || value.startsWith("--") || options[key] !== undefined) {
      throw new Error(`Invalid candidate verifier argument: ${argv[index] ?? "<missing>"}.`);
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== names.size) {
    throw new Error("Candidate verifier arguments are incomplete.");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const readinessOrigin = normalizePrivateBaseUrl(options.readinessUrl);
  const before = inspectContainer(options.container);
  const response = await fetch(new URL("/api/v1/health/ready", readinessOrigin), {
    headers: { accept: "application/json", "user-agent": "wa-studio-event-inbox-candidate-verifier" },
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Candidate readiness returned HTTP ${response.status}.`);
  }
  const manifest = JSON.parse(readFileSync(resolve(options.manifestPath), "utf8"));
  const readiness = await readBoundedJson(response);
  const after = inspectContainer(options.container);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error("Candidate container changed while readiness was being verified.");
  }
  const result = verifyEventInboxCandidate({
    manifest,
    readiness,
    observedImage: after.image,
    readinessOrigin,
  });
  process.stdout.write(`${JSON.stringify({
    ...result,
    containerId: after.containerId,
    containerStartedAt: after.startedAt,
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  void main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
