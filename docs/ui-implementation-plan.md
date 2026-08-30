# UI implementation plan

WA Studio uses the product-owned [WA Design System](./design-system.md), with a Warp
Terminal-inspired visual language. Warm graphite surfaces, compact spacing, quiet interaction
states, and monospace technical data support the operations-console context without importing Warp
branding or assets. Feature modules own domain language, validation, Runtime requests, server state,
and workflows; the design system owns visual hierarchy, interaction anatomy, and shared
accessibility semantics.

## Composition rules

- Prefer semantic HTML for buttons, fields, selects, alerts, cards, and data tables.
- Use the WA Studio tokens in `src/app/app.css` for color, typography, focus treatment, and component states.
- Keep the design language compact and desktop-native; reserve monospace for identifiers, URLs, timestamps, commands, and other machine-oriented data.
- Add a WA Studio component abstraction only when it encodes recurring product behavior.
- Shell CSS targets only WA Studio-owned classes.
- Keep Runtime-generated DTOs and API logic out of UI components.
- Keep `DataTable` controlled: Runtime query parameters and response metadata own filtering, sorting, and pagination.
- Match failures to their scope: field errors for invalid input, panel alerts for scoped failures, persistent banners for application-wide failures, and transient notices only for non-blocking background results.
- Treat menus, listboxes, selectors, drawers, and dialogs as a stack: `Escape` dismisses only the topmost interactive layer and restores focus to that layer's trigger.
- Use one keyboard contract for popup controls: Down opens at the first available item, Up opens at the last available item, Tab dismisses without stealing the browser's next focus target, and disabled controls cannot retain an open popup.
- Reset transient popup search state after outside-pointer dismissal so reopening always starts from canonical data rather than a hidden stale filter.

## Delivery slices

### 1. Connection screen

Use semantic form, input, button, and status elements styled by the product UI layer. Preserve the connection state machine and API tests. Cover keyboard submission, loading, rejected-key, and readiness failures.

Status: completed.

### 2. Desktop shell

Compose the shell from semantic header, navigation, content, and footer regions. Navigation is registry-driven and grouped into Operate (Groups, Campaigns, Runs, Activity) and System (Sessions, Settings). Keep page routing and the shared selected-session context in the application. WA Runtime connection actions belong to the toolbar menu, while concise operational context belongs to the status bar.

Status: completed with the Sessions, Groups, and Campaigns destinations active and future destinations explicitly disabled until their slices exist.

### 3. Sessions and groups

Use semantic tables, fields, buttons, badges, and alerts. Groups must use Runtime-backed pagination/filtering rather than loading a large session into a client-only table. A group detail panel shows send capability and exposes refresh as an explicit action.

Status: completed. Sessions owns selection, status, and read-model refresh. Groups owns Runtime-backed browse, search, filtering, pagination, detail and member inspection, capability refresh, and durable full-sync monitoring.

### 4. Campaign editor and preflight

Use labelled form controls for campaign content and scheduling, controlled group selection for targets, and scoped alerts for preflight findings. A live run action remains visually and behaviorally distinct from dry-run or draft actions.

Status: completed through Runtime-backed campaign search, persisted drafts, revision-safe manual targets, atomic Group List materialization with provenance, DRY_RUN/LIVE preflight review, explicit run launch, and pause/resume/cancel reconciliation. LIVE launch is confirmation-gated and Runtime-authoritative.

### 5. Run monitoring

Use native progress elements, status feedback, controlled delivery tables, and accessible confirmation dialogs for destructive controls. Pause, resume, and cancel remain Runtime commands; UI state is reconciled from durable Runtime responses.

### 6. Settings

Use a task-based overview with vertical section navigation for product status, managed connection,
backup/recovery, and signed updates. Keep WA Studio product controls separate from WA Runtime service
controls. Every destructive or Runtime-interrupting action stays confirmation-gated, preserves
single-flight ownership, redacts submitted secrets, and reports a failed confirmation inside the
active modal rather than behind its isolated background.

Status: implementation and component-level accessibility coverage are complete. Every Settings
section is named by its visible heading; each settings row exposes its label and description as one
accessible group; vertical task navigation, draft discard, busy operations, modal error scope, and
single-flight behavior have regression coverage. UI acceptance is based on product-task fit,
information hierarchy, desktop-window behavior, keyboard operation, and accessibility rather than
pixel parity with an external artifact.

