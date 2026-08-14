# WA Studio architecture

## Boundary

WA Studio is the first management client for WA Runtime. It does not call OpenWA, PostgreSQL, Redis, or workers directly. WA Runtime owns business rules, authorization, preflight, campaign execution, delivery state, and Gateway compatibility.

```text
WA Studio desktop
  -> WA Runtime API v1
      -> PostgreSQL / Redis / workers
      -> OpenWA Gateway
```

This boundary lets future web and mobile clients use the same WA Runtime contract without moving orchestration logic into a UI.

## Source of truth

- `contracts/wa-runtime/v1/openapi.json` is the pinned WA Runtime v1 contract snapshot copied byte-for-byte from Runtime revision `f2eb638ce8e51b74f4ff224850093b59aa11ee6a` (SHA-256 `e77b1058958dfa8238ebc3f71940165eaf5b82fd7ae2a487b183c3990071cdf2`).
- `src/shared/api/generated/runtime.ts` is generated; do not edit it by hand.
- `src/shared/api/runtime-client.ts` owns URL normalization, authentication headers, transport, and error mapping.
- Feature modules consume the typed client and must not redefine Runtime DTOs.

When WA Runtime changes, update the snapshot from a released WA Runtime revision, run `npm run contract:generate`, then fix compile/test failures in affected feature modules. Additive API changes should not force UI changes; breaking changes require a new contract version or an explicit coordinated migration.

## Feature slices

```text
src/app                  composition and application shell
src/features/connection first-run connection and credential validation
src/features/sessions   session selection, status, and read-model refresh
src/features/groups     browse, filter, inspect, capability, and full sync
src/features/campaigns  server-backed browse/filter, draft details, targets, preflight
src/features/runs       progress, delivery failures, controls (later)
src/shared/api          generated contract and WA Runtime transport
src/shared/platform     typed adapters for optional desktop capabilities
src-tauri/src/windowing native window policy and platform implementations
```

Keep state near its feature. WA Runtime data is server state; only UI preferences and connection profiles belong locally. Introduce a shared state library only when multiple completed slices prove the need.

## Native window experience

The frontend expresses window intent as `normal`, `maximized`, or `immersive`; it never selects an operating-system fullscreen API. `src-tauri/src/windowing` owns the state machine, native menu, shortcut, capability discovery, rollback, and platform policy. `src/shared/platform/windowing.ts` is the only frontend adapter for that contract.

On macOS, immersive mode uses Simple Fullscreen on the current Space. Native Space fullscreen is disabled for the main `NSWindow`, so the green title-bar control remains Zoom/Maximize and `Control-Command-F` enters or exits immersive mode without the cross-Space snapshot animation. On Windows, the same intent falls back to Tauri fullscreen and uses `F11`; Windows-specific DWM, Snap Layout, and per-monitor DPI work stays isolated behind the same Rust facade.

Native title-bar actions can change maximize state without going through a Tauri command. The facade reconciles observed native state immediately before an immersive transition or state query, which avoids reading transient AppKit state during resize while preserving the correct restore target for sequences such as Maximize → Immersive → Exit. Platform state is emitted as `window://state-changed`; application features must not infer it from viewport dimensions.

Responsive CSS still owns content layout, but it must not simulate native window transitions. Desktop typography and spacing change at explicit breakpoints rather than continuously with viewport units, preventing WebView reflow from competing with native window animation.

## User interface

WA Studio owns its semantic React controls and CSS. The interface follows a Warp Terminal-inspired operations language—graphite surfaces, restrained violet accents, compact system typography, and monospace for technical data—without copying Warp branding or assets. Feature modules continue to own accessibility, domain language, validation, WA Runtime requests, server state, and workflows. See [ui-implementation-plan.md](ui-implementation-plan.md) for the incremental rollout.

## Security

The first slice holds `X-Runtime-Key` only in process memory. It is never placed in source control, local storage, logs, or a Vite environment variable. Before persistent connection profiles are added, store secrets in the OS-backed Tauri Stronghold integration. Production WA Runtime URLs must use HTTPS; plain HTTP is reserved for local development.

Tauri HTTP permissions and its custom-header feature are intentionally explicit. The build permits
the local development origins and `https://wa-runtime-staging.onio.cc`. Add the exact production WA
Runtime origin only when that endpoint is settled. Arbitrary user-entered origins remain blocked by
the native layer.

## Initial workflow

1. Normalize the WA Runtime origin entered by the operator.
2. Call `GET /api/v1/health/ready` to verify service dependencies.
3. Call authenticated `GET /api/v1/sessions` to validate credentials and display readiness.
4. Continue to session/group management only after both checks pass.

## Desktop workspace state

After authentication, `RuntimeConnectionProvider` holds the normalized WA Runtime origin, API key, typed API client, initial sessions, and selected session in process memory. The session list returned during credential verification is reused when the workspace opens, so entering the shell does not duplicate `GET /sessions`.

The shell treats the selected session as shared workspace context. Its toolbar selector is therefore the single context switch used by current and future Groups, Campaigns, Runs, and Activity pages. Destinations and availability live in `src/app/workspace-pages.ts`; adding a feature page means registering it there and adding its renderer, without duplicating sidebar or status-bar logic. Unimplemented destinations remain visibly disabled rather than presenting mock workflows.

Disconnect clears the connection profile, API client, sessions, and selection. A monotonically increasing connection revision prevents late connect or refresh responses from restoring state after disconnect. Session full sync follows the durable WA Runtime workflow: create a sync run, poll its status, then refresh session read models after completion.

## Campaign draft boundary

The Campaign list is a Runtime-owned projection. Studio sends the trimmed, debounced query and selected status/schedule arrays to Runtime, renders the returned page in Runtime order, and uses `meta.total` for pagination. Search input remains separate from the applied request state. Query, filter, offset, session, and component-lifetime request keys prevent late responses from replacing newer results; a session change clears all list criteria. Studio neither filters nor sorts the returned page locally.

Campaign creation owns one UUID idempotency key per create intent. The key survives transport failure and response loss; only opening a new create intent allocates a new key. HTTP 201 and HTTP 200 replay are reconciled by campaign ID so the list cannot gain a duplicate row.

The editor keeps Runtime DTOs authoritative. The transport canonicalizes IMMEDIATE create requests to `scheduledAt: null`; content-only PATCH requests omit scheduling fields. Changing ONCE to IMMEDIATE sends `scheduledAt: null`; changing IMMEDIATE to ONCE sends a timezone-qualified timestamp that Runtime canonicalizes to UTC. Target PUT requests are complete replacement sets, validated for uniqueness and the 1,000-item limit before submission. The UI commits only the canonical response and refreshes the campaign afterward to obtain its new `targetsRevision`.

Preflight evaluates persisted state only. The UI renders Runtime status, counters, stable check codes, and stable issue reasons without recomputing policy. Local edits make a displayed result stale, successful details/target persistence clears it, and returned campaign/target revisions are checked against the current campaign. Editor epochs prevent late responses from a closed editor or a different session from being applied. No campaign-run or message-send operation is exposed by the Studio client in v0.2.0.
