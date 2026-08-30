# WA Design System v1

Release state: **v1.0.0 frozen and fully adopted on 2026-08-30**. The public component catalog is defined in
[`design-system-components.md`](./design-system-components.md); feature adoption follows
[`design-system-migration.md`](./design-system-migration.md).

## Purpose

WA Design System is a product-owned desktop interface system for WA Studio. Its visual direction is
inspired by Warp Terminal: warm graphite surfaces, compact operational density, quiet interaction
states, and monospace technical data. It does not copy Warp branding, assets, product structure, or
screen layouts.

The system exists to make product UI predictable. Feature code owns domain language, state, and
workflows; the design system owns visual hierarchy, interaction anatomy, accessibility semantics,
and composition rules.

## Non-negotiable principles

1. **Desktop native and compact.** Controls are deliberately dense, but readable at the supported
   960 x 560 minimum window.
2. **Quiet by default.** Neutral surfaces and typography carry normal hierarchy. Semantic color is
   reserved for information, warning, danger, and meaningful success feedback.
3. **One interaction grammar.** Hover, pressed, selected, disabled, invalid, loading, and
   focus-visible states are consistent across equivalent controls.
4. **Keyboard focus is singular.** A compound control renders one keyboard-only focus indicator on
   its visible owner. Feature CSS never invents focus visuals.
5. **Technical data is explicit.** Identifiers, timestamps, versions, URLs, and policy codes use the
   mono role. Labels and prose use the body family.
6. **Hierarchy before decoration.** Spacing, typography, and surface level establish structure before
   borders or color.
7. **Product semantics first.** Native HTML and ARIA semantics are part of the component contract,
   not an optional implementation detail.
8. **No feature-owned lookalikes.** A recurring control or composition is promoted to shared UI
   instead of being redrawn in feature CSS.

## Token architecture

Tokens have three layers:

- **Foundation:** raw palette, type families, spacing scale, radius scale, motion duration, easing.
- **Semantic:** surfaces, text roles, dividers, feedback tones, and interactive state roles.
- **Component:** control, badge, selector, table, shell, overlay, and product-layout geometry.

Only `src/styles/tokens.css` may define raw colors or expose the raw type scale. Foundation colors
and `--type-*` sizes are private to that file; shared UI and features consume semantic or component
roles only. Shared UI must consume radius and motion tokens. One-pixel accessibility techniques and
intrinsic artwork dimensions are documented exceptions to the general geometry rule.

### Radius roles

| Role | Use |
| --- | --- |
| `--radius-indicator` | Checkbox-like square indicators |
| `--radius-control` | Buttons, fields, tabs, compact options |
| `--radius-panel` | Cards, alerts, listboxes, grouped content |
| `--radius-overlay` | Dialogs and elevated transient surfaces |
| `--radius-pill` | Badges, dots, radio/switch tracks |

### Motion roles

| Role | Use |
| --- | --- |
| `--motion-snap` | Small popup entry |
| `--motion-fast` | Hover and local control state |
| `--motion-base` | Selection and compact layout transition |
| `--motion-slow` | Shell or larger spatial transition |
| `--motion-spin` | Continuous progress icon cycle |

Every motion must use a named duration and easing token. Reduced-motion mode short-circuits
transitions and animations globally.

`--motion-reduced` is an implementation token used by the global reduced-motion override; feature
code must not consume it directly.

## Surface and border grammar

The surface stack is `canvas -> chrome/panel -> control -> selected/feedback`. A composition should
not introduce another surface merely to create spacing.

- Use a divider to separate adjacent regions on the same surface.
- Use a panel border only when the region must read as one independent object.
- Do not wrap a bordered panel in another bordered panel with the same visual weight.
- Do not use bottom rails or pseudo-element bars to show selection.
- Do not combine a tinted feedback surface, a status badge, and repeated semantic icons unless each
  communicates different information.
- Normal success is quiet. Warning, blocked, destructive, or invalid states receive stronger visual
  emphasis.

## Typography roles

The raw `--type-*` scale is a private foundation. Product CSS selects a semantic role based on the
meaning of the region, never by choosing a visually convenient size.

| Semantic role | Size | Use |
| --- | ---: | --- |
| `page-title` | 20px | Page and primary workspace title only |
| `overlay-title` | 15px | Dialog, workspace, and inspector identity |
| `section-title` | 14px | Local section and disclosure heading |
| `body` | 14px | Normal prose and content |
| `control` | 14px | Standard field, button, tab, and selector label |
| `control-compact` | 12px | Intentionally compact control only |
| `data-primary` | 14px | Primary row or object name |
| `data-value` | 13px | Dense operational value |
| `supporting` | 12px | Description, help, warning explanation, and secondary copy |
| `technical` | 11px | Identifier, timestamp, version, URL, policy code, and revision |
| `compact` | 11px | Badge and compact metadata label |
| `overline` | 10px | Short uppercase eyebrow and table header only |
| `metric` | 15px | Comparable summary metric |

