# WA Studio release runbook

This runbook stages an independently deployable Event Inbox server candidate, then publishes the
macOS updater and all components as one product release. The GitHub Actions workflow is
authoritative; do not upload or replace release assets manually.

`release/components.json` declares the release channel. A `canary` release is published as a GitHub
prerelease and is intentionally excluded from the `releases/latest` updater endpoint. A `stable`
release is published as the latest release. Change the channel only in a version-bump commit that
passes every required check; never mutate the channel of an existing tag or published release.

## Preconditions

- Release from a pull-request commit on `main` with every required check current and successful.
- Keep every component's source version synchronized with its corresponding field in
  `release/components.json`; the Studio, Runtime, contract, Connector and OpenWA versions are
  independent and are not required to be numerically equal. `npm run release:manifest:check` must
  pass.
- Build and publish desktop artifacts only from Apple Silicon. The supported updater platform is
  `darwin-aarch64` and the packaged app declares macOS 13.5 as its minimum system version; release
  preflight rejects a different build architecture, and post-build validation inspects both the
  Mach-O binary and app `Info.plist` before accepting the artifact.
- Configure `WA_STUDIO_UPDATER_ENDPOINT` as exactly
  `https://github.com/hiepknor/wa-studio/releases/latest/download/latest.json`.
- Configure the matching `WA_STUDIO_UPDATER_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY` and optional
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` GitHub Actions secrets.
- To publish the desktop product, configure the Developer ID certificate and App Store Connect
  notarization secrets used by `.github/workflows/release.yml`. A missing desktop credential does
  not weaken or block the separately attested server candidate, but it must keep product publication
  fail-closed.
- Set the repository variable `WA_STUDIO_DESKTOP_RELEASE_ENABLED=true` only after those credentials
  are configured and a desktop product release is intended. When absent or false, the desktop and
  coordinated publish jobs are intentionally skipped while the server candidate remains green.
- Configure desktop credentials as secrets of the protected `release` GitHub environment. In this
  single-maintainer repository, the protected tag, required checks, signed workflow and artifact
  verification replace a manual environment approval.

Before creating any tag, run `npm run release:environment:check`. It reads names and policy metadata
through the authenticated GitHub CLI, never secret values, and fails unless the `release`
environment contains every Apple/updater input, repository variable
`WA_STUDIO_DESKTOP_RELEASE_ENABLED` is exactly `true`, and the environment is restricted to `v*`
tags. A stable candidate additionally requires `PRODUCTION_ACCEPTANCE_PUBLIC_KEY_PEM` at repository
scope because the early verification job does not enter the protected environment.

Never print, copy into a workflow artifact, or add a fallback for any signing or notarization secret.
Keep signing, updater, and notarization secrets scoped to the single signed-build step; dependency
installation, lifecycle scripts, validation, SBOM generation, staging, and publishing must not inherit
them through a job-level environment. The signed-build wrapper also strips those values while preparing
the Runtime sidecar and exposes them only to the Tauri signing/build command.

## Internal-local UAT without Developer ID

The internal-local lane exists only to continue same-Mac functional UAT while Apple signing and
notarization are unavailable. It is not a release channel and must never weaken the product release
workflow above.

1. Use a clean worktree whose `HEAD` exactly matches local `origin/main`, with
   `release/components.json` still set to `canary`.
2. Run `npm run build:desktop:internal-local`. The wrapper strips Apple, updater, GitHub release,
   signing and caller-supplied Rust build overrides; builds native `aarch64-apple-darwin` in a
   temporary Cargo target; packages only an `.app`; and removes the temporary target after staging.
3. Run `npm run verify:desktop:internal-local`. Verification binds the app to the current commit and
   version, checks the bundle identifier and macOS 13.5 floor, checks both Studio and Runtime Mach-O
   architectures, validates the ad-hoc code signature, and compares recorded bundle, binary,
   sidecar, manifest and CodeDirectory hashes.
4. Run the app only on the build Mac, with every other WA Studio instance stopped. The bundle keeps
   `dev.hiepknor.wastudio` so the managed data path remains unchanged. If the connector is not
   already installed, install the locally packaged, checksum-verified connector through the OpenWA
   operator UI; the internal build does not invent a public connector URL.
5. Use this build for functional synchronization, dry runs and a tightly supervised Test-list
   canary only. Record its metadata as diagnostic context, not as production acceptance.
6. Run `npm run clean:desktop:internal-local` before producing a newer candidate.

The generated path is `dist/internal-local/WA Studio.app`. Do not upload it, attach it to a GitHub
Release, enable automatic updates, bypass Gatekeeper for a downloaded copy, or use its observations
to satisfy the signed/notarized release checklist. A tag, public desktop artifact, unattended
production declaration and stable promotion remain blocked until Developer ID signing and Apple
notarization are available.

## Publish

1. Run `npm run release:environment:check`, `npm run check`, and `npm run test:integration` from the
   release commit.
2. Create and push the tag `v<apps/studio/package.json version>` without moving an existing tag.
3. Watch the `Release` workflow. `verify`, `event-inbox-image`, and `connector-plugin` produce the
   server candidate first. `publish-server-candidate` verifies provenance and stages four
   assets in a draft GitHub Release. It does not expose a desktop update.
4. When `WA_STUDIO_DESKTOP_RELEASE_ENABLED=true`, the independent `desktop` job must still import the
   Developer ID identity, notarize, sign the updater, and pass the packaged Runtime drill. Only then
   may `publish` bind all components and publish the draft.
5. The image job publishes BuildKit SBOM/provenance attestations for the immutable GHCR digest. The
   desktop job generates an SPDX 2.3 SBOM and signs GitHub provenance attestations for every staged
   release file.
6. The publish job verifies those attestations against this repository, workflow and source commit,
   resumes the server-candidate draft, uploads the desktop and coordinated assets, verifies exactly
   twelve assets, downloads `latest.json` back
   for comparison, and only then publishes the draft as a prerelease or latest release according to
   the reviewed release channel.

The release assets are:

- the normalized `.app.tar.gz` updater archive and its `.sig` file;
- the notarized `.dmg` installer;
- the generated `WA-Studio_<version>_sbom.spdx.json` software bill of materials;
- `latest.json`, `release-checksums.txt`, and `release-assets.json`;
- `event-inbox-image.txt`, containing the immutable GHCR digest deployed with this product version;
- `wa-studio-server-deployment.json`, the attested server-only binding used to canary Event Inbox
  without depending on macOS signing;
- `wa-studio-deployment.json`, the attested binding between the source commit, desktop checksum set,
  Event Inbox digest and migration set, connector digest and protocol, OpenWA pin, production
  acceptance policy digest, and component versions;
- the installable `wa-studio-connector-<version>.zip` and its `.sha256` checksum.

## Verify after publication

```bash
gh release view "v<version>" --json tagName,isDraft,assets
gh release download "v<version>" --dir "release-v<version>"
cd "release-v<version>"
shasum -a 256 --check release-checksums.txt
for asset in WA-Studio_* latest.json release-assets.json release-checksums.txt; do
  gh attestation verify "$asset" \
    --repo hiepknor/wa-studio \
    --signer-workflow hiepknor/wa-studio/.github/workflows/release.yml \
    --source-digest "$(git rev-list -n 1 v<version>)"
