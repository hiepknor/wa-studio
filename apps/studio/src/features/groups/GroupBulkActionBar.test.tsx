import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { GroupBulkActionBar } from "./GroupBulkActionBar";

function renderBar(overrides: Partial<Parameters<typeof GroupBulkActionBar>[0]> = {}) {
  const props: Parameters<typeof GroupBulkActionBar>[0] = {
    mode: "add",
    onAddExisting: vi.fn(),
    onClear: vi.fn(),
    onCreate: vi.fn(),
    onRemove: vi.fn(),
    selectedCount: 2,
    ...overrides,
  };
  render(<GroupBulkActionBar {...props} />);
  return props;
}

describe("GroupBulkActionBar", () => {
  it("routes an empty catalog directly to New list", async () => {
    const user = userEvent.setup();
    const props = renderBar({ existingListsState: "empty" });

    expect(screen.queryByRole("button", { name: "Add to list" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New list" }));

    expect(props.onCreate).toHaveBeenCalledTimes(1);
  });

  it("keeps local Clear available while server-backed actions are temporarily locked", async () => {
    const user = userEvent.setup();
    const props = renderBar({ actionDisabled: true });

    expect(screen.getByRole("button", { name: "Add to list" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(props.onClear).toHaveBeenCalledTimes(1);
  });

  it("keeps New list available when existing destinations cannot be loaded", async () => {
    const user = userEvent.setup();
    const props = renderBar({ existingListsState: "unavailable" });

    await user.click(screen.getByRole("button", { name: "Add to list" }));
    expect(screen.getByRole("menuitem", { name: /Add to existing list/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("menuitem", { name: /Create new list/ }));

    expect(props.onCreate).toHaveBeenCalledTimes(1);
  });
});
