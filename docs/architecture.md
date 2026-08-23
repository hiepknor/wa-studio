# WA Studio architecture

## Boundary

WA Studio and WA Runtime are versioned and built from one monorepo, but remain separate architectural
components. Studio does not call OpenWA, PostgreSQL, queues, or workers directly. WA Runtime owns
business rules, authorization, preflight, campaign execution, delivery state, and Gateway
compatibility. OpenWA remains an external deployment pinned to 0.22.0.

```text
WA Studio desktop
  -> loopback WA Runtime API v1 / worker / scheduler
      -> managed PostgreSQL queue and business state
      -> OpenWA Gateway 0.22.0
      <- durable Event Inbox claim / lease / receipt ACK
```

This boundary lets future web and mobile clients use the same WA Runtime contract without moving orchestration logic into a UI.

## Monorepo ownership

```text
apps/studio               desktop UI and native process supervisor
services/runtime          API, worker, scheduler, Event Inbox, migrations
packages/runtime-contract generated public API snapshot and TypeScript types
tooling                    sidecar packaging, lifecycle E2E, release orchestration
release/components.json   coordinated component and external dependency versions
```

The monorepo has one npm lockfile and one root command surface. Runtime is compiled into a Tauri
sidecar; no build or development path may depend on a sibling repository. Repository unification does
not collapse trust boundaries: Studio UI receives no OpenWA secret, Runtime listens on loopback in
the desktop-managed profile, and the native supervisor remains the lifecycle authority.

## Source of truth

- `packages/runtime-contract/openapi.json` is the generated WA Runtime v1 contract snapshot (OpenAPI `1.0.0`).
- `packages/runtime-contract/src/generated.ts` is generated; do not edit it by hand.
- `apps/studio/src/shared/api/runtime-client.ts` owns URL normalization, authentication headers, transport, and error mapping.
- Feature modules consume the typed client and must not redefine Runtime DTOs.

When WA Runtime changes, run `npm run contract:generate` from the monorepo root, review the generated snapshot, then fix compile/test failures in affected feature modules. Additive API changes should not force UI changes; breaking changes require a new contract version or an explicit coordinated migration.

## Feature slices

```text
apps/studio/src/app                  composition and application shell
apps/studio/src/features/connection first-run connection and credential validation
apps/studio/src/features/sessions   session selection, status, and read-model refresh
apps/studio/src/features/groups     browse, inspect, sync, and reusable static lists
apps/studio/src/features/campaigns  drafts, targets, preflight, and run lifecycle
apps/studio/src/shared/api          Runtime transport using the shared contract package
apps/studio/src/shared/platform     typed adapters for optional desktop capabilities
apps/studio/src-tauri/src/windowing native window policy and platform implementations
```

Keep state near its feature. WA Runtime data is server state; only UI preferences and connection profiles belong locally. Introduce a shared state library only when multiple completed slices prove the need.

## Native window experience

The frontend expresses window intent as `normal`, `maximized`, or `immersive`; it never selects an operating-system fullscreen API. `apps/studio/src-tauri/src/windowing` owns the state machine, native menu, shortcut, capability discovery, rollback, and platform policy. `apps/studio/src/shared/platform/windowing.ts` is the only frontend adapter for that contract.

On macOS, immersive mode uses Simple Fullscreen on the current Space. Native Space fullscreen is disabled for the main `NSWindow`, so the green title-bar control remains Zoom/Maximize and `Control-Command-F` enters or exits immersive mode without the cross-Space snapshot animation. On Windows, the same intent falls back to Tauri fullscreen and uses `F11`; Windows-specific DWM, Snap Layout, and per-monitor DPI work stays isolated behind the same Rust facade.

Native title-bar actions can change maximize state without going through a Tauri command. The facade reconciles observed native state immediately before an immersive transition or state query, which avoids reading transient AppKit state during resize while preserving the correct restore target for sequences such as Maximize → Immersive → Exit. Platform state is emitted as `window://state-changed`; application features must not infer it from viewport dimensions.

Responsive CSS still owns content layout, but it must not simulate native window transitions. Desktop typography and spacing change at explicit breakpoints rather than continuously with viewport units, preventing WebView reflow from competing with native window animation.

## User interface

WA Studio owns its semantic React controls and CSS. The interface follows a Warp Terminal-inspired operations language—graphite surfaces, restrained violet accents, compact system typography, and monospace for technical data—without copying Warp branding or assets. Feature modules continue to own accessibility, domain language, validation, WA Runtime requests, server state, and workflows. See [ui-implementation-plan.md](ui-implementation-plan.md) for the incremental rollout.

## Security

The native supervisor stores the Runtime key, OpenWA API key, derived webhook secret, Event Inbox
device token, callback and session scope in the protected local secret file under schema v2. Secrets never cross the
Tauri command response into React, source control, logs, local storage, or Vite environment variables.
Legacy schema-v1 relay records are not read or migrated.

Tauri HTTP permissions and its custom-header feature are intentionally explicit. The build permits
the local development origins and the production Event Inbox at `https://wa-events.onio.cc`.
WA Runtime remains bound to loopback; arbitrary user-entered origins remain blocked by the native
layer.

## Initial workflow

1. Normalize the OpenWA origin and verify release 0.22.0.
2. Read `/.well-known/wa-studio` from that origin.
3. Pair a stable desktop device with the discovered Event Inbox using the supplied OpenWA API key.
4. Persist the returned token, signing secret, callback and authorized session scope atomically in the protected local secret file.
5. Start managed PostgreSQL and Runtime, then reconcile the supported OpenWA webhook registration.

