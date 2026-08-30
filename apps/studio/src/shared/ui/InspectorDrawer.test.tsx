import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Badge } from "./Badge";
import { DrawerHost, DrawerProvider } from "./Drawer";
import {
  InspectorDisclosure,
  InspectorDrawer,
  InspectorSection,
} from "./InspectorDrawer";

describe("InspectorDrawer", () => {
  it("locks the inspector header, navigation, content, and size contract", async () => {
    render(
      <DrawerProvider data-testid="frame">
        <InspectorDrawer
          kicker="Campaign run"
          meta={["Run 12345678", "Dry run"]}
          navigation={<div role="tablist">Inspector tabs</div>}
          onClose={vi.fn()}
          open
          size="wide"
          status={<Badge tone="success">Running</Badge>}
          title="Product release"
        >
          <InspectorSection
            description="Runtime-authoritative execution state."
            eyebrow="Execution"
            title="Run summary"
            titleId="run-summary"
          >
            Summary content
          </InspectorSection>
        </InspectorDrawer>
        <DrawerHost />
      </DrawerProvider>,
    );

    const dialog = await screen.findByRole("dialog", { name: "Product release" });
    expect(dialog).toHaveClass("inspector-drawer", "drawer-surface-wide");
    expect(dialog).toHaveAttribute("data-size", "wide");
    expect(dialog).toHaveAccessibleDescription("Run 12345678·Dry run·Running");
    expect(screen.getByTestId("frame")).toHaveAttribute("data-drawer-size", "wide");
    expect(screen.getByRole("heading", { name: "Run summary" })).toBeInTheDocument();
    const navigation = screen.getByRole("tablist");
    expect(navigation.closest(".drawer-subheader")).not.toBeNull();
    expect(dialog.querySelector(".drawer-body")).not.toContainElement(navigation);
  });

  it("provides a shared technical disclosure", () => {
    render(
      <InspectorDisclosure
        description="Runtime identifiers."
        title="Technical details"
        titleId="technical-details"
      >
        Identifier content
      </InspectorDisclosure>,
    );

    const disclosure = screen.getByText("Technical details").closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Technical details").closest("summary")!);
    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByText("Identifier content")).toBeInTheDocument();
  });
});
