# WA Studio

Desktop operations client packaged with WA Runtime and managed PostgreSQL. WA Studio manages sessions, groups, campaigns, preflight, runs, and delivery visibility through the loopback WA Runtime API; neither Studio nor its bundled Runtime changes OpenWA.

## Prerequisites

- Node.js 24+
- Rust stable
- macOS: Xcode or Xcode Command Line Tools
- The sibling `wa-runtime` repository (or set `WA_RUNTIME_DIR`)
- OpenWA 0.22.0 credentials for managed desktop provisioning

## Development

```bash
npm install
npm run contract:generate
npm test
npm run tauri dev
```

`npm run tauri:dev` builds the Runtime desktop sidecar and copies its migrations before starting the app. Production Connect accepts only the OpenWA Base URL and API key. Native provisioning verifies OpenWA 0.22.0, reads its discovery document, pairs a device with Event Inbox, derives the session scope, and stores schema-v2 credentials in a protected local secret file (`0700` directory / `0600` file). Runtime API, worker, scheduler, queue, and PostgreSQL bind locally.

## Fresh desktop authority

Production installation is greenfield. WA Studio creates a new local Runtime database and does not
offer a VPS Runtime export/import workflow. Event Inbox delivers callbacks immediately after pairing;
old Runtime campaigns, projections, queue rows and webhook history are intentionally not copied.
Encrypted backups in Settings protect only data created by this desktop-managed deployment.

## Checks

```bash
npm run check
npm run tauri build -- --debug
```

`npm run check` regenerates the pinned API types, runs frontend tests/build, then runs Rust formatting and Clippy with warnings treated as errors.

`npm run tauri:build` creates a development artifact. On macOS without a Developer ID identity it is
unsigned or ad-hoc signed and must not be distributed as a production release.

## Signed updater releases

Normal development builds intentionally have no update channel. A release operator must provide all three values before updater artifacts can be built:

```bash
export WA_STUDIO_UPDATER_ENDPOINT='https://updates.example.com/wa-studio/{{target}}/{{arch}}/{{current_version}}'
export WA_STUDIO_UPDATER_PUBLIC_KEY='...minisign public key...'
export TAURI_SIGNING_PRIVATE_KEY='...CI secret or key path...'
export APPLE_SIGNING_IDENTITY='Developer ID Application: ...'
export APPLE_API_ISSUER='...App Store Connect issuer ID...'
export APPLE_API_KEY='...App Store Connect key ID...'
export APPLE_API_KEY_PATH='/secure/ci/AuthKey_....p8'
npm run tauri:build:signed-update
```

Instead of the App Store Connect API variables, notarization may use `APPLE_ID`, `APPLE_PASSWORD`
and `APPLE_TEAM_ID`. CI may also import `APPLE_CERTIFICATE` plus
`APPLE_CERTIFICATE_PASSWORD` instead of selecting an installed `APPLE_SIGNING_IDENTITY`.

The release command fails closed when updater signing, Developer ID signing, notarization or the
HTTPS endpoint is incomplete. After the build it verifies the nested app signature and stapled
notarization ticket. Private keys and passwords must remain in the CI secret store and must never be
committed. Before installing a downloaded and signature-verified artifact, WA Studio stops local
Runtime writers, creates and verifies a fresh encrypted `pre-update` PostgreSQL backup, stops
PostgreSQL, installs, and restarts. Installation failure restarts the existing local stack; OpenWA
is never updated by this flow.

See [docs/architecture.md](docs/architecture.md) for system boundaries, contract ownership, security, and the planned feature slices.
The incremental UI rollout is documented in [docs/ui-implementation-plan.md](docs/ui-implementation-plan.md).
