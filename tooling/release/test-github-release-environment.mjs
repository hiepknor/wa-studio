import assert from "node:assert/strict";

import { validateReleaseEnvironment } from "./github-release-environment.mjs";

const environmentSecrets = [
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
const deploymentBranchPolicies = [{ type: "tag", name: "v*" }];
const deploymentBranchPolicy = {
  custom_branch_policies: true,
  protected_branches: false,
};

const validate = overrides => validateReleaseEnvironment({
  channel: "canary",
  environmentSecrets,
  repositoryVariables: [{ name: "WA_STUDIO_DESKTOP_RELEASE_ENABLED", value: "true" }],
  deploymentBranchPolicy,
  deploymentBranchPolicies,
  ...overrides,
});

assert.deepEqual(validate({}), []);
assert.deepEqual(validate({ environmentSecrets: environmentSecrets.slice(1) }), [
  "Release environment is missing secrets: APPLE_API_ISSUER.",
]);
assert.deepEqual(validate({ repositoryVariables: [] }), [
  "Repository variable WA_STUDIO_DESKTOP_RELEASE_ENABLED must equal true.",
]);
assert.deepEqual(validate({ deploymentBranchPolicies: [] }), [
  "Release environment must allow only the protected v* tag policy.",
]);
assert.deepEqual(validate({
  deploymentBranchPolicies: [
    ...deploymentBranchPolicies,
    { type: "branch", name: "main" },
  ],
  deploymentBranchPolicyCount: 2,
}), [
  "Release environment must allow only the protected v* tag policy.",
]);
assert.deepEqual(validate({
  deploymentBranchPolicy: { custom_branch_policies: false, protected_branches: true },
}), [
  "Release environment must use custom deployment policies only.",
]);
assert.deepEqual(validate({
  channel: "stable",
  repositoryVariables: [
    { name: "WA_STUDIO_DESKTOP_RELEASE_ENABLED", value: "true" },
    { name: "PRODUCTION_ACCEPTANCE_PUBLIC_KEY_PEM", value: "public-key-not-printed" },
  ],
}), []);
assert.deepEqual(validate({ channel: "stable" }), [
  "Stable release requires repository variable PRODUCTION_ACCEPTANCE_PUBLIC_KEY_PEM.",
]);
assert.deepEqual(validate({
  channel: "stable",
  repositoryVariables: [
    { name: "WA_STUDIO_DESKTOP_RELEASE_ENABLED", value: "true" },
    { name: "PRODUCTION_ACCEPTANCE_PUBLIC_KEY_PEM", value: "   " },
  ],
}), [
  "Stable release requires repository variable PRODUCTION_ACCEPTANCE_PUBLIC_KEY_PEM.",
]);

process.stdout.write(
  "GitHub release environment test passed: signing, desktop and stable promotion inputs fail closed.\n",
);
