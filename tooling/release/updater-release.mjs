import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const studioRoot = resolve(workspaceRoot, "apps/studio");
const defaultBundleRoot = resolve(studioRoot, "src-tauri/target/release/bundle");
const defaultOutputRoot = resolve(workspaceRoot, "dist/updater-release");
const releaseMetadataFile = "release-assets.json";
const checksumFile = "release-checksums.txt";

function required(value, label) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function validateRepository(repository) {
  const normalized = required(repository, "GitHub repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalized)) {
    throw new Error("GitHub repository must use the owner/name format.");
  }
  return normalized;
}

export function canonicalUpdaterEndpoint(repository) {
  return `https://github.com/${validateRepository(repository)}/releases/latest/download/latest.json`;
}

function releaseDownloadUrl(repository, tag, assetName) {
  return `https://github.com/${validateRepository(repository)}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

function findSingleFile(directory, predicate, label) {
  const matches = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && predicate(entry.name))
    .map(entry => resolve(directory, entry.name));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} in ${directory}; found ${matches.length}.`);
  }
  return matches[0];
}

function assertNonemptyFile(path, label) {
  if (!statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`${label} is missing or empty: ${path}`);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function expectedAssetNames(version, target) {
  const architecture = target.split("-").at(-1);
  return {
    updater: `WA-Studio_${version}_${architecture}.app.tar.gz`,
    signature: `WA-Studio_${version}_${architecture}.app.tar.gz.sig`,
    installer: `WA-Studio_${version}_${architecture}.dmg`,
    sbom: `WA-Studio_${version}_sbom.spdx.json`,
    manifest: "latest.json",
    checksums: checksumFile,
    metadata: releaseMetadataFile,
  };
}

export function createUpdaterManifest({
  version,
  repository,
  tag,
  target,
  updaterAssetName,
  signature,
  publishedAt,
  notes,
}) {
  const date = new Date(required(publishedAt, "Release publication date"));
  if (Number.isNaN(date.getTime())) {
    throw new Error("Release publication date must be a valid RFC 3339 timestamp.");
  }
  return {
    version: required(version, "Studio version"),
    notes: notes?.trim() || `WA Studio ${version}`,
    pub_date: date.toISOString(),
    platforms: {
      [required(target, "Updater target")]: {
        signature: required(signature, "Updater signature"),
        url: releaseDownloadUrl(repository, tag, updaterAssetName),
      },
    },
  };
}

export function stageUpdaterRelease({
  bundleRoot = defaultBundleRoot,
  outputRoot = defaultOutputRoot,
  packagePath = resolve(studioRoot, "package.json"),
  sbomPath,
  repository,
  tag,
  target = "darwin-aarch64",
  publishedAt = new Date().toISOString(),
  notes,
}) {
  const version = required(readJson(packagePath, "Studio package").version, "Studio version");
  const normalizedTag = required(tag, "Release tag");
  if (normalizedTag !== `v${version}`) {
    throw new Error(`Release tag ${normalizedTag} does not match Studio version v${version}.`);
  }
  const normalizedRepository = validateRepository(repository);
  if (target !== "darwin-aarch64") {
    throw new Error(`Unsupported updater target: ${target}.`);
  }

  mkdirSync(outputRoot, { recursive: true });
  const existing = readdirSync(outputRoot);
  if (existing.length > 0) {
    throw new Error(`Updater release staging directory must be empty: ${outputRoot}`);
  }

  const sourceUpdater = findSingleFile(
    resolve(bundleRoot, "macos"),
    name => name.endsWith(".app.tar.gz"),
    "macOS updater archive",
  );
  const sourceSignature = `${sourceUpdater}.sig`;
  const sourceInstaller = findSingleFile(
    resolve(bundleRoot, "dmg"),
    name => name.endsWith(".dmg"),
    "macOS DMG installer",
  );
  assertNonemptyFile(sourceUpdater, "Updater archive");
  assertNonemptyFile(sourceSignature, "Updater signature");
  assertNonemptyFile(sourceInstaller, "DMG installer");
  const sourceSbom = resolve(required(sbomPath, "Desktop SBOM path"));
  assertNonemptyFile(sourceSbom, "Desktop SBOM");
  const sbom = readJson(sourceSbom, "Desktop SBOM");
  if (sbom.spdxVersion !== "SPDX-2.3"
    || sbom.SPDXID !== "SPDXRef-DOCUMENT"
    || !Array.isArray(sbom.packages)
    || sbom.packages.length === 0) {
    throw new Error("Desktop SBOM must be a non-empty SPDX 2.3 document.");
  }

  const names = expectedAssetNames(version, target);
  for (const [source, name] of [
    [sourceUpdater, names.updater],
    [sourceSignature, names.signature],
    [sourceInstaller, names.installer],
    [sourceSbom, names.sbom],
  ]) {
    copyFileSync(source, resolve(outputRoot, name));
  }

  const signature = readFileSync(resolve(outputRoot, names.signature), "utf8").trim();
  const manifest = createUpdaterManifest({
    version,
    repository: normalizedRepository,
    tag: normalizedTag,
    target,
    updaterAssetName: names.updater,
    signature,
    publishedAt,
    notes,
  });
  writeFileSync(resolve(outputRoot, names.manifest), `${JSON.stringify(manifest, null, 2)}\n`);

  const checksummedNames = [
    names.updater,
    names.signature,
    names.installer,
    names.sbom,
    names.manifest,
  ];
  const checksums = checksummedNames
    .map(name => `${sha256(resolve(outputRoot, name))}  ${name}`)
    .join("\n");
  writeFileSync(resolve(outputRoot, names.checksums), `${checksums}\n`);

  const metadata = {
    schemaVersion: 1,
    repository: normalizedRepository,
    tag: normalizedTag,
    version,
    target,
    assets: names,
  };
  writeFileSync(resolve(outputRoot, names.metadata), `${JSON.stringify(metadata, null, 2)}\n`);
  verifyUpdaterRelease({ directory: outputRoot, repository: normalizedRepository, tag: normalizedTag });
  return metadata;
}

export function verifyUpdaterRelease({ directory, repository, tag }) {
  const normalizedRepository = validateRepository(repository);
  const normalizedTag = required(tag, "Release tag");
  const metadata = readJson(resolve(directory, releaseMetadataFile), "Release metadata");
  if (metadata.schemaVersion !== 1
    || metadata.repository !== normalizedRepository
    || metadata.tag !== normalizedTag
    || metadata.tag !== `v${metadata.version}`
    || metadata.target !== "darwin-aarch64") {
    throw new Error("Updater release metadata does not match the requested release.");
  }

  const expectedNames = expectedAssetNames(metadata.version, metadata.target);
  if (JSON.stringify(metadata.assets) !== JSON.stringify(expectedNames)) {
    throw new Error("Updater release metadata contains unexpected asset names.");
  }
  const allowedNames = new Set(Object.values(expectedNames));
  const stagedNames = readdirSync(directory);
  if (stagedNames.length !== allowedNames.size
    || stagedNames.some(name => !allowedNames.has(name))) {
    throw new Error("Updater release staging directory contains missing or unexpected assets.");
  }
  for (const name of allowedNames) {
    assertNonemptyFile(resolve(directory, name), `Release asset ${name}`);
  }

  const manifest = readJson(resolve(directory, expectedNames.manifest), "Updater manifest");
  const sbom = readJson(resolve(directory, expectedNames.sbom), "Desktop SBOM");
  if (sbom.spdxVersion !== "SPDX-2.3"
    || sbom.SPDXID !== "SPDXRef-DOCUMENT"
    || !Array.isArray(sbom.packages)
    || sbom.packages.length === 0) {
    throw new Error("Desktop SBOM must be a non-empty SPDX 2.3 document.");
  }
  const signature = readFileSync(resolve(directory, expectedNames.signature), "utf8").trim();
  const platform = manifest.platforms?.[metadata.target];
  if (manifest.version !== metadata.version
    || !platform
    || platform.signature !== signature
    || platform.url !== releaseDownloadUrl(
      normalizedRepository,
      normalizedTag,
      expectedNames.updater,
    )) {
    throw new Error("Updater manifest does not match the staged signed archive.");
  }
  if (Number.isNaN(new Date(manifest.pub_date).getTime())) {
    throw new Error("Updater manifest publication date is invalid.");
  }

  const expectedChecksums = [
    expectedNames.updater,
    expectedNames.signature,
    expectedNames.installer,
    expectedNames.sbom,
    expectedNames.manifest,
  ].map(name => `${sha256(resolve(directory, name))}  ${name}`).join("\n");
  if (readFileSync(resolve(directory, expectedNames.checksums), "utf8").trim() !== expectedChecksums) {
    throw new Error("Updater release checksums do not match the staged assets.");
  }
  return metadata;
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const command = process.argv[2];
  const options = {
    directory: resolve(argument("directory") ?? defaultOutputRoot),
    repository: argument("repository") ?? process.env.GITHUB_REPOSITORY,
    tag: argument("tag") ?? process.env.GITHUB_REF_NAME,
  };
  if (command === "stage") {
    const metadata = stageUpdaterRelease({
      bundleRoot: resolve(argument("bundle-root") ?? defaultBundleRoot),
      outputRoot: options.directory,
      sbomPath: argument("sbom"),
      repository: options.repository,
      tag: options.tag,
      target: argument("target") ?? "darwin-aarch64",
      publishedAt: argument("published-at") ?? new Date().toISOString(),
      notes: argument("notes"),
    });
    process.stdout.write(`Staged signed updater release ${metadata.tag}.\n`);
    return;
  }
  if (command === "verify") {
    const metadata = verifyUpdaterRelease(options);
    process.stdout.write(`Verified signed updater release ${metadata.tag}.\n`);
    return;
  }
  throw new Error("Usage: updater-release.mjs <stage|verify> [options]");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) main();
