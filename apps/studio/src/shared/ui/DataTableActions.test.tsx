import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DataTablePrimaryAction } from "./DataTablePrimaryAction";
import { FilterChip } from "./FilterChip";

describe("data table actions", () => {
  it("provides one shared primary row action", async () => {
    const onClick = vi.fn();
    render(<DataTablePrimaryAction onClick={onClick}>North America operations</DataTablePrimaryAction>);

    await userEvent.click(screen.getByRole("button", { name: "North America operations" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("provides a removable filter chip with an overridable accessible label", async () => {
    const onRemove = vi.fn();
    render(<FilterChip label="Allowed" onRemove={onRemove} removeLabel="Remove capability: Allowed filter" />);

    await userEvent.click(screen.getByRole("button", { name: "Remove capability: Allowed filter" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