done
connector_zip="$(find . -maxdepth 1 -type f -name 'wa-studio-connector-*.zip' -print -quit)"
test -n "$connector_zip" -a -f "${connector_zip}.sha256"
shasum -a 256 --check "${connector_zip}.sha256"
gh attestation verify "$connector_zip" \
  --repo hiepknor/wa-studio \
  --signer-workflow hiepknor/wa-studio/.github/workflows/release.yml \
  --source-digest "$(git rev-list -n 1 v<version>)"
node tooling/release/deployment-release.mjs verify \
  --repository hiepknor/wa-studio \
  --tag "v<version>" \
  --git-commit "$(git rev-list -n 1 v<version>)" \
  --image-file event-inbox-image.txt \
  --connector-directory . \
  --updater-directory . \
  --manifest wa-studio-deployment.json
gh attestation verify wa-studio-deployment.json \
  --repo hiepknor/wa-studio \
  --signer-workflow hiepknor/wa-studio/.github/workflows/release.yml \
  --source-digest "$(git rev-list -n 1 v<version>)"
```

Before product publication, operators may download the four assets from the authenticated draft and
deploy only the server candidate. Verify `wa-studio-server-deployment.json` with `verify-server` and
verify its GitHub attestation before staging the image:

```bash
node tooling/release/deployment-release.mjs verify-server \
  --repository hiepknor/wa-studio \
  --tag "v<version>" \
  --git-commit "$(git rev-list -n 1 v<version>)" \
  --image-file event-inbox-image.txt \
  --connector-directory . \
  --manifest wa-studio-server-deployment.json
