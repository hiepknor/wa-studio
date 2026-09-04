import assert from "node:assert/strict";

import { verifyConnectorDeployment } from "./verify-connector-deployment.mjs";

const openwaOrigin = "https://openwa.example.test";
const eventInboxOrigin = "https://events.example.test";
const apiKey = "openwa-secret";
const deviceToken = "event-inbox-device-secret";
const sessionId = "00000000-0000-4000-8000-000000000001";
const connectorId = "00000000-0000-4000-8000-000000000002";
const instanceId = `wa-studio-${connectorId}`;
const generatedAt = "2026-08-31T12:00:10.000Z";
const observedAt = "2026-08-31T12:00:00.000Z";

function fixture(overrides = {}) {
  const state = {
    health: { status: "ok", version: "0.23.3" },
    sessions: [{ id: sessionId }],
    plugin: {
      id: "wa-studio-connector",
      version: "0.1.0",
      status: "enabled",
      ingressCapable: true,
      sessionScoped: true,
      activeSessions: [sessionId],
    },
    pluginHealth: { healthy: true },
    instances: [{
      pluginId: "wa-studio-connector",
      instanceId,
      sessionScope: sessionId,
      enabled: true,
    }],
    connectorStatus: {
      protocolVersion: 1,
      generatedAt,
      sessions: [{
        sessionId,
        binding: {
          connectorId,
          webhookId: "wa-studio-webhook",
          generation: 4,
          updatedAt: "2026-08-31T11:59:00.000Z",
        },
        connector: {
          connectorId,
          tokenGeneration: 2,
          pluginVersion: "0.1.0",
          protocolVersion: 1,
          journalSchemaVersion: 1,
          bindingGeneration: 4,
          pendingCount: 0,
          oldestPendingSeconds: null,
          storageUtilization: 0.1,
          blockedReason: null,
          observedAt,
        },
      }],
    },
    ...overrides,
  };
  const requests = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    requests.push({ url: url.toString(), headers: init.headers });
    let value;
    if (url.origin === openwaOrigin && url.pathname === "/.well-known/wa-studio") {
      value = { protocolVersion: 2, eventInboxUrl: eventInboxOrigin };
      assert.equal(init.headers["x-api-key"], undefined);
      assert.equal(init.headers.authorization, undefined);
    } else if (url.origin === openwaOrigin && url.pathname === "/api/health") {
      value = state.health;
      assert.equal(init.headers["x-api-key"], apiKey);
    } else if (url.origin === openwaOrigin && url.pathname === "/api/sessions") {
      value = state.sessions;
      assert.equal(url.search, "?limit=1000");
      assert.equal(init.headers["x-api-key"], apiKey);
    } else if (url.origin === openwaOrigin
      && url.pathname === "/api/plugins/wa-studio-connector") {
      value = state.plugin;
      assert.equal(init.headers["x-api-key"], apiKey);
    } else if (url.origin === openwaOrigin
      && url.pathname === "/api/plugins/wa-studio-connector/health") {
      value = state.pluginHealth;
      assert.equal(init.headers["x-api-key"], apiKey);
    } else if (url.origin === openwaOrigin
      && url.pathname === "/api/integration/plugins/wa-studio-connector/instances") {
      value = state.instances;
      assert.equal(init.headers["x-api-key"], apiKey);
    } else if (url.origin === eventInboxOrigin
      && url.pathname === "/api/v1/event-inbox/connectors/status") {
      value = state.connectorStatus;
      assert.equal(init.headers.authorization, `Bearer ${deviceToken}`);
      assert.equal(init.headers["x-api-key"], undefined);
    } else {
      return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    }
    const body = JSON.stringify(value);
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(Buffer.byteLength(body)) },
    });
  };
  return { fetchImpl, requests };
}

function input(fetchImpl) {
  return {
    openwaBaseUrl: openwaOrigin,
    openwaApiKey: apiKey,
    eventInboxDeviceToken: deviceToken,
    connectorId,
    instanceId,
    sessionId,
    tokenGeneration: 2,
    fetchImpl,
  };
}

{
  const { fetchImpl, requests } = fixture();
  const result = await verifyConnectorDeployment(input(fetchImpl));
  assert.deepEqual(result, {
    openwaOrigin,
    eventInboxOrigin,
    openwaRelease: "0.23.3",
    pluginVersion: "0.1.0",
    protocolVersion: 1,
    journalSchemaVersion: 1,
    sessionId,
    connectorId,
    instanceId,
    tokenGeneration: 2,
    bindingGeneration: 4,
    heartbeatObservedAt: observedAt,
    heartbeatAgeMs: 10_000,
    verifiedAt: generatedAt,
    pendingCount: 0,
    storageUtilization: 0.1,
  });
  assert.equal(requests.length, 7);
}

{
  const { fetchImpl } = fixture({
    instances: [
      {
        pluginId: "wa-studio-connector",
        instanceId,
        sessionScope: sessionId,
        enabled: true,
      },
      {
        pluginId: "wa-studio-connector",
        instanceId: "wa-studio-foreign",
        sessionScope: sessionId,
        enabled: false,
      },
    ],
  });
  await assert.rejects(
    verifyConnectorDeployment(input(fetchImpl)),
    /exactly one WA Studio Connector ingress/u,
  );
}

{
  const { fetchImpl } = fixture({
    connectorStatus: {
      protocolVersion: 1,
      generatedAt: "2026-08-31T12:01:00.000Z",
      sessions: [{
        sessionId,
        binding: {
          connectorId,
          webhookId: "wa-studio-webhook",
          generation: 4,
          updatedAt: "2026-08-31T11:59:00.000Z",
        },
        connector: {
          connectorId,
          tokenGeneration: 2,
          pluginVersion: "0.1.0",
          protocolVersion: 1,
          journalSchemaVersion: 1,
          bindingGeneration: 4,
          pendingCount: 0,
          oldestPendingSeconds: null,
          storageUtilization: 0.1,
          blockedReason: null,
          observedAt,
        },
      }],
    },
  });
  await assert.rejects(
    verifyConnectorDeployment(input(fetchImpl)),
    /heartbeat is stale/u,
  );
}

{
  const { fetchImpl } = fixture({ health: { status: "ok", version: "0.24.0" } });
  await assert.rejects(
    verifyConnectorDeployment(input(fetchImpl)),
    /OpenWA release must be 0\.23\.3/u,
  );
}

{
  const { fetchImpl } = fixture({ health: { status: "ok" } });
  await assert.rejects(
    verifyConnectorDeployment(input(fetchImpl)),
    /OpenWA did not disclose its release/u,
  );
}

process.stdout.write(
  "Connector deployment verifier test passed: identity, exclusivity, release and heartbeat gates fail closed.\n",
);
