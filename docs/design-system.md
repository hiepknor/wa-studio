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

Only `src/styles/tokens.css` may define raw colors. Foundation colors are private to that file;
shared UI and features consume semantic or component roles only. Shared UI must consume radius and
motion tokens. One-pixel accessibility techniques and intrinsic artwork dimensions are documented
exceptions to the general geometry rule.

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

- `title`: page and primary workspace title only.
- `emphasis`: dialog and section titles.
- `body`: normal controls and content.
- `ui`: dense supporting content.
- `caption`: descriptions and secondary metadata.
- `label`: compact control metadata.
- `micro`: table headers, policy codes, and tertiary technical labels.

Uppercase tracking is limited to short labels. Paragraphs, actions, and status explanations remain
sentence case. Mono is never used to make ordinary prose appear technical.

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
- semantic, keyboard, focus, contrast, reduced-motion, and visual regression checks pass;
- accepted baselines exist at 960 x 560, 1100 x 720, and 1500 x 850;
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
