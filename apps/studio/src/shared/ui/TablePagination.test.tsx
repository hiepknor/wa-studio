import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TablePagination } from "./TablePagination";

describe("TablePagination", () => {
  it("uses an honest empty label and disables navigation when there are no results", () => {
    render(<TablePagination limit={50} offset={0} onOffsetChange={vi.fn()} total={0} />);

    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("supports domain-specific labels without changing offset navigation", async () => {
    const user = userEvent.setup();
    const onOffsetChange = vi.fn();
    render(
      <TablePagination
        label="75 durable runs"
        limit={50}
        offset={0}
        onOffsetChange={onOffsetChange}
        total={75}
      />,
    );

    expect(screen.getByText("75 durable runs")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(onOffsetChange).toHaveBeenCalledWith(50);
  });
});
