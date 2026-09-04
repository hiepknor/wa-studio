# WA Studio

WA Studio is a desktop operations workspace that bundles WA Runtime and manages a private local
PostgreSQL instance. Studio talks to the bundled Runtime over loopback; Runtime owns orchestration,
durable state, and the OpenWA integration. OpenWA remains an external, release-pinned gateway and is
not modified by this repository.

## Canonical names

| Name | Meaning | Stable identifier |
| --- | --- | --- |
| WA Studio | operator-facing desktop product and this monorepo's release product | `wa-studio` |
| WA Runtime | UI-independent business engine, sidecar, service and public API contract | `wa-runtime` |
| OpenWA | external, release-pinned WhatsApp gateway | reviewed tag in `release/components.json` |

The project is therefore not renamed wholesale to WA Runtime: Studio is the shipped desktop
product, while Runtime is the reusable engine inside and behind it. The release gate enforces these
names together with npm package names, the sidecar name, and the preserved Tauri identifier.

## Repository layout

```text
apps/studio               React + Tauri desktop application
services/runtime          NestJS Runtime and Event Inbox service
packages/runtime-contract generated Runtime OpenAPI snapshot and TypeScript types
tooling                    monorepo sidecar, E2E, and release tooling
release                    coordinated component version manifest
```

The repository uses one npm workspace lockfile. Do not install dependencies separately inside a
workspace.

## Prerequisites

- Node.js 24 (see `.nvmrc`)
- Rust stable
- macOS: Xcode or Xcode Command Line Tools
- PostgreSQL only for integration tests that explicitly use an external database
- OpenWA Base URL and API key for a server running the reviewed tag when exercising the real Connect flow

## Development

From the repository root:

```bash
npm ci
npm run dev
```

`npm run dev` generates the release manifest, builds the Runtime sidecar, stages Runtime migrations,
and starts Tauri. Connect accepts an OpenWA Base URL and API key. Native provisioning verifies
the server's release against the reviewed pin, discovers Event Inbox, pairs the desktop device,
persists the provisioning profile in the protected local app store, and starts local PostgreSQL,
API, worker, and scheduler processes.

Production installation is greenfield. WA Studio creates a new local Runtime database and does not
import legacy VPS Runtime data. Encrypted backups in Settings cover only data created by this
desktop-managed deployment.

## Verification

```bash
npm run check
npm run test:integration
npm run build:desktop -- --debug
```

`npm run check` regenerates and verifies the shared Runtime contract, checks Runtime architecture,
types, tests and build, then runs Studio frontend tests/build plus Rust formatting and Clippy. The
desktop build packages the exact Runtime sidecar, migrations, and generated release manifest from
this commit.

The packaged Connect/start/quit lifecycle can be tested against an isolated PostgreSQL instance:

```bash
export WA_RUNTIME_E2E_DATABASE_URL='postgresql://localhost:5432/postgres'
export WA_STUDIO_APP_BINARY="$PWD/apps/studio/src-tauri/target/debug/bundle/macos/WA Studio.app/Contents/MacOS/wa-studio"
npm run test:managed-runtime:event-inbox
```

This test uses an OpenWA stub; it does not require or mutate the production OpenWA gateway.

## Contracts and component versions

`packages/runtime-contract/openapi.json` is the single Runtime API snapshot. After changing a
Runtime controller or DTO, run `npm run contract:generate`, review both generated files, and commit
them with the producer and consumer changes.

`release/components.json` schema v2 pins the `wa-studio` product, `wa-runtime` service, Studio,
Runtime, Runtime contract, and OpenWA versions. Run
`npm run release:manifest:check` to reject version drift, or `npm run release:manifest` to create the
manifest bundled into the desktop app.

## Signed updater releases

Development builds intentionally have no updater channel. Signed releases use the canonical static
feed at:

```bash
https://github.com/hiepknor/wa-studio/releases/latest/download/latest.json
```

Set `WA_STUDIO_UPDATER_ENDPOINT` to that exact value in the GitHub Actions secret store, together
with the updater, Developer ID, and notarization credentials. A release operator can validate a
signed build locally with:

```bash
export WA_STUDIO_UPDATER_ENDPOINT='https://github.com/hiepknor/wa-studio/releases/latest/download/latest.json'
export WA_STUDIO_UPDATER_PUBLIC_KEY='...minisign public key...'
export TAURI_SIGNING_PRIVATE_KEY='...CI secret or key path...'
export APPLE_SIGNING_IDENTITY='Developer ID Application: ...'
export APPLE_API_ISSUER='...App Store Connect issuer ID...'
export APPLE_API_KEY='...App Store Connect key ID...'
export APPLE_API_KEY_PATH='/secure/ci/AuthKey_....p8'
npm run build:desktop:signed-update
```

Notarization can instead use `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`. CI may import
`APPLE_CERTIFICATE` with `APPLE_CERTIFICATE_PASSWORD` instead of selecting an installed identity.
The release command fails closed if updater signing, Developer ID signing, notarization, or the HTTPS
endpoint is incomplete; it then verifies the app signature and stapled notarization ticket.

### Internal-local macOS candidate

When Developer ID and notarization are unavailable, an operator may build a private candidate for
functional UAT on the same Apple Silicon Mac:

```bash
npm run build:desktop:internal-local
npm run verify:desktop:internal-local
```

This lane requires a clean checkout at the exact local `origin/main` commit and the `canary` release
channel. It creates only `dist/internal-local/WA Studio.app`, uses an ad-hoc signature, embeds no
updater endpoint, and deletes its temporary Cargo target directory after staging the app. It does
not create a DMG, update manifest, tag, GitHub Release, or production-acceptance artifact. Never
upload or distribute this build. It retains the production bundle identifier and therefore must not
run alongside another WA Studio build that owns the same managed Runtime data. The verifier also
executes the packaged Runtime manifest under Hardened Runtime and rejects missing or broader-than-
required executable-memory entitlements.

Use `npm run clean:desktop:internal-local` to remove only this rebuildable local artifact before
building a newer commit. Developer ID signing and notarization remain mandatory for a product
release.

Pushing a tag that exactly matches `v<apps/studio/package.json version>` runs the release workflow.
It builds and verifies the macOS updater, stages a normalized signed archive, DMG, static
`latest.json`, checksums and release metadata, and publishes the immutable Event Inbox image. The
workflow creates a draft GitHub Release only after both builds pass, verifies the uploaded feed, and
then promotes the draft to the latest published release. A failed or incomplete upload remains a
draft and is never exposed through the updater endpoint.

See [docs/release-runbook.md](docs/release-runbook.md) for release prerequisites, post-publication
verification, retry behavior, and fix-forward recovery.

See [docs/architecture.md](docs/architecture.md) for system boundaries and security ownership.
