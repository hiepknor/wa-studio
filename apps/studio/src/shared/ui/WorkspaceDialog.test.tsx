import { readFileSync } from "node:fs";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceDialog } from "./WorkspaceDialog";
import { WorkspaceFooter, WorkspaceSectionHeader } from "./WorkspaceDrawer";

function Harness() {
  const [contentKey, setContentKey] = useState("details");
  return (
    <WorkspaceDialog
      contentKey={contentKey}
      description="Edit a persisted object in sequence."
      eyebrow="Workspace"
      footer={<WorkspaceFooter actions={<button type="button">Save</button>} description="No unsaved changes" title="Step 1" />}
      headerActions={<button type="button">More actions</button>}
      navigation={<nav aria-label="Editor steps">Steps</nav>}
      notice={<p>Runtime notice</p>}
      onClose={vi.fn()}
      open
      title="Release"
    >
      <WorkspaceSectionHeader description="Configure the release." kicker="Step 1" title="Details" />
      <button onClick={() => setContentKey("targets")} type="button">Next section</button>
    </WorkspaceDialog>
  );
}

describe("WorkspaceDialog", () => {
  it("composes a large workflow surface and resets body scroll with its content key", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const dialog = screen.getByRole("dialog", { name: "Release" });
    expect(dialog).toHaveClass("workspace-dialog");
    expect(dialog).toHaveAttribute("data-size", "workflow");
    expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Editor steps" })).toBeInTheDocument();
    expect(screen.getByText("Runtime notice")).toBeInTheDocument();
    expect(screen.getByText("No unsaved changes")).toBeInTheDocument();

    const body = dialog.querySelector<HTMLElement>(".modal-dialog-body");
    expect(body).not.toBeNull();
    if (!body) return;
    body.scrollTop = 160;
    await user.click(screen.getByRole("button", { name: "Next section" }));
    await waitFor(() => expect(body.scrollTop).toBe(0));
  });

  it("keeps the workflow geometry and shared responsive container contract", () => {
    const modalCss = readFileSync("src/shared/ui/modal-dialog.css", "utf8");
    const workspaceCss = readFileSync("src/shared/ui/workspace-dialog.css", "utf8");

    expect(modalCss).toContain("width: min(1080px, 100%);");
    expect(modalCss).toContain("height: min(820px, calc(100dvh - 32px));");
    expect(workspaceCss).toContain("container: workspace-drawer / inline-size;");
    expect(workspaceCss).toContain("overscroll-behavior: contain;");
  });
});
