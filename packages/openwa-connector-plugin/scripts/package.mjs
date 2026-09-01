import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { zipStore } from './zip-store.mjs';

const root = resolve(import.meta.dirname, '..');
const workspaceRoot = resolve(root, '..', '..');
const manifest = readJson(resolve(root, 'manifest.json'));
const packageJson = readJson(resolve(root, 'package.json'));
const components = readJson(resolve(workspaceRoot, 'release/components.json'));
const commandSchema = readJson(resolve(
  workspaceRoot,
  'packages/runtime-contract/openwa-connector/v1/command.schema.json',
));

assert.equal(manifest.id, 'wa-studio-connector');
assert.equal(manifest.type, 'extension');
assert.equal(manifest.main, 'dist/index.js');
assert.equal(manifest.version, packageJson.version);
assert.equal(manifest.sdkVersion, '1');
assert.equal(manifest.minOpenWAVersion, components.openwaReleaseTag);
assert.equal(manifest.testedOpenWAVersion, components.openwaReleaseTag);
assert.equal(manifest.waStudioProtocolVersion, 1);
assert.equal(manifest.waStudioJournalSchemaVersion, 1);
assert.match(commandSchema.$id, /\/openwa-connector\/v1\/command\.schema\.json$/u);
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
assert.match(changelog, new RegExp(`^## \\[${escapeRegex(manifest.version)}\\]`, 'mu'));

const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: resolve(dist, 'index.js'),
  define: { __PLUGIN_VERSION__: JSON.stringify(manifest.version) },
  logLevel: 'warning',
});
await writeFile(resolve(dist, 'package.json'), `${JSON.stringify({ type: 'commonjs' })}\n`);

const loaded = createRequire(import.meta.url)(resolve(dist, 'index.js'));
assert.equal(typeof (loaded.default ?? loaded), 'function', 'plugin bundle must export a constructable default class');

if (process.argv.includes('--bundle-only')) {
  process.stdout.write(`Built WA Studio connector v${manifest.version}.\n`);
  process.exit(0);
}

const files = [
  { name: 'manifest.json', data: readFileSync(resolve(root, 'manifest.json')) },
  { name: 'dist/index.js', data: readFileSync(resolve(dist, 'index.js')) },
  { name: 'dist/package.json', data: readFileSync(resolve(dist, 'package.json')) },
];
assert(files.length <= 200, 'plugin package exceeds OpenWA 200-member limit');
const zip = zipStore(files);
assert(zip.length <= 5 * 1024 * 1024, 'plugin package exceeds OpenWA 5 MiB compressed limit');
const artifactDirectory = resolve(root, 'build');
await mkdir(artifactDirectory, { recursive: true });
const basename = `wa-studio-connector-${manifest.version}.zip`;
const artifact = resolve(artifactDirectory, basename);
const digest = createHash('sha256').update(zip).digest('hex');
await writeFile(artifact, zip);
await writeFile(`${artifact}.sha256`, `${digest}  ${basename}\n`);
process.stdout.write(`Packaged ${basename} (${zip.length} bytes)\nsha256 ${digest}\n`);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