gh attestation verify wa-studio-server-deployment.json \
  --repo hiepknor/wa-studio \
  --signer-workflow hiepknor/wa-studio/.github/workflows/release.yml \
  --source-digest "$(git rev-list -n 1 v<version>)"
```

Confirm that:

- the release is not a draft, contains exactly twelve assets, and its prerelease/latest state matches
  `release/components.json`;
- `latest.json` reports the tagged version and a `darwin-aarch64` platform;
- its URL points to the updater archive in the same immutable tag;
- its inline signature equals the contents of the `.sig` asset;
- the SPDX document reports `SPDX-2.3` and contains at least one package;
- `event-inbox-image.txt` contains
  `ghcr.io/hiepknor/wa-event-inbox@sha256:<64 lowercase hex characters>`;
- the connector ZIP digest matches its adjacent checksum and its provenance identifies this release
  workflow and tagged source commit;
- the attested coordinated deployment manifest exactly matches the other release artifacts and the
  tagged source tree; operators deploy from it rather than manually pairing independent versions.

Authenticate to GHCR and verify the image provenance bundle separately:

```bash
image="$(tr -d '\r\n' < event-inbox-image.txt)"
gh auth token | docker login ghcr.io -u "$(gh api user --jq .login)" --password-stdin
gh attestation verify "oci://${image}" \
  --repo hiepknor/wa-studio \
  --signer-workflow hiepknor/wa-studio/.github/workflows/release.yml \
  --source-digest "$(git rev-list -n 1 v<version>)" \
  --bundle-from-oci
