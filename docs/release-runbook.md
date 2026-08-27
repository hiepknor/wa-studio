# WA Studio release runbook

This runbook publishes the macOS desktop updater and the Event Inbox image as one product release.
The GitHub Actions workflow is authoritative; do not upload or replace updater assets manually.

## Preconditions

- Release from a reviewed commit on `main` with a clean CI result.
- Keep `apps/studio/package.json`, Tauri, Runtime, contract and `release/components.json` versions
  aligned. `npm run release:manifest:check` must pass.
- Configure `WA_STUDIO_UPDATER_ENDPOINT` as exactly
  `https://github.com/hiepknor/wa-studio/releases/latest/download/latest.json`.
- Configure the matching `WA_STUDIO_UPDATER_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY` and optional
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` GitHub Actions secrets.
- Configure the Developer ID certificate and App Store Connect notarization secrets used by
  `.github/workflows/release.yml`.

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
   creates or resumes a draft release, uploads exactly eight assets, downloads `latest.json` back
   for comparison, and only then publishes the draft as the latest release.

The release assets are:

- the normalized `.app.tar.gz` updater archive and its `.sig` file;
- the notarized `.dmg` installer;
- the generated `WA-Studio_<version>_sbom.spdx.json` software bill of materials;
- `latest.json`, `release-checksums.txt`, and `release-assets.json`;
- `event-inbox-image.txt`, containing the immutable GHCR digest deployed with this product version.

## Verify after publication

```bash
gh release view "v<version>" --json tagName,isDraft,assets
gh release download "v<version>" --dir "release-v<version>"
cd "release-v<version>"
shasum -a 256 --check release-checksums.txt
for asset in *; do
  [[ "$asset" == "event-inbox-image.txt" ]] && continue
  gh attestation verify "$asset" \
    --repo hiepknor/wa-studio \
    --signer-workflow hiepknor/wa-studio/.github/workflows/release.yml \
    --source-digest "$(git rev-list -n 1 v<version>)"
done
```

Confirm that:

- the release is not a draft and contains exactly eight assets;
- `latest.json` reports the tagged version and a `darwin-aarch64` platform;
- its URL points to the updater archive in the same immutable tag;
- its inline signature equals the contents of the `.sig` asset;
- the SPDX document reports `SPDX-2.3` and contains at least one package;
- `event-inbox-image.txt` contains
  `ghcr.io/hiepknor/wa-event-inbox@sha256:<64 lowercase hex characters>`.

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

## Failure and recovery

- A failure before `publish` exposes no new desktop update. An Event Inbox image may already exist by
  immutable digest, but it is not declared as a product release.
- A failed asset upload leaves a draft. Re-run the same workflow; it resumes that draft and replaces
  only its expected assets before verification.
- The workflow refuses to replace an already-published release or a mismatched version tag.
- Never mutate a published archive, signature, manifest or tag. If a published release is defective,
  ship a higher fix-forward version. The updater creates an encrypted pre-update Runtime backup
  before installation, but it does not use downgrade releases as rollback.
