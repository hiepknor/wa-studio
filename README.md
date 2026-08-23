# WA Studio

WA Studio is a desktop operations workspace that bundles WA Runtime and manages a private local
PostgreSQL instance. Studio talks to the bundled Runtime over loopback; Runtime owns orchestration,
durable state, and the OpenWA integration. OpenWA remains an external, release-pinned gateway and is
not modified by this repository.

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
- OpenWA 0.22.0 Base URL and API key when exercising the real Connect flow

## Development

From the repository root:

```bash
npm ci
npm run dev
```

`npm run dev` generates the release manifest, builds the Runtime sidecar, stages Runtime migrations,
and starts Tauri. Connect accepts an OpenWA Base URL and API key. Native provisioning verifies
OpenWA 0.22.0, discovers Event Inbox, pairs the desktop device, persists the provisioning profile in
the protected local app store, and starts local PostgreSQL, API, worker, and scheduler processes.

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

`release/components.json` pins the Studio, Runtime, Runtime contract, and OpenWA versions. Run
`npm run release:manifest:check` to reject version drift, or `npm run release:manifest` to create the
manifest bundled into the desktop app.

## Signed updater releases

Development builds intentionally have no updater channel. A release operator supplies updater,
Developer ID, and notarization credentials through the CI secret store, then runs:

```bash
export WA_STUDIO_UPDATER_ENDPOINT='https://updates.example.com/wa-studio/{{target}}/{{arch}}/{{current_version}}'
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

See [docs/architecture.md](docs/architecture.md) for system boundaries and security ownership.
