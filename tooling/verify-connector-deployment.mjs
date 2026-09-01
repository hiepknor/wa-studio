import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultWorkspaceRoot = resolve(import.meta.dirname, "..");
const maximumResponseBytes = 1024 * 1024;
const requestTimeoutMs = 15_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function requiredString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return normalized;
}

function normalizeOrigin(value, label) {
  let url;
  try {
    url = new URL(requiredString(value, label));
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) origin.`);
  }
  if (!["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.search || url.hash
    || !["", "/"].includes(url.pathname)) {
    throw new Error(`${label} must be an HTTP(S) origin without credentials, path, query or fragment.`);
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !loopback) {
    throw new Error(`${label} must use HTTPS outside loopback development.`);
  }
  return url.origin;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, label) {
  expect(value !== null && typeof value === "object" && !Array.isArray(value), `${label} is invalid.`);
  return value;
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

async function requestJson(fetchImpl, origin, path, headers, label) {
  const response = await fetchImpl(new URL(path, origin), {
    headers: {
      accept: "application/json",
      "user-agent": "wa-studio-connector-deployment-verifier",
      ...headers,
    },
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${label} returned HTTP ${response.status}.`);
  }
  return readBoundedJson(response, label);
}

function releaseComponents(workspaceRoot) {
  let components;
  try {
    components = JSON.parse(readFileSync(resolve(workspaceRoot, "release/components.json"), "utf8"));
  } catch {
    throw new Error("Release components are missing or invalid.");
  }
  expect(components.schemaVersion === 4, "Unsupported release component schema.");
  return {
    openwaReleaseTag: requiredString(components.openwaReleaseTag, "OpenWA release tag"),
    pluginVersion: requiredString(components.connectorPluginVersion, "Connector plugin version"),
    protocolVersion: positiveInteger(components.connectorProtocolVersion, "Connector protocol version"),
    journalSchemaVersion: positiveInteger(
      components.connectorJournalSchemaVersion,
      "Connector journal schema version",
    ),
  };
}

function expectedIdentity(input) {
  const connectorId = requiredString(input.connectorId, "WA_STUDIO_CONNECTOR_ID");
  const sessionId = requiredString(input.sessionId, "WA_STUDIO_SESSION_ID");
  expect(uuidPattern.test(connectorId), "WA_STUDIO_CONNECTOR_ID must be a UUID.");
  expect(uuidPattern.test(sessionId), "WA_STUDIO_SESSION_ID must be a UUID.");
  return {
    connectorId,
    sessionId,
    instanceId: requiredString(input.instanceId, "WA_STUDIO_CONNECTOR_INSTANCE_ID"),
    tokenGeneration: positiveInteger(
      input.tokenGeneration,
      "WA_STUDIO_CONNECTOR_TOKEN_GENERATION",
    ),
  };
}