## Desktop workspace state

After authentication, `RuntimeConnectionProvider` holds the normalized WA Runtime origin, API key, typed API client, initial sessions, and selected session in process memory. The session list returned during credential verification is reused when the workspace opens, so entering the shell does not duplicate `GET /sessions`.

The shell treats the selected session as shared workspace context. Its toolbar selector is therefore the single context switch used by current and future Groups, Campaigns, Runs, and Activity pages. Destinations and availability live in `src/app/workspace-pages.ts`; adding a feature page means registering it there and adding its renderer, without duplicating sidebar or status-bar logic. Unimplemented destinations remain visibly disabled rather than presenting mock workflows.

Disconnect clears the connection profile, API client, sessions, and selection. A monotonically increasing connection revision prevents late connect or refresh responses from restoring state after disconnect. Session full sync follows the durable WA Runtime workflow: create a sync run, poll its status, then refresh session read models after completion.

## Campaign draft boundary

The Campaign list is a Runtime-owned projection. Studio sends the trimmed, debounced query and selected status/schedule arrays to Runtime, renders the returned page in Runtime order, and uses `meta.total` for pagination. Search input remains separate from the applied request state. Query, filter, offset, session, and component-lifetime request keys prevent late responses from replacing newer results; a session change clears all list criteria. Studio neither filters nor sorts the returned page locally.

Campaign creation owns one UUID idempotency key per create intent. The key survives transport failure and response loss; only opening a new create intent allocates a new key. HTTP 201 and HTTP 200 replay are reconciled by campaign ID so the list cannot gain a duplicate row.

The editor keeps Runtime DTOs authoritative. The transport canonicalizes IMMEDIATE create requests to `scheduledAt: null`; content-only PATCH requests omit scheduling fields. Changing ONCE to IMMEDIATE sends `scheduledAt: null`; changing IMMEDIATE to ONCE sends a timezone-qualified timestamp that Runtime canonicalizes to UTC. Manual target PUT requests are complete replacement sets, validated for uniqueness and the 1,000-item limit before submission, and carry `expectedTargetsRevision`. Studio commits only canonical `data`, `targetsRevision`, and nullable `source`; a manual replacement clears Group List provenance according to Runtime's response.

Preflight evaluates persisted state only. The UI renders Runtime status, counters, policy version, stable check codes, and issue reasons—including stale capability—without recomputing policy, with a safe display fallback for future codes. Local edits make a displayed result stale, successful details/target persistence clears it, and returned campaign/target revisions are checked against the current campaign.

Run creation is a separate, explicit action after review. Studio sends both reviewed campaign and target revisions with an idempotency key retained across transport retry. DRY_RUN can be repeated while the campaign remains DRAFT. LIVE requires confirmation; a successful launch refreshes the campaign into its Runtime-owned read-only lifecycle. Revision and launch conflicts are never retried with newer revisions: Studio reloads campaign, target, and run state and requires review/preflight again. Pause, resume, and cancel reconcile both run state and the coarser campaign lifecycle. Run `targetSource` is immutable audit data and is never resolved through the current Group List.

Campaign deletion is a revision-safe removal from the active workspace, not audit erasure. Studio sends the displayed campaign and target revisions, waits for Runtime HTTP 204 before removing the row, and preserves current list criteria while refreshing the authoritative page. Only DRAFT and ARCHIVED snapshots can enter confirmation locally; Runtime remains authoritative for lifecycle and unfinished-run conflicts. Revision conflicts refresh without automatic retry and require a new operator confirmation. Runtime retains run, delivery, and message-job history.

## Reusable group-list boundary

Runtime Group Lists are session-scoped static templates, not saved queries or dynamic segments. Groups exposes All groups and Group lists as two views under the existing single sidebar destination. List create owns one UUID idempotency key per intent; editing loads complete canonical membership, keeps persisted and staged IDs separate, sends aggregate revision for metadata/delete and membership revision for replacement, and never retries a conflict silently. Product copy describes deletion from saved lists; Runtime implements it as an idempotent archive. Studio waits for HTTP 204 before removing the item, and deleting a list does not alter any campaign target snapshot.

Applying a Group List to Campaign targets uses Runtime's atomic apply endpoint with `groupListId`, `expectedMembershipRevision`, and `expectedTargetsRevision`. It replaces the materialized campaign target snapshot with the canonical response and records nullable source provenance; it does not fetch/copy membership in Studio and does not create a campaign–list binding. Later list rename, edit, or archive cannot mutate existing campaign targets.

Campaign and run provenance render the required `groupListNameSnapshot` returned by Runtime. Studio never resolves the current Group List merely to reconstruct historical naming. A manual target replacement clears source to `null` and the UI presents the result as a custom selection.

`apps/studio/src/features/groups/selection` owns the shared Runtime-backed directory query, filter toolbar, selection table, and ordered set helpers used by both Group List editing and Campaign Targets. Search, filters, pagination, request identity, and page-scoped select-all therefore have one implementation. Selected IDs remain independent of the current response page, and inactive, DENIED, and UNKNOWN groups remain selectable because Runtime preflight owns eligibility policy.

Applying a Group List uses Runtime's atomic endpoint with membership and target revision preconditions. The canonical response replaces the persisted Campaign target snapshot and records provenance without creating a live campaign–list binding. Later Group List edits or archival cannot change an already materialized Campaign snapshot; subsequent manual target replacement clears provenance.
