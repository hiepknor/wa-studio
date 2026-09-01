import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TablePagination } from "./TablePagination";

describe("TablePagination", () => {
  it("keeps page ownership in the footer and disables navigation when there are no results", () => {
    render(<TablePagination limit={50} offset={0} onOffsetChange={vi.fn()} total={0} />);

    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("avoids page arithmetic when every result already fits", () => {
    render(<TablePagination limit={50} offset={0} onOffsetChange={vi.fn()} total={1} />);

    expect(screen.getByText("All results shown")).toBeInTheDocument();
    expect(screen.queryByText("Page 1 of 1")).not.toBeInTheDocument();
  });

  it("supports domain-specific labels without changing offset navigation", async () => {
    const user = userEvent.setup();
    const onOffsetChange = vi.fn();
    render(
      <TablePagination
        label="75 durable runs"
        limit={50}
        nextButtonAriaLabel="Next run page"
        offset={0}
        onOffsetChange={onOffsetChange}
        previousButtonAriaLabel="Previous run page"
        total={75}
      />,
    );

    expect(screen.getByText("75 durable runs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous run page" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next run page" }));
    expect(onOffsetChange).toHaveBeenCalledWith(50);
  });
});
