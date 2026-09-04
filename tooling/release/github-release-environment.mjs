import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const releaseEnvironment = "release";
const requiredEnvironmentSecrets = [
  "APPLE_API_ISSUER",
  "APPLE_API_KEY",
  "APPLE_API_PRIVATE_KEY",
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "TAURI_SIGNING_PRIVATE_KEY",
  "WA_STUDIO_UPDATER_ENDPOINT",
  "WA_STUDIO_UPDATER_PUBLIC_KEY",
];

function required(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function ghJson(arguments_) {
  return JSON.parse(execFileSync("gh", arguments_, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

export function validateReleaseEnvironment({
  channel,
  environmentSecrets,
  repositoryVariables,
  deploymentBranchPolicy,
  deploymentBranchPolicies,
  deploymentBranchPolicyCount = deploymentBranchPolicies.length,
}) {
  const errors = [];
  if (!["canary", "stable"].includes(channel)) {
    errors.push(`Unsupported release channel: ${channel}.`);
  }
  const secrets = new Set(environmentSecrets);
  const missingSecrets = requiredEnvironmentSecrets.filter(name => !secrets.has(name));
  if (missingSecrets.length > 0) {
    errors.push(`Release environment is missing secrets: ${missingSecrets.join(", ")}.`);
  }
  const variables = new Map(repositoryVariables.map(variable => [variable.name, variable.value]));
  if (variables.get("WA_STUDIO_DESKTOP_RELEASE_ENABLED") !== "true") {
    errors.push("Repository variable WA_STUDIO_DESKTOP_RELEASE_ENABLED must equal true.");
  }
  if (channel === "stable"
    && !String(variables.get("PRODUCTION_ACCEPTANCE_PUBLIC_KEY_PEM") ?? "").trim()) {
    errors.push("Stable release requires repository variable PRODUCTION_ACCEPTANCE_PUBLIC_KEY_PEM.");
  }
  if (deploymentBranchPolicy?.custom_branch_policies !== true
    || deploymentBranchPolicy?.protected_branches !== false) {
    errors.push("Release environment must use custom deployment policies only.");
  }
  const exactTagPolicy = deploymentBranchPolicyCount === 1
    && deploymentBranchPolicies.length === 1
    && deploymentBranchPolicies[0]?.type === "tag"
    && deploymentBranchPolicies[0]?.name === "v*";
  if (!exactTagPolicy) {
    errors.push("Release environment must allow only the protected v* tag policy.");
  }
  return errors;
}

export function inspectGitHubReleaseEnvironment({ channel, repository } = {}) {
  const components = JSON.parse(readFileSync(
    resolve(workspaceRoot, "release/components.json"),
    "utf8",
  ));
  const selectedChannel = channel ?? required(components.releaseChannel, "Release channel");
  const selectedRepository = repository ?? required(
    ghJson(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner,
    "GitHub repository",
  );
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(selectedRepository)) {
    throw new Error("GitHub repository must use owner/name format.");
  }
  const environment = ghJson([
    "api", `repos/${selectedRepository}/environments/${releaseEnvironment}`,
  ]);
  const environmentSecrets = ghJson([
    "secret", "list", "--env", releaseEnvironment, "--json", "name",
  ]).map(secret => secret.name);
  const repositoryVariables = ghJson([
    "variable", "list", "--json", "name,value",
  ]);
  const deploymentBranchPolicyResponse = ghJson([
    "api",
    `repos/${selectedRepository}/environments/${releaseEnvironment}/deployment-branch-policies?per_page=100`,
  ]);
  const deploymentBranchPolicies = deploymentBranchPolicyResponse.branch_policies ?? [];
  const errors = validateReleaseEnvironment({
    channel: selectedChannel,
    environmentSecrets,
    repositoryVariables,
    deploymentBranchPolicy: environment.deployment_branch_policy,
    deploymentBranchPolicies,
    deploymentBranchPolicyCount: deploymentBranchPolicyResponse.total_count ?? 0,
  });
  return {
    schemaVersion: 1,
    status: errors.length === 0 ? "ready" : "blocked",
    repository: selectedRepository,
    channel: selectedChannel,
    environment: releaseEnvironment,
    errors,
  };
}

function main() {
  const result = inspectGitHubReleaseEnvironment();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "ready") process.exit(1);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) main();
