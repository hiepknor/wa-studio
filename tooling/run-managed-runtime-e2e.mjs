import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import process from "node:process";

const workspaceRoot = resolve(import.meta.dirname, "..");
const studioRoot = resolve(workspaceRoot, "apps/studio");
const runtimeRoot = resolve(workspaceRoot, "services/runtime");
const openWaReleaseTag = JSON.parse(
  readFileSync(resolve(workspaceRoot, "release/components.json"), "utf8"),
).openwaReleaseTag;
const runtimeRequire = createRequire(resolve(runtimeRoot, "package.json"));
const { Pool } = runtimeRequire("pg");

const sessionId = "00000000-0000-4000-8000-000000000001";
let runtimePort = 34_100;
const testRuntimeApiKey = "packaged-e2e-runtime-key-with-at-least-32-characters";
const testOpenWaApiKey = "packaged-e2e-openwa-api-key";
const eventInboxMasterSecret =
  "packaged-e2e-event-inbox-master-secret-with-at-least-32-characters";
const testWebhookSecret = createHmac("sha256", eventInboxMasterSecret)
  .update("openwa-webhook-secret:v1")
  .digest("base64url");
const managedPostgresPassword =
  "desktop-e2e-postgres-password-with-at-least-32-characters";
const managedPostgresRoot = resolve(
  studioRoot,
  "src-tauri/target/managed-postgres-e2e",
);
const managedBackupRoot = resolve(
  studioRoot,
  "src-tauri/target/managed-postgres-e2e-backups",
);
const appBinary = resolve(
  process.env.WA_STUDIO_APP_BINARY
    ?? resolve(
      studioRoot,
      "src-tauri/target/release/bundle/macos/WA Studio.app/Contents/MacOS/wa-studio",
    ),
);

