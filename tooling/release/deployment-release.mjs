import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readProductionAcceptancePolicy } from "./production-acceptance.mjs";

const defaultWorkspaceRoot = resolve(import.meta.dirname, "../..");
const digestPattern = /^[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;

function required(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
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

function validateRepository(value) {
  const repository = required(value, "GitHub repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GitHub repository must use the owner/name format.");
  }
  return repository;
}

function readConnectorArtifact(directory, version) {
  const expectedName = `wa-studio-connector-${version}.zip`;
  const zipNames = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".zip"))
    .map(entry => entry.name);
  if (zipNames.length !== 1 || zipNames[0] !== expectedName) {
    throw new Error(`Connector directory must contain exactly ${expectedName}.`);
  }
  const artifactPath = resolve(directory, expectedName);
  const checksumPath = `${artifactPath}.sha256`;
  if (!statSync(artifactPath).isFile() || !statSync(checksumPath).isFile()) {
    throw new Error("Connector artifact or checksum is missing.");
  }
  const digest = sha256(artifactPath);
  const checksum = readFileSync(checksumPath, "utf8").trim();
  if (checksum !== `${digest}  ${expectedName}`) {
    throw new Error("Connector checksum does not match the packaged artifact.");
  }
  return { name: expectedName, sha256: digest };
}

function readEventInboxImage(path, repository) {
  const image = required(readFileSync(path, "utf8"), "Event Inbox image reference");
  const owner = repository.split("/")[0].toLowerCase();
  const match = image.match(/^ghcr\.io\/([a-z0-9_.-]+)\/wa-event-inbox@sha256:([0-9a-f]{64})$/u);
  if (!match || match[1] !== owner) {
    throw new Error("Event Inbox image must be the repository owner's immutable GHCR digest.");
  }
  return { reference: image, sha256: match[2] };
}

function readDesktopRelease(directory, repository, tag, version) {
  const checksumsPath = resolve(directory, "release-checksums.txt");
  const assetsPath = resolve(directory, "release-assets.json");
  const assets = readJson(assetsPath, "Desktop release assets");
  if (assets.schemaVersion !== 1
    || assets.repository !== repository
    || assets.tag !== tag
    || assets.version !== version) {
    throw new Error("Desktop release assets do not match the coordinated release.");
  }
  if (!statSync(checksumsPath).isFile() || readFileSync(checksumsPath).length === 0) {
    throw new Error("Desktop release checksums are missing or empty.");
  }
  return {
    releaseAssetsSha256: sha256(assetsPath),
    releaseChecksumsSha256: sha256(checksumsPath),
  };
}

function readMigrationHead(workspaceRoot) {
  const directory = resolve(workspaceRoot, "services/runtime/event-inbox-migrations");
  const migrations = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".sql"))
    .map(entry => entry.name)
    .sort();
  if (migrations.length === 0) throw new Error("Event Inbox migrations are missing.");
  if (migrations.some(name => !/^\d{3}_[a-z0-9_]+\.sql$/u.test(name))) {
    throw new Error("Every Event Inbox migration must use a three-digit ordered filename.");
  }
  const ordinals = migrations.map(name => name.slice(0, 3));
  if (new Set(ordinals).size !== ordinals.length) {
    throw new Error("Event Inbox migration ordinals must be unique.");
  }
  const name = migrations.at(-1);
  const setHash = createHash("sha256");
  for (const migration of migrations) {
    setHash.update(migration);
    setHash.update("\0");
    setHash.update(readFileSync(resolve(directory, migration)));
    setHash.update("\0");
  }
  return {
    name,
    count: migrations.length,
    sha256: sha256(resolve(directory, name)),
    setSha256: setHash.digest("hex"),
  };
}

