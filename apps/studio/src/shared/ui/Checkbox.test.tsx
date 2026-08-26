import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Checkbox } from "./Checkbox";

describe("Checkbox", () => {
  it("keeps native checkbox semantics behind the shared visual primitive", () => {
    render(<label><Checkbox defaultChecked /><span>Include archived groups</span></label>);

    const checkbox = screen.getByRole("checkbox", { name: "Include archived groups" });
    expect(checkbox).toHaveClass("checkbox");
    expect(checkbox).toBeChecked();
    expect(checkbox).toHaveAttribute("type", "checkbox");
  });

  it("forwards disabled state and a consumer class", () => {
    render(<Checkbox aria-label="Unavailable group" className="table-checkbox" disabled />);

    expect(screen.getByRole("checkbox", { name: "Unavailable group" }))
      .toHaveClass("checkbox", "table-checkbox");
    expect(screen.getByRole("checkbox", { name: "Unavailable group" })).toBeDisabled();
  });
});