async function main() {
  const runtimeEnvFile = resolve(
    process.env.WA_RUNTIME_ENV_FILE ?? resolve(runtimeRoot, ".env"),
  );
  if (existsSync(runtimeEnvFile)) process.loadEnvFile(runtimeEnvFile);
  const useExternalPostgres = process.argv.includes("--external-postgres");
  const withEventInbox = process.argv.includes("--with-event-inbox");
  const oneShot = process.argv.includes("--one-shot");
  if (oneShot && !withEventInbox) {
    throw new Error("--one-shot requires --with-event-inbox so the full packaged data path is verified.");
  }
  if (withEventInbox && useExternalPostgres) {
    throw new Error("The Event Inbox packaged E2E must use managed PostgreSQL to verify the complete app.");
  }
  if (!existsSync(appBinary)) {
    throw new Error(`WA Studio application binary does not exist at ${appBinary}.`);
  }

  runtimePort = process.env.WA_RUNTIME_E2E_PORT
    ? parseRuntimePort(process.env.WA_RUNTIME_E2E_PORT)
    : oneShot
      ? await availablePort()
      : 34_100;

  const profile = withEventInbox ? eventInboxTestProfile() : developmentProfile();
  const databaseEnvironment = useExternalPostgres
    ? externalDatabaseEnvironment()
    : managedDatabaseEnvironment();
  if (oneShot) prepareManagedPostgresRoot();
  await assertPortAvailable(runtimePort, "managed Runtime");

  let openwa;
  let eventInbox;
  let app;
  let runFailed = false;
  let successfulNativeQuit = false;
  const signalHandlers = new Map();
  try {
    openwa = withEventInbox
      ? await startOpenWaStub(profile.openwaApiKey, profile.webhookSecret)
      : developmentOpenWa(profile.openwaBaseUrl);
    eventInbox = withEventInbox
      ? await startEventInbox(
          openwa.baseUrl,
          profile.openwaApiKey,
          profile.eventInboxMasterSecret,
        )
      : undefined;

    const openwaBaseUrl = openwa.baseUrl;
    const eventInboxBaseUrl = eventInbox?.baseUrl ?? profile.eventInboxBaseUrl;
    const eventInboxDeviceToken = eventInbox
      ? eventInbox.deviceToken
      : profile.eventInboxDeviceToken;
    const appEnvironment = {
        ...process.env,
        ...databaseEnvironment,
        WA_DESKTOP_DEV_RUNTIME: "1",
        WA_DESKTOP_RUNTIME_PORT: String(runtimePort),
        WA_DESKTOP_RUNTIME_NODE_ENV: withEventInbox ? "test" : "development",
        WA_DESKTOP_RUNTIME_API_KEY: profile.runtimeApiKey,
        WA_DESKTOP_OPENWA_BASE_URL: openwaBaseUrl,
        WA_DESKTOP_OPENWA_API_KEY: profile.openwaApiKey,
        WA_DESKTOP_OPENWA_WEBHOOK_SECRET: profile.webhookSecret,
        WA_DESKTOP_OPENWA_ALLOWED_SESSION_IDS: profile.allowedSessionIds,
        WA_DESKTOP_ALLOW_LIVE_SENDS: "false",
        ...(eventInboxBaseUrl
          ? {
              WA_DESKTOP_EVENT_INBOX_BASE_URL: eventInboxBaseUrl,
              WA_DESKTOP_EVENT_INBOX_DEVICE_TOKEN: eventInboxDeviceToken,
              WA_DESKTOP_EVENT_INBOX_CALLBACK_URL:
                `${eventInboxBaseUrl}/api/v1/webhooks/openwa`,
            }
          : {}),
    };
    app = spawn(appBinary, [], {
      env: appEnvironment,
      stdio: "inherit",
    });

    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => app?.kill(signal);
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }

    if (!oneShot) {
      const [code, signal] = await once(app, "exit");
      if (signal) process.kill(process.pid, signal);
      process.exitCode = code ?? 1;
      return;
    }

    const operational = await waitForRuntimeOperational(profile.runtimeApiKey);
    assert(
      /^desktop-[1-9][0-9]*$/u.test(operational.instanceId),
      "Packaged Runtime operational health did not report its supervisor generation",
    );
    const health = await waitForRuntimeReady(profile.runtimeApiKey);
    assertCompleteRuntimeHealth(health);
    const registration = await waitForWebhookRegistration(openwa, eventInboxBaseUrl);
    const syncRun = await requestFullSync(profile.runtimeApiKey);
    await waitForSyncCompleted(syncRun.id, profile.runtimeApiKey);
    assert(openwa.releaseProbeCount() > 0, "Packaged Runtime did not probe the OpenWA release");
    assertWebhookRegistration(registration, eventInboxBaseUrl, profile.webhookSecret);

    const event = packagedWebhookEvent();
    await postSignedWebhook(eventInboxBaseUrl, profile.webhookSecret, event);
    await waitForEventInboxDrain(eventInboxBaseUrl);
    await assertLocalWebhookCommitted(event, 1);

    // An Event Inbox redelivery after ACK must still collapse onto the same local idempotency key.
    await postSignedWebhook(eventInboxBaseUrl, profile.webhookSecret, event);
    await waitForEventInboxDrain(eventInboxBaseUrl);
    await assertLocalWebhookCommitted(event, 1);

    nativeQuitStudio();
    await waitForChildExit(app, 30_000, "WA Studio did not exit after the native quit request");
    app = spawn(appBinary, [], { env: appEnvironment, stdio: "inherit" });
    await waitForRuntimeOperational(profile.runtimeApiKey);
    await waitForRuntimeReady(profile.runtimeApiKey);
    assertManagedBackupCreated();
    nativeQuitStudio();
    await waitForChildExit(
      app,
      30_000,
      "WA Studio did not exit after the backup-verification restart",
    );
    successfulNativeQuit = true;
  } catch (error) {
    runFailed = true;
    throw error;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    if (app?.exitCode === null && app?.signalCode === null) {
      if (oneShot) {
        try {
          nativeQuitStudio();
          await waitForChildExit(app, 30_000, "WA Studio did not exit during E2E cleanup");
        } catch {
          await terminateChild(app, "WA Studio");
        }
      } else {
        await terminateChild(app, "WA Studio");
      }
    }
    if (eventInbox) await eventInbox.close();
    if (openwa?.close) await openwa.close();
    if (oneShot) {
      if (runFailed) await stopOrphanedManagedPostgres();
      await waitForNoPackagedProcesses();
      cleanManagedPostgresData();
    }
  }

  if (oneShot) {
    if (!successfulNativeQuit) throw new Error("Packaged E2E did not complete a native app shutdown.");
    process.stdout.write(
      `Packaged managed Runtime E2E passed: OpenWA ${openWaReleaseTag} registration, durable Event Inbox claim/ACK, local PostgreSQL dedup, verified encrypted restart backup, safe native shutdown.\n`,
    );
  }
}

