# WA Studio architecture

## Boundary

WA Studio and WA Runtime are versioned and built from one monorepo, but remain separate architectural
components. Studio does not call OpenWA, PostgreSQL, queues, or workers directly. WA Runtime owns
business rules, authorization, preflight, campaign execution, delivery state, and Gateway
compatibility. OpenWA remains an external deployment pinned to the reviewed tag and contract digest
in `release/components.json`.

```text
WA Studio desktop
  -> loopback WA Runtime API v1 / worker / scheduler
      -> managed PostgreSQL queue and business state
      -> signed command ingress -> WA Studio Connector -> OpenWA Gateway (reviewed tag)
      <- connector heartbeat and send evidence through the Event Inbox
      <- durable Event Inbox claim / lease / receipt ACK
```

This boundary lets future web and mobile clients use the same WA Runtime contract without moving orchestration logic into a UI.

## Component identity

The monorepo and desktop release remain **WA Studio** (`wa-studio`). **WA Runtime** (`wa-runtime`)
is the client-independent engine: API contract, sidecar process, business services, workers,
scheduler, and durable state ownership. OpenWA is neither component; it remains an external pinned
gateway. “Runtime” in UI copy always refers to the engine, never to the desktop product.

These names are checked at release time against the Studio and Runtime npm packages, Runtime source
manifest, Cargo package, Tauri product name, sidecar declaration, and the immutable Tauri identifier
`dev.hiepknor.wastudio`. Existing application data paths and installation identity are not renamed.
See [ADR 018](../services/runtime/docs/adr/018-studio-runtime-component-identity.md).

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

Modal workflows use the shared dialog primitives as the sole focus owner. While open, they portal above the application, make every background body sibling inert, lock body scrolling, trap keyboard focus, and restore the still-connected invocation target after close. The visual backdrop is hidden from the accessibility tree; the named close or cancel button remains the single discoverable dismissal control. Confirmation submission is synchronously single-flight, and guarded workspace navigation consumes its pending destination before applying it, so repeated input in one browser task cannot repeat a destructive action or navigation side effect.

## Security

The native supervisor stores the Runtime key, OpenWA API key, derived webhook secret, Event Inbox
device token, callback and session scope in the operating-system credential store (macOS Keychain).
The Runtime credential payload uses schema v2. Secrets never cross the Tauri command response into
React, source control, logs, local storage, or Vite environment variables. On first secure-store
access, a supported legacy schema-v1 `secrets.json` is migrated into missing credential-store entries
and removed only after every write succeeds; secure-store failures never fall back to plaintext.

Tauri HTTP permissions and its custom-header feature are intentionally explicit. The build permits
the local development origins and the production Event Inbox at `https://wa-events.onio.cc`.
WA Runtime remains bound to loopback; arbitrary user-entered origins remain blocked by the native
layer.

The developer-only external Runtime fallback accepts an origin or that origin's `/api/v1` root,
requires HTTPS outside loopback, and rejects URL credentials, query strings and fragments. Its API
key remains memory-only and is attached behind an exact-origin transport policy: redirects are
denied, every request has a 30-second deadline, success bodies are capped at 8 MiB, error bodies at
256 KiB, and outgoing request bodies at 2 MiB. Managed Runtime requests cross the webview boundary
without a key and retain the same API-path, cancellation and response bounds; the Rust transport
independently revalidates them and injects the key from native state.

Runtime read methods accept an `AbortSignal`. Each screen owns independent latest-read slots for
directories, details and polling: a new request aborts the superseded transport, and session changes,
drawer/dialog closure and component unmount abort any remaining read. Request revision and target
keys remain a second guard against adapters that resolve after cancellation. Submitted mutations are
not automatically aborted because a lost response cannot prove that Runtime did not commit the
operation. The HTTP boundary records whether a failed request reached the transport adapter. A
post-dispatch mutation failure is treated as an unknown outcome: idempotent creates, session sync,
capability refresh, and run lifecycle actions retain their original request key; revisioned updates
reload canonical Runtime state while preserving staged operator input; deletes confirm presence
before offering another attempt; and
asynchronous requests continue observation when a durable result can still appear. Session changes,
target changes and unmount invalidate the UI continuation so a late mutation cannot write old-session
state or start a later step in a multi-step save. Typed HTTP failures remain authoritative and are
never reclassified as transport ambiguity.

Settings and managed setup apply the same ownership rule to native operations that cannot be
aborted. Each surface invalidates superseded or unmounted continuations before it updates React
state, while the native operation itself is allowed to finish. Native mutations acquire a
single-flight token synchronously before React busy state renders; the ownership primitives restore
their mounted state after React StrictMode's development effect rehearsal. Recovery mutations are
mutually exclusive, and a committed backup or restore is reported separately from a failed follow-up refresh
so the UI never invites a duplicate destructive retry. Independent diagnostics and backup reads
retain whichever result succeeds. Native error copy is normalized before display and redacts any
submitted OpenWA key or recovery passphrase.

