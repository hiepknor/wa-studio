import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const read = relativePath => readFileSync(resolve(repositoryRoot, relativePath), "utf8");
const workflowDirectory = resolve(repositoryRoot, ".github/workflows");

const workflowFiles = readdirSync(workflowDirectory, { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.ya?ml$/u.test(entry.name))
  .map(entry => `.github/workflows/${entry.name}`)
  .sort();

const unpinnedActions = [];
for (const workflowPath of workflowFiles) {
  const workflow = read(workflowPath);
  for (const match of workflow.matchAll(/^\s*(?:-\s*)?uses:\s*["']?([^"'#\s]+)["']?(?:\s+#.*)?$/gmu)) {
    const action = match[1];
    if (!action.startsWith("./") && !/^[^@\s]+@[0-9a-f]{40}$/u.test(action)) {
      unpinnedActions.push(`${workflowPath}: ${action}`);
    }
  }
}
assert.deepEqual(
  unpinnedActions,
  [],
  `Every external GitHub Action must be pinned to a full commit SHA:\n${unpinnedActions.join("\n")}`,
);

const expectedNodeVersion = "24.19.0";
for (const nodeVersionFile of [".nvmrc", "services/runtime/.nvmrc"]) {
  assert.equal(
    read(nodeVersionFile).trim(),
    expectedNodeVersion,
    `${nodeVersionFile} must pin Node.js ${expectedNodeVersion}`,
  );
}
for (const packageFile of ["package.json", "services/runtime/package.json"]) {
  const packageManifest = JSON.parse(read(packageFile));
  assert.equal(
    packageManifest.engines?.node,
    ">=24.19.0 <25",
    `${packageFile} must reject unreviewed Node.js majors and older Node 24 releases`,
  );
}

const rustToolchain = read("rust-toolchain.toml");
assert.match(rustToolchain, /channel = "1\.97\.1"/u);
assert.match(rustToolchain, /profile = "minimal"/u);
assert.match(rustToolchain, /components = \["clippy", "rustfmt"\]/u);

const expectedNodeImage = "node:24.19.0-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43";
const dockerfile = read("services/runtime/Dockerfile");
const baseImages = [...dockerfile.matchAll(/^FROM\s+(\S+)/gmu)].map(match => match[1]);
assert.deepEqual(
  baseImages,
  [expectedNodeImage, expectedNodeImage],
  "Every Runtime image stage must use the reviewed Node.js tag and immutable digest",
);

const runtimeCompose = read("services/runtime/docker-compose.yml");
for (const image of [
  "postgres:17.11-alpine3.24@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73",
  "redis:8.10.1-alpine3.23@sha256:becdda6c7f4b3fb42e42fd7f120bbf5c54c4caaaf16f26da24e4563d2c1f0576",
]) {
  assert.ok(runtimeCompose.includes(`image: ${image}`), `Runtime Compose must pin ${image}`);
}
assert.match(runtimeCompose, /context: \.\.\/\.\./u);
assert.match(runtimeCompose, /dockerfile: services\/runtime\/Dockerfile/u);

const ciWorkflow = read(".github/workflows/ci.yml");
assert.doesNotMatch(
  ciWorkflow,
  /^ {6}GITHUB_TOKEN:\s/mu,
  "CI job-level environment must not expose GITHUB_TOKEN to dependency lifecycle scripts",
);
for (const requiredCiGate of [
  "actions/dependency-review-action@",
  "npm audit --audit-level=high",
  "npm audit signatures",
  "cargo audit --file apps/studio/src-tauri/Cargo.lock",
  "npm run check:security",
]) {
  assert.ok(ciWorkflow.includes(requiredCiGate), `CI is missing supply-chain gate: ${requiredCiGate}`);
}

const releaseWorkflow = read(".github/workflows/release.yml");
assert.doesNotMatch(
  releaseWorkflow,
  /^ {6}[A-Z][A-Z0-9_]*:\s+\$\{\{\s*secrets\./mu,
  "Release secrets must be scoped to the individual step that consumes them",
);
assert.doesNotMatch(
  releaseWorkflow,
  /^ {6}GITHUB_TOKEN:\s/mu,
  "Release job-level environment must not expose GITHUB_TOKEN to dependency lifecycle scripts",
);
for (const requiredReleaseGate of [
  "provenance: mode=max",
  "sbom: true",
  "anchore/sbom-action@",
  "actions/attest-build-provenance@",
  "gh attestation verify",
  "--bundle-from-oci",
]) {
  assert.ok(
    releaseWorkflow.includes(requiredReleaseGate),
    `Release is missing supply-chain gate: ${requiredReleaseGate}`,
  );
}

const dependabot = read(".github/dependabot.yml");
for (const ecosystem of ["npm", "cargo", "github-actions", "docker"]) {
  assert.ok(
    dependabot.includes(`package-ecosystem: ${ecosystem}`),
    `Dependabot is missing the ${ecosystem} ecosystem`,
  );
}

const codeql = read(".github/workflows/codeql.yml");
assert.match(codeql, /javascript-typescript/u);
assert.match(codeql, /^\s*- rust$/mu);
assert.match(codeql, /github\/codeql-action\/init@[0-9a-f]{40}/u);
assert.match(codeql, /github\/codeql-action\/analyze@[0-9a-f]{40}/u);

process.stdout.write(
  `Supply-chain policy passed: ${workflowFiles.length} workflows use immutable actions; toolchains, images, dependency review, CodeQL, SBOM and provenance gates are present.\n`,
);
