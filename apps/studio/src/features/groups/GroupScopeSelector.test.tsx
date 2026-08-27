import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeGroupList } from "@/shared/api/runtime-client";
import { GroupScopeSelector } from "./GroupScopeSelector";

const lists: RuntimeGroupList[] = [
  {
    archivedAt: null,
    createdAt: "2026-08-25T00:00:00.000Z",
    description: null,
    groupCount: 12,
    id: "list-1",
    membershipRevision: 2,
    name: "North America",
    revision: 3,
    sessionId: "session-1",
    updatedAt: "2026-08-25T00:00:00.000Z",
  },
];

describe("GroupScopeSelector", () => {
  it("opens into search, exposes grouped scopes, and selects a saved list", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    const onSelectList = vi.fn();
    render(
      <GroupScopeSelector
        lists={lists}
        onNewList={vi.fn()}
        onQueryChange={onQueryChange}
        onSelectDirectory={vi.fn()}
        onSelectList={onSelectList}
        query=""
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Group scope" });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search saved lists" })).toHaveFocus());
    expect(screen.getByRole("option", { name: /All groups/ })).toHaveAttribute("aria-selected", "true");

    await user.type(screen.getByRole("searchbox", { name: "Search saved lists" }), "north");
    expect(onQueryChange).toHaveBeenLastCalledWith("h");
    await user.click(screen.getByRole("option", { name: /North America/ }));
    expect(onSelectList).toHaveBeenCalledWith(lists[0]);
    expect(trigger).toHaveFocus();
  });

  it("supports keyboard traversal and restores trigger focus on Escape", async () => {
    const user = userEvent.setup();
    render(
      <GroupScopeSelector
        lists={lists}
        onNewList={vi.fn()}
        onQueryChange={vi.fn()}
        onSelectDirectory={vi.fn()}
        onSelectList={vi.fn()}
        query=""
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "Group scope" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const search = screen.getByRole("searchbox", { name: "Search saved lists" });
    await waitFor(() => expect(search).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /All groups/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("consumes search Escape and closes if the selector becomes disabled", async () => {
    const user = userEvent.setup();
    const onAncestorKeyDown = vi.fn();
    const selector = (disabled = false) => (
      <div onKeyDown={onAncestorKeyDown}>
        <GroupScopeSelector
          disabled={disabled}
          lists={lists}
          onNewList={vi.fn()}
          onQueryChange={vi.fn()}
          onSelectDirectory={vi.fn()}
          onSelectList={vi.fn()}
          query=""
        />
      </div>
    );
    const { rerender } = render(selector());
    const trigger = screen.getByRole("combobox", { name: "Group scope" });

    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search saved lists" })).toHaveFocus());
    onAncestorKeyDown.mockClear();
    await user.keyboard("{Escape}");
    expect(onAncestorKeyDown).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    rerender(selector(true));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps New list available in the fixed pane header", async () => {
    const user = userEvent.setup();
    const onNewList = vi.fn();
    render(
      <GroupScopeSelector
        lists={[]}
        onNewList={onNewList}
        onQueryChange={vi.fn()}
        onSelectDirectory={vi.fn()}
        onSelectList={vi.fn()}
        query=""
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Group scope" }));
    await user.click(screen.getByRole("button", { name: /New list/ }));
    expect(onNewList).toHaveBeenCalledOnce();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