Connection draft protection (2026-08-27): Settings now treats an edited OpenWA endpoint, replacement
credential, or live-send policy as one explicit draft. Switching Settings tasks or leaving the
workspace requires a context-specific discard confirmation, while `beforeunload` remains armed at
the shell boundary. An in-form Discard changes action restores the saved profile and clears the
replacement credential without invoking Runtime. This tranche is frontend-only and uses Vite HMR;
the running Tauri and managed Runtime processes are not restarted.

Recovery task protection (2026-08-27): Portable archive passphrases now register as an ephemeral
Settings draft and are cleared only after explicit cancel, successful completion, or confirmed task
navigation. Backup/export/import work registers as a busy navigation guard, so Settings tasks,
workspace pages, session changes, and window unload cannot silently abandon an active operation.
Navigation confirmation remains modal and changes from a locked progress state to an explicit
continue/discard choice after the operation settles.

Update task protection (2026-08-27): Read-only update checks remain safe to leave, while an accepted
signed installation registers as a busy Settings navigation task for its complete promise lifetime.
Task, workspace, session, and window navigation remain locked while WA Runtime may be paused; once
installation settles, a previously requested destination requires an explicit Continue action.
Installation failures remain retryable inside the active confirmation dialog.

Settings delivery boundary (2026-08-27): The task-based Settings slice now loads as a dedicated
feature chunk behind an accessible shell fallback. This keeps its native update/recovery dependencies
out of the initial workspace bundle: production output is 471.59 kB for the initial JS plus a
31.37 kB Settings chunk, with no Vite chunk-size warning. Direct component tests still import the
screen synchronously; shell tests cover the lazy boundary.

Settings compact-window inspection (2026-08-27): The already-running macOS Tauri app was inspected
at its configured 960×560 minimum and restored to 1100×720 without restarting Studio or Runtime.
All four tasks—Overview, Connection, Backups & recovery, and Updates—preserve the shell, vertical
task navigation, fixed status bar, and single vertical content scroll boundary; the backup table
uses contained horizontal overflow. Redundant top-level notices were removed, and shared inline
alerts now wrap both long titles and safety-critical copy instead of truncating them. No connection,
backup, restore, export, import, update, or other staging mutation was issued.

## Quality gates per slice

1. Component tests cover keyboard interaction, loading, empty, error, and success states.
2. `npm run check` passes.
3. Tauri development build is inspected on macOS for focus, overlays, reduced motion, compact spacing, and window resizing.
4. Bundle-size changes are recorded when new UI dependencies or substantial styles are introduced.
5. No feature may call OpenWA or redefine Runtime DTOs.

WA Design System v1 rollout status (2026-08-30): completed across connection, shell, Sessions,
Settings, Groups and group lists, Campaigns, Runs, and Activity. The frozen component gallery,
canonical token contract, Axe scan, reduced-motion test, keyboard-focus checks, and Darwin visual
baselines at 960×560, 1100×720, and 1500×850 are enforced in CI.

Current Campaign Drafts, Search & Preflight baseline: 310.54 kB JavaScript (93.60 kB gzip) and 52.86 kB CSS (10.45 kB gzip), plus 106.41 kB of locally bundled variable-font subsets. The production brand mark is an inlined SVG; native bundle icons are generated from the dedicated SVG app-icon master.

Groups and Sessions MVP validation (2026-08-14): `npm run check` passes with 104 tests; the macOS debug app and DMG build successfully; and staging smoke coverage passes for session reload, Runtime-backed group search, compact-window group inspection, member pagination, capability refresh, full-sync background handoff, and completed-sync metadata reconciliation. Focus treatment, compact resizing, and the overlay drawer were inspected in the debug app. The macOS reduced-motion setting was not toggled during this validation.

Campaign Drafts & Preflight validation (2026-08-14): `npm run check` passes with 160 tests, including the pinned contract checksum, generated nullable update scheduling type, idempotent create replay, canonical target replacement, typed Runtime errors, all DRY_RUN/LIVE status variants, revision staleness, late-response protection, discard confirmation, and shared form-control accessibility. Campaigns reuses the same data table, pagination, drawer, tabs, search, capability, feedback, and action primitives as Groups/Sessions. The Vite production build and Rust fmt/clippy gates pass. Native packaging and staging smoke testing were not run because this milestone was not requested for deployment.