```

Finally, check for updates from the preceding signed WA Studio release. Development builds cannot
perform this check because they intentionally contain no update channel or public key.

## 0.2 production rollout sequence

### Canary 0.2.2

1. Keep `releaseChannel` set to `canary` and tag the verified `main` commit as `v0.2.2`. Install the
   published notarized DMG manually on only the canary Mac; prereleases are intentionally invisible
   to the stable updater endpoint.
2. Verify all twelve release assets, attestations, checksums, the updater signature, connector package,
   and Event Inbox image digest. Stage that image digest with the Event Inbox `canary` Compose
   profile on port 34201, then run `npm run event-inbox:candidate:verify` against the attested
   server deployment manifest and the actual canary container before routing traffic.
3. Confirm private readiness reports available maximum-callback admission, switch only
   `wa-events.onio.cc` to the candidate with
   `WA_EVENT_INBOX_UPSTREAM=127.0.0.1:34201`, and keep the accepted primary live on 34200 throughout
   the observation window.
4. Run the production-readiness checklist in `docs/production-readiness.md`, including one real
   outbound run scoped to the dedicated test group. Do not reuse a customer group or broaden the
   target after it has been recorded for UAT.
5. Observe for 24 continuous hours. Runtime records an aggregate sample every minute and the final
   verifier requires the exact Studio/Runtime/OpenWA/instance identity, no violating sample, and no
   gap over five minutes. Closing the app or changing candidate identity therefore prevents the
   window from passing. Restart the clock after any candidate redeploy, unexplained endpoint switch,
   critical alert, failed backup, or unresolved UAT discrepancy.
6. Accept only with zero unexplained callback loss, zero duplicate outbound effects, zero critical
   alerts, a successful encrypted off-host backup plus restore drill, and explicit operator
   sign-off. Create the private record with `release:acceptance:create`; at the end of the unchanged
   window run `release:operational:capture` and `release:operational:verify`, then bind that file with
   `release:acceptance:attach-operational`. Refresh **Settings → Backups & recovery** at the end of
   the window, retain its native managed-storage evidence, and populate `managedStorage` with the
   exact diagnostics: normal pressure, at least 20 GiB available, one or more recovery points, fresh
   recovery and integrity checks, and automatic recovery usage no greater than its budget. Capture
   both the operational snapshot and native storage evidence within the final 15 minutes of the
   recorded canary window. The operational capture must show zero ambiguous or deferred Message
   Jobs, no open/recovering/throttled safety scope, no dead Runtime webhook, fresh callback
   processing, and available maximum-event spool admission; these values are collected from the
   authenticated Runtime endpoint rather than transcribed by the operator. Validate
   drafts with `release:acceptance:verify`, and require `release:acceptance:verify-go` to pass against
   both the operational snapshot and attested coordinated deployment manifest before accepting the
   canary. Preserve the snapshot, encrypted evidence archive, native storage capture, and record by
   release digest and UTC interval; none belongs in Git.

Rollback server traffic immediately to 34200 when liveness/readiness fails, a callback cannot be
accounted for, an outbound result is `UNKNOWN`, storage becomes critical, or a paging path is broken.
Server rollback is a Caddy reload and does not mutate the database or downgrade the desktop. Stop
further outbound UAT, retain both slots and logs for diagnosis, and ship a higher candidate version.

### Stable 0.2.3

After canary acceptance, create a version-bump commit that moves Studio and Tauri to 0.2.3,
updates Runtime metadata only when Runtime changed, regenerates the release manifest, and changes
`releaseChannel` to `stable`. Merge it through a pull request with every required check successful,
then tag only that commit as `v0.2.3`.
The stable bump is forbidden unless the private canary record has passed
`release:acceptance:verify-go`. Generate `release/production-promotion.json` from that record with
`release:promotion:create` for the exact stable tag and the dedicated production-authorization
Ed25519 private key, then commit the sanitized signed receipt with the
version/channel-only stable bump. CI rejects a stable tag without it, downloads the accepted canary
manifest, verifies the receipt with `PRODUCTION_ACCEPTANCE_PUBLIC_KEY_PEM`, and then verifies its
digest, source commit, tag binding, prerelease state, and GitHub attestation
before publishing. The stable commit must descend from the accepted canary and its complete diff is
restricted to the receipt plus normalized Studio/Tauri version and release-channel fields; any other
code, dependency, configuration, file mode, or manifest change requires a new canary. CI runs this
comparison with the verifier checked out from the accepted canary rather than trusting candidate
code. Keep the coordinated manifest, operational snapshot, encrypted evidence archive, and acceptance
JSON together as the immutable private promotion input.
Converge the primary Event Inbox slot to the accepted immutable image,
switch Caddy back to the fail-safe 34200 target, then publish 0.2.3 as latest. Verify an installed
0.2.2 canary and the preceding stable build both discover 0.2.3 through the signed updater manifest.
Do not promote or relabel the 0.2.2 prerelease.

## Failure and recovery

- A desktop or `publish` failure exposes no new desktop update. A successful
  `publish-server-candidate` leaves an authenticated draft containing the attested server identity;
  it may be used only by the server canary runbook and is not a published product release.
- A failed asset upload leaves a draft. Re-run failed jobs; the server stage verifies its four
  required assets byte-for-byte even when a prior product upload left additional expected files,
  while final publication still refuses any set other than the exact twelve product assets.
- If publication succeeded but advancing the mutable canary channel pointer failed, re-run the
  workflow from the same tag. It downloads all twelve published assets, verifies the updater,
  connector checksum, both deployment manifests, every applicable GitHub attestation, and the OCI
  image provenance before retrying only the channel pointer. It never replaces a published product
  asset.
- The workflow refuses to replace an already-published release or a mismatched version tag.
- Never mutate a published archive, signature, manifest or tag. If a published release is defective,
  ship a higher fix-forward version. The updater creates an encrypted pre-update Runtime backup
  before installation, but it does not use downgrade releases as rollback.
