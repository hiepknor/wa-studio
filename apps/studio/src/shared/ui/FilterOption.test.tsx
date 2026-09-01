import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FilterOption } from "./FilterOption";

describe("FilterOption", () => {
  it("renders a compact native checkbox option", () => {
    render(<FilterOption defaultChecked>Allowed</FilterOption>);

    const option = screen.getByRole("checkbox", { name: "Allowed" });
    expect(option).toHaveClass("filter-option-input");
    expect(option).toBeChecked();
    expect(option.closest(".filter-option")).toBeInTheDocument();
  });

  it("supports native radio grouping without changing its presentation contract", () => {
    render(<>
      <FilterOption defaultChecked name="state" type="radio">Active</FilterOption>
      <FilterOption name="state" type="radio">Inactive</FilterOption>
    </>);

    expect(screen.getByRole("radio", { name: "Active" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Inactive" })).not.toBeChecked();
  });
});
