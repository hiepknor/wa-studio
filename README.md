# WA Studio

Desktop operations client for Automation Runtime. WA Studio manages sessions, groups, campaigns, preflight, runs, and delivery visibility through the versioned Runtime API; it never talks to OpenWA directly.

## Prerequisites

- Node.js 24+
- Rust stable
- macOS: Xcode or Xcode Command Line Tools
- A running Automation Runtime and an `X-Runtime-Key`

## Development

```bash
npm install
npm run contract:generate
npm test
npm run tauri dev
```

The default development Runtime URL is `http://127.0.0.1:3100`. Enter the development key in the connection screen; the current milestone keeps it in memory only.

## Checks

```bash
npm run check
npm run tauri build -- --debug
```

`npm run check` regenerates the pinned API types, runs frontend tests/build, then runs Rust formatting and Clippy with warnings treated as errors.

See [docs/architecture.md](docs/architecture.md) for system boundaries, contract ownership, security, and the planned feature slices.
The incremental Ink UI rollout is documented in [docs/ui-implementation-plan.md](docs/ui-implementation-plan.md).