function assertManagedBackupCreated() {
  const backups = readdirSync(managedBackupRoot)
    .filter(name => name.endsWith(".dump.age"))
    .map(name => resolve(managedBackupRoot, name));
  assert(backups.length > 0, "Packaged Runtime restart did not create a recovery backup");
  for (const backup of backups) {
    assert(statSync(backup).size > 0, `Packaged Runtime created an empty backup: ${backup}`);
    assert(
      readFileSync(backup).subarray(0, 64).toString("utf8").includes("age-encryption.org/v1"),
      `Packaged Runtime backup is not an age archive: ${backup}`,
    );
  }
}

function eventInboxTestProfile() {
  requiredTestDatabaseUrl();
  return {
    runtimeApiKey: testRuntimeApiKey,
    openwaApiKey: testOpenWaApiKey,
    webhookSecret: testWebhookSecret,
    eventInboxMasterSecret,
    allowedSessionIds: sessionId,
  };
}

function developmentProfile() {
  const required = [
    "RUNTIME_API_KEY",
    "OPENWA_BASE_URL",
    "OPENWA_API_KEY",
    "OPENWA_WEBHOOK_SECRET",
    "OPENWA_ALLOWED_SESSION_IDS",
    "EVENT_INBOX_BASE_URL",
    "EVENT_INBOX_DEVICE_TOKEN",
  ];
  const missing = required.filter(name => !process.env[name]);
  if (missing.length) {
    throw new Error(`Runtime development environment is missing ${missing.join(", ")}.`);
  }
  return {
    runtimeApiKey: process.env.RUNTIME_API_KEY,
    openwaBaseUrl: process.env.OPENWA_BASE_URL,
    openwaApiKey: process.env.OPENWA_API_KEY,
    webhookSecret: process.env.OPENWA_WEBHOOK_SECRET,
    allowedSessionIds: process.env.OPENWA_ALLOWED_SESSION_IDS,
    eventInboxBaseUrl: process.env.EVENT_INBOX_BASE_URL,
    eventInboxDeviceToken: process.env.EVENT_INBOX_DEVICE_TOKEN,
  };
}

function externalDatabaseEnvironment() {
  const databaseUrl = localDevelopmentDatabaseUrl();
  databaseUrl.pathname = "/wa_runtime_desktop_e2e";
  return { WA_DESKTOP_DATABASE_URL: databaseUrl.toString() };
}

function managedDatabaseEnvironment() {
  return {
    WA_DESKTOP_POSTGRES_ROOT: managedPostgresRoot,
    WA_DESKTOP_BACKUP_ROOT: managedBackupRoot,
    // Public age crate test identity; never used outside this isolated E2E cluster.
    WA_DESKTOP_BACKUP_IDENTITY:
      "AGE-SECRET-KEY-1GQ9778VQXMMJVE8SK7J6VT8UJ4HDQAJUVSFCWCM02D8GEWQ72PVQ2Y5J33",
    WA_DESKTOP_DATABASE_PASSWORD: managedPostgresPassword,
  };
}

function developmentOpenWa(baseUrl) {
  const openwaUrl = new URL(baseUrl);
  openwaUrl.hostname = "127.0.0.1";
  openwaUrl.port = "2785";
  return { baseUrl: openwaUrl.toString() };
}

