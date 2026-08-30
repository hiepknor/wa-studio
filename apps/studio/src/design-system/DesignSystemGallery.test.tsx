import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ToastProvider } from "../shared/ui/Toast";
import { DesignSystemGallery } from "./DesignSystemGallery";

describe("DesignSystemGallery", () => {
  it("covers the foundation, primitive state matrix, and reference compositions", () => {
    render(<ToastProvider><DesignSystemGallery /></ToastProvider>);

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
  });
});
