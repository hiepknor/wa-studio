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

Compose the shell from semantic header, navigation, content, and footer regions. Navigation is registry-driven and grouped into Operate (Groups, Campaigns, Runs, Activity) and System (Sessions, Settings). Keep page routing and the shared selected-session context in the application. Runtime connection actions belong to the toolbar menu, while concise operational context belongs to the status bar.

Status: completed with the Sessions destination active and future destinations explicitly disabled until their slices exist.

### 3. Sessions and groups

Use semantic tables, fields, buttons, badges, and alerts. Groups must use Runtime-backed pagination/filtering rather than loading a large session into a client-only table. A group detail panel shows send capability and exposes refresh as an explicit action.

Status: Sessions selection, refresh, and durable full-sync monitoring completed; Groups remains next.

### 4. Campaign editor and preflight

Use labelled form controls for campaign content and scheduling, controlled group selection for targets, and scoped alerts for preflight findings. A live run action remains visually and behaviorally distinct from dry-run or draft actions.

### 5. Run monitoring

Use native progress elements, status feedback, controlled delivery tables, and accessible confirmation dialogs for destructive controls. Pause, resume, and cancel remain Runtime commands; UI state is reconciled from durable Runtime responses.

## Quality gates per slice

1. Component tests cover keyboard interaction, loading, empty, error, and success states.
2. `npm run check` passes.
3. Tauri development build is inspected on macOS for focus, overlays, reduced motion, compact spacing, and window resizing.
4. Bundle-size changes are recorded when new UI dependencies or substantial styles are introduced.
5. No feature may call OpenWA or redefine Runtime DTOs.

Current post-migration frontend baseline: 228.64 kB JavaScript (72.10 kB gzip) and 26.49 kB CSS (6.04 kB gzip), plus 106.41 kB of locally bundled variable-font subsets. The production brand mark is an inlined SVG; native bundle icons are generated from the dedicated SVG app-icon master.

## Dependency policy

The application commits `package-lock.json` for reproducible builds. Shared controls use native semantics; UI dependencies require review for accessibility, frontend bundle size, and Tauri WebView behavior. Inter Variable and JetBrains Mono Variable are self-hosted with Latin and Vietnamese subsets so the desktop shell remains consistent across platforms without a remote asset host.
