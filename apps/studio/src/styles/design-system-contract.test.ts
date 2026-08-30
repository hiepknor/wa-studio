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
const fontsCss = readFileSync("src/fonts.css", "utf8");
const focusCss = readFileSync("src/styles/focus.css", "utf8");
const appCss = readFileSync("src/app/app.css", "utf8");
const appIconCss = readFileSync("src/shared/ui/app-icon.css", "utf8");
const appIconSource = readFileSync("src/shared/ui/AppIcon.tsx", "utf8");
const buttonCss = readFileSync("src/shared/ui/button.css", "utf8");
const buttonSource = readFileSync("src/shared/ui/Button.tsx", "utf8");
const badgeCss = readFileSync("src/shared/ui/badge.css", "utf8");
const badgeSource = readFileSync("src/shared/ui/Badge.tsx", "utf8");
const modalDialogCss = readFileSync("src/shared/ui/modal-dialog.css", "utf8");
const modalDialogSource = readFileSync("src/shared/ui/ModalDialog.tsx", "utf8");
const confirmationDialogSource = readFileSync(
  "src/shared/ui/ConfirmationDialog.tsx",
  "utf8",
);
const modalIsolationSource = readFileSync("src/shared/ui/modal-isolation.ts", "utf8");
const tabsCss = readFileSync("src/shared/ui/tabs.css", "utf8");
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
const groupsCss = readFileSync("src/features/groups/groups.css", "utf8");
const groupSelectionCss = readFileSync(
  "src/features/groups/selection/group-selection.css",
  "utf8",
);
const campaignsCss = readFileSync("src/features/campaigns/campaigns.css", "utf8");
const dataFilterToolbarCss = readFileSync("src/shared/ui/data-filter-toolbar.css", "utf8");
const dataFilterToolbarSource = readFileSync("src/shared/ui/DataFilterToolbar.tsx", "utf8");
const workspaceShell = readFileSync("src/app/WorkspaceShell.tsx", "utf8");
const searchFieldCss = readFileSync("src/shared/ui/search-field.css", "utf8");
const searchSelectCss = readFileSync("src/shared/ui/search-select.css", "utf8");
const searchSelectSource = readFileSync("src/shared/ui/SearchSelect.tsx", "utf8");
const selectMenuCss = readFileSync("src/shared/ui/select-menu.css", "utf8");
const segmentedControlCss = readFileSync("src/shared/ui/segmented-control.css", "utf8");
const segmentedControlSource = readFileSync("src/shared/ui/SegmentedControl.tsx", "utf8");
const decisionGroupCss = readFileSync("src/shared/ui/decision-group.css", "utf8");
const decisionGroupSource = readFileSync("src/shared/ui/DecisionGroup.tsx", "utf8");
const switchCss = readFileSync("src/shared/ui/switch-field.css", "utf8");
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

