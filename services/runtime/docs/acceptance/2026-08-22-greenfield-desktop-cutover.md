# Greenfield desktop-managed production cutover — 2026-08-22

## Decision and boundary

This was a clean greenfield cutover: no old Runtime data, no migration import and no fallback
deployment. OpenWA remains unchanged and pinned to `0.22.0`; the VPS hosts only Event Inbox and its
dedicated PostgreSQL database.

## VPS result

| Item | Accepted state |
| --- | --- |
| Discovery | `https://openwa.onio.cc/.well-known/wa-studio` → `https://wa-events.onio.cc` |
| Public callback | `https://wa-events.onio.cc/api/v1/webhooks/openwa` |
| Event Inbox image | `wa-runtime@sha256:d4e37232821982e962f96f6911ba07313eb8edab69531c45c9435683921d734c` |
| PostgreSQL image | `postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193` |
| Queue bounds | 100,000 events, 256 MiB aggregate payloads, 256 KiB/event, seven-day expiry |
| OpenWA image | `ghcr.io/rmyndharis/openwa:0.22.0@sha256:9cc0059361d3339d80af1c69c9ef221031905d3e2669597e0cb3d6de26318b50` |
| Root filesystem | 45% used, 32 GiB available |

The legacy relay project, containers, networks, PostgreSQL volume, directory and image were removed.
The old buffered data was intentionally not migrated and is unrecoverable by design.

## Runtime and Studio result

WA Studio packages Runtime, worker, scheduler and managed PostgreSQL locally. Native provisioning
accepts only OpenWA Base URL and API key, verifies `0.22.0`, discovers Event Inbox and stores schema-v2
credentials in an atomically-written protected local file (`0700` directory / `0600` file). React never
receives these credentials.

## Verification evidence

| Gate | Result |
| --- | --- |
| WA Runtime `npm run check` | Passed: 47 test files, 177 tests, architecture, typecheck and build |
| Runtime Event Inbox E2E | Passed: pairing, HMAC, deduplication, lease fencing, retry, ACK and poison isolation |
| WA Studio `npm run check` | Passed: 44 test files, 314 tests, frontend build, Rust fmt/clippy and release preflight |
| Packaged managed Runtime E2E | Passed: OpenWA `0.22.0` registration, Event Inbox claim/ACK, local PostgreSQL dedup and native shutdown |
| Public health | Ready through TLS; legacy relay and GET pairing routes return `404` |

The locally built app and DMG remain ad-hoc development artifacts. Developer ID signing and
notarization are still required before distribution.
