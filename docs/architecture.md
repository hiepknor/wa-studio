# WA Studio architecture

## Boundary

WA Studio is the first management client for Automation Runtime. It does not call OpenWA, PostgreSQL, Redis, or workers directly. Runtime owns business rules, authorization, preflight, campaign execution, delivery state, and Gateway compatibility.

```text
WA Studio desktop
  -> Automation Runtime API v1
      -> PostgreSQL / Redis / workers
      -> OpenWA Gateway
```

This boundary lets future web and mobile clients use the same Runtime contract without moving orchestration logic into a UI.

## Source of truth

- `contracts/automation-runtime/v1/openapi.json` is the pinned Runtime v1 contract snapshot.
- `src/shared/api/generated/runtime.ts` is generated; do not edit it by hand.
- `src/shared/api/runtime-client.ts` owns URL normalization, authentication headers, transport, and error mapping.
- Feature modules consume the typed client and must not redefine Runtime DTOs.

When Runtime changes, update the snapshot from a released Runtime revision, run `npm run contract:generate`, then fix compile/test failures in affected feature modules. Additive API changes should not force UI changes; breaking changes require a new contract version or an explicit coordinated migration.

## Feature slices

```text
src/app                  composition and application shell
src/features/connection first-run connection and credential validation
src/features/sessions   session selection and status (next)
src/features/groups     browse, filter, inspect capability (next)
src/features/campaigns  draft, targets, preflight, launch (later)
src/features/runs       progress, delivery failures, controls (later)
src/shared/api          generated contract and Runtime transport
```

Keep state near its feature. Runtime data is server state; only UI preferences and connection profiles belong locally. Introduce a shared state library only when multiple completed slices prove the need.

## User interface

`@hiepknor/ink-react` supplies accessible React primitives and design tokens. It does not own routing, requests, validation rules, or domain state. See [ui-implementation-plan.md](ui-implementation-plan.md) for component mapping and incremental rollout.

## Security

The first slice holds `X-Runtime-Key` only in process memory. It is never placed in source control, local storage, logs, or a Vite environment variable. Before persistent connection profiles are added, store secrets in the OS-backed Tauri Stronghold integration. Production Runtime URLs must use HTTPS; plain HTTP is reserved for local development.

Tauri HTTP permissions and its custom-header feature are intentionally explicit. The development build permits only `127.0.0.1:3100` and `localhost:3100`; add the exact HTTPS Runtime origin to the release capability when the production endpoint is settled. Arbitrary user-entered origins remain blocked by the native layer.

## Initial workflow

1. Normalize the Runtime origin entered by the operator.
2. Call `GET /api/v1/health/ready` to verify service dependencies.
3. Call authenticated `GET /api/v1/sessions` to validate credentials and display readiness.
4. Continue to session/group management only after both checks pass.
