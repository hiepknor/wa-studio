# Ink UI implementation plan

WA Studio uses `@hiepknor/ink-react` as its UI primitive layer. Feature modules continue to own domain language, validation, Runtime requests, server state, and workflows.

## Composition rules

- Put one `InkProvider` at the application root with `compact` density for desktop operations.
- Import the aggregate Ink stylesheet once at the application entrypoint, before product layout CSS.
- Use Ink components directly inside features. Add a WA Studio wrapper only when it encodes recurring product behavior, not merely to rename or restyle a primitive.
- Use Ink tokens for product layout CSS. Avoid copying component CSS or introducing a second token system.
- Keep Runtime-generated DTOs and API logic out of UI components.
- Keep `DataTable` controlled: Runtime query parameters and response metadata own filtering, sorting, and pagination.
- Match failures to their scope: field errors for invalid input, `ErrorState` for a failed panel, `Banner` for persistent application-wide failures, and toasts only for non-blocking background results.

## Delivery slices

### 1. Connection screen

Replace native controls and bespoke card/status styles with `Card`, `Stack`, `TextField`, `Button`, and `Alert`. Preserve the existing connection state machine and API tests. Add keyboard, loading, rejected-key, and readiness-failure component tests.

### 2. Desktop shell

Compose `Toolbar`, `Sidebar`, `Panel`, and `StatusBar`. Navigation destinations are Sessions, Groups, Campaigns, and Runs. Keep routing and selected-session state in the application; Ink owns only presentation and accessible interaction.

### 3. Sessions and groups

Use `DataTable`, `DataTableToolbar`, `Badge`, `StatusMark`, `Skeleton`, and `ErrorState`. Groups must use Runtime-backed pagination/filtering rather than loading a large session into a client-only table. A group detail panel shows send capability and exposes refresh as an explicit action.

### 4. Campaign editor and preflight

Use form primitives for campaign content and scheduling, controlled group selection for targets, and `Alert`/`ErrorState` for preflight findings. A live run action remains visually and behaviorally distinct from dry-run or draft actions.

### 5. Run monitoring

Use `Progress`, status feedback, controlled delivery tables, and `Dialog` confirmation for destructive controls. Pause, resume, and cancel remain Runtime commands; UI state is reconciled from durable Runtime responses.

## Quality gates per slice

1. Component tests cover keyboard interaction, loading, empty, error, and success states.
2. `npm run check` passes.
3. Tauri development build is inspected on macOS for focus, overlays, reduced motion, compact density, and window resizing.
4. Bundle-size changes are recorded because Ink currently ships an aggregate stylesheet.
5. No feature may call OpenWA or redefine Runtime DTOs.

## Dependency policy

The application declares the stable `1.x` package range and commits `package-lock.json` for reproducible builds. Ink upgrades are reviewed as dedicated dependency changes, including its changelog, visual behavior, accessibility checks, frontend build size, and Tauri WebView behavior.