describe("WARP design-system contract", () => {
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
    expect(tokensCss).toContain("--drawer-width-default: 360px");
    expect(tokensCss).toContain("--drawer-width-compact: 320px");
    expect(tokensCss).toContain("--rail-width: 176px");
    expect(tokensCss).toContain("--rail-width-collapsed: 52px");
    expect(tokensCss).toContain("--session-selector-panel-width: 360px");
    expect(tauriConfig.app.windows[0]?.minWidth).toBe(960);
    expect(tokensCss).toContain(
      `--app-min-width: ${tauriConfig.app.windows[0]?.minWidth}px`,
    );
  });

  it("binds the self-hosted type families and semantic scale", () => {
    expect(tokensCss).toContain('--font-display: "Matter Regular", "Matter", "Inter", ui-sans-serif, system-ui, sans-serif');
    expect(tokensCss).toContain('--font-body: "Matter Regular", "Matter", "Inter", ui-sans-serif, system-ui, sans-serif');
    expect(tokensCss).toContain('--font-mono: "Geist Mono", "Matter Mono Regular", ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace');
    expect(fontsCss).toContain('font-family: "Inter"');
    expect(fontsCss).toContain('font-family: "Geist Mono"');
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
    }
  });

  it("maps core text roles to the product typography contract", () => {
    expect(appCss).toContain("font: var(--weight-regular) var(--type-body)/var(--leading-ui) var(--font-body)");
    expect(appCss).toContain("h1, h2, h3, h4, h5, h6 { font-weight: var(--weight-regular); }");
    expect(appCss).toContain("strong, b { font-weight: var(--weight-medium); }");
    expect(appCss).toContain("font-size: var(--type-body);\n  text-align: left;\n  white-space: nowrap;");
    expect(appCss).toContain("table { width: 100%; border-collapse: collapse; font-size: var(--type-body); }");
    expect(appCss).toContain(".data-table { font-size: var(--type-body); line-height: var(--leading-ui); }");
    expect(appCss).toContain(".data-column-time, .data-cell-time");
    expect(appCss).toContain(".data-cell-value,\n.data-cell-number,\n.data-cell-time {");
    expect(appCss).toContain("font-weight: var(--weight-regular); letter-spacing: var(--tracking-label); text-transform: uppercase");

    expect(buttonCss).toContain("font-size: var(--type-body)");
    expect(buttonCss).toContain("font-weight: var(--weight-medium)");
    expect(buttonCss).toContain("line-height: var(--leading-ui)");
    expect(buttonCss).toContain("letter-spacing: var(--tracking-ui)");
    expect(textFieldCss).toContain("--field-control-font-size: var(--type-body)");
    expect(textFieldCss).toContain("line-height: var(--control-line-height)");
    expect(searchFieldCss).not.toContain("font-size:");
    expect(selectMenuCss).toContain("line-height: var(--control-line-height)");
    expect(tabsCss).toContain("font-size: var(--type-body)");
    expect(tabsCss).toContain("font-weight: var(--weight-regular)");
    expect(badgeCss).toContain("font-size: var(--type-label)");
    expect(badgeCss).toContain("font-weight: var(--weight-regular)");
    expect(badgeCss).toContain("line-height: var(--leading-tight-ui)");
    expect(badgeCss).toContain("letter-spacing: var(--tracking-ui)");
    expect(modalDialogCss).toContain("font-size: var(--type-emphasis); font-weight: var(--weight-regular); letter-spacing: var(--tracking-title)");
  });

  it("locks the WARP button anatomy and state hierarchy", () => {
    expect(tokensCss).toContain("--control-compact: 30px");
    expect(tokensCss).toContain("--control-height: 34px");
    expect(tokensCss).toContain("--control-large: 44px");
    expect(tokensCss).toContain("--hit-slop-inline: 3px");
    expect(tokensCss).toContain("--hit-slop-block: 5px");
    expect(tokensCss).toContain("--press-shift: 1px");
    expect(tokensCss).toContain("--disabled-opacity: .62");
    expect(tokensCss).toContain("--radius-control: var(--radius-sm)");

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
    expect(buttonCss).toContain(".button-sm { --button-height: var(--control-compact); padding-inline: var(--space-2); font-size: var(--type-caption); }");
    expect(buttonCss).toContain(".button-lg { --button-height: var(--control-large); padding-inline: var(--space-4); }");
    expect(buttonCss).toContain(".button-icon-only");
    expect(buttonSource).toContain('size="md"');
    expect(buttonSource).toContain('iconOnly ? "button-icon-only" : ""');
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
    expect(focusCss).toContain(".focus-owner { border-radius: var(--radius-sm); }");
    expect(focusCss).toContain(
      'html[data-focus-modality="keyboard"] .focus-owner:has(> input:focus-visible)',
    );
    expect(focusCss).toContain(
      'html[data-focus-modality="keyboard"] .focus-owner > input:focus-visible',
    );
    expect(focusCss).toContain(".switch-field input:focus-visible + .switch-field-control");
    expect(focusCss).toContain(
      ".filter-option:has(.filter-option-input:focus-visible)",
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
    expect(filterOptionSource).toContain('className="filter-option-input"');
    expect(filterOptionCss).toContain("min-height: var(--filter-option-height)");
    expect(filterOptionCss).toContain("width: var(--filter-indicator-size)");
    expect(filterOptionCss).toContain('.filter-option-input[type="checkbox"]');
    expect(filterOptionCss).toContain('.filter-option-input[type="radio"]');
    expect(filterOptionCss).toContain(".filter-option:hover:not(.is-disabled)");
    expect(filterOptionCss).toContain(".filter-option:has(.filter-option-input:checked)");
    expect(focusCss).toContain(".filter-option-input:focus-visible");
    expect(focusCss).toContain(".filter-option:has(.filter-option-input:focus-visible)");
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
    expect(textFieldCss).toContain("border: 1px solid var(--control-border-default)");
    expect(textFieldCss).toContain("background: var(--control-surface-default)");
    expect(textFieldCss).toContain(".text-field-control input:hover:not(:disabled)");
    expect(textFieldCss).toContain(".text-field-control textarea:hover:not(:disabled)");
    expect(textFieldCss).toContain("border-color: var(--control-border-hover)");
    expect(textFieldCss).toContain("background: var(--control-surface-hover)");
    expect(selectMenuCss).toContain("border: 1px solid var(--control-border-default)");
    expect(selectMenuCss).toContain("background: var(--control-surface-default)");
    expect(groupsCss).toContain("border: 1px solid var(--control-border-default)");
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
    expect(appCss).toContain(
      'tbody tr[data-selected="true"] { background: var(--surface-selected); }',
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
    expect(groupSelectionCss).toContain(
      'tbody tr[data-selected="true"] { background: var(--surface-selected);',
    );
    expect(segmentedControlCss).toContain(
      '.segmented-control-option:has(.segmented-control-input:checked) {\n  background: var(--surface-selected);',
    );
  });

  it("assigns selector geometry by option cardinality and consequence", () => {
    expect(segmentedControlSource).toContain('role="radiogroup"');
    expect(segmentedControlSource).toContain('type="radio"');
    expect(segmentedControlCss).toContain("height: var(--field-control-height)");
    expect(segmentedControlCss).toContain("grid-auto-flow: column");
    expect(decisionGroupSource).toContain('role="radiogroup"');
    expect(decisionGroupSource).toContain('className="decision-group-copy"');
    expect(decisionGroupCss).toContain("min-height: 52px");
    expect(searchSelectSource).toContain('searchLabel = "Search options"');
    expect(searchSelectSource).toContain('role="listbox"');
    expect(searchSelectCss).toContain("height: var(--field-control-height)");
    expect(searchSelectCss).toContain("width: max(100%, 280px)");
    expect(focusCss).toContain(".segmented-control-input:focus-visible");
    expect(focusCss).toContain(".decision-group-input:focus-visible");
    expect(focusCss).toContain(".search-select-trigger");
    expect(campaignsCss).not.toContain("campaign-content-type-control");
  });

  it("anchors filter controls and result counts to opposite toolbar edges", () => {
    expect(dataFilterToolbarCss)
      .toContain(".data-table-toolbar.data-filter-toolbar { padding-inline: 0; }");
    expect(dataFilterToolbarCss)
      .toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(dataFilterToolbarCss).toContain(".data-filter-controls { min-width: 0;");
    expect(dataFilterToolbarCss).toContain("justify-self: start");
    expect(dataFilterToolbarCss).toContain(".data-filter-result-summary { justify-self: end;");
    expect(dataFilterToolbarSource).toMatch(/ref=\{filterTriggerRef\}\s+size="md"/);
    expect(dataFilterToolbarSource).not.toContain("panelMode");
  });

  it("lets the Groups scope popover escape a short table container", () => {
    expect(appCss).toContain(".data-table-container { overflow: hidden;");
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
    expect(focusCss).toContain(".switch-field input:focus-visible + .switch-field-control");
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
