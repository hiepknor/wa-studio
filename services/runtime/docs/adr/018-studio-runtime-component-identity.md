# ADR 018: WA Studio and WA Runtime component identity

- Status: Accepted
- Date: 2026-08-23
- Supersedes: ADR 002 only where it names the whole product or repository WA Runtime
- Preserves: ADR 002's completed `wa-runtime` service and storage namespace migration

## Context

ADR 002 correctly established WA Runtime as the durable control plane and removed legacy Runtime
identifiers. The codebase later became a monorepo that also builds the operator-facing Tauri
application. Calling the whole project WA Runtime now collapses two trust and release boundaries:
the desktop product that supervises local processes, and the reusable business engine consumed
through a public contract.

A wholesale rename would also churn the installed Tauri identity and data paths without improving
the Runtime API. That creates migration and recovery risk for local PostgreSQL, encrypted secrets,
backups, updater identity, and operating-system permissions.

## Decision

| Boundary | Display name | Machine identifier |
| --- | --- | --- |
| Desktop product, repository release, React UI and native supervisor | WA Studio | `wa-studio`, `@wa/studio` |
| Business engine, sidecar, service, logs and public API | WA Runtime | `wa-runtime`, `@wa/runtime` |
| Generated API consumer contract | WA Runtime contract | `@wa/runtime-contract`, contract `v1` |
| External gateway dependency | OpenWA | release pinned by `release/components.json` |

The Tauri product remains `WA Studio`; identifier `dev.hiepknor.wastudio` and established local data
paths are compatibility identifiers and must not change as part of naming cleanup. The Runtime
release manifest continues to identify `service: "wa-runtime"` in both server and desktop-managed
profiles.

The coordinated release manifest uses schema v2 and records both `product: "wa-studio"` and
`runtimeService: "wa-runtime"`. Its generation gate validates Studio, Runtime and contract package
names, Cargo package identity, Tauri display name and identifier, bundled sidecar declaration,
Runtime source service constant, and component versions. A naming drift therefore fails before
packaging rather than becoming an installed compatibility problem.

## Consequences

- Product copy can say WA Studio for operator actions and WA Runtime for engine state without
  treating them as aliases.
- Web or mobile clients may consume WA Runtime without inheriting the Studio name or desktop
  lifecycle model.
- Runtime operational namespaces established by ADR 002 remain unchanged.
- Repository, installer, updater, application data, and keychain identity remain WA Studio.
- Any future rename that changes an installed identifier requires its own migration ADR, recovery
  drill, compatibility window, and rollback plan.
