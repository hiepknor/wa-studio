import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function filesWithSuffix(directory: string, suffix: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory()
      ? filesWithSuffix(path, suffix)
      : path.endsWith(suffix)
        ? [path]
        : [];
  });
}

function cssFiles(directory: string): string[] {
  return filesWithSuffix(directory, ".css");
}

const tokensCss = readFileSync("src/styles/tokens.css", "utf8");
const designSystemDoc = readFileSync("../../docs/design-system.md", "utf8");
const componentCatalogDoc = readFileSync(
  "../../docs/design-system-components.md",
  "utf8",
);
const migrationGuideDoc = readFileSync(
  "../../docs/design-system-migration.md",
  "utf8",
);
const fontsCss = readFileSync("src/fonts.css", "utf8");
const focusCss = readFileSync("src/styles/focus.css", "utf8");
const appCss = readFileSync("src/app/app.css", "utf8");
const compositionCss = readFileSync("src/shared/ui/composition.css", "utf8");
const compositionSource = readFileSync("src/shared/ui/Composition.tsx", "utf8");
const dataTableCss = readFileSync("src/shared/ui/data-table.css", "utf8");
const dataTableSource = readFileSync("src/shared/ui/DataTable.tsx", "utf8");
const appIconCss = readFileSync("src/shared/ui/app-icon.css", "utf8");
const appIconSource = readFileSync("src/shared/ui/AppIcon.tsx", "utf8");
const buttonCss = readFileSync("src/shared/ui/button.css", "utf8");
const buttonSource = readFileSync("src/shared/ui/Button.tsx", "utf8");
const dropdownMenuCss = readFileSync("src/shared/ui/dropdown-menu.css", "utf8");
const dropdownMenuSource = readFileSync("src/shared/ui/DropdownMenu.tsx", "utf8");
const badgeCss = readFileSync("src/shared/ui/badge.css", "utf8");
const badgeSource = readFileSync("src/shared/ui/Badge.tsx", "utf8");
const inlineAlertCss = readFileSync("src/shared/ui/inline-alert.css", "utf8");
const inlineAlertSource = readFileSync("src/shared/ui/InlineAlert.tsx", "utf8");
const modalDialogCss = readFileSync("src/shared/ui/modal-dialog.css", "utf8");
const modalDialogSource = readFileSync("src/shared/ui/ModalDialog.tsx", "utf8");
const drawerSource = readFileSync("src/shared/ui/Drawer.tsx", "utf8");
const drawerConfigSource = readFileSync("src/shared/ui/drawer-config.ts", "utf8");
const inspectorDrawerSource = readFileSync("src/shared/ui/InspectorDrawer.tsx", "utf8");
const inspectorDrawerCss = readFileSync("src/shared/ui/inspector-drawer.css", "utf8");
const confirmationDialogSource = readFileSync(
  "src/shared/ui/ConfirmationDialog.tsx",
  "utf8",
);
const modalIsolationSource = readFileSync("src/shared/ui/modal-isolation.ts", "utf8");
const tabsCss = readFileSync("src/shared/ui/tabs.css", "utf8");
const tabsSource = readFileSync("src/shared/ui/Tabs.tsx", "utf8");
const workflowStepperSource = readFileSync(
  "src/shared/ui/WorkflowStepper.tsx",
  "utf8",
);
const checkboxCss = readFileSync("src/shared/ui/checkbox.css", "utf8");
const checkboxSource = readFileSync("src/shared/ui/Checkbox.tsx", "utf8");
const focusModalitySource = readFileSync("src/app/installFocusModality.ts", "utf8");
const filterOptionCss = readFileSync("src/shared/ui/filter-option.css", "utf8");
const filterOptionSource = readFileSync("src/shared/ui/FilterOption.tsx", "utf8");
const participantRangeSource = readFileSync(
  "src/features/groups/ParticipantRangeFilter.tsx",
  "utf8",
);
const groupFilterPanelSource = readFileSync(
  "src/features/groups/GroupFilterPanel.tsx",
  "utf8",
);
const groupSelectionToolbarSource = readFileSync(
  "src/features/groups/selection/GroupSelectionToolbar.tsx",
  "utf8",
);
const groupSelectionTableSource = readFileSync(
  "src/features/groups/selection/GroupSelectionTable.tsx",
  "utf8",
);
const groupSelectionCss = readFileSync(
  "src/features/groups/selection/group-selection.css",
  "utf8",
);
const groupsTableSource = readFileSync("src/features/groups/GroupsTable.tsx", "utf8");
const activityTableSource = readFileSync("src/features/activity/ActivityTable.tsx", "utf8");
const runsTableSource = readFileSync("src/features/runs/RunsTable.tsx", "utf8");
const groupsCss = readFileSync("src/features/groups/groups.css", "utf8");
const campaignsSource = readFileSync("src/features/campaigns/CampaignsScreen.tsx", "utf8");
const campaignsCss = readFileSync("src/features/campaigns/campaigns.css", "utf8");
const dataFilterToolbarCss = readFileSync("src/shared/ui/data-filter-toolbar.css", "utf8");
const dataFilterToolbarSource = readFileSync("src/shared/ui/DataFilterToolbar.tsx", "utf8");
const publicUiSource = readFileSync("src/shared/ui/index.ts", "utf8");
const workspaceShell = readFileSync("src/app/WorkspaceShell.tsx", "utf8");
const searchFieldCss = readFileSync("src/shared/ui/search-field.css", "utf8");
const searchSelectCss = readFileSync("src/shared/ui/search-select.css", "utf8");
const searchSelectSource = readFileSync("src/shared/ui/SearchSelect.tsx", "utf8");
const anchoredPopupSource = readFileSync("src/shared/ui/anchored-popup.ts", "utf8");
const selectMenuCss = readFileSync("src/shared/ui/select-menu.css", "utf8");
const selectMenuSource = readFileSync("src/shared/ui/SelectMenu.tsx", "utf8");
const segmentedControlCss = readFileSync("src/shared/ui/segmented-control.css", "utf8");
const segmentedControlSource = readFileSync("src/shared/ui/SegmentedControl.tsx", "utf8");
const decisionGroupCss = readFileSync("src/shared/ui/decision-group.css", "utf8");
const decisionGroupSource = readFileSync("src/shared/ui/DecisionGroup.tsx", "utf8");
const switchCss = readFileSync("src/shared/ui/switch-field.css", "utf8");
const switchSource = readFileSync("src/shared/ui/SwitchField.tsx", "utf8");
const textFieldCss = readFileSync("src/shared/ui/text-field.css", "utf8");
const settingsCss = readFileSync("src/features/settings/settings.css", "utf8");
const settingsScreenSource = readFileSync("src/features/settings/SettingsScreen.tsx", "utf8");
const settingsSectionSource = readFileSync("src/features/settings/SettingsSection.tsx", "utf8");
const pageHeaderSource = readFileSync("src/shared/ui/PageHeader.tsx", "utf8");
const settingsOverviewSource = readFileSync(
  "src/features/settings/SettingsOverviewPanel.tsx",
  "utf8",
);
const connectionShellSource = readFileSync(
  "src/features/connection/ConnectionShell.tsx",
  "utf8",
);
const connectionScreenSource = readFileSync(
  "src/features/connection/ConnectionScreen.tsx",
  "utf8",
);
const managedSetupSource = readFileSync(
  "src/features/connection/ManagedRuntimeSetupScreen.tsx",
  "utf8",
);
const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as {
  app: { windows: Array<{ minWidth: number }> };
};

