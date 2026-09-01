import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";

import { verifyEventInboxCandidate } from "./verify-event-inbox-candidate.mjs";

const image = `ghcr.io/hiepknor/wa-event-inbox@sha256:${"a".repeat(64)}`;
const manifest = {
  schemaVersion: 1,
  product: "wa-studio",
  tag: "v0.2.0",
  gitCommit: "b".repeat(40),
  components: {
    runtime: { version: "0.1.0" },
    eventInbox: {
      image,
      imageDigest: `sha256:${"a".repeat(64)}`,
      migrationHead: { name: "011_legacy_primary_compatibility.sql", count: 11 },
    },
    connector: { protocolVersion: 1, journalSchemaVersion: 1 },
    openwa: { releaseTag: "0.23.3" },
  },
};
const readiness = {
  status: "ready",
  service: "wa-event-inbox",
  protocolVersion: 2,
  migrationHead: "011_legacy_primary_compatibility.sql",
  migrationCount: 11,
  webhookAdmission: {
    available: true,
    eventSlotsRemaining: 499_999,
    byteHeadroom: 2_147_483_648,
    requiredByteHeadroom: 262_215,
  },
  release: {
    runtimeVersion: "0.1.0",
    openwaReleaseTag: "0.23.3",
    connectorProtocolVersion: 1,
    connectorJournalSchemaVersion: 1,
    migrationHead: "011_legacy_primary_compatibility.sql",
    migrationCount: 11,
  },
};

assert.deepEqual(verifyEventInboxCandidate({
  manifest,
  readiness,
  observedImage: image,
  readinessOrigin: "http://127.0.0.1:34201",
}), {
  status: "verified",
  tag: "v0.2.0",
  gitCommit: "b".repeat(40),
  readinessOrigin: "http://127.0.0.1:34201",
  image,
  runtimeVersion: "0.1.0",
  openwaReleaseTag: "0.23.3",
  connectorProtocolVersion: 1,
  connectorJournalSchemaVersion: 1,
  migrationHead: "011_legacy_primary_compatibility.sql",
  migrationCount: 11,
});

for (const [label, input, pattern] of [
  ["image", { observedImage: image.replace(/a$/u, "b") }, /Container image/u],
  ["runtime", { readiness: {
    ...readiness,
    release: { ...readiness.release, runtimeVersion: "0.0.9" },
  } }, /Runtime version/u],
  ["migration", { readiness: { ...readiness, migrationCount: 10 } }, /migration count/u],
  ["protocol", { readiness: {
    ...readiness,
    release: { ...readiness.release, connectorProtocolVersion: 2 },
  } }, /Connector protocol/u],
  ["admission", { readiness: {
    ...readiness,
    status: "not_ready",
    webhookAdmission: { ...readiness.webhookAdmission, available: false },
  } }, /readiness status/u],
  ["admission headroom", { readiness: {
    ...readiness,
    webhookAdmission: { ...readiness.webhookAdmission, byteHeadroom: 1 },
  } }, /admission headroom/u],
]) {
  assert.throws(
    () => verifyEventInboxCandidate({
      manifest,
      readiness,
      observedImage: image,
      readinessOrigin: "http://127.0.0.1:34201",
      ...input,
    }),
    pattern,
    label,
  );
}

const probeRoot = mkdtempSync(resolve(tmpdir(), "wa-event-inbox-candidate-verifier-"));
const server = createServer((request, response) => {
  if (request.url !== "/api/v1/health/ready") {
    response.writeHead(404).end();
    return;
  }
  const body = JSON.stringify(readiness);
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  });
  response.end(body);
});
try {
  const docker = resolve(probeRoot, "docker");
  const containerId = "c".repeat(64);
  const containerStartedAt = "2026-09-01T00:00:00.000Z";
  writeFileSync(docker, `#!/usr/bin/env node
if (process.argv[2] !== "inspect" || !process.argv[3].startsWith("--format={{.Id}}")) process.exit(2);
process.stdout.write(${JSON.stringify(`${containerId}\t${image}\ttrue\t${containerStartedAt}\n`)});
`);
  chmodSync(docker, 0o700);
  const manifestPath = resolve(probeRoot, "wa-studio-deployment.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const execute = promisify(execFile);
  const result = await execute(process.execPath, [
    resolve(import.meta.dirname, "verify-event-inbox-candidate.mjs"),
    "--manifest", manifestPath,
    "--readiness-url", `http://127.0.0.1:${address.port}`,
    "--container", "wa-event-inbox-canary-1",
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${probeRoot}:${process.env.PATH ?? ""}` },
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "verified",
    tag: manifest.tag,
    gitCommit: manifest.gitCommit,
    readinessOrigin: `http://127.0.0.1:${address.port}`,
    image,
    runtimeVersion: "0.1.0",
    openwaReleaseTag: "0.23.3",
    connectorProtocolVersion: 1,
    connectorJournalSchemaVersion: 1,
    migrationHead: "011_legacy_primary_compatibility.sql",
    migrationCount: 11,
    containerId,
    containerStartedAt,
  });
} finally {
  server.close();
  await once(server, "close");
  rmSync(probeRoot, { recursive: true, force: true });
}

process.stdout.write(
  "Event Inbox candidate verifier test passed: container, process and migration identity fail closed.\n",
);
