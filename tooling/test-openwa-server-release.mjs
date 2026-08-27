import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  openWAServerReleaseStatus,
  promoteOpenWAServerRelease,
  renderGeneratedOpenWARelease,
  syncOpenWAServerRelease,
  verifyOpenWAServerRelease,
} from "./openwa-server-release.mjs";

const currentTag = "0.22.0";
const observedTag = "0.23.3";
const currentContract = contract(currentTag);
const observedContract = contract(observedTag);

function contract(version) {
  return Buffer.from(`${JSON.stringify({
    openapi: "3.0.0",
    info: { version },
    paths: { "/api/health": { get: {} } },
    components: { schemas: { Health: { type: "object" } } },
  }, null, 2)}\n`);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "wa-studio-openwa-server-release-"));
  const metadata = {
    releaseTag: currentTag,
    contractSha256: digest(currentContract),
  };
  mkdirSync(resolve(root, `services/runtime/contracts/openwa/${currentTag}`), { recursive: true });
  mkdirSync(resolve(root, "services/runtime/src/contracts/release"), { recursive: true });
  mkdirSync(resolve(root, "services/runtime/test/unit"), { recursive: true });
  mkdirSync(resolve(root, "release"), { recursive: true });
  writeFileSync(
    resolve(root, `services/runtime/contracts/openwa/${currentTag}/openapi.json`),
    currentContract,
  );
  writeFileSync(
    resolve(root, "services/runtime/src/contracts/release/openwa-release.generated.ts"),
    renderGeneratedOpenWARelease(metadata),
  );
  writeFileSync(
    resolve(root, "services/runtime/test/unit/openwa-contract-upgrade.spec.ts"),
    `const REVIEWED_OPENWA_RELEASE = '${currentTag}' as const;\n`,
  );
  writeFileSync(
    resolve(root, "release/components.json"),
    `${JSON.stringify({
      schemaVersion: 3,
      product: "wa-studio",
      runtimeService: "wa-runtime",
      studioVersion: "0.2.0",
      runtimeVersion: "0.1.0",
      runtimeContractVersion: "v1",
      openwaReleaseTag: currentTag,
      openwaContractSha256: metadata.contractSha256,
    }, null, 2)}\n`,
  );
  return root;
}

function serverFetch(version = observedTag) {
  return async (input, init) => {
    assert.equal(init.headers["x-api-key"], "server-secret");
    const url = new URL(input);
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ status: "ok", version }), { status: 200 });
    }
    if (url.pathname === "/api/docs-json") {
      return new Response(observedContract, {
        status: 200,
        headers: { "content-length": String(observedContract.byteLength) },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

const root = fixture();
try {
  assert.equal(verifyOpenWAServerRelease({ workspaceRoot: root }).releaseTag, currentTag);
  const status = await openWAServerReleaseStatus({
    workspaceRoot: root,
    baseUrl: "https://openwa.example.test",
    apiKey: "server-secret",
    fetchImpl: serverFetch(),
  });
  assert.deepEqual(status, {
    origin: "https://openwa.example.test",
    status: "upgrade_available",
    pinnedTag: currentTag,
    observedTag,
  });

  const synchronized = await syncOpenWAServerRelease({
    workspaceRoot: root,
    baseUrl: "https://openwa.example.test",
    apiKey: "server-secret",
    fetchImpl: serverFetch(),
  });
  assert.equal(synchronized.releaseTag, observedTag);
  assert.equal(synchronized.contractSha256, digest(observedContract));
  assert.equal(
    readFileSync(resolve(root, `services/runtime/contracts/openwa/${observedTag}/openapi.json`), "utf8"),
    observedContract.toString("utf8"),
  );
  assert.equal(
    verifyOpenWAServerRelease({ workspaceRoot: root }).releaseTag,
    currentTag,
    "staging a server contract must not advance the reviewed runtime pin",
  );
  await assert.rejects(
    promoteOpenWAServerRelease({
      workspaceRoot: root,
      baseUrl: "https://openwa.example.test",
      apiKey: "server-secret",
      fetchImpl: serverFetch(),
    }),
    /adapter contract review is approved/u,
  );

  writeFileSync(
    resolve(root, "services/runtime/test/unit/openwa-contract-upgrade.spec.ts"),
    `const REVIEWED_OPENWA_RELEASE = '${observedTag}' as const;\n`,
  );
  const promoted = await promoteOpenWAServerRelease({
    workspaceRoot: root,
    baseUrl: "https://openwa.example.test",
    apiKey: "server-secret",
    fetchImpl: serverFetch(),
  });
  assert.equal(promoted.releaseTag, observedTag);
  assert.equal(verifyOpenWAServerRelease({ workspaceRoot: root }).releaseTag, observedTag);

  await assert.rejects(
    openWAServerReleaseStatus({
      workspaceRoot: root,
      baseUrl: "http://openwa.example.test",
      apiKey: "server-secret",
      fetchImpl: serverFetch(),
    }),
    /must use HTTPS/u,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
  "OpenWA server release synchronization test passed: live health discovery, exact server contract staging, reviewed promotion and generated pins are enforced.\n",
);