Campaign server-side search/filter validation (2026-08-15): `npm run check` passes with 186 tests, covering 300 ms debouncing, trimmed/omitted queries, comma-separated multi-select filters, filtered pagination and empty states, offset recovery, typed validation errors, session/query/filter/unmount race protection, and the existing Draft/Target/Preflight and target-picker regressions. The Campaign Workspace and shared schedule `SelectMenu` were inspected in the live Tauri development app at 1500×850 docked, 1100×720 overlay, and the native 820×650 minimum window. The reusable workflow Tabs expose Details, Targets, and Preflight as numbered steps, skip unavailable steps during keyboard navigation, and keep later steps locked until the draft exists. Global campaign metadata is removed from the workspace chrome: schedule remains in Details, target counts remain in Targets, revision metadata remains in Preflight, and the fixed footer is reserved for current-step state and actions. Campaign rows show the searchable campaign ID rather than technical revision data. The wide Drawer uses a 480 px docked rail and 560 px overlay surface, resets body scroll when its content identity changes, preserves sticky workflow context and a fixed footer, and keeps the menu within the scrolling boundary. The Vite production build and Rust fmt/clippy gates pass. Native packaging and staging smoke testing were not run because deployment was outside this change.

Campaign Workspace target/preflight refinement (2026-08-15): `npm run check` passes with 194 tests. Targets now distinguish staged selection from the authoritative saved set, summarize additions/removals, and retain canonical state after replacement failures. Available, saved, and staged groups are merged and deduplicated into one table; selected groups remain pinned above the current server page, while one checkbox per row is the selection source of truth. The table adds Participants from the Groups read model, displays `—` for saved-only snapshots where that field is unavailable, and uses the shared server-side `TablePagination` with 20 groups per page and Runtime `meta.total`. The indeterminate header checkbox selects or clears only the current Runtime page, preserving selections from other pages and searches. Target search reuses `SearchField`, trims and debounces by 300 ms, resets the target offset, omits whitespace-only queries, and rejects late query, page, campaign, session, close, and unmount responses. The oversized selection card is replaced by a compact selected/added/removed status beside the section heading, with capacity emphasis reserved for 900+ targets. The table no longer owns a nested vertical scrollbar or sticky header; drawer body is the single content scroll boundary and the action footer remains fixed. Preflight reuses `SelectMenu` for Dry run/Live policy and exposes one `Run preflight` action; neither mode creates a run or sends a message. The live Tauri app was audited without mutating staging data at 1100×720 overlay and 820×720 minimum width; column density, select-all state, scroll ownership, footer stability, and responsive layout passed visual inspection.

Campaign target filter validation (2026-08-15): WA Studio pins Runtime OpenAPI revision `8e6e7e22cd5694085f6824d5d9adc5181aefa1b4` at SHA-256 `411f2130011c309ac6f43c081983461c3c36b00b312215f6179d94456697c991`; two client generations are byte-stable. The target picker reuses `DataFilterToolbar`, the shared filter-panel language, `TextField`, chips, buttons, and pagination used by Groups/Sessions. Runtime-backed filters cover capability status, capability freshness, inclusive minimum/maximum synchronized participant counts, and active/inactive groups. Participant inputs validate non-negative PostgreSQL int32 values locally and map Runtime typed field errors; unknown participant counts follow Runtime exclusion semantics whenever a bound is active. Search and filters reset offset, compose before pagination, preserve pinned selections, keep select-all page-scoped, and reject late filter/page responses. `npm run check` passes with 29 test files and 202 tests, TypeScript/Vite production build, and Rust fmt/clippy. The connected staging app was audited at 1100×720 and 820×720 using read-only filter requests: combined capability, freshness, participant, and state criteria updated Runtime totals while an out-of-filter saved target remained pinned; the shared panel, chips, single drawer scroll boundary, fixed footer, and responsive columns remained coherent. No staging mutation, target replacement, run, or message sending occurred.

Reusable Group Lists (2026-08-15): Groups keeps one sidebar destination and presents All groups and Group lists as top-level views. Group lists use Runtime search/pagination and a shared wide drawer for idempotent create, canonical edit, atomic complete membership replacement, and revision-safe archive. The Group List editor and Campaign Targets share the Runtime-backed group directory hook, filter toolbar, selection table, page-scoped select-all behavior, and selection helpers. Lists remain static templates rather than live bindings.

Campaign Target groups refinement (2026-08-15): Group lists are available inside the shared target toolbar. Under the provenance contract, apply is an explicit confirmed atomic replacement—not a client-side Add/Replace import—and sends both list membership and campaign target revision preconditions. Canonical targets, revision, and source replace local state wholesale. Manual selection remains staged until Save target set; saving manual changes displays that provenance will be cleared. One table continues to separate persisted/selected rows outside the current Runtime result page from current results, with page-scoped select-all.