export async function verifyConnectorDeployment({
  workspaceRoot = defaultWorkspaceRoot,
  openwaBaseUrl,
  openwaApiKey,
  eventInboxDeviceToken,
  connectorId,
  instanceId,
  sessionId,
  tokenGeneration,
  maximumHeartbeatAgeMs = 20_000,
  maximumStorageUtilization = 0.75,
  fetchImpl = fetch,
} = {}) {
  const openwaOrigin = normalizeOrigin(openwaBaseUrl, "OPENWA_BASE_URL");
  const apiKey = requiredString(openwaApiKey, "OPENWA_API_KEY");
  const deviceToken = requiredString(eventInboxDeviceToken, "EVENT_INBOX_DEVICE_TOKEN");
  const expected = expectedIdentity({ connectorId, instanceId, sessionId, tokenGeneration });
  const versions = releaseComponents(workspaceRoot);
  expect(
    Number.isSafeInteger(maximumHeartbeatAgeMs) && maximumHeartbeatAgeMs >= 10_000
      && maximumHeartbeatAgeMs <= 300_000,
    "CONNECTOR_HEARTBEAT_MAX_AGE_MS must be between 10000 and 300000.",
  );
  expect(
    Number.isFinite(maximumStorageUtilization) && maximumStorageUtilization >= 0.5
      && maximumStorageUtilization <= 1,
    "CONNECTOR_MAX_STORAGE_UTILIZATION must be between 0.5 and 1.",
  );

  const openwaHeaders = { "x-api-key": apiKey };
  const discovery = object(await requestJson(
    fetchImpl,
    openwaOrigin,
    "/.well-known/wa-studio",
    {},
    "WA Studio discovery",
  ), "WA Studio discovery");
  expect(discovery.protocolVersion === 2, "WA Studio discovery protocol must be 2.");
  const eventInboxOrigin = normalizeOrigin(discovery.eventInboxUrl, "Discovered Event Inbox URL");

  const [healthValue, sessionsValue, pluginValue, pluginHealthValue, instancesValue, statusValue] =
    await Promise.all([
      requestJson(fetchImpl, openwaOrigin, "/api/health", openwaHeaders, "OpenWA health"),
      requestJson(
        fetchImpl,
        openwaOrigin,
        "/api/sessions?limit=1000",
        openwaHeaders,
        "OpenWA session scope",
      ),
      requestJson(
        fetchImpl,
        openwaOrigin,
        "/api/plugins/wa-studio-connector",
        openwaHeaders,
        "WA Studio Connector metadata",
      ),
      requestJson(
        fetchImpl,
        openwaOrigin,
        "/api/plugins/wa-studio-connector/health",
        openwaHeaders,
        "WA Studio Connector health",
      ),
      requestJson(
        fetchImpl,
        openwaOrigin,
        "/api/integration/plugins/wa-studio-connector/instances",
        openwaHeaders,
        "WA Studio Connector ingress instances",
      ),
      requestJson(
        fetchImpl,
        eventInboxOrigin,
        "/api/v1/event-inbox/connectors/status",
        { authorization: `Bearer ${deviceToken}` },
        "Event Inbox connector status",
      ),
    ]);

  const health = object(healthValue, "OpenWA health");
  expect(health.status === "ok", "OpenWA health is not ok.");
  expect(
    typeof health.version === "string" && health.version.length > 0,
    "OpenWA did not disclose its release; verify the API key and source-IP permission.",
  );
  expect(
    health.version === versions.openwaReleaseTag,
    `OpenWA release must be ${versions.openwaReleaseTag}.`,
  );

  expect(Array.isArray(sessionsValue), "OpenWA session scope is invalid.");
  expect(sessionsValue.length === 1, "OpenWA API key must expose exactly one session.");
  expect(sessionsValue[0]?.id === expected.sessionId, "OpenWA session scope does not match the local profile.");

  const plugin = object(pluginValue, "WA Studio Connector metadata");
  expect(plugin.id === "wa-studio-connector", "Unexpected OpenWA connector plugin ID.");
  expect(plugin.version === versions.pluginVersion, `Connector plugin must be ${versions.pluginVersion}.`);
  expect(plugin.status === "enabled", "WA Studio Connector plugin is not enabled.");
  expect(plugin.ingressCapable === true, "WA Studio Connector must support ingress.");
  expect(plugin.sessionScoped === true, "WA Studio Connector must be session scoped.");
  expect(
    Array.isArray(plugin.activeSessions)
      && plugin.activeSessions.length === 1
      && plugin.activeSessions[0] === expected.sessionId,
    "WA Studio Connector must activate only the managed session.",
  );
  const pluginHealth = object(pluginHealthValue, "WA Studio Connector health");
  expect(pluginHealth.healthy === true, "WA Studio Connector health is not healthy.");

  expect(Array.isArray(instancesValue), "WA Studio Connector ingress list is invalid.");
  expect(instancesValue.length === 1, "OpenWA must contain exactly one WA Studio Connector ingress.");
  const instance = object(instancesValue[0], "WA Studio Connector ingress");
  expect(instance.pluginId === "wa-studio-connector", "Ingress plugin identity is invalid.");
  expect(instance.instanceId === expected.instanceId, "Ingress instance does not match the local profile.");
  expect(
    instance.instanceId === `wa-studio-${expected.connectorId}`,
    "Ingress instance does not encode the connector identity.",
  );
  expect(instance.sessionScope === expected.sessionId, "Ingress session scope is invalid.");
  expect(instance.enabled === true, "WA Studio Connector ingress is not enabled.");

  const status = object(statusValue, "Event Inbox connector status");
  expect(status.protocolVersion === versions.protocolVersion, "Event Inbox connector protocol is incompatible.");
  expect(Array.isArray(status.sessions), "Event Inbox connector sessions are invalid.");
  expect(status.sessions.length === 1, "Event Inbox device must own exactly one session.");
  const report = object(status.sessions[0], "Event Inbox connector session");
  expect(report.sessionId === expected.sessionId, "Event Inbox session does not match the local profile.");
  const binding = object(report.binding, "Event Inbox connector binding");
  const connector = object(report.connector, "Event Inbox connector heartbeat");
  expect(binding.connectorId === expected.connectorId, "Event Inbox binding connector is invalid.");
  expect(connector.connectorId === expected.connectorId, "Heartbeat connector identity is invalid.");
  expect(
    connector.tokenGeneration === expected.tokenGeneration,
    "Heartbeat token generation does not match the local profile.",
  );
  expect(binding.generation === connector.bindingGeneration, "Heartbeat binding generation is stale.");
  expect(connector.pluginVersion === versions.pluginVersion, "Heartbeat plugin version is incompatible.");
  expect(connector.protocolVersion === versions.protocolVersion, "Heartbeat protocol version is incompatible.");
  expect(
    connector.journalSchemaVersion === versions.journalSchemaVersion,
    "Heartbeat journal schema version is incompatible.",
  );
  expect(connector.blockedReason === null, "WA Studio Connector reports a blocked state.");
  expect(
    Number.isInteger(connector.pendingCount) && connector.pendingCount >= 0,
    "Heartbeat pending count is invalid.",
  );
  expect(
    Number.isFinite(connector.storageUtilization)
      && connector.storageUtilization >= 0
      && connector.storageUtilization < maximumStorageUtilization,
    "WA Studio Connector storage pressure is unsafe.",
  );
  const generatedAt = Date.parse(status.generatedAt);
  const observedAt = Date.parse(connector.observedAt);
  expect(Number.isFinite(generatedAt) && Number.isFinite(observedAt), "Heartbeat timestamps are invalid.");
  const heartbeatAgeMs = generatedAt - observedAt;
  expect(heartbeatAgeMs >= 0, "Heartbeat timestamp is ahead of Event Inbox time.");
  expect(heartbeatAgeMs <= maximumHeartbeatAgeMs, "WA Studio Connector heartbeat is stale.");

  return {
    openwaOrigin,
    eventInboxOrigin,
    openwaRelease: health.version,
    pluginVersion: plugin.version,
    sessionId: expected.sessionId,
    connectorId: expected.connectorId,
    instanceId: expected.instanceId,
    tokenGeneration: connector.tokenGeneration,
    bindingGeneration: connector.bindingGeneration,
    heartbeatObservedAt: connector.observedAt,
    heartbeatAgeMs,
    pendingCount: connector.pendingCount,
    storageUtilization: connector.storageUtilization,
  };
}

