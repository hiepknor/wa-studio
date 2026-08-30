import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeGroupList } from "@/shared/api/runtime-client";
import { GroupListDestinationDialog } from "./GroupListDestinationDialog";

const list: RuntimeGroupList = {
  archivedAt: null,
  createdAt: "2026-08-25T00:00:00.000Z",
  description: "Priority accounts",
  groupCount: 2,
  id: "list-1",
  membershipRevision: 3,
  name: "North America",
  revision: 4,
  sessionId: "session-1",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

function renderDialog(overrides: Partial<Parameters<typeof GroupListDestinationDialog>[0]> = {}) {
  const props: Parameters<typeof GroupListDestinationDialog>[0] = {
    error: null,
    hasMore: false,
    lists: [list],
    loading: false,
    onApply: vi.fn(),
    onClose: vi.fn(),
    onCreate: vi.fn(),
    onLoadMore: vi.fn(),
    onQueryChange: vi.fn(),
    open: true,
    query: "",
    saving: false,
    selectedCount: 2,
    ...overrides,
  };
  render(<GroupListDestinationDialog {...props} />);
  return props;
}

describe("GroupListDestinationDialog", () => {
  it("applies a keyboard-accessible saved-list destination", async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    const dialog = screen.getByRole("dialog", { name: "Add to existing list" });

    await user.click(within(dialog).getByRole("radio", { name: list.name }));
    await user.click(within(dialog).getByRole("button", { name: "Add to list" }));

    expect(props.onApply).toHaveBeenCalledWith(list);
  });

  it("recovers from an empty catalog through the consistent New list action", async () => {
    const user = userEvent.setup();
    const props = renderDialog({ emptyCatalog: true, lists: [] });
    const dialog = screen.getByRole("dialog", { name: "No saved lists" });

    expect(within(dialog).queryByRole("radiogroup")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "New list" }));

    expect(props.onCreate).toHaveBeenCalledTimes(1);
  });

  it("offers a safe creation path when the catalog fails while open", async () => {
    const user = userEvent.setup();
    const props = renderDialog({
      error: { body: "Retry when Runtime is available.", title: "Could not load saved lists" },
      lists: [],
    });
    const dialog = screen.getByRole("dialog", { name: "Saved lists unavailable" });

    await user.click(within(dialog).getByRole("button", { name: "New list" }));

    expect(props.onCreate).toHaveBeenCalledTimes(1);
  });

  it("clears an empty search instead of trapping the user in a disabled state", async () => {
    const user = userEvent.setup();
    const props = renderDialog({ lists: [], query: "missing list" });
    const dialog = screen.getByRole("dialog", { name: "Add to existing list" });

    expect(within(dialog).queryByRole("radiogroup")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Clear search" }));

    expect(props.onQueryChange).toHaveBeenCalledWith("");
  });
});