function expectedManifest({
  workspaceRoot,
  repository,
  tag,
  gitCommit,
  imageMetadataPath,
  connectorDirectory,
  updaterDirectory,
}) {
  const components = readJson(
    resolve(workspaceRoot, "release/components.json"),
    "Release components",
  );
  const connectorManifest = readJson(
    resolve(workspaceRoot, "packages/openwa-connector-plugin/manifest.json"),
    "Connector manifest",
  );
  const normalizedRepository = validateRepository(repository);
  const normalizedTag = required(tag, "Release tag");
  const normalizedCommit = required(gitCommit, "Release commit");
  if (components.schemaVersion !== 4 || components.product !== "wa-studio") {
    throw new Error("Release component schema is incompatible.");
  }
  if (!["canary", "stable"].includes(components.releaseChannel)) {
    throw new Error("Release channel must be canary or stable.");
  }
  if (normalizedTag !== `v${components.studioVersion}`) {
    throw new Error(`Release tag must be v${components.studioVersion}.`);
  }
  if (!commitPattern.test(normalizedCommit)) {
    throw new Error("Release commit must be a lowercase 40-character Git object ID.");
  }
  if (connectorManifest.id !== "wa-studio-connector"
    || connectorManifest.version !== components.connectorPluginVersion
    || connectorManifest.waStudioProtocolVersion !== components.connectorProtocolVersion
    || connectorManifest.waStudioJournalSchemaVersion !== components.connectorJournalSchemaVersion) {
    throw new Error("Connector manifest does not match release components.");
  }
  const image = readEventInboxImage(imageMetadataPath, normalizedRepository);
  const artifact = readConnectorArtifact(
    connectorDirectory,
    components.connectorPluginVersion,
  );
  const migrationHead = readMigrationHead(workspaceRoot);
  const commonDigests = [
    image.sha256,
    artifact.sha256,
    migrationHead.sha256,
    migrationHead.setSha256,
    components.openwaContractSha256,
  ];
  if (!commonDigests.every(value => digestPattern.test(value))) {
    throw new Error("A server component digest is invalid.");
  }
  const manifest = {
    schemaVersion: 1,
    product: components.product,
    releaseScope: updaterDirectory ? "product" : "server-candidate",
    releaseChannel: components.releaseChannel,
    repository: normalizedRepository,
    tag: normalizedTag,
    gitCommit: normalizedCommit,
    components: {
      runtime: {
        service: components.runtimeService,
        version: components.runtimeVersion,
        contractVersion: components.runtimeContractVersion,
      },
      eventInbox: {
        image: image.reference,
        imageDigest: `sha256:${image.sha256}`,
        migrationHead,
      },
      connector: {
        id: connectorManifest.id,
        version: components.connectorPluginVersion,
        protocolVersion: components.connectorProtocolVersion,
        journalSchemaVersion: components.connectorJournalSchemaVersion,
        artifact,
      },
      openwa: {
        releaseTag: components.openwaReleaseTag,
        contractSha256: components.openwaContractSha256,
      },
    },
  };
  if (!updaterDirectory) return manifest;

  const acceptancePolicy = readProductionAcceptancePolicy(
    resolve(workspaceRoot, "release/production-acceptance-policy.json"),
  );
  const desktop = readDesktopRelease(
    updaterDirectory,
    normalizedRepository,
    normalizedTag,
    components.studioVersion,
  );
  if (![desktop.releaseAssetsSha256, desktop.releaseChecksumsSha256]
    .every(value => digestPattern.test(value))) {
    throw new Error("A desktop component digest is invalid.");
  }
  return {
    ...manifest,
    components: {
      studio: { version: components.studioVersion, ...desktop },
      acceptance: {
        policyVersion: acceptancePolicy.identity.version,
        policySha256: acceptancePolicy.identity.sha256,
      },
      ...manifest.components,
    },
  };
}

export function createDeploymentManifest(options) {
  const manifest = expectedManifest({
    workspaceRoot: options.workspaceRoot ?? defaultWorkspaceRoot,
    ...options,
  });
  const outputPath = resolve(required(options.outputPath, "Deployment manifest output path"));
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifest;
}

export function verifyDeploymentManifest(options) {
  const expected = expectedManifest({
    workspaceRoot: options.workspaceRoot ?? defaultWorkspaceRoot,
    ...options,
  });
  const actual = readJson(
    resolve(required(options.manifestPath, "Deployment manifest path")),
    "Deployment manifest",
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Deployment manifest does not match coordinated release inputs.");
  }
  return actual;
}

export function createServerDeploymentManifest(options) {
  return createDeploymentManifest({ ...options, updaterDirectory: undefined });
}

export function verifyServerDeploymentManifest(options) {
  return verifyDeploymentManifest({ ...options, updaterDirectory: undefined });
}

function parseArguments(argv) {
  const [command, ...values] = argv;
  if (!["create", "verify", "create-server", "verify-server"].includes(command)) {
    throw new Error(
      "Usage: deployment-release.mjs <create|verify|create-server|verify-server> --repository ...",
    );
  }
  const create = ["create", "create-server"].includes(command);
  const server = ["create-server", "verify-server"].includes(command);
  const options = {};
  const names = new Map([
    ["--repository", "repository"],
    ["--tag", "tag"],
    ["--git-commit", "gitCommit"],
    ["--image-file", "imageMetadataPath"],
    ["--connector-directory", "connectorDirectory"],
    ...(server ? [] : [["--updater-directory", "updaterDirectory"]]),
    [create ? "--output" : "--manifest", create ? "outputPath" : "manifestPath"],
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const key = names.get(values[index]);
    const value = values[index + 1];
    if (!key || value === undefined || value.startsWith("--") || options[key] !== undefined) {
      throw new Error(`Invalid deployment manifest argument: ${values[index] ?? "<missing>"}.`);
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== names.size) {
    throw new Error("Deployment manifest arguments are incomplete.");
  }
  return { command, create, server, options };
}

function main() {
  const { create, server, options } = parseArguments(process.argv.slice(2));
  const manifest = create
    ? (server ? createServerDeploymentManifest(options) : createDeploymentManifest(options))
    : (server ? verifyServerDeploymentManifest(options) : verifyDeploymentManifest(options));
  process.stdout.write(
    `${create ? "Created" : "Verified"} ${server ? "server candidate" : "coordinated"} deployment manifest for ${manifest.tag}.\n`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) main();