Audience provenance and live launch migration (2026-08-15): WA Studio pins Runtime commits `8173ab8` and `b8d63ff` at SHA-256 `d8de71d177c7e14a3b79a71bd1a9d8cdf4b829e742a3cf9663148a108a874d0b`. Group List mutations use aggregate and membership revisions. Campaign target source is displayed as snapshot audit metadata without resolving or binding to the current list. Preflight renders policy v2 stale capability and future codes safely. Reviewed DRY_RUN/LIVE launches send campaign and target revision preconditions with stable retry idempotency; LIVE is confirmation-gated and switches the editor to Runtime-owned read-only lifecycle. Campaign status and run status remain distinct, and run provenance is rendered from its immutable snapshot.

Runtime Release A coordinated migration (2026-08-15): WA Studio pins Runtime release documentation HEAD `7fb0a9f`, audience launch invariants `0cddc89`, OpenWA compatibility `48ad3a0`, and OpenAPI SHA-256 `4b932b05213252c624b9d0cb359d696d30db9e90d23e1b91421286076ccec760`. Campaign and run target provenance use required immutable `groupListNameSnapshot` directly from Runtime responses; current Group List rename/archive state is never resolved into historical snapshots. Manual replacement renders Custom selection. Group List metadata, membership, and archive conflicts reload canonical state without automatic mutation retry while preserving safe operator input.

Group List editor refinement (2026-08-15): The editor now separates List details from Groups, uses domain-neutral shared selection styles, keeps persisted and staged membership visible in one table, and reports `Saved / Staged / + / −` in the sticky footer. Clean edits disable Save; Reset changes restores canonical metadata and membership without mutation; Archive is isolated from save actions; partial metadata/membership failure copy states exactly what Runtime persisted. Group List names open the editor directly and descriptions can use two lines. Live Tauri smoke confirms selection, page-scoped select-all, filters, dirty-close, Reset, sticky footer, and the minimum supported 800px window. `npm run check` passes with 32 test files and 229 tests, TypeScript/Vite production build, and Rust fmt/clippy.

Revision-safe resource deletion (2026-08-16): WA Studio pins WA Runtime HEAD `5642851bd0a12b58512e616abffc5b17366466be`, OpenAPI `1.0.0`, SHA-256 `39b6b5ac71937d75da32084e307c0af4b8548d317daed7bd73a482759a08e3db`. Campaign and Group List deletion are exposed through keyboard-accessible row and detail overflow menus, use the displayed revisions, wait for HTTP 204 before removing local items, preserve list criteria, and retain Runtime audit/history semantics. Pending confirmation blocks dismissal and duplicate submission. Revision conflicts refresh without retry and require a new confirmation; campaign state/run conflicts refresh campaign and run data, and missing items are removed as stale. `npm run test:e2e` passes two connected-workspace happy paths against the mocked Runtime boundary; the repository does not currently include a browser/WebDriver Tauri E2E harness. `npm run check` passes with 36 test files and 294 tests, the TypeScript/Vite production build, and Rust fmt/clippy. No destructive staging request was issued during visual audit.

Overlay interaction hardening (2026-08-26): Shared menus and selectors now obey one layered dismissal contract. Portaled overflow menus consume `Escape` before a drawer can observe it; Up/Down opening intent selects the expected edge item; session and group selectors reset or close transient panels when their source becomes unavailable; outside dismissal clears hidden session search state; and portal positioning remains viewport-safe even when content is wider than the available viewport. The frontend gate passes with 68 test files and 480 tests plus TypeScript and the Vite production build. The already-running Tauri development processes were intentionally not restarted.

Confirmation failure-scope audit (2026-08-27): All 11 shared confirmation call sites were classified by workflow lifetime. Short asynchronous mutations keep retryable failures inside the active modal, suppress inaccessible duplicate alerts behind modal isolation, expose one shared busy/error contract, and retain single-flight submission ownership. This covers Settings update/configuration/recovery, managed-database recovery, LIVE Campaign launch, Campaign deletion, Group List deletion, and Run cancellation. Long-running Groups synchronization intentionally hands off to its page-level durable monitor after request acceptance; synchronous discard, navigation, and disconnect confirmations do not own an asynchronous error state. The frontend gate passes with 68 test files and 488 tests plus TypeScript and the Vite production build. The already-running Tauri development processes were intentionally not restarted.

## Dependency policy

The application commits `package-lock.json` for reproducible builds. Shared controls use native semantics; UI dependencies require review for accessibility, frontend bundle size, and Tauri WebView behavior. Inter Variable and Geist Mono Variable are self-hosted with Latin and Vietnamese subsets so the desktop shell remains consistent across platforms without a remote asset host. Matter names remain optional local aliases; packaged builds deterministically fall back to the bundled Inter and Geist Mono files when those aliases are unavailable.