async function startOpenWaStub(apiKey, webhookSecret) {
  const registrations = [];
  const metrics = { releaseProbes: 0 };
  let requestFailure;
  const server = createHttpServer((request, response) => {
    void handleOpenWaRequest(request, response, {
      apiKey,
      metrics,
      registrations,
      webhookSecret,
    }).catch(error => {
      requestFailure = error;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OpenWA stub has no TCP port.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    registrations,
    releaseProbeCount: () => metrics.releaseProbes,
    requestFailure: () => requestFailure,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function handleOpenWaRequest(request, response, state) {
  if (request.headers["x-api-key"] !== state.apiKey) {
    return json(response, 401, { error: "invalid OpenWA API key" });
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/api/health") {
    state.metrics.releaseProbes += 1;
    return json(response, 200, {
      status: "ok",
      timestamp: new Date().toISOString(),
      version: openWaReleaseTag,
    });
  }
  if (request.method === "GET" && url.pathname === "/api/sessions") {
    return json(response, 200, [openWaSession()]);
  }
  const sessionPath = url.pathname.match(/^\/api\/sessions\/([^/]+)$/u);
  if (request.method === "GET" && sessionPath
    && decodeURIComponent(sessionPath[1]) === sessionId) {
    return json(response, 200, openWaSession());
  }
  const groupsPath = url.pathname.match(/^\/api\/sessions\/([^/]+)\/groups$/u);
  if (request.method === "GET" && groupsPath
    && decodeURIComponent(groupsPath[1]) === sessionId) {
    return json(response, 200, []);
  }
  const webhookPath = url.pathname.match(/^\/api\/sessions\/([^/]+)\/webhooks(?:\/([^/]+))?$/u);
  if (!webhookPath || decodeURIComponent(webhookPath[1]) !== sessionId) {
    return json(response, 404, { error: "not found" });
  }
  const webhookId = webhookPath[2] ? decodeURIComponent(webhookPath[2]) : undefined;
  if (request.method === "GET" && !webhookId) {
    return json(response, 200, state.registrations);
  }
  if (request.method === "POST" && !webhookId) {
    const input = await readJsonBody(request);
    assert(input.secret === state.webhookSecret, "Runtime registered the wrong webhook secret");
    const created = {
      id: "packaged-e2e-webhook",
      sessionId,
      url: input.url,
      events: input.events,
      active: true,
      retryCount: input.retryCount,
    };
    state.registrations.push(created);
    return json(response, 201, created);
  }
  if (request.method === "PUT" && webhookId) {
    const input = await readJsonBody(request);
    assert(input.secret === state.webhookSecret, "Runtime updated with the wrong webhook secret");
    const index = state.registrations.findIndex(item => item.id === webhookId);
    if (index < 0) return json(response, 404, { error: "webhook not found" });
    state.registrations[index] = { id: webhookId, sessionId, ...input };
    return json(response, 200, state.registrations[index]);
  }
  if (request.method === "DELETE" && webhookId) {
    const index = state.registrations.findIndex(item => item.id === webhookId);
    if (index >= 0) state.registrations.splice(index, 1);
    response.writeHead(204);
    return response.end();
  }
  return json(response, 405, { error: "method not allowed" });
}

function openWaSession() {
  const timestamp = new Date().toISOString();
  return {
    id: sessionId,
    name: "Packaged E2E session",
    status: "ready",
    phone: null,
    pushName: "WA Studio E2E",
    connectedAt: timestamp,
    lastActive: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastError: null,
    restriction: null,
    engineLoaded: true,
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error("OpenWA stub request body exceeded 64 KiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startEventInbox(openwaBaseUrl, openwaApiKey, masterSecret) {
  const databaseUrl = localDevelopmentDatabaseUrl();
  const schema = `wa_studio_event_inbox_e2e_${process.pid}_${Date.now()}`;
  assert(/^[a-z0-9_]+$/u.test(schema), "Unsafe Event Inbox test schema name");
  const adminPool = new Pool({ connectionString: databaseUrl.toString(), max: 1 });
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const eventInboxDatabaseUrl = new URL(databaseUrl);
  eventInboxDatabaseUrl.searchParams.set("options", `-csearch_path=${schema}`);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const deviceId = randomUUID();
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    EVENT_INBOX_BIND_HOST: "127.0.0.1",
    EVENT_INBOX_PORT: String(port),
    EVENT_INBOX_DATABASE_URL: eventInboxDatabaseUrl.toString(),
    EVENT_INBOX_MASTER_SECRET: masterSecret,
    EVENT_INBOX_PUBLIC_BASE_URL: baseUrl,
    EVENT_INBOX_OPENWA_BASE_URL: openwaBaseUrl,
    EVENT_INBOX_ALLOWED_SESSION_IDS: sessionId,
    EVENT_INBOX_LEASE_SECONDS: "10",
  };
  let child;
  try {
    runRuntimeEntrypoint("event-inbox-migrate.js", environment);
    child = spawn(
      process.execPath,
      [resolve(runtimeRoot, "dist/src/entrypoints/event-inbox.js")],
      { cwd: runtimeRoot, env: environment, stdio: "inherit" },
    );
    await waitForJson(`${baseUrl}/api/v1/health/ready`, value =>
      value.status === "ready" && value.protocolVersion === 2, 30_000);
    const pairing = await pairEventInbox(baseUrl, openwaBaseUrl, openwaApiKey, deviceId);
    return {
      baseUrl,
      deviceId,
      deviceToken: pairing.deviceToken,
      close: async () => {
        await terminateChild(child, "Event Inbox");
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await adminPool.end();
      },
    };
  } catch (error) {
    if (child) await terminateChild(child, "Event Inbox");
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await adminPool.end();
    throw error;
  }
}

async function pairEventInbox(baseUrl, openwaBaseUrl, openwaApiKey, deviceId) {
  const response = await fetch(`${baseUrl}/api/v1/event-inbox/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ openwaBaseUrl, openwaApiKey, deviceId }),
  });
  if (!response.ok) throw new Error(`Event Inbox pairing returned HTTP ${response.status}`);
  const pairing = await response.json();
  assert(pairing.protocolVersion === 2, "Event Inbox pairing protocol drifted");
  return pairing;
}

function runRuntimeEntrypoint(name, environment) {
  const entrypoint = resolve(runtimeRoot, "dist/src/entrypoints", name);
  if (!existsSync(entrypoint)) {
    throw new Error(`Runtime entrypoint does not exist at ${entrypoint}; run npm run build first.`);
  }
  const result = spawnSync(process.execPath, [entrypoint], {
    cwd: runtimeRoot,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed with status ${result.status}.`);
}

function localDevelopmentDatabaseUrl() {
  const explicitlyConfigured = process.env.WA_RUNTIME_E2E_DATABASE_URL;
  const databaseUrl = new URL(requiredTestDatabaseUrl());
  if (!explicitlyConfigured
    && ["postgres", "wa-runtime-postgres"].includes(databaseUrl.hostname)) {
    databaseUrl.hostname = "127.0.0.1";
    databaseUrl.port = process.env.WA_RUNTIME_E2E_DOCKER_POSTGRES_PORT ?? "5433";
  }
  return databaseUrl;
}

function requiredTestDatabaseUrl() {
  const databaseUrl = process.env.WA_RUNTIME_E2E_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "WA_RUNTIME_E2E_DATABASE_URL or DATABASE_URL is required for packaged Runtime E2E.",
    );
  }
  return databaseUrl;
}

async function waitForRuntimeReady(runtimeApiKey) {
  return waitForJson(
    `http://127.0.0.1:${runtimePort}/api/v1/health/ready`,
    value => value.status === "ready"
      && value.processes?.worker === "healthy"
      && value.processes?.scheduler === "healthy",
    180_000,
    { headers: { "x-runtime-key": runtimeApiKey } },
  );
}

async function waitForRuntimeOperational(runtimeApiKey) {
  return waitForJson(
    `http://127.0.0.1:${runtimePort}/api/v1/health/operational`,
    value => value.status === "operational"
      && value.processes?.worker === "healthy"
      && value.processes?.scheduler === "healthy",
    180_000,
    { headers: { "x-runtime-key": runtimeApiKey } },
  );
}

function assertCompleteRuntimeHealth(health) {
  assert(health.dependencies?.postgres === true, "Packaged Runtime PostgreSQL is not ready");
  assert(
    health.dependencies?.queue?.backend === "postgres"
      && health.dependencies.queue.ready === true,
    "Packaged Runtime is not using its PostgreSQL durable queue",
  );
  assert(health.liveSendsEnabled === false, "Packaged E2E unexpectedly enabled live sends");
  assert(
    health.openwaRelease === openWaReleaseTag,
    `Packaged Runtime did not pin OpenWA ${openWaReleaseTag}`,
  );
  assert(health.allowedSessionCount === 1, "Packaged Runtime allowed-session scope drifted");
}

async function requestFullSync(runtimeApiKey) {
  const response = await fetch(
    `http://127.0.0.1:${runtimePort}/api/v1/sessions/${sessionId}/sync`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-runtime-key": runtimeApiKey,
      },
      body: JSON.stringify({ mode: "FULL" }),
    },
  );
  if (response.status !== 202) {
    throw new Error(`Packaged Runtime sync request returned HTTP ${response.status}.`);
  }
  return response.json();
}

async function waitForSyncCompleted(syncRunId, runtimeApiKey) {
  const url = `http://127.0.0.1:${runtimePort}/api/v1/sessions/${sessionId}/sync-runs/${syncRunId}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(url, { headers: { "x-runtime-key": runtimeApiKey } });
    if (!response.ok) throw new Error(`Packaged Runtime sync status returned HTTP ${response.status}.`);
    const run = await response.json();
    if (run.status === "COMPLETED") return run;
    if (run.status === "FAILED") throw new Error(`Packaged Runtime sync failed: ${run.error}`);
    await delay(100);
  }
  throw new Error("Packaged Runtime did not complete its OpenWA compatibility sync.");
}

async function waitForWebhookRegistration(openwa, eventInboxBaseUrl) {
  const expectedUrl = `${eventInboxBaseUrl}/api/v1/webhooks/openwa`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (openwa.requestFailure()) throw openwa.requestFailure();
    const registration = openwa.registrations.find(item => item.url === expectedUrl);
    if (registration) return registration;
    await delay(100);
  }
  throw new Error("Packaged Runtime did not reconcile the OpenWA Event Inbox registration.");
}

function assertWebhookRegistration(registration, eventInboxBaseUrl, webhookSecret) {
  const expectedEvents = [
    "message.received",
    "message.sent",
    "message.ack",
    "message.failed",
    "session.status",
    "session.restriction",
    "group.join",
    "group.leave",
    "group.update",
  ];
  assert(registration.url === `${eventInboxBaseUrl}/api/v1/webhooks/openwa`, "Callback URL drifted");
  assert(registration.active === true, "OpenWA webhook registration is inactive");
  assert(registration.retryCount === 3, "OpenWA webhook retry count drifted");
  assert(
    JSON.stringify(registration.events) === JSON.stringify(expectedEvents),
    "OpenWA webhook event subscription drifted",
  );
  assert(webhookSecret === testWebhookSecret, "Packaged E2E webhook secret drifted");
}

function packagedWebhookEvent() {
  const suffix = `${process.pid}-${Date.now()}`;
  return {
    event: "message.received",
    timestamp: new Date().toISOString(),
    sessionId,
    idempotencyKey: `packaged-e2e-event-${suffix}`,
    deliveryId: `packaged-e2e-delivery-${suffix}`,
    data: {
      id: `packaged-e2e-message-${suffix}`,
      chatId: "120363000000000000@g.us",
      author: "84900000000@c.us",
      body: "packaged Event Inbox E2E",
      type: "chat",
      fromMe: false,
      isGroup: true,
      timestamp: Date.now(),
    },
  };
}

async function postSignedWebhook(eventInboxBaseUrl, webhookSecret, event) {
  const rawBody = JSON.stringify(event);
  const signature = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
  const response = await fetch(`${eventInboxBaseUrl}/api/v1/webhooks/openwa`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openwa-signature": signature,
    },
    body: rawBody,
  });
  if (!response.ok) throw new Error(`Event Inbox webhook returned HTTP ${response.status}.`);
  const body = await response.json();
  assert(body.accepted === true, "Event Inbox did not accept the packaged E2E webhook");
}

async function waitForEventInboxDrain(eventInboxBaseUrl) {
  return waitForJson(
    `${eventInboxBaseUrl}/api/v1/health/ready`,
    value => value.status === "ready"
      && value.pendingEvents === 0
      && value.storedBytes === 0,
    30_000,
  );
}

async function assertLocalWebhookCommitted(event, expectedCount) {
  const pidFile = resolve(managedPostgresRoot, "data-v17/postmaster.pid");
  const lines = readFileSync(pidFile, "utf8").split(/\r?\n/u);
  const port = Number(lines[3]);
  assert(Number.isInteger(port) && port > 0, "Managed PostgreSQL did not publish its port");
  const pool = new Pool({
    host: "127.0.0.1",
    port,
    user: "postgres",
    password: managedPostgresPassword,
    database: "wa_runtime",
    max: 1,
  });
  try {
    const result = await pool.query(
      `SELECT payload, processing_state
       FROM webhook_events
       WHERE idempotency_key = $1`,
      [event.idempotencyKey],
    );
    assert(result.rowCount === expectedCount, "Local Runtime webhook deduplication failed");
    assert(result.rows[0]?.payload?.deliveryId === event.deliveryId, "Local Runtime changed webhook bytes");
    assert(result.rows[0]?.payload?.sessionId === event.sessionId, "Local Runtime changed session scope");
  } finally {
    await pool.end();
  }
}

async function waitForJson(url, predicate, timeoutMs, init = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const value = await response.json();
        if (predicate(value)) return value;
      } else {
        lastError = new Error(`${url} returned HTTP ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}.`, { cause: lastError });
}

async function availablePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a TCP port.");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

function parseRuntimePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("WA_RUNTIME_E2E_PORT must be an integer between 1 and 65535.");
  }
  return parsed;
}

async function assertPortAvailable(port, label) {
  const server = createNetServer();
  server.listen(port, "127.0.0.1");
  try {
    await Promise.race([
      once(server, "listening"),
      once(server, "error").then(([error]) => Promise.reject(error)),
    ]);
  } catch (error) {
    throw new Error(`TCP port ${port} for ${label} is already in use.`, { cause: error });
  } finally {
    if (server.listening) {
      server.close();
      await once(server, "close");
    }
  }
}

function prepareManagedPostgresRoot() {
  const leaks = packagedProcesses();
  if (leaks.length > 0) {
    throw new Error(`Refusing to reset managed E2E data while processes are alive:\n${leaks.join("\n")}`);
  }
  cleanManagedPostgresData();
}

function cleanManagedPostgresData() {
  // Remove the installation cache too: every one-shot run must prove that PostgreSQL can be
  // extracted from the bundled archive without relying on a previous developer machine install.
  rmSync(managedPostgresRoot, { recursive: true, force: true });
  rmSync(managedBackupRoot, { recursive: true, force: true });
}

function nativeQuitStudio() {
  if (process.platform !== "darwin") {
    throw new Error("Packaged native quit verification is currently implemented for macOS only.");
  }
  const attempts = [
    'tell application id "dev.hiepknor.wastudio" to quit',
    'tell application "WA Studio" to quit',
  ];
  for (const script of attempts) {
    const result = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
    if (!result.error && result.status === 0) return;
  }
  throw new Error("Could not ask the packaged WA Studio application to quit natively.");
}

async function waitForChildExit(child, timeoutMs, message) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timeout;
  try {
    await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function terminateChild(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForChildExit(child, 10_000, `${label} ignored SIGTERM`);
  } catch {
    child.kill("SIGKILL");
    await waitForChildExit(child, 5_000, `${label} ignored SIGKILL`);
  }
}

function packagedProcesses() {
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Could not inspect packaged Runtime processes.");
  const packagedRuntimePrefix = resolve(dirname(appBinary), "wa-runtime");
  return result.stdout
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line =>
      line.includes(appBinary)
      || line.includes(packagedRuntimePrefix)
      || line.includes(managedPostgresRoot));
}

async function waitForNoPackagedProcesses() {
  const deadline = Date.now() + 15_000;
  let leaks = [];
  while (Date.now() < deadline) {
    leaks = packagedProcesses();
    if (leaks.length === 0) return;
    await delay(100);
  }
  throw new Error(`Packaged app leaked managed processes:\n${leaks.join("\n")}`);
}

async function stopOrphanedManagedPostgres() {
  const pidFile = resolve(managedPostgresRoot, "data-v17/postmaster.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").split(/\r?\n/u)[0]);
  if (!Number.isInteger(pid) || pid <= 1) return;
  const owned = packagedProcesses().some(line =>
    line.startsWith(`${pid} `) && line.includes(managedPostgresRoot));
  if (!owned) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await delay(100);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
  }
  throw new Error(`Orphaned managed PostgreSQL process ${pid} did not stop.`);
}

const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
