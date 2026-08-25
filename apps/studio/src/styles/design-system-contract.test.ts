import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function cssFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory()
      ? cssFiles(path)
      : path.endsWith(".css")
        ? [path]
        : [];
  });
}

const tokensCss = readFileSync("src/styles/tokens.css", "utf8");
const appCss = readFileSync("src/app/app.css", "utf8");
const workspaceShell = readFileSync("src/app/WorkspaceShell.tsx", "utf8");
const selectMenuCss = readFileSync("src/shared/ui/select-menu.css", "utf8");
const switchCss = readFileSync("src/shared/ui/switch-field.css", "utf8");

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
  });

  it("locks the accepted prototype shell and keeps deprecated chrome absent", () => {
    expect(appCss).toContain("grid-template-rows: var(--shell-header-height) minmax(0, 1fr) var(--shell-footer-height)");
    expect(appCss).toContain(".workspace.workspace-rail-collapsed");
    expect(workspaceShell).toContain('className="workspace-sidebar-bottom"');
    expect(workspaceShell).toContain('className="workspace-build-line"');
    expect(workspaceShell).toContain("Active workspace");
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
    expect(switchCss).toContain("outline-offset: var(--focus-offset)");
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
