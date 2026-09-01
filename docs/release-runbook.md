# WA Studio release runbook

This runbook publishes the macOS desktop updater and the Event Inbox image as one product release.
The GitHub Actions workflow is authoritative; do not upload or replace updater assets manually.

`release/components.json` declares the release channel. A `canary` release is published as a GitHub
prerelease and is intentionally excluded from the `releases/latest` updater endpoint. A `stable`
release is published as the latest release. Change the channel only in a version-bump commit that
passes every required check; never mutate the channel of an existing tag or published release.

## Preconditions

- Release from a pull-request commit on `main` with every required check current and successful.
- Keep `apps/studio/package.json`, Tauri, Runtime, contract and `release/components.json` versions
  aligned. `npm run release:manifest:check` must pass.
- Configure `WA_STUDIO_UPDATER_ENDPOINT` as exactly
  `https://github.com/hiepknor/wa-studio/releases/latest/download/latest.json`.
- Configure the matching `WA_STUDIO_UPDATER_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY` and optional
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` GitHub Actions secrets.
- Configure the Developer ID certificate and App Store Connect notarization secrets used by
  `.github/workflows/release.yml`.
- Configure those credentials as secrets of the protected `release` GitHub environment. In this
  single-maintainer repository, the protected tag, required checks, signed workflow and artifact
  verification replace a manual environment approval.

Never print, copy into a workflow artifact, or add a fallback for any signing or notarization secret.
Keep signing, updater, and notarization secrets scoped to the single signed-build step; dependency
installation, lifecycle scripts, validation, SBOM generation, staging, and publishing must not inherit
them through a job-level environment. The signed-build wrapper also strips those values while preparing
the Runtime sidecar and exposes them only to the Tauri signing/build command.

## Publish

1. Run `npm run check` and `npm run test:integration` from the release commit.
2. Create and push the tag `v<apps/studio/package.json version>` without moving an existing tag.
3. Watch the `Release` workflow. It must complete `verify`, `event-inbox-image`, `desktop`, then
   `publish` in that order.
4. The image job publishes BuildKit SBOM/provenance attestations for the immutable GHCR digest. The
   desktop job generates an SPDX 2.3 SBOM and signs GitHub provenance attestations for every staged
   release file.
5. The publish job verifies those attestations against this repository, workflow and source commit,
   creates or resumes a draft release, uploads exactly eleven assets, downloads `latest.json` back
   for comparison, and only then publishes the draft as a prerelease or latest release according to
   the reviewed release channel.

The release assets are:

- the normalized `.app.tar.gz` updater archive and its `.sig` file;
- the notarized `.dmg` installer;
- the generated `WA-Studio_<version>_sbom.spdx.json` software bill of materials;
- `latest.json`, `release-checksums.txt`, and `release-assets.json`;
- `event-inbox-image.txt`, containing the immutable GHCR digest deployed with this product version;
- `wa-studio-deployment.json`, the attested binding between the source commit, desktop checksum set,
  Event Inbox digest and migration set, connector digest and protocol, OpenWA pin, and component versions;
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

Confirm that:

- the release is not a draft, contains exactly eleven assets, and its prerelease/latest state matches
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

### Canary 0.2.0

1. Keep `releaseChannel` set to `canary` and tag the verified `main` commit as `v0.2.0`. Install the
   published notarized DMG manually on only the canary Mac; prereleases are intentionally invisible
   to the stable updater endpoint.
2. Verify all eleven release assets, attestations, checksums, the updater signature, connector package,
   and Event Inbox image digest. Stage that image digest with the Event Inbox `canary` Compose
   profile on port 34201, then run `npm run event-inbox:candidate:verify` against the attested
   deployment manifest and the actual canary container before routing traffic.
3. Confirm private readiness, switch only `wa-events.onio.cc` to the candidate with
   `WA_EVENT_INBOX_UPSTREAM=127.0.0.1:34201`, and keep the accepted primary live on 34200 throughout
   the observation window.
4. Run the production-readiness checklist in `docs/production-readiness.md`, including one real
   outbound run scoped to the dedicated test group. Do not reuse a customer group or broaden the
   target after it has been recorded for UAT.
5. Observe for 24 continuous hours. Restart the clock after any candidate redeploy, unexplained
   endpoint switch, critical alert, failed backup, or unresolved UAT discrepancy.
6. Accept only with zero unexplained callback loss, zero duplicate outbound effects, zero critical
   alerts, a successful encrypted off-host backup plus restore drill, and explicit operator
   sign-off. Preserve the evidence by release digest and UTC interval.

Rollback server traffic immediately to 34200 when liveness/readiness fails, a callback cannot be
accounted for, an outbound result is `UNKNOWN`, storage becomes critical, or a paging path is broken.
Server rollback is a Caddy reload and does not mutate the database or downgrade the desktop. Stop
further outbound UAT, retain both slots and logs for diagnosis, and ship a higher candidate version.

### Stable 0.2.1

After canary acceptance, create a version-bump commit that moves Studio and Tauri to 0.2.1,
updates Runtime metadata only when Runtime changed, regenerates the release manifest, and changes
`releaseChannel` to `stable`. Merge it through a pull request with every required check successful,
then tag only that commit as `v0.2.1`.
Converge the primary Event Inbox slot to the accepted immutable image,
switch Caddy back to the fail-safe 34200 target, then publish 0.2.1 as latest. Verify an installed
0.2.0 canary and the preceding stable build both discover 0.2.1 through the signed updater manifest.
Do not promote or relabel the 0.2.0 prerelease.

## Failure and recovery

- A failure before `publish` exposes no new desktop update. An Event Inbox image may already exist by
  immutable digest, but it is not declared as a product release.
- A failed asset upload leaves a draft. Re-run the same workflow; it resumes that draft and replaces
  only its expected assets before verification.
- The workflow refuses to replace an already-published release or a mismatched version tag.
- Never mutate a published archive, signature, manifest or tag. If a published release is defective,
  ship a higher fix-forward version. The updater creates an encrypted pre-update Runtime backup
  before installation, but it does not use downgrade releases as rollback.
