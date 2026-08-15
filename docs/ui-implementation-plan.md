# UI implementation plan

WA Studio uses product-owned semantic React controls and CSS with a Warp Terminal-inspired visual language. Graphite surfaces, compact spacing, restrained violet accents, and monospace technical data support the operations-console context without importing Warp branding or assets. Feature modules own domain language, accessibility, validation, Runtime requests, server state, and workflows.

## Composition rules

- Prefer semantic HTML for buttons, fields, selects, alerts, cards, and data tables.
- Use the WA Studio tokens in `src/app/app.css` for color, typography, focus treatment, and component states.
- Keep the design language compact and desktop-native; reserve monospace for identifiers, URLs, timestamps, commands, and other machine-oriented data.
- Add a WA Studio component abstraction only when it encodes recurring product behavior.
- Shell CSS targets only WA Studio-owned classes.
- Keep Runtime-generated DTOs and API logic out of UI components.
- Keep `DataTable` controlled: Runtime query parameters and response metadata own filtering, sorting, and pagination.
- Match failures to their scope: field errors for invalid input, panel alerts for scoped failures, persistent banners for application-wide failures, and transient notices only for non-blocking background results.

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

Status: completed for v0.2.0 through Runtime-backed campaign search, multi-select status/schedule filtering, persisted drafts, complete target replacement, and DRY_RUN/LIVE preflight review. Campaign execution and message sending remain deferred; LIVE here is a preflight policy mode, not a launch action.

### 5. Run monitoring

Use native progress elements, status feedback, controlled delivery tables, and accessible confirmation dialogs for destructive controls. Pause, resume, and cancel remain Runtime commands; UI state is reconciled from durable Runtime responses.

## Quality gates per slice

1. Component tests cover keyboard interaction, loading, empty, error, and success states.
2. `npm run check` passes.
3. Tauri development build is inspected on macOS for focus, overlays, reduced motion, compact spacing, and window resizing.
4. Bundle-size changes are recorded when new UI dependencies or substantial styles are introduced.
5. No feature may call OpenWA or redefine Runtime DTOs.

Current Campaign Drafts, Search & Preflight baseline: 310.54 kB JavaScript (93.60 kB gzip) and 52.86 kB CSS (10.45 kB gzip), plus 106.41 kB of locally bundled variable-font subsets. The production brand mark is an inlined SVG; native bundle icons are generated from the dedicated SVG app-icon master.

Groups and Sessions MVP validation (2026-08-14): `npm run check` passes with 104 tests; the macOS debug app and DMG build successfully; and staging smoke coverage passes for session reload, Runtime-backed group search, compact-window group inspection, member pagination, capability refresh, full-sync background handoff, and completed-sync metadata reconciliation. Focus treatment, compact resizing, and the overlay drawer were inspected in the debug app. The macOS reduced-motion setting was not toggled during this validation.

Campaign Drafts & Preflight validation (2026-08-14): `npm run check` passes with 160 tests, including the pinned contract checksum, generated nullable update scheduling type, idempotent create replay, canonical target replacement, typed Runtime errors, all DRY_RUN/LIVE status variants, revision staleness, late-response protection, discard confirmation, and shared form-control accessibility. Campaigns reuses the same data table, pagination, drawer, tabs, search, capability, feedback, and action primitives as Groups/Sessions. The Vite production build and Rust fmt/clippy gates pass. Native packaging and staging smoke testing were not run because this milestone was not requested for deployment.

Campaign server-side search/filter validation (2026-08-15): `npm run check` passes with 186 tests, covering 300 ms debouncing, trimmed/omitted queries, comma-separated multi-select filters, filtered pagination and empty states, offset recovery, typed validation errors, session/query/filter/unmount race protection, and the existing Draft/Target/Preflight and target-picker regressions. The Campaign Workspace and shared schedule `SelectMenu` were inspected in the live Tauri development app at 1500×850 docked, 1100×720 overlay, and the native 820×650 minimum window. The reusable workflow Tabs expose Details, Targets, and Preflight as numbered steps, skip unavailable steps during keyboard navigation, and keep later steps locked until the draft exists. Global campaign metadata is removed from the workspace chrome: schedule remains in Details, target counts remain in Targets, revision metadata remains in Preflight, and the fixed footer is reserved for current-step state and actions. Campaign rows show the searchable campaign ID rather than technical revision data. The wide Drawer uses a 480 px docked rail and 560 px overlay surface, resets body scroll when its content identity changes, preserves sticky workflow context and a fixed footer, and keeps the menu within the scrolling boundary. The Vite production build and Rust fmt/clippy gates pass. Native packaging and staging smoke testing were not run because deployment was outside this change.

