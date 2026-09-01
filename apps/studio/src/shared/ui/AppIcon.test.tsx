import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppIcon } from "./AppIcon";

describe("AppIcon", () => {
  it("renders the product-owned WARP path for core icons", () => {
    const { container } = render(<AppIcon name="groups" />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
    expect(svg).toHaveAttribute("width", "16");
    expect(svg).toHaveClass("ui-icon-md");
    expect(svg?.querySelector("path")).toHaveAttribute(
      "d",
      "M3.5 19c.4-3.2 2.3-5 5.5-5s5.1 1.8 5.5 5M14 15c3.5-.7 5.7.7 6.5 4",
    );
  });

  it("keeps supplemental action icons on the same shared geometry", () => {
    const { container } = render(<AppIcon name="copy" size="sm" />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveAttribute("width", "14");
    expect(svg).toHaveClass("ui-icon-sm");
    expect(svg).toHaveAttribute("stroke-width", "1.7");
  });
});
