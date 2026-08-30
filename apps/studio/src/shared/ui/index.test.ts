import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as publicUi from "./index";

const PUBLIC_RUNTIME_EXPORTS = [
  "ActionFooter",
  "AppIcon",
  "Badge",
  "BrandMark",
  "Button",
  "Checkbox",
  "ConfirmationDialog",
  "DataFilterToolbar",
  "DataTable",
  "DataTableEmptyCell",
  "DataTableFrame",
  "DataTablePrimaryAction",
  "DataTableScroll",
  "DataTableSelectionBar",
  "DateTime",
  "DecisionGroup",
  "DescriptionList",
  "Drawer",
  "DrawerHost",
  "DrawerProvider",
  "DropdownMenu",
  "DropdownMenuItem",
  "DropdownMenuSeparator",
  "EmptyState",
  "EvidenceList",
  "FilterChip",
  "FilterOption",
  "InlineAlert",
  "InspectorDisclosure",
  "InspectorDrawer",
  "InspectorSection",
  "MetricGrid",
  "ModalDialog",
  "OverflowMenu",
  "PageHeader",
  "SearchField",
  "SearchSelect",
  "SectionHeader",
  "SegmentedControl",
  "SelectMenu",
  "StatusDot",
  "SurfacePanel",
  "SwitchField",
  "TablePagination",
  "Tabs",
  "TextAreaField",
  "TextField",
  "ToastProvider",
  "WorkflowStepper",
  "WorkspaceDialog",
  "WorkspaceDisclosurePanel",
  "WorkspaceDrawer",
  "WorkspaceEmptyState",
  "WorkspaceFooter",
  "WorkspacePanel",
  "WorkspaceSectionHeader",
  "WorkspaceSummaryCard",
  "useToast",
] as const;

const PUBLIC_TYPE_EXPORTS = [
  "ActionFooterProps",
  "AppIconName",
  "AppIconProps",
  "AppIconSize",
  "BadgeProps",
  "BrandMarkProps",
  "ButtonProps",
  "ButtonSize",
  "ButtonVariant",
  "CheckboxProps",
  "ConfirmationDialogProps",
  "DataFilterToolbarProps",
  "DataTableEmptyCellProps",
  "DataTableFrameProps",
  "DataTablePrimaryActionProps",
  "DataTableProps",
  "DataTableScrollProps",
  "DataTableSelectionBarProps",
  "DateTimePrecision",
  "DateTimeProps",
  "DecisionGroupOption",
  "DecisionGroupProps",
  "DescriptionListItem",
  "DescriptionListProps",
  "DrawerMode",
  "DrawerProps",
  "DrawerProviderProps",
  "DrawerSize",
  "DropdownMenuItemProps",
  "DropdownMenuProps",
  "DropdownTriggerProps",
  "EmptyStateProps",
  "EvidenceListItem",
  "EvidenceListProps",
  "FeedbackTone",
  "FilterChipProps",
  "FilterOptionProps",
  "HeadingLevel",
  "InlineAlertProps",
  "InspectorDisclosureProps",
  "InspectorDrawerProps",
  "InspectorSectionProps",
  "MetricGridItem",
  "MetricGridProps",
  "ModalDialogProps",
  "OverflowMenuProps",
  "PageHeaderProps",
  "RelativeDateTimeStyle",
  "SearchFieldProps",
  "SearchSelectOption",
  "SearchSelectProps",
  "SectionHeaderProps",
  "SegmentedControlOption",
  "SegmentedControlProps",
  "SelectMenuOption",
  "SelectMenuProps",
  "StatusDotProps",
  "SurfacePanelProps",
  "SwitchFieldProps",
  "TabItem",
  "TablePaginationProps",
  "TabsProps",
  "TextAreaFieldProps",
  "TextFieldProps",
  "ToastInput",
  "ToastProviderProps",
  "WorkflowStepItem",
  "WorkflowStepperProps",
  "WorkspaceDialogProps",
  "WorkspaceDisclosurePanelProps",
  "WorkspaceDrawerProps",
  "WorkspaceEmptyStateProps",
  "WorkspaceFooterProps",
  "WorkspacePanelProps",
  "WorkspaceSectionHeaderProps",
  "WorkspaceSummaryCardProps",
  "WorkspaceSummaryMetric",
] as const;

function exportedTypeNames(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "index.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isExportDeclaration(statement)
      || !statement.exportClause
      || !ts.isNamedExports(statement.exportClause)
    ) return [];
    return statement.exportClause.elements
      .filter((element) => statement.isTypeOnly || element.isTypeOnly)
      .map((element) => element.name.text);
  }).sort();
}

describe("shared UI public API", () => {
  it("changes only through an explicit contract update", () => {
    expect(Object.keys(publicUi).sort()).toEqual([...PUBLIC_RUNTIME_EXPORTS].sort());
    expect(exportedTypeNames(readFileSync("src/shared/ui/index.ts", "utf8")))
      .toEqual([...PUBLIC_TYPE_EXPORTS].sort());
  });
});