`setup` at 36px is reserved for the connection/onboarding statement and is not a normal product
heading. Roles may currently resolve to the same raw size; keeping their names separate lets the
hierarchy evolve without feature-level rewrites.

The shipped type system is deterministic: Inter is the self-hosted display/body family and Geist
Mono is the self-hosted technical family. System-installed fonts are never placed ahead of those
families because visual baselines must render identically on every supported Mac.

Uppercase tracking is limited to short overlines and column labels. Paragraphs, actions, empty
states, warnings, and status explanations remain sentence case and never use `overline`. Mono is
reserved for the `technical` role or values whose exact shape is operationally meaningful; it is
never used to make ordinary prose appear technical.

## Primitive contract

Each shared primitive must demonstrate these applicable states in the Design System Gallery:

- default, hover, pressed, keyboard focus;
- selected or checked;
- disabled and loading;
- invalid, warning, danger, and success;
- icon-only and icon-with-label;
- long English and Vietnamese copy;
- narrow container and overflow;
- reduced motion.

The primitive set covers buttons, fields, selectors, checkboxes, filter options, switches, badges,
alerts, menus, tabs, steppers, dialogs, drawers, pagination, and empty/loading states.

## Composition patterns

The approved reusable patterns are:

- page and section header;
- toolbar with controls and result summary;
- filter panel and active-filter summary;
- data table, selection bar, pagination, and scoped empty/error state;
- summary metrics, key/value metadata, and evidence list;
- inspector and workflow workspace;
- dialog header, scroll boundary, and fixed action footer;
- settings task navigation and setting row;
- destructive action and confirmation flow.

Patterns own layout and responsive behavior. Features supply copy, data, commands, and state.

### Inspector drawer behavior

Inspectors use one stable information architecture at every window size: identity and status,
optional local navigation, prioritized sections, progressive disclosure, then a fixed action area
only when the object has available commands. Compact, standard, and wide are semantic content
sizes—not hard-coded feature widths. Their rendered width is fluid within a reviewed minimum and
maximum.

The shell chooses presentation from measured workspace geometry. It docks only when the navigation
rail, inspector, and at least 760px of primary work area all fit. Otherwise it becomes a modal
overlay and isolates the background. Large displays therefore add useful inspector width without
leaving an unusably narrow table behind; narrow displays preserve the same content and actions in
an overlay. Feature CSS may adapt internal domain grids with inspector container queries, but may
not branch on the application viewport or restyle drawer chrome.

## Accessibility contract

- All interaction remains operable by keyboard.
- Focus order follows visual order and focus is restored when a layer closes.
- Popup controls implement one documented opening, dismissal, and selection contract.
- Text and meaningful UI indicators meet WCAG AA contrast.
- Serious and critical automated accessibility findings block release.
- The system is usable at the minimum desktop window, browser zoom, and reduced motion.

## Design System v1 gate

Feature rollout starts only after all of the following are true:

- foundation, semantic, and component tokens are reviewed;
- shared UI contains no unapproved raw colors, typography, radius, or motion values;
- every primitive is represented in the gallery state matrix;
- reference compositions cover a data table, settings form, workflow dialog, inspector, and feedback
  flow;
- deterministic product fixtures cover Connection, Groups, Campaign Workspace, and the Activity,
  Group, and Run inspectors using production components with only the Runtime API boundary replaced;
- semantic, keyboard, focus, contrast, reduced-motion, and visual regression checks pass;
- accepted application baselines exist at 960 x 560, 1100 x 720, and 1500 x 850; inspector mode
  baselines additionally cover overlay at 1100px, docked at 1440px, and expanded docked at 1920px;
- the migration guide documents component mapping and allowed exceptions;
- the v1 component API is frozen before feature migration begins.

## Do / Don't

### Do

- Reuse semantic primitives and composition patterns.
- Use spacing and type hierarchy before adding a border.
- Keep technical identifiers copyable and visibly distinct from prose.
- Test long copy and asynchronous states in the primitive or pattern that owns them.

### Don't

- Recreate a button, field, badge, tab, alert, or popup inside feature CSS.
- Add a raw color, arbitrary radius, or one-off motion duration.
- Use semantic color as decoration.
- hide selection or focus behind color alone;
- add nested scrolling when a workspace already owns the vertical scroll boundary.