function managedProfile() {
  if (process.platform !== "darwin") {
    throw new Error("--managed-profile requires the macOS Keychain.");
  }
  let raw;
  try {
    raw = execFileSync("/usr/bin/security", [
      "find-generic-password",
      "-s",
      "dev.hiepknor.wastudio",
      "-a",
      "runtime-credentials-v2",
      "-w",
    ], { encoding: "utf8", maxBuffer: maximumResponseBytes });
  } catch {
    throw new Error("WA Studio managed Runtime credentials are unavailable in Keychain.");
  }
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new Error("WA Studio managed Runtime credentials are invalid.");
  }
  if (credentials.schemaVersion !== 3 || !credentials.connector) {
    throw new Error("WA Studio managed profile must be migrated to connector schema 3 first.");
  }
  return {
    openwaBaseUrl: credentials.openwaBaseUrl,
    openwaApiKey: credentials.openwaApiKey,
    eventInboxDeviceToken: credentials.eventInboxDeviceToken,
    connectorId: credentials.connector.connectorId,
    instanceId: credentials.connector.ingressInstanceId,
    sessionId: credentials.connector.sessionId,
    tokenGeneration: credentials.connector.tokenGeneration,
  };
}

function environmentProfile(environment) {
  return {
    openwaBaseUrl: environment.OPENWA_BASE_URL,
    openwaApiKey: environment.OPENWA_API_KEY,
    eventInboxDeviceToken: environment.EVENT_INBOX_DEVICE_TOKEN,
    connectorId: environment.WA_STUDIO_CONNECTOR_ID,
    instanceId: environment.WA_STUDIO_CONNECTOR_INSTANCE_ID,
    sessionId: environment.WA_STUDIO_SESSION_ID,
    tokenGeneration: environment.WA_STUDIO_CONNECTOR_TOKEN_GENERATION,
  };
}

async function main() {
  const profile = process.argv.includes("--managed-profile")
    ? managedProfile()
    : environmentProfile(process.env);
  const result = await verifyConnectorDeployment({
    ...profile,
    maximumHeartbeatAgeMs: process.env.CONNECTOR_HEARTBEAT_MAX_AGE_MS
      ? Number(process.env.CONNECTOR_HEARTBEAT_MAX_AGE_MS)
      : undefined,
    maximumStorageUtilization: process.env.CONNECTOR_MAX_STORAGE_UTILIZATION
      ? Number(process.env.CONNECTOR_MAX_STORAGE_UTILIZATION)
      : undefined,
  });
  process.stdout.write(`${JSON.stringify({ status: "verified", ...result }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`Connector deployment verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