Campaign editing follows the same rule across details, target replacement, saved-list application,
run launch/state changes, and deletion. These writes share one synchronous single-flight owner per
editor, while preflight has an independent read owner that is invalidated as soon as persisted input
becomes dirty. Closing or retargeting the editor clears every busy projection immediately and makes
late continuations observationally inert. A run response is the commit boundary: if a subsequent
Campaign refresh fails, Studio keeps the canonical run result and reports only the refresh failure,
never presenting a committed launch or state change as safe to retry.

The Runs inspector cancels any in-flight detail poll before dispatching a lifecycle mutation and
admits only one pause, resume, or cancel request at a time. Each action/run intent owns one UUID that
survives an unconfirmed response. Retrying that intent replays the Runtime receipt instead of applying
the transition twice. Retargeting or closing the inspector invalidates the old continuation without
attempting to abort a possibly committed write. When the write response is ambiguous, canonical
detail/list reconciliation preserves the ambiguity warning instead of clearing it at refresh start,
so refreshed state never masquerades as proof that the original request failed.

Initial managed setup and developer fallback attachment use the same synchronous single-flight
boundary, so repeated form or confirmation events cannot dispatch overlapping provision, restore,
or attach operations. A late stored-profile read never replaces an OpenWA URL the operator has
already edited, and a new degraded episode clears the previous recovery catalog before loading and
presenting the current verified recovery points.

## Initial workflow

1. Normalize the OpenWA origin and verify its live release against the reviewed pin.
2. Install or validate the release-pinned WA Studio Connector, then reject provisioning if any other
   connector ingress instance already exists. This read-before-pair ownership gate prevents a second
   local workspace from taking over the Event Inbox before the OpenWA conflict is visible.
3. Read `/.well-known/wa-studio` and pair one stable desktop device with the discovered Event Inbox
   using an API key that exposes exactly one OpenWA session.
4. Provision one prepared connector credential. Configure the same connector identity as the OpenWA
   plugin's base lifecycle config, managed-session override and ingress-instance config; replace the
   plugin's active session set with that one session before enabling it.
5. Reconcile the ingress instance and require plugin health before persisting the returned device,
   signing, connector and session credentials in the operating-system credential store.
6. Start managed PostgreSQL and Runtime, then require a fresh Event Inbox heartbeat whose connector,
   credential, binding, protocol and journal generations exactly match the stored profile.

The OpenWA plugin API owns one worker and supplies only base config during `onEnable`, so this release
deliberately permits one WA Studio Connector ingress per OpenWA deployment. It does not emulate
multi-instance lifecycle in Studio. Changing an API key for the same normalized OpenWA origin retains
the connector identity after verifying that the new key still exposes the stored session. Disconnect
deletes the ingress, clears its session override, removes the active session, disables the last plugin
worker and overwrites the merge-only base config with a non-secret retired tombstone before revoking
Event Inbox ownership.

## Desktop workspace state

After authentication, `RuntimeConnectionProvider` holds the normalized WA Runtime origin, API key, typed API client, initial sessions, and selected session in process memory. The session list returned during credential verification is reused when the workspace opens, so entering the shell does not duplicate `GET /sessions`.

Connection discovery and supervisor events share one ordered ownership boundary. Once a supervisor
event has arrived, an older discovery result or discovery failure cannot replace it. Starting a new
attach aborts the previous probe; even adapters that ignore cancellation cannot let a stale success
or failure replace the newer connection. Session refresh reports whether its response was actually
accepted, so a screen that disconnects or unmounts never announces a stale reload as successful.

The shell treats the selected session as shared workspace context. Its toolbar selector is therefore the single context switch used by current and future Groups, Campaigns, Runs, and Activity pages. Destinations and availability live in `src/app/workspace-pages.ts`; adding a feature page means registering it there and adding its renderer, without duplicating sidebar or status-bar logic. Unimplemented destinations remain visibly disabled rather than presenting mock workflows.

Disconnect clears the connection profile, API client, sessions, and selection. A monotonically increasing connection revision prevents late connect or refresh responses from restoring state after disconnect. Session full sync follows the durable WA Runtime workflow: request a sync run with one stable UUID, poll its status, then refresh session read models after completion. The UUID is retained only while the dispatch outcome is unknown, so a retry observes the original durable run. Studio admits one sync dispatch before React busy state renders, cancels polling when its session or screen loses ownership, and removes abort listeners after each completed poll delay.

## Campaign draft boundary

The Campaign list is a Runtime-owned projection. Studio sends the trimmed, debounced query and selected status/schedule arrays to Runtime, renders the returned page in Runtime order, and uses `meta.total` for pagination. Search input remains separate from the applied request state. Query, filter, offset, session, and component-lifetime request keys prevent late responses from replacing newer results; a session change clears all list criteria. Studio neither filters nor sorts the returned page locally.

