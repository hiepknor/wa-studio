import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Badge } from "./Badge";
import { DrawerHost, DrawerProvider } from "./Drawer";
import {
  WorkspaceDrawer,
  WorkspaceDisclosurePanel,
  WorkspaceEmptyState,
  WorkspaceFooter,
  WorkspacePanel,
  WorkspaceSectionHeader,
  WorkspaceSummaryCard,
} from "./WorkspaceDrawer";

describe("WorkspaceDrawer", () => {
  it("composes navigation, content, and a persistent action footer", async () => {
    render(
      <DrawerProvider>
        <WorkspaceDrawer
          description="Edit a persisted object."
          eyebrow="Workspace"
          footer={<WorkspaceFooter actions={<button type="button">Save</button>} description="No unsaved changes" title="Step 1" />}
          navigation={<nav aria-label="Editor steps">Steps</nav>}
          onClose={vi.fn()}
          open
          title="Release"
        >
          <WorkspaceSectionHeader description="Configure the release." kicker="Step 1" title="Details" />
        </WorkspaceDrawer>
        <DrawerHost />
      </DrawerProvider>,
    );

    const dialog = await screen.findByRole("dialog", { name: "Release" });
    expect(dialog).toHaveClass("workspace-drawer");
    expect(screen.getByRole("navigation", { name: "Editor steps" }))
      .toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Details" })).toBeInTheDocument();
    expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("renders shared summary, panel, and empty-state semantics", () => {
    render(
      <>
        <WorkspaceSummaryCard
          dirty
          icon="groups"
          label="Target snapshot"
          metrics={[{ label: "Saved", value: 4 }, { label: "Revision", value: "r2" }]}
          status={<Badge tone="warning">Unsaved changes</Badge>}
          title="Custom selection"
          titleId="target-summary"
        />
        <WorkspacePanel title="Configuration" titleId="configuration-title">
          Panel content
        </WorkspacePanel>
        <WorkspaceEmptyState icon="activity" title="Ready for evaluation">
          Run the check to continue.
        </WorkspaceEmptyState>
      </>,
    );

    expect(screen.getByRole("heading", { name: "Custom selection" }).closest("section"))
      .toHaveAttribute("data-dirty", "true");
    expect(screen.getByText("r2")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Configuration" })).toBeInTheDocument();
    expect(screen.getByText("Run the check to continue.")).toBeInTheDocument();
  });

  it("renders a collapsible panel with the shared panel language", () => {
    render(
      <WorkspaceDisclosurePanel
        description="Synchronization history and Runtime identifiers."
        title="Technical metadata"
        titleId="technical-metadata-title"
      >
        Metadata content
      </WorkspaceDisclosurePanel>,
    );

    const disclosure = screen
      .getByRole("heading", { name: "Technical metadata" })
      .closest("details");
    expect(disclosure).not.toHaveAttribute("open");

    fireEvent.click(screen.getByText("Technical metadata").closest("summary")!);

    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByText("Metadata content")).toBeInTheDocument();
  });
});