describe("WA Design System contract", () => {
  it("defines a product-owned WARP-inspired contract and rollout gate", () => {
    expect(designSystemDoc).toContain("WA Design System is a product-owned desktop interface system");
    expect(designSystemDoc).toContain("inspired by Warp Terminal");
    expect(designSystemDoc).toContain("Feature rollout starts only after");
    expect(designSystemDoc).toContain("960 x 560, 1100 x 720, and 1500 x 850");
    expect(designSystemDoc).toContain("deterministic product fixtures cover Connection, Groups, Campaign Workspace, and the Activity");
    expect(designSystemDoc).toContain("overlay at 1100px, docked at 1440px, and expanded docked at 1920px");
    expect(designSystemDoc).toContain("The raw `--type-*` scale is a private foundation");
    expect(designSystemDoc).toContain("`technical` | 11px");
    expect(designSystemDoc).toContain("`overline` | 10px");
    expect(componentCatalogDoc).toContain("API freeze rule");
    expect(componentCatalogDoc).toContain("Raw `--type-*` foundation sizes are private");
    expect(componentCatalogDoc).toContain("Compatibility surfaces");
    expect(migrationGuideDoc).toContain("Rollout order");
    expect(migrationGuideDoc).toContain("Shared UI and feature CSS select the documented");
    expect(migrationGuideDoc).toContain("Definition of done");
    expect(migrationGuideDoc).toContain("apps/studio/product-fixtures.html");
  });

  it("publishes one explicit UI API without exposing implementation helpers", () => {
    expect(publicUiSource).toContain("WA Design System v1 public contract index");
    expect(publicUiSource).toContain('export { DataTable');
    expect(publicUiSource).toContain('export { DataFilterToolbar }');
    expect(publicUiSource).toContain("InspectorDisclosure,");
    expect(publicUiSource).toContain("InspectorDrawer,");
    expect(publicUiSource).toContain("InspectorSection,");
    expect(publicUiSource).not.toMatch(
      /(?:FieldFrame|anchored-popup|modal-isolation|focus-delegate|focus-overflow)/,
    );
    expect(componentCatalogDoc).toContain("src/shared/ui/index.ts");
  });

  it("locks one container-aware inspector drawer contract", () => {
    expect(componentCatalogDoc).toContain("New product inspectors use `InspectorDrawer`");
    expect(migrationGuideDoc).toContain("Activity at 1100px overlay, Group at 1440px docked");
    expect(drawerConfigSource).toContain("export const DRAWER_MAIN_MIN_WIDTH = 760");
    expect(drawerConfigSource).toContain('compact: { minWidth: 360, maxWidth: 440, preferredRatio: 0.26 }');
    expect(drawerConfigSource).toContain('standard: { minWidth: 400, maxWidth: 560, preferredRatio: 0.3 }');
    expect(drawerConfigSource).toContain('wide: { minWidth: 480, maxWidth: 720, preferredRatio: 0.36 }');
    expect(drawerSource).toContain('data-drawer-mode={activeSize ? layout.mode : undefined}');
    expect(drawerSource).toContain('data-drawer-size={activeSize ?? undefined}');
    expect(drawerSource).toContain('className="drawer-subheader"');
    expect(inspectorDrawerSource).toContain('className={`inspector-drawer ${className}`.trim()}');
    expect(inspectorDrawerSource).toContain('className="inspector-drawer-navigation"');
    expect(inspectorDrawerSource).toContain('className={`inspector-drawer-content ${contentClassName}`.trim()}');
    expect(inspectorDrawerCss).toContain("container-name: inspector-drawer workspace-drawer");
    expect(inspectorDrawerCss).toContain("container-type: inline-size");
    expect(inspectorDrawerSource).toContain("subheader={navigation && (");
    expect(inspectorDrawerCss).toContain("@container inspector-drawer (max-width: 380px)");
    expect(inspectorDrawerCss).not.toContain("position: sticky");

    for (const path of filesWithSuffix("src/features", ".tsx").filter((path) => (
      !path.endsWith(".test.tsx")
    ))) {
      const source = readFileSync(path, "utf8");
      expect(source, `${path} must compose inspectors through InspectorDrawer`)
        .not.toMatch(/<(?:Drawer|WorkspaceDrawer)\b/);
    }
    for (const path of cssFiles("src/features")) {
      expect(readFileSync(path, "utf8"), `${path} must not restyle drawer chrome`)
        .not.toMatch(/\.drawer-[a-z0-9-]+/i);
    }
  });

  it("keeps the token graph closed", () => {
    const source = cssFiles("src").map((path) => readFileSync(path, "utf8")).join("\n");
    const definitions = new Set(
      [...source.matchAll(/(--[a-z][a-z0-9-]+)\s*:/gi)].map((match) => match[1]),
    );
    const references = new Set(
      [...source.matchAll(/var\((--[a-z][a-z0-9-]+)/gi)].map((match) => match[1]),
    );
    expect([...references].filter((token) => !definitions.has(token)).sort()).toEqual([]);
  });

  it("locks the warm foundation and operational geometry", () => {
    expect(tokensCss).toContain("--bg: #161412");
    expect(tokensCss).toContain("--surface: #1f1d1b");
    expect(tokensCss).toContain("--fg: #faf9f6");
    expect(tokensCss).toContain("--fg-2: #afaeac");
    expect(tokensCss).toContain("--control-height: 34px");
    expect(tokensCss).toContain("--shell-header-height: 52px");
    expect(tokensCss).toContain("--shell-footer-height: 32px");
    expect(tokensCss).toContain("--table-header-height: 36px");
    expect(tokensCss).toContain("--table-row-height: 48px");
    expect(tokensCss).toContain("--table-cell-padding-inline: var(--space-4)");
    expect(tokensCss).toContain("--table-selection-width: 48px");
    expect(tokensCss).toContain("--drawer-width-compact-min: 360px");
    expect(tokensCss).toContain("--drawer-width-compact-max: 440px");
    expect(tokensCss).toContain("--drawer-width-standard-min: 400px");
    expect(tokensCss).toContain("--drawer-width-standard-max: 560px");
    expect(tokensCss).toContain("--drawer-width-wide-min: 480px");
    expect(tokensCss).toContain("--drawer-width-wide-max: 720px");
    expect(tokensCss).toContain("--rail-width: 176px");
    expect(tokensCss).toContain("--rail-width-collapsed: 52px");
    expect(tokensCss).toContain("--session-selector-panel-width: 360px");
    expect(tauriConfig.app.windows[0]?.minWidth).toBe(960);
    expect(tokensCss).toContain(
      `--app-min-width: ${tauriConfig.app.windows[0]?.minWidth}px`,
    );
  });

  it("binds the self-hosted type families and semantic scale", () => {
    expect(tokensCss).toContain('--font-display: "Inter", ui-sans-serif, system-ui, sans-serif');
    expect(tokensCss).toContain('--font-body: "Inter", ui-sans-serif, system-ui, sans-serif');
    expect(tokensCss).toContain('--font-mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace');
    expect(fontsCss).toContain('font-family: "Inter"');
    expect(fontsCss).toContain('font-family: "Geist Mono"');
    expect(tokensCss).not.toContain("Matter");
    expect(fontsCss).not.toContain('font-family: "Inter Variable"');
    expect(fontsCss).not.toMatch(/https?:\/\//i);
    expect(tokensCss).toContain("--type-micro: 10px");
    expect(tokensCss).toContain("--type-label: 11px");
    expect(tokensCss).toContain("--type-caption: 12px");
    expect(tokensCss).toContain("--type-ui: 13px");
    expect(tokensCss).toContain("--type-body: 14px");
    expect(tokensCss).toContain("--type-emphasis: 15px");
    expect(tokensCss).toContain("--type-title: 20px");
    expect(tokensCss).toContain("--type-setup: 36px");
    for (const [role, foundation] of [
      ["setup", "setup"],
      ["page-title", "title"],
      ["overlay-title", "emphasis"],
      ["section-title", "body"],
      ["body", "body"],
      ["control", "body"],
      ["control-compact", "caption"],
      ["data-primary", "body"],
      ["data-value", "ui"],
      ["supporting", "caption"],
      ["technical", "label"],
      ["compact", "label"],
      ["overline", "micro"],
      ["metric", "emphasis"],
    ] as const) {
      expect(tokensCss).toContain(`--text-${role}-size: var(--type-${foundation})`);
    }
    expect(tokensCss).toContain("--weight-regular: 400");
    expect(tokensCss).toContain("--weight-medium: 500");
    expect(tokensCss).toContain("--leading-solid: 1");
    expect(tokensCss).toContain("--leading-tight-ui: 1.2");
    expect(tokensCss).toContain("--leading-ui: 1.4");
    expect(tokensCss).toContain("--leading-copy: 1.55");
    expect(tokensCss).toContain("--control-line-height: 20px");
    expect(tokensCss).toContain("--tracking-body: 0");
    expect(tokensCss).toContain("--tracking-ui: .02em");
    expect(tokensCss).toContain("--tracking-label: .08em");
    expect(tokensCss).toContain("--tracking-editorial: .1em");
    expect(tokensCss).toContain("--tracking-title: -.015em");
    expect(tokensCss).not.toMatch(/--type-(?:nano|heading|display|hero)\b/);
    expect(tokensCss).not.toMatch(/--weight-(?:book|demi|semibold|strong)\b/);
    expect(tokensCss).not.toMatch(/--font-size-(?:xs|sm)\b/);

    const componentFiles = cssFiles("src").filter((path) => (
      path !== "src/fonts.css" && path !== "src/styles/tokens.css"
    ));
    for (const path of componentFiles) {
      const css = readFileSync(path, "utf8");
      expect(css, `${path} must use semantic font-size tokens`)
        .not.toMatch(/font-size:\s*[0-9.]+(?:px|rem)\b/i);
      expect(css, `${path} must use semantic font-weight tokens`)
        .not.toMatch(/font-weight:\s*(?:450|500|550|600|650)\b/i);
      expect(css, `${path} must use semantic leading tokens`)
        .not.toMatch(/line-height:\s*-?(?:\d|\.\d)/i);
      expect(css, `${path} must use semantic tracking tokens`)
        .not.toMatch(/letter-spacing:\s*-?(?:\d|\.\d)/i);
      expect(css, `${path} must not use retired font-size aliases`)
        .not.toMatch(/var\(--font-size-(?:xs|sm)\)/i);
      expect(css, `${path} must consume semantic typography roles instead of the raw scale`)
        .not.toMatch(/var\(--type-(?:micro|label|caption|ui|body|emphasis|title|setup)\)/i);
    }
  });

  it("maps core text roles to the product typography contract", () => {
    expect(appCss).toContain("font: var(--weight-regular) var(--text-body-size)/var(--leading-ui) var(--font-body)");
    expect(appCss).toContain("h1, h2, h3, h4, h5, h6 { font-weight: var(--weight-regular); }");
    expect(appCss).toContain("strong, b { font-weight: var(--weight-medium); }");
    expect(appCss).toContain("font-size: var(--text-body-size);\n  text-align: left;\n  white-space: nowrap;");
    expect(dataTableCss).toContain(".ui-data-table {");
    expect(dataTableCss).toContain("font-size: var(--text-data-value-size);");
    expect(dataTableCss).toContain("font-size: var(--text-data-primary-size);");
    expect(dataTableCss).toContain("font-size: var(--text-technical-size);");
    expect(dataTableCss).toContain(".ui-data-table .data-column-time,");
    expect(dataTableCss).toContain(".ui-data-table .data-cell-value,");
    expect(dataTableCss).toContain("font-weight: var(--weight-regular);");
    expect(dataTableCss).toContain("letter-spacing: var(--tracking-label);");
    expect(dataTableCss).toContain("text-transform: uppercase;");

    expect(buttonCss).toContain("font-size: var(--text-control-size)");
    expect(buttonCss).toContain("font-weight: var(--weight-medium)");
    expect(buttonCss).toContain("line-height: var(--leading-ui)");
    expect(buttonCss).toContain("letter-spacing: var(--tracking-ui)");
    expect(textFieldCss).toContain("--field-control-font-size: var(--text-control-size)");
    expect(textFieldCss).toContain("line-height: var(--control-line-height)");
    expect(searchFieldCss).not.toContain("font-size:");
    expect(searchFieldCss).toContain(".search-field-toolbar { width: clamp(280px, 34vw, 420px); max-width: 100%; }");
    expect(selectMenuCss).toContain("line-height: var(--control-line-height)");
    expect(tabsCss).toContain("font-size: var(--text-control-size)");
    expect(tabsCss).toContain("font-weight: var(--weight-regular)");
    expect(badgeCss).toContain("font-size: var(--text-compact-size)");
    expect(badgeCss).toContain("font-weight: var(--weight-regular)");
    expect(badgeCss).toContain("line-height: var(--leading-tight-ui)");
    expect(badgeCss).toContain("letter-spacing: var(--tracking-ui)");
    expect(modalDialogCss).toContain("font-size: var(--text-overlay-title-size); font-weight: var(--weight-regular); letter-spacing: var(--tracking-title)");
  });

  it("locks the WARP button anatomy and state hierarchy", () => {
    expect(tokensCss).toContain("--control-compact: 30px");
    expect(tokensCss).toContain("--control-height: 34px");
    expect(tokensCss).toContain("--control-large: 44px");
    expect(tokensCss).toContain("--hit-slop-inline: 3px");
    expect(tokensCss).toContain("--hit-slop-block: 5px");
    expect(tokensCss).toContain("--press-shift: 1px");
    expect(tokensCss).toContain("--disabled-opacity: .62");
    expect(tokensCss).toContain("--radius-indicator: 3px");
    expect(tokensCss).toContain("--radius-control: 6px");
    expect(tokensCss).toContain("--radius-panel: 8px");
    expect(tokensCss).toContain("--radius-overlay: 12px");
    expect(tokensCss).toContain("--radius-pill: 9999px");
    expect(tokensCss).not.toMatch(/--radius-(?:xs|sm|md|lg)\b/);

    expect(buttonCss).toContain("gap: var(--space-2)");
    expect(buttonCss).toContain("padding: var(--space-tight) var(--space-3)");
    expect(buttonCss).toContain("border: var(--border-width) solid var(--divider-strong)");
    expect(buttonCss).toContain("border-radius: var(--radius-control)");
    expect(buttonCss).toContain("inset: calc(var(--hit-slop-block) * -1) calc(var(--hit-slop-inline) * -1)");
    expect(buttonCss).toContain("transform: translateY(var(--press-shift))");
    expect(buttonCss).toContain(".button-secondary { background: transparent; }");
    expect(buttonCss).toContain("color: var(--text-primary)");
    expect(buttonCss).toContain(".button-danger { border-color: var(--state-danger-border); background: transparent; color: var(--state-danger); }");
    expect(buttonCss).toContain("opacity: var(--disabled-opacity)");
    expect(buttonCss).toContain(".button-sm { --button-height: var(--control-compact); padding-inline: var(--space-2); font-size: var(--text-control-compact-size); }");
    expect(buttonCss).toContain(".button-lg { --button-height: var(--control-large); padding-inline: var(--space-4); }");
    expect(buttonCss).toContain(".button-icon-only");
    expect(buttonSource).toContain("size={size}");
    expect(buttonCss).not.toMatch(/\.button-icon-only\s*\{[^}]*--button-height:/s);
    expect(buttonSource).toContain('iconOnly ? "button-icon-only" : ""');
  });

  it("keeps shared radius and motion geometry on the approved token scales", () => {
    expect(tokensCss).toContain("--motion-snap: 90ms");
    expect(tokensCss).toContain("--motion-fast: 120ms");
    expect(tokensCss).toContain("--motion-base: 150ms");
    expect(tokensCss).toContain("--motion-slow: 200ms");
    expect(tokensCss).toContain("--motion-spin: 800ms");
    expect(tokensCss).toContain("--ease-enter:");
    expect(tokensCss).toContain("--ease-exit:");
    expect(tokensCss).toContain("--shadow-flat: none");
    expect(tokensCss).toContain("--shadow-overlay:");
    expect(tokensCss).not.toMatch(/--(?:background|foreground|dim|ok|ok-soft|warning|warning-soft|danger|danger-soft|font-ui|elev-flat|elev-ring|elev-raised)\s*:/);

    for (const path of cssFiles("src").filter((path) => path !== "src/styles/tokens.css")) {
      const css = readFileSync(path, "utf8");
      expect(css, `${path} must use an approved radius token`)
        .not.toMatch(/border-radius:\s*(?:\d+(?:\.\d+)?px|50%)\b/i);
      expect(css, `${path} must use semantic radius roles`)
        .not.toMatch(/var\(--radius-(?:xs|sm|md|lg)\)/i);
      expect(css, `${path} must use named motion duration tokens`)
        .not.toMatch(/(?:transition|animation)(?:-duration)?:\s*[^;{}]*\b[1-9]\d*ms\b/i);
      expect(css, `${path} must use the shared border-width token`)
        .not.toMatch(/\bborder(?:-(?:top|right|bottom|left|block|inline))?:\s*1px\b/i);
      expect(css, `${path} must use the shared border-width token in border-width shorthands`)
        .not.toMatch(/\bborder-width:\s*[^;{}]*\b1px\b/i);
      expect(css, `${path} must use canonical semantic tokens instead of rollout aliases`)
        .not.toMatch(/var\(--(?:background|foreground|dim|ok|ok-soft|warning|warning-soft|danger|danger-soft|font-ui|elev-flat|elev-ring|elev-raised)\)/i);
      expect(css, `${path} must not consume foundation colors directly`)
        .not.toMatch(/var\(--(?:bg|surface|fg|fg-2|muted|meta|border|accent|accent-hover)\)/i);
    }

    for (const path of cssFiles("src").filter((path) => path !== "src/styles/tokens.css")) {
      const css = readFileSync(path, "utf8");
      expect(css, `${path} must use the shared spacing scale`)
        .not.toMatch(/(?:gap|row-gap|column-gap|padding(?:-[a-z]+)?|margin(?:-[a-z]+)?):[^;{}]*(?<!-)[1-9]\d*px/i);
    }
  });

  it("keeps action menus compact and semantically hierarchical", () => {
    expect(dropdownMenuCss).toContain("min-width: 220px");
    expect(dropdownMenuCss).toContain("width: min(280px, calc(100vw - var(--space-5)))");
    expect(dropdownMenuCss).toContain("min-height: var(--control-height)");
    expect(dropdownMenuCss).toContain("min-height: var(--row-height-relaxed)");
    expect(dropdownMenuCss).toContain("grid-template-columns: 18px minmax(0, 1fr)");
    expect(dropdownMenuCss).toContain("font-size: var(--text-data-value-size)");
    expect(dropdownMenuCss).toContain("font-size: var(--text-supporting-size)");
    expect(dropdownMenuCss).toContain("background: var(--state-danger-surface)");
    expect(dropdownMenuSource).toContain('className="menu-item-icon-slot"');
    expect(dropdownMenuSource).toContain('data-tone={danger ? "danger" : "neutral"}');
    expect(appCss).not.toContain(".menu-item-rich");
  });

  it("keeps modal focus ownership and backdrop semantics centralized", () => {
    for (const source of [modalDialogSource, confirmationDialogSource]) {
      expect(source).toContain("acquireModalIsolation(layer");
      expect(source).toContain('aria-hidden="true"');
      expect(source).not.toMatch(/aria-label="Close (?:modal|confirmation)"/);
    }
    expect(modalIsolationSource).toContain('document.body.style.overflow = "hidden"');
    expect(modalIsolationSource).toContain("element.inert = element !== topLayer");
    expect(modalIsolationSource).toContain("bodyObserver.observe(document.body, { childList: true })");
    expect(confirmationDialogSource).toContain("confirmRequestedRef.current");
  });

  it("locks one compact semantic badge matrix", () => {
    expect(tokensCss).toContain("--badge-min-height: 20px");
    expect(tokensCss).toContain("--badge-padding-block: var(--space-hair)");
    expect(tokensCss).toContain("--badge-padding-inline: var(--space-2)");
    expect(tokensCss).toContain("--badge-radius: var(--radius-pill)");
    expect(badgeSource).toContain("data-tone={tone}");
    expect(badgeCss).toContain("min-height: var(--badge-min-height)");
    expect(badgeCss).toContain("gap: var(--space-1)");
    expect(badgeCss).toContain("width: max-content");
    expect(badgeCss).toContain("padding: var(--badge-padding-block) var(--badge-padding-inline)");
    expect(badgeCss).toContain("border: var(--border-width) solid var(--badge-border-color)");
    expect(badgeCss).toContain("border-radius: var(--badge-radius)");
    expect(badgeCss).toContain("font-family: var(--font-body)");
    expect(badgeCss).toContain("white-space: nowrap");
    for (const tone of ["neutral", "info", "success", "warning", "danger"]) {
      expect(badgeCss).toContain(`.ui-badge-${tone} {`);
    }
  });

  it("keeps Campaign preflight feedback on shared status primitives", () => {
    expect(campaignsSource).toContain('<InlineAlert indicator title="No target issues" tone="success">');
    expect(campaignsSource).not.toContain('className="preflight-no-issues"');
    expect(campaignsCss).not.toContain(".preflight-no-issues");
    expect(campaignsCss).toContain(".preflight-check-status { flex: 0 0 auto; justify-content: center; }");
    expect(campaignsCss).not.toMatch(/\.preflight-check-status\s*\{[^}]*(?:min-width|margin-top):/s);
  });

  it("locks InlineAlert anatomy for indicator and action combinations", () => {
    expect(inlineAlertSource).toContain("data-has-action={Boolean(action) || undefined}");
    expect(inlineAlertSource).toContain("data-has-indicator={indicator || undefined}");
    expect(inlineAlertCss).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(inlineAlertCss).toContain(".inline-alert[data-has-indicator] { grid-template-columns: auto minmax(0, 1fr); }");
    expect(inlineAlertCss).toContain(".inline-alert[data-has-action] { grid-template-columns: minmax(0, 1fr) auto; }");
    expect(inlineAlertCss).toContain(".inline-alert[data-has-indicator][data-has-action] { grid-template-columns: auto minmax(0, 1fr) auto; }");
    expect(inlineAlertCss).not.toContain("justify-content: space-between");
    expect(inlineAlertCss).not.toMatch(/\.inline-alert-copy span\s*\{[^}]*opacity:/s);
  });

  it("keeps icons optically consistent across the shared size matrix", () => {
    for (const [name, size] of [
      ["xs", "12px"],
      ["sm", "14px"],
      ["md", "16px"],
      ["lg", "18px"],
    ]) {
      expect(tokensCss).toContain(`--icon-${name}: ${size}`);
      expect(appIconCss).toContain(`width: var(--icon-${name})`);
    }
    expect(tokensCss).toContain("--icon-stroke: 1.7");
    expect(appIconCss).toContain("stroke-width: var(--icon-stroke)");
    expect(appIconSource).toContain('d="M3.5 19c.4-3.2 2.3-5 5.5-5s5.1 1.8 5.5 5M14 15c3.5-.7 5.7.7 6.5 4"');
    expect(appIconSource).toContain('d="m4 13 13-7v12L4 13Z"');
    expect(appIconSource).not.toContain("absoluteStrokeWidth");
  });

  it("uses the product keyboard-only focus grammar", () => {
    expect(tokensCss).toContain("--focus-outer-color: var(--muted)");
    expect(tokensCss).toContain("--focus-inner-border: var(--muted)");
    expect(tokensCss).toContain("--focus-width: 1px");
    expect(tokensCss).toContain("--focus-offset: 0px");
    expect(focusCss).toContain('html[data-focus-modality="keyboard"] :focus-visible');
    expect(focusCss).toContain("outline: var(--focus-width) solid transparent");
    expect(focusCss).toContain("outline: var(--focus-width) solid var(--focus-outer-color)");
    expect(focusCss).toContain("border-color: var(--focus-inner-border)");
    expect(focusCss).toContain('[tabindex="-1"]:not(button):not(a):not(input):not(textarea):not(select)');
    expect(focusModalitySource).toContain('addEventListener("keydown"');
    expect(focusModalitySource).toContain('addEventListener("pointerdown"');
    expect(focusCss).toContain(".focus-owner { border-radius: var(--radius-control); }");
    expect(focusCss).toContain(
      'html[data-focus-modality="keyboard"] .focus-owner:has(> input:focus-visible)',
    );
    expect(focusCss).toContain(
      'html[data-focus-modality="keyboard"] .focus-owner > input:focus-visible',
    );
    expect(focusCss).toContain(".focus-delegate-input:focus-visible");
    expect(focusCss).toContain(
      ".focus-delegate-surface:has(.focus-delegate-input:focus-visible)",
    );
    expect(focusCss).toContain(".focus-overflow-owner:has(:focus-visible)");
    expect(focusCss).toContain(".focus-ring-inset {");
    expect(focusCss).not.toMatch(
      /\.(?:switch-field|filter-option|segmented-control|decision-group|campaign-group-list|group-list-destination|data-cell-action)/,
    );
    expect(focusCss).not.toMatch(/(?:box-shadow|background|transition)\s*:/i);
    expect(tokensCss).not.toMatch(/--(?:focus-border|focus-surface|danger-focus-border)\b/);

    for (const path of cssFiles("src").filter((path) => (
      path !== "src/styles/focus.css" && path !== "src/styles/tokens.css"
    ))) {
      const css = readFileSync(path, "utf8");
      expect(css, `${path} must delegate focus visuals to styles/focus.css`)
        .not.toMatch(/:focus(?!-within)/);
      expect(css, `${path} must not consume focus tokens as component state`)
        .not.toMatch(/var\(--focus-/);
      expect(css, `${path} must delegate outline geometry to styles/focus.css`)
        .not.toMatch(/outline(?:-offset|-color|-width|-style)?\s*:/);
    }

    for (const path of filesWithSuffix("src", ".tsx")) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/className="([^"]*\bdata-cell-action\b[^"]*)"/g)) {
        expect(match[1], `${path} action cells must allow the shared focus ring to escape`)
          .toContain("focus-overflow-owner");
      }
    }
    for (const path of cssFiles("src/features")) {
      expect(readFileSync(path, "utf8"), `${path} must use semantic focus ownership hooks`)
        .not.toContain(":focus-within");
    }
  });

  it("uses one native WARP checkbox primitive for table and membership selection", () => {
    expect(tokensCss).toContain("--selector-indicator-size: 16px");
    expect(tokensCss).toContain("--selector-hit-size: 34px");
    expect(tokensCss).toContain("--rotation-check: 45deg");
    expect(checkboxSource).toContain('className={`checkbox ${className}`.trim()}');
    expect(checkboxSource).toContain('type="checkbox"');
    expect(checkboxCss).toContain("width: var(--selector-indicator-size)");
    expect(checkboxCss).toContain("height: var(--selector-hit-size)");
    expect(checkboxCss).toContain(".checkbox:checked");
    expect(checkboxCss).toContain(".checkbox:indeterminate");
    expect(checkboxCss).toContain("width: var(--space-tight)");
    expect(checkboxCss).toContain("height: var(--space-hair)");
    expect(checkboxCss).toContain(".checkbox:disabled");
    expect(focusCss).toContain(
      ".checkbox:not(:checked):not(:indeterminate):focus-visible",
    );
    expect(dataFilterToolbarCss).not.toContain("data-filter-check");

    for (const path of filesWithSuffix("src", ".tsx").filter((path) => (
      path !== "src/shared/ui/Checkbox.tsx" && path !== "src/shared/ui/SwitchField.tsx"
    ))) {
      expect(readFileSync(path, "utf8"), `${path} must use the shared Checkbox primitive`)
        .not.toContain('type="checkbox"');
    }
  });

  it("keeps filter-panel choices on their own compact semantic standard", () => {
    expect(tokensCss).toContain("--filter-indicator-size: 12px");
    expect(tokensCss).toContain("--filter-option-height: 28px");
    expect(filterOptionSource).toContain('type?: "checkbox" | "radio"');
    expect(filterOptionSource).toContain('className="filter-option-input focus-delegate-input"');
    expect(filterOptionCss).toContain("min-height: var(--filter-option-height)");
    expect(filterOptionCss).toContain("width: var(--filter-indicator-size)");
    expect(filterOptionCss).toContain('.filter-option-input[type="checkbox"]');
    expect(filterOptionCss).toContain('.filter-option-input[type="radio"]');
    expect(filterOptionCss).toContain(".filter-option:hover:not(.is-disabled)");
    expect(filterOptionCss).toContain(".filter-option:has(.filter-option-input:checked)");
    expect(filterOptionSource).toContain("focus-delegate-surface");
    expect(dataFilterToolbarCss).toContain(".data-filter-panel-grid-2 .data-filter-panel-body");
    expect(dataFilterToolbarCss).toContain(".data-filter-range {");
    expect(participantRangeSource).toContain('className="data-filter-range"');
    expect(participantRangeSource).toContain('placeholder="Min"');
    expect(participantRangeSource).toContain('placeholder="Max"');
    expect(groupFilterPanelSource).toContain("<ParticipantRangeFilter");
    expect(groupSelectionToolbarSource).toContain("<ParticipantRangeFilter");
    expect(dataFilterToolbarCss).not.toMatch(/\.data-filter-options\s+(?:label|input)/);
  });

  it("binds text and selector controls to one surface state matrix", () => {
    expect(tokensCss).toContain("--control-surface-default: var(--surface-control)");
    expect(tokensCss).toContain("--control-surface-hover: var(--surface-hover)");
    expect(tokensCss).toContain("--control-surface-disabled: var(--surface-disabled)");
    expect(tokensCss).toContain("--control-border-default: color-mix(in oklab, var(--fg) 38%, transparent)");
    expect(tokensCss).toContain("--control-border-hover: color-mix(in oklab, var(--fg) 52%, transparent)");
    expect(tokensCss).toContain("--control-border-disabled: var(--border-subtle)");
    expect(textFieldCss).toContain("border: var(--border-width) solid var(--control-border-default)");
    expect(textFieldCss).toContain("background: var(--control-surface-default)");
    expect(textFieldCss).toContain(".text-field-control input:hover:not(:disabled)");
    expect(textFieldCss).toContain(".text-field-control textarea:hover:not(:disabled)");
    expect(textFieldCss).toContain("border-color: var(--control-border-hover)");
    expect(textFieldCss).toContain("background: var(--control-surface-hover)");
    expect(selectMenuCss).toContain("border: var(--border-width) solid var(--control-border-default)");
    expect(selectMenuCss).toContain("background: var(--control-surface-default)");
    expect(groupsCss).toContain("border: var(--border-width) solid var(--control-border-default)");
    expect(groupsCss).toContain("background: var(--control-surface-default)");
    expect(searchFieldCss).not.toMatch(/(?:border(?:-color)?|background)\s*:/);
    expect(appCss).toMatch(
      /\.workspace-session-search input\s*\{[^}]*border: var\(--border-width\) solid var\(--control-border-default\);[^}]*background: var\(--control-surface-default\)/s,
    );
    expect(appCss).toMatch(
      /\.workspace-session-search input:hover:not\(:disabled\)\s*\{[^}]*border-color: var\(--control-border-hover\);[^}]*background: var\(--control-surface-hover\)/s,
    );
  });

  it("uses surface and typography states without persistent selection rails", () => {
    const allCss = cssFiles("src").map((path) => readFileSync(path, "utf8")).join("\n");

    expect(tokensCss).not.toContain("--active-rail");
    expect(tokensCss).not.toContain("--selection-rail-width");
    expect(allCss).not.toMatch(
      /\[(?:aria-current|aria-selected|data-selected)="true"\][^{]*::(?:before|after)/,
    );
    expect(dataTableCss).toContain(
      '.ui-data-table > tbody > tr[data-selected="true"] { background: var(--surface-selected); }',
    );
    expect(selectMenuCss).toContain(
      '.select-menu-option[aria-selected="true"] { background: var(--surface-selected);',
    );
    expect(tabsCss).toContain(
      '.tabs-trigger[aria-selected="true"] {\n  background: var(--surface-selected);',
    );
    expect(groupsCss).toContain(
      '.group-scope-option[aria-selected="true"] { background: var(--surface-selected);',
    );
    expect(groupSelectionTableSource).toContain("<DataTable caption={caption}>");
    expect(groupSelectionTableSource).toContain("data-selected={selected || undefined}");
    expect(segmentedControlCss).toContain(
      '.segmented-control-option:has(.segmented-control-input:checked) {\n  background: var(--surface-selected);',
    );
  });

  it("shares one paged group-selection contract across directory tables", () => {
    expect(groupsTableSource).toContain("dataTablePageSelectionState(");
    expect(groupSelectionTableSource).toContain("dataTablePageSelectionState(");
    expect(groupsTableSource).toContain('className="data-selection-cell"');
    expect(groupSelectionTableSource).toContain('className="data-selection-cell"');
    expect(groupSelectionTableSource).toContain("<DataTableSelectionBar");
    expect(groupSelectionTableSource).toContain('"Show selected"');
    expect(groupSelectionTableSource).not.toContain("Saved or selected outside current results");
    expect(groupSelectionTableSource).not.toContain("group-selection-divider");
    expect(dataTableCss).toContain("width: var(--table-selection-width);");
    expect(dataTableCss).toContain("padding-inline: var(--space-3);");
    expect(dataTableCss).toContain(".ui-data-table-selection-bar {");
    expect(dataTableCss).toMatch(
      /\.ui-data-table-selection-bar\s*\{[^}]*padding: var\(--table-chrome-padding-block\) var\(--table-chrome-padding-inline\);/s,
    );
    expect(dataTableSource).toContain('aria-label={ariaLabel}');
    expect(tokensCss).toContain("--table-chrome-padding-block: var(--space-2);");
    expect(tokensCss).toContain("--table-chrome-padding-inline: var(--table-cell-padding-inline);");
    expect(dataFilterToolbarCss).toContain(
      "padding: var(--table-chrome-padding-block) var(--table-chrome-padding-inline);",
    );
    expect(dataFilterToolbarCss).not.toContain("min-height: var(--table-toolbar-height)");
    expect(tokensCss).not.toContain("--table-toolbar-height");
    expect(groupSelectionCss).not.toContain(".group-selection-data > .data-filter-toolbar");
    expect(dataTableCss).toContain(".ui-data-table-visually-hidden {");
    expect(dataTableCss).toContain(".ui-data-table .data-cell-action-icon {");
    for (const source of [activityTableSource, groupsTableSource, runsTableSource]) {
      expect(source).toContain("data-cell-action data-cell-action-icon focus-overflow-owner");
    }
    for (const path of cssFiles("src/features")) {
      expect(readFileSync(path, "utf8"), `${path} must not restyle shared action cells`)
        .not.toMatch(/\.data-cell-action(?:\b|:)[^{]*\{/);
    }
    for (const path of filesWithSuffix("src", ".tsx")) {
      const source = readFileSync(path, "utf8");
      expect(source, `${path} must give empty visual table headers real text`).not.toMatch(
        /<th\b[^>]*aria-label=[^>]*(?:\/\>|>\s*<\/th>)/s,
      );
    }
  });

  it("keeps one tab anatomy and separates sequential workflow navigation", () => {
    expect(tabsSource).not.toContain("appearance");
    expect(tabsSource).not.toContain("step?:");
    expect(tabsCss).toContain("min-height: var(--control-height)");
    expect(tabsCss).toContain("border-radius: var(--radius-control)");
    expect(tabsCss).not.toContain("border-bottom");
    expect(settingsCss).not.toContain(".settings-navigation .tabs-trigger");
    expect(workflowStepperSource).toContain('className="workflow-stepper"');
    expect(workflowStepperSource).toContain('aria-current={activeStep === step.id ? "step" : undefined}');
  });

  it("keeps the Campaign Workspace hierarchy flat and operational", () => {
    expect(campaignsCss).toContain(".campaign-workspace-section {");
    expect(campaignsCss).toContain("border-top: var(--border-width) solid var(--divider)");
    expect(campaignsCss).toContain(".campaign-content-layout { min-width: 0; display: grid;");
    expect(campaignsCss).toContain("grid-template-columns: minmax(0, 1.7fr) minmax(280px, .8fr)");
    expect(campaignsCss).toMatch(/\.campaign-message-preview-media img\s*\{[^}]*object-fit: contain;/s);
    expect(campaignsCss).toContain(".campaign-message-preview-sticky { position: sticky;");
    expect(campaignsCss).toContain(".campaign-review-eyebrow {");
    expect(campaignsCss).toContain("line-height: var(--icon-sm)");
    expect(campaignsCss).not.toContain(".campaign-editor-panel");
    expect(campaignsCss).not.toContain(".campaign-snapshot-panel");
    expect(campaignsCss).not.toContain(".campaign-target-overview-icon");
  });

  it("assigns selector geometry by option cardinality and consequence", () => {
    expect(segmentedControlSource).toContain('role="radiogroup"');
    expect(segmentedControlSource).toContain('type="radio"');
    expect(segmentedControlCss).toContain("height: var(--field-control-height)");
    expect(segmentedControlCss).toContain("grid-auto-flow: column");
    expect(decisionGroupSource).toContain('role="radiogroup"');
    expect(decisionGroupSource).toContain('aria-orientation="horizontal"');
    expect(decisionGroupSource).toContain('className="decision-group-copy"');
    expect(decisionGroupSource).toContain("data-selected={selected || undefined}");
    expect(decisionGroupCss).toContain("min-height: 68px");
    expect(decisionGroupCss).toContain("grid-auto-flow: column");
    expect(decisionGroupCss).toContain('.decision-group-option[data-selected="true"] { background: var(--surface-selected);');
    expect(searchSelectSource).toContain('searchLabel = "Search options"');
    expect(searchSelectSource).toContain('role="listbox"');
    expect(searchSelectCss).toContain("height: var(--field-control-height)");
    expect(searchSelectCss).toContain("width: max(100%, var(--popup-min-width))");
    expect(searchSelectSource).toContain("useAnchoredPopup({");
    expect(selectMenuSource).toContain("useAnchoredPopup({");
    expect(searchSelectSource).not.toContain("clippingBoundary");
    expect(selectMenuSource).not.toContain("clippingBoundary");
    expect(anchoredPopupSource).toContain("popupClippingBoundary(root)");
    expect(segmentedControlSource).toContain("segmented-control-input focus-delegate-input");
    expect(segmentedControlSource).toContain("segmented-control-control focus-delegate-surface");
    expect(decisionGroupSource).toContain("decision-group-input focus-delegate-input");
    expect(decisionGroupSource).toContain("decision-group-control focus-delegate-surface");
    expect(focusCss).toContain(".search-select-trigger");
    expect(campaignsCss).not.toContain("campaign-content-type-control");
  });

  it("keeps one compact filter-toolbar inset across data tables", () => {
    expect(tokensCss).toContain("--table-chrome-padding-block: var(--space-2);");
    expect(tokensCss).toContain("--table-chrome-padding-inline: var(--table-cell-padding-inline);");
    expect(dataFilterToolbarCss).toContain(
      "padding: var(--table-chrome-padding-block) var(--table-chrome-padding-inline);",
    );
    expect(compositionCss).toMatch(
      /\.ui-data-table-toolbar\s*\{[^}]*padding: var\(--table-chrome-padding-block\) var\(--table-chrome-padding-inline\);/s,
    );
    expect(dataFilterToolbarCss).not.toMatch(/(?:^|\n)\s*padding-(?:block|inline)\s*:/);
    for (const path of cssFiles("src/features")) {
      const source = readFileSync(path, "utf8");
      expect(source, `${path} must not override DataFilterToolbar padding`).not.toMatch(
        /data-filter-toolbar[^{}]*\{[^}]*\bpadding(?:-(?:block|inline))?\s*:/s,
      );
    }
    expect(dataFilterToolbarCss)
      .toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(dataFilterToolbarCss).toContain(".data-filter-controls { min-width: 0;");
    expect(dataFilterToolbarCss).toContain("justify-self: stretch");
    expect(dataFilterToolbarCss).toContain(".data-filter-controls > .search-field { width: auto; flex: 1 1 180px; }");
    expect(dataFilterToolbarCss).toContain(".data-filter-result-summary { justify-self: end;");
    expect(dataFilterToolbarSource).toMatch(/ref=\{filterTriggerRef\}\s+size="md"/);
    expect(dataFilterToolbarSource).not.toContain("panelMode");
    expect(groupsCss).toContain("@container groups-list (max-width: 620px)");
    expect(groupsCss).toMatch(
      /@container groups-list \(max-width: 620px\)\s*\{[^}]*\.group-scope-selector \{ width: 100%; flex-basis: 100%; \}/s,
    );
  });

  it("lets the Groups scope popover escape a short table container", () => {
    expect(compositionSource).toContain('variant = "outlined"');
    expect(compositionSource).toContain("data-variant={variant}");
    expect(compositionCss).toContain('.ui-data-table-frame[data-variant="outlined"] {');
    expect(compositionCss).toContain("border: var(--border-width) solid var(--divider-strong);");
    expect(compositionCss).toContain("border-radius: var(--radius-panel);");
    expect(groupsCss).toContain(
      ".data-table-container.groups-list-panel { min-width: 0; overflow: visible;",
    );
    expect(groupsCss).toContain(".group-scope-pane {\n  position: absolute;");
  });

  it("locks the accepted product shell and keeps deprecated chrome absent", () => {
    expect(appCss).toContain("grid-template-rows: var(--shell-header-height) minmax(0, 1fr) var(--shell-footer-height)");
    expect(appCss).toContain(".workspace.workspace-rail-collapsed");
    expect(workspaceShell).toContain('className="workspace-sidebar-bottom"');
    expect(workspaceShell).toContain('className="workspace-build-line"');
    expect(workspaceShell).toContain("Current view");
    expect(workspaceShell).toContain("Connected locally");
    expect(workspaceShell).not.toContain("workspace-runtime-summary");
    expect(workspaceShell).not.toContain("action editor");
  });

  it("keeps every custom combobox at the shared 34px height", () => {
    expect(selectMenuCss).toContain(
      ".select-menu.ui-field { --field-control-height: var(--control-height); }",
    );
    expect(selectMenuCss).toContain("height: var(--field-control-height)");
    expect(appCss).toContain("height: var(--control-height)");
  });

  it("locks switch track, thumb, travel, and focus geometry", () => {
    expect(switchCss).toContain("width: var(--switch-width)");
    expect(switchCss).toContain("height: var(--switch-height)");
    expect(switchCss).toContain("top: var(--switch-thumb-padding-inset)");
    expect(switchCss).toContain("left: var(--switch-thumb-padding-inset)");
    expect(switchCss).toContain("transform: translateX(var(--switch-travel))");
    expect(switchSource).toContain('className="focus-delegate-input"');
    expect(switchSource).toContain("switch-field-control focus-delegate-surface");
    expect(focusCss).toContain("outline-offset: var(--focus-offset)");
  });

  it("locks the accepted WARP Settings anatomy", () => {
    expect(tokensCss).toContain("--settings-nav-width: 172px");
    expect(tokensCss).toContain("--setting-row-min-height: 62px");
    expect(tokensCss).toContain("--copy-line-settings: 58ch");
    expect(settingsScreenSource).toContain('orientation="vertical"');
    expect(settingsScreenSource).not.toContain("tabIndex={0}");
    expect(pageHeaderSource).toContain('<h1 className="page-header-title"');
    expect(settingsSectionSource).toContain("<h2 id={titleId}>");
    expect(settingsCss).toContain("grid-template-columns: var(--settings-nav-width) minmax(0, 1fr)");
    expect(settingsCss).toContain("min-height: var(--setting-row-min-height)");
    expect(settingsCss).toContain("border-radius: 0");
    expect(settingsCss).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(settingsOverviewSource).not.toContain("settings-status-hero");
    expect(settingsOverviewSource).not.toContain("settings-summary-card");
    expect(settingsCss).not.toContain("box-shadow");
  });

  it("locks the accepted WARP connection anatomy", () => {
    expect(appCss).toContain("grid-template-columns: var(--connection-columns)");
    expect(appCss).toContain("grid-template-rows: var(--connection-brand-height) minmax(0, 1fr)");
    expect(connectionShellSource).toContain("<h1 id={titleId}>");
    expect(connectionScreenSource).toContain('className="connection-form connection-setup-card"');
    expect(managedSetupSource).toContain('className="connection-form connection-setup-card"');
    expect(connectionScreenSource).not.toContain("connection-terminal-bar");
    expect(managedSetupSource).not.toContain("connection-terminal-bar");
  });

  it("keeps component CSS token-driven, flat, and free of colored focus effects", () => {
    const componentFiles = cssFiles("src").filter((path) => path !== "src/styles/tokens.css");

    for (const path of componentFiles) {
      const css = readFileSync(path, "utf8");
      expect(css, `${path} must not define raw hex colors`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(css, `${path} must not define raw rgb colors`).not.toMatch(/rgba?\(/i);
      expect(css, `${path} must not use gradients`).not.toMatch(/(?:linear|radial)-gradient\(/i);
      expect(css, `${path} must not use blur`).not.toMatch(/blur\(/i);

      for (const block of css.match(/[^{}]*:focus-visible[^{}]*\{[^{}]*\}/g) ?? []) {
        expect(block.replace(/box-shadow:\s*none\s*;?/gi, ""), `${path} focus must not glow`)
          .not.toMatch(/box-shadow\s*:/i);
      }
    }
  });
});
