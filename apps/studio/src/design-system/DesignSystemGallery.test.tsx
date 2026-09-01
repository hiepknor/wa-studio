import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ToastProvider } from "../shared/ui/Toast";
import { DesignSystemGallery } from "./DesignSystemGallery";
import { DESIGN_SYSTEM_STATE_MATRIX } from "./design-system-state-matrix";

describe("DesignSystemGallery", () => {
  it("covers the foundation, primitive state matrix, and reference compositions", () => {
    const { container } = render(<ToastProvider><DesignSystemGallery /></ToastProvider>);

    for (const heading of [
      "Foundation",
      "Actions",
      "Fields and selectors",
      "Selection",
      "Status and feedback",
      "Navigation and overlays",
      "Composition patterns",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(screen.getByRole("region", { name: "Group directory" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Runtime target assessment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open modal" })).toBeInTheDocument();
    expect(screen.getAllByRole("switch", { name: "Live-send protection" })).toHaveLength(2);

    for (const [component, states] of Object.entries(DESIGN_SYSTEM_STATE_MATRIX)) {
      const boundary = container.querySelector(`[data-ds-component="${component}"]`);
      expect(boundary, `${component} must have a production gallery specimen`).not.toBeNull();
      expect(boundary?.getAttribute("data-ds-states")?.split(" "))
        .toEqual([...states]);
    }
  });
});
