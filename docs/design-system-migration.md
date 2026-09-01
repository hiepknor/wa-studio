# WA Design System v1 migration guide

Rollout begins only after the v1 release candidate passes its static, unit, accessibility, reduced
motion, and visual gates. Migration changes presentation and composition; it does not redesign
Runtime contracts, persistence, domain validation, or workflow authority.

## Source of truth

- Tokens: `apps/studio/src/styles/tokens.css`
- Global focus: `apps/studio/src/styles/focus.css`
- Global motion: `apps/studio/src/styles/motion.css`
- Stable component catalog: [`design-system-components.md`](./design-system-components.md)
- Visual and state reference: `apps/studio/design-system.html`
- Product-screen reference: `apps/studio/product-fixtures.html`
- Browser gate: `npm -w @wa/studio run design-system:check`

Feature CSS may own product-specific grids, column widths, scroll boundaries, and responsive
arrangement. It may not own a recurring control, focus ring, feedback tone, typography scale,
radius, or animation duration.

The raw `--type-*` scale is foundation-only. Shared UI and feature CSS select the documented
`--text-*-size` semantic role for the region; they do not consume raw sizes or add a one-off font
size. Typography changes are made by role in `tokens.css`, then verified in the gallery specimen and
product fixtures before rollout.

## Rollout status

The v1 rollout completed on 2026-08-30 after the frozen gallery and quality gates passed. Shell and
connection, Sessions, Settings, Groups and group lists, Campaigns, Runs, and Activity now consume
the same canonical token graph and shared control/composition contracts. Main tables use
`DataTableFrame`; recurring filters and row actions use shared primitives; operational metrics and
key/value metadata use valid shared semantics.

Activity, Group, and Run inspectors use the shared `InspectorDrawer` anatomy and semantic size
contract. The supported `Workspace*` compatibility compositions remain intentionally in v1 for
other established compositions. They consume the same token, focus, motion, and accessibility
contracts and are not visual forks. Removal is deferred to a versioned v2 change, not performed as
incidental feature cleanup.

## Replacement map

| Existing feature pattern | v1 target |
| --- | --- |
| Hand-built button or icon action | `Button` + `AppIcon` |
| Raw input, textarea, or search wrapper | `TextField`, `TextAreaField`, or `SearchField` |
| Native-looking custom select | `SelectMenu` or `SearchSelect` |
| Choice rail with short peers | `SegmentedControl` |
| Choice card with consequence copy | `DecisionGroup` |
| Ad hoc chip or status text | `Badge`, optionally `StatusDot` beside accessible text |
| Inline success/error block | `InlineAlert`; transient acknowledgement uses toast |
| Feature tabs or step rail | `Tabs` or `WorkflowStepper` with matching tab panels |
| Search/filter/result row | `DataFilterToolbar` |
| Table wrapper and custom pager | `DataTableFrame` + `TablePagination` |
| Summary card grid | `SurfacePanel` + `MetricGrid` |
| Policy or diagnostic rows | `SurfacePanel` + `EvidenceList` |
| Inspector drawer | `InspectorDrawer` + `InspectorSection` / `InspectorDisclosure` |
| Large editor drawer | `WorkspaceDialog` |
| Consequential confirmation | `ConfirmationDialog` |
| Custom modal | `ModalDialog` |

## Rollout order

1. **Application shell and connection.** Establish canvas, chrome, headers, status, and setup-form
   grammar without changing managed Runtime lifecycle.
2. **Sessions and Settings.** Migrate the simpler tables, toolbars, task navigation, and setting
   rows first; use them to validate density and narrow-window behavior.
3. **Groups and group lists.** Adopt the table frame, filter toolbar, bulk selection, saved-list
   menu, inspector, and capability feedback while preserving current selection state ownership.
4. **Campaigns.** Migrate list, workspace dialog, stepper, content preview, target selection,
   preflight evidence, and confirmations without altering immutable revision semantics.
5. **Runs and Activity.** Normalize operational tables, progress/evidence, inspector, filters, and
   timestamps while preserving polling and cache ownership.
6. **Repository cleanup.** Remove zero-use compatibility CSS/components, then re-run the complete
   contract and visual audit.

Inspector acceptance is container-aware: verify Activity at 1100px overlay, Group at 1440px docked,
and Run at 1920px expanded docked in addition to the normal application viewports. The primary work
area must remain at least 760px when docked, focus must return to the exact invoking control, and
only the inspector body may own vertical scrolling.

One rollout unit is one screen or one independently testable workspace. Do not mix domain refactors
with a visual migration commit.

## Per-screen procedure

1. Record the current component tree, state owners, scroll owners, keyboard path, and async states.
2. Map recurring UI to the stable catalog; list deliberate feature-owned layout exceptions.
3. Replace primitives first, then compositions, then delete redundant selectors.
4. Preserve labels, IDs, `aria-*` relationships, focus return, query state, selection state, and
   mutation/error behavior.
5. Add the screen's distinctive state to the gallery only when it reveals a missing shared-system
   capability; do not turn the gallery into a feature demo.
6. Run `npm run check`, the relevant integration/E2E tests, and visual inspection at the three
   accepted window sizes.

## Required states

Every migrated screen must verify loading, empty, populated, filtered-empty, partial/error,
disabled, in-progress, success, long content, and minimum-window behavior where applicable.
Overlays additionally verify Escape, outside dismissal policy, focus trap, and focus restoration.
Tables verify keyboard selection, horizontal overflow, result summary, and footer/pagination.

## Allowed exceptions

An exception must be product geometry that cannot be represented semantically, such as a domain
column width, preview aspect ratio, or workspace split. It must use existing tokens for surfaces,
text, borders, spacing, and motion, and carry a comment describing why it is feature-owned. Raw
colors, one-off focus visuals, duplicated primitive anatomy, and decorative semantic color are not
exceptions.

The current reviewed product composites are the workspace navigation row, Session switcher
listbox, Group scope/list option rows, Settings operation rows, and media-preview geometry. Their
domain layout and interaction state remain feature-owned; their tokens, focus treatment, icons,
feedback tones, and primitive controls remain Design System-owned.

## Definition of done

A rollout unit is complete only when:

- Shared primitives own all recurring visual and accessibility behavior.
- No redundant feature selector remains.
- Domain behavior and tests are unchanged or intentionally expanded.
- Static contracts, unit tests, Axe, reduced motion, and visual baselines pass.
- The deterministic product fixture for the rollout unit renders production components; only the
  Runtime API boundary may be replaced by fixture data.
- The screen works at 960 x 560, 1100 x 720, and 1500 x 850.
- A reviewer can identify any remaining compatibility surface and its removal condition.