Campaign Workspace target/preflight refinement (2026-08-15): `npm run check` passes with 194 tests. Targets now distinguish staged selection from the authoritative saved set, summarize additions/removals, and retain canonical state after replacement failures. Available, saved, and staged groups are merged and deduplicated into one table; selected groups remain pinned above the current server page, while one checkbox per row is the selection source of truth. The table adds Participants from the Groups read model, displays `—` for saved-only snapshots where that field is unavailable, and uses the shared server-side `TablePagination` with 20 groups per page and Runtime `meta.total`. The indeterminate header checkbox selects or clears only the current Runtime page, preserving selections from other pages and searches. Target search reuses `SearchField`, trims and debounces by 300 ms, resets the target offset, omits whitespace-only queries, and rejects late query, page, campaign, session, close, and unmount responses. The oversized selection card is replaced by a compact selected/added/removed status beside the section heading, with capacity emphasis reserved for 900+ targets. The table no longer owns a nested vertical scrollbar or sticky header; drawer body is the single content scroll boundary and the action footer remains fixed. Preflight reuses `SelectMenu` for Dry run/Live policy and exposes one `Run preflight` action; neither mode creates a run or sends a message. The live Tauri app was audited without mutating staging data at 1100×720 overlay and 820×720 minimum width; column density, select-all state, scroll ownership, footer stability, and responsive layout passed visual inspection.

Campaign target filter validation (2026-08-15): WA Studio pins Runtime OpenAPI revision `8e6e7e22cd5694085f6824d5d9adc5181aefa1b4` at SHA-256 `411f2130011c309ac6f43c081983461c3c36b00b312215f6179d94456697c991`; two client generations are byte-stable. The target picker reuses `DataFilterToolbar`, the shared filter-panel language, `TextField`, chips, buttons, and pagination used by Groups/Sessions. Runtime-backed filters cover capability status, capability freshness, inclusive minimum/maximum synchronized participant counts, and active/inactive groups. Participant inputs validate non-negative PostgreSQL int32 values locally and map Runtime typed field errors; unknown participant counts follow Runtime exclusion semantics whenever a bound is active. Search and filters reset offset, compose before pagination, preserve pinned selections, keep select-all page-scoped, and reject late filter/page responses. `npm run check` passes with 29 test files and 202 tests, TypeScript/Vite production build, and Rust fmt/clippy. The connected staging app was audited at 1100×720 and 820×720 using read-only filter requests: combined capability, freshness, participant, and state criteria updated Runtime totals while an out-of-filter saved target remained pinned; the shared panel, chips, single drawer scroll boundary, fixed footer, and responsive columns remained coherent. No staging mutation, target replacement, run, or message sending occurred.

Reusable Group Lists (2026-08-15): WA Studio pins Runtime delivery range `f92edef^..798b306` at SHA-256 `ce54abc0b8f1184b99d1d25e1266f0e7b27c66ce4bb72e03669594eebcaf2b4e`. Groups keeps one sidebar destination and presents All groups and Saved lists as top-level views. Saved lists use Runtime search/pagination and a shared wide drawer for idempotent create, canonical edit, atomic complete membership replacement, and archive. The Group List editor and Campaign Targets share the same Runtime-backed group directory hook, filter toolbar, selection table, page-scoped select-all behavior, and selection set helpers. Applying a list to a campaign changes staged IDs only: Add unions and deduplicates, Replace requires confirmation, and Save target set remains the sole persistence point. Lists are static templates; no campaign–list provenance or live binding is stored, and no run, job, delivery, or message-send behavior is introduced. `npm run check` passes with 32 test files and 225 tests, TypeScript/Vite production build, and Rust fmt/clippy. The live dev app renders the new Groups information architecture, but mutation/persistence smoke is deferred because the staging Runtime still returns HTTP 404 for the new Group Lists endpoint.

## Dependency policy

The application commits `package-lock.json` for reproducible builds. Shared controls use native semantics; UI dependencies require review for accessibility, frontend bundle size, and Tauri WebView behavior. Inter Variable and JetBrains Mono Variable are self-hosted with Latin and Vietnamese subsets so the desktop shell remains consistent across platforms without a remote asset host.