Campaign creation owns one UUID idempotency key per create intent. The key survives transport failure and response loss; only opening a new create intent allocates a new key. HTTP 201 and HTTP 200 replay are reconciled by campaign ID so the list cannot gain a duplicate row.

The editor keeps Runtime DTOs authoritative. The transport canonicalizes IMMEDIATE create requests to `scheduledAt: null`; content-only PATCH requests omit scheduling fields. Changing ONCE to IMMEDIATE sends `scheduledAt: null`; changing IMMEDIATE to ONCE sends a timezone-qualified timestamp that Runtime canonicalizes to UTC. Manual target PUT requests are complete replacement sets, validated for uniqueness and the 1,000-item limit before submission, and carry `expectedTargetsRevision`. Studio commits only canonical `data`, `targetsRevision`, and nullable `source`; a manual replacement clears Group List provenance according to Runtime's response.

Preflight evaluates persisted state only. The UI renders Runtime status, counters, policy version, stable check codes, and issue reasons—including stale capability—without recomputing policy, with a safe display fallback for future codes. Local edits make a displayed result stale, successful details/target persistence clears it, and returned campaign/target revisions are checked against the current campaign.

Run creation is a separate, explicit action after review. Studio sends both reviewed campaign and target revisions with an idempotency key retained across transport retry. LIVE also returns the signed, short-lived proof from the displayed passing preflight, so confirmation is bound to that campaign/session/revision snapshot. DRY_RUN can be repeated while the campaign remains DRAFT. LIVE requires confirmation; a successful launch refreshes the campaign into its Runtime-owned read-only lifecycle. Revision, proof, and launch conflicts are never retried with newer state: Studio reloads campaign, target, and run state and requires review/preflight again. Pause, resume, and cancel each retain a per-action/run UUID after response loss; Runtime replays the receipt, including a prior blocked-resume rejection, while returning the current canonical run on successful replay. They reconcile both run state and the coarser campaign lifecycle. Run `targetSource` is immutable audit data and is never resolved through the current Group List.

Campaign deletion is a revision-safe removal from the active workspace, not audit erasure. Studio sends the displayed campaign and target revisions, waits for Runtime HTTP 204 before removing the row, and preserves current list criteria while refreshing the authoritative page. Only DRAFT and ARCHIVED snapshots can enter confirmation locally; Runtime remains authoritative for lifecycle and unfinished-run conflicts. Revision conflicts refresh without automatic retry and require a new operator confirmation. Runtime retains run, delivery, and message-job history.

## Reusable group-list boundary

Runtime Group Lists are session-scoped static templates, not saved queries or dynamic segments. Groups exposes All groups and Group lists as two views under the existing single sidebar destination. List create owns one UUID idempotency key per intent; editing loads complete canonical membership, keeps persisted and staged IDs separate, sends aggregate revision for metadata/delete and membership revision for replacement, and never retries a conflict silently. Product copy describes deletion from saved lists; Runtime implements it as an idempotent archive. Studio waits for HTTP 204 before removing the item, and deleting a list does not alter any campaign target snapshot.

The scope controller admits only one multi-step save pipeline at a time. Scope, session, and component-lifetime changes invalidate every remaining continuation, while catalog and membership reads require both a matching request revision and current abort-signal ownership before committing state. This second guard protects the UI even when a transport adapter ignores cancellation.

Applying a Group List to Campaign targets uses Runtime's atomic apply endpoint with `groupListId`, `expectedMembershipRevision`, and `expectedTargetsRevision`. It replaces the materialized campaign target snapshot with the canonical response and records nullable source provenance; it does not fetch/copy membership in Studio and does not create a campaign–list binding. Later list rename, edit, or archive cannot mutate existing campaign targets.

Campaign and run provenance render the required `groupListNameSnapshot` returned by Runtime. Studio never resolves the current Group List merely to reconstruct historical naming. A manual target replacement clears source to `null` and the UI presents the result as a custom selection.

`apps/studio/src/features/groups/selection` owns the shared Runtime-backed directory query, filter toolbar, selection table, and ordered set helpers used by both Group List editing and Campaign Targets. Search, filters, pagination, request identity, and page-scoped select-all therefore have one implementation. Selected IDs remain independent of the current response page, and inactive, DENIED, and UNKNOWN groups remain selectable because Runtime preflight owns eligibility policy.

Applying a Group List uses Runtime's atomic endpoint with membership and target revision preconditions. The canonical response replaces the persisted Campaign target snapshot and records provenance without creating a live campaign–list binding. Later Group List edits or archival cannot change an already materialized Campaign snapshot; subsequent manual target replacement clears provenance.
