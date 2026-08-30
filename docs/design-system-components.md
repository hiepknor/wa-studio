# WA Design System v1 component catalog

This catalog is the public UI boundary for WA Studio. A stable component may receive compatible
additions and accessibility fixes during rollout, but its current meaning and interaction model do
not change. Feature modules import components directly from `apps/studio/src/shared/ui` and do not
fork their visual anatomy.

## Stable foundations

| Component | Contract |
| --- | --- |
| `AppIcon` | Product icon vocabulary with four tokenized sizes and one stroke grammar. |
| `BrandMark` | WA Studio product mark. It is not a generic illustration surface. |
| `Button` | Primary, secondary, ghost, and danger hierarchy; small, medium, and large geometry. |
| `Badge` | Compact semantic status. `status` is for state; default is for quiet metadata. |
| `StatusDot` | Secondary status reinforcement beside text; never the only accessible label. |
| `FilterChip` | Removable active-filter summary with a complete accessible removal label. |
| `DataTablePrimaryAction` | Text-first primary action inside a data-table row. |

## Stable fields and selection

| Component | Contract |
| --- | --- |
| `TextField`, `TextAreaField` | Human and technical entry with shared size, validation, hover, disabled, and focus behavior. |
| `SearchField` | Search semantics and icon treatment; contained and toolbar variants. |
| `SelectMenu` | Small known option sets with short labels and optional descriptions. |
| `SearchSelect` | Searchable option sets and grouped availability. |
| `Checkbox` | Independent or bulk membership selection. |
| `FilterOption` | Compact checkbox/radio choice inside a filter surface. |
| `SwitchField` | Immediate durable setting; description explains operational consequence. |
| `SegmentedControl` | Two or three compact peer choices without per-option prose. |
| `DecisionGroup` | Consequential peer choices that require description or metadata. |

`FieldFrame`, field-size helpers, popup positioning, and focus ownership classes are implementation
details. Feature code must not style or reproduce them directly.

## Stable feedback and navigation

| Component | Contract |
| --- | --- |
| `InlineAlert` | Scoped status, warning, or error with optional recovery action. |
| `ToastProvider` / `useToast` | Transient acknowledgement; blocking errors stay in their owning surface. |
| `Tabs` | Peer content views with a corresponding `tabpanel` for every tab. |
| `WorkflowStepper` | Ordered editable steps with a corresponding `tabpanel` for every step. |
| `TablePagination` | Offset pagination and result position; tables always retain a footer state. |
| `DateTime` | Shared display and exact-value semantics for operational timestamps. |

## Stable overlays

| Component | Contract |
| --- | --- |
| `DropdownMenu` / `OverflowMenu` | Short contextual action sets with keyboard navigation. |
| `ModalDialog` | Bounded task or information layer. |
| `ConfirmationDialog` | Explicit destructive or consequential confirmation. |
| `Drawer` | Contextual inspection that may dock on wide windows; it is not a multi-step workspace. |
| `WorkspaceDialog` | Large multi-step or editing workspace with one scroll owner and a fixed action footer. |

## Stable compositions

| Component | Contract |
| --- | --- |
| `PageHeader`, `SectionHeader` | Page and local section hierarchy with optional actions. |
| `SurfacePanel` | Independent outlined or flat content region. Avoid same-weight nested panels. |
| `DataFilterToolbar` | Search, filters, contextual actions, and result summary in one responsive row. |
| `DataTableFrame` | One toolbar/table/footer frame. `outlined` is the standalone default with a complete panel-radius boundary; `flush` embeds a table inside an existing panel or dialog without nested chrome. |
| `MetricGrid` | Small comparable operational values with valid description-list semantics. |
| `DescriptionList` | Accessible key/value metadata whose rows retain valid description-list semantics. |
| `EvidenceList` | Status, title, explanation, and technical evidence code. |
| `EmptyState` | Scoped empty result or first-use state; action remains supplied by the feature. |
| `ActionFooter` | Sticky or fixed workflow summary and action group. |

Standalone data tables use one 8px outlined frame around toolbar, rows, and footer. The filter
toolbar, header, and body cells share a 16px horizontal inset so labels and controls never touch the
frame; selection columns use a centered 48px slot. Embedded tables use `flush` and inherit the
boundary of their parent.

## Compatibility surfaces

`WorkspaceDrawer`, `WorkspacePanel`, `WorkspaceSummaryCard`, `WorkspaceDisclosurePanel`,
`WorkspaceFooter`, and `WorkspaceEmptyState` remain supported v1 compositions for the existing
inspector and workflow surfaces. They are not the default for new work and must not be duplicated
under another name. Their replacement or removal is a v2 decision after repository usage reaches
zero.

## Internal utilities

`data-table-selection`, `list-result-summary`, `date-time`, `feedback-tone`, `field-size`,
`modal-isolation`, and `drawer-config` are behavior or formatting utilities. They are tested shared
infrastructure but do not define a visual surface by themselves.

## API freeze rule

During rollout:

- Additive props require a gallery state and a contract test.
- Changing geometry, semantics, focus, or dismissal behavior requires a v1 design-system review.
- Removing or renaming a stable prop is deferred to v2.
- Feature-specific copy, domain state, and commands never move into shared UI.
- A compatibility surface can be removed only after repository usage reaches zero.
